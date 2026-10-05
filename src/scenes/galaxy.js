/**
 * Scene 2 — the Milky Way.
 *
 * The galaxy is 220,000 points in a single draw call. Each star carries the
 * attributes the vertex shader needs to place it (radius, arm, base angle,
 * height, brightness, colour), and the shader does the differential rotation on
 * the GPU. That inversion matters: doing the rotation on the CPU would mean
 * rewriting a 660,000-float buffer every frame, which is ~10 MB/frame of
 * PCIe traffic for something a vertex shader does for free.
 *
 * The spiral is generated to match the real Milky Way's structure:
 *
 *  • **Differential rotation.** Inner material orbits faster, so the arms wind
 *    up into a trailing spiral. A rigidly rotated disc cannot produce arms at
 *    all; the winding is the entire phenomenon.
 *  • **Four main arms** (Perseus, Sagittarius, Scutum–Centaurus, Norma) with
 *    arms 5 and 9 in between, which is why the real galaxy looks messy and
 *    this one looks too clean. `uArmTightness` and the arm-weight noise are the
 *    knobs that fix that.
 *  • **Bar + bulge.** The Milky Way is barred; the core is a boxy/peanut
 *    bulge, not a smooth sphere. `uArm = -1` selects the bulge population.
 *  • **Colour by population.** The arms are bluer (young, hot, massive O and B
 *    stars); the bulge is yellower and redder (older, metal-poor). This is the
 *    single strongest visual cue that the model is doing astronomy rather than
 *    decorating a disc.
 *
 * @module scenes/galaxy
 */

import * as THREE from 'three';
import { SCALE, RENDERER } from '../config.js';
import { clamp01 } from '../utils/math.js';
import {
  GALAXY_VERTEX, GALAXY_FRAGMENT, GALAXY_ATTRIBUTES, GALAXY_UNIFORM_DEFAULTS, SMBH_FRAGMENT,
} from '../shaders/galaxy.js';
import {
  STARFIELD_VERTEX, STARFIELD_FRAGMENT,
} from '../shaders/nebula.js';
import { SceneBase } from './scene-base.js';

const TWO_PI = Math.PI * 2;

/** The Sun's galactocentric radius, ~26,000 ly, in scene units. */
const SUN_RADIUS_UNITS = 26_000 * 9.4607e12 / SCALE.UNIT_KM;
/** Milky Way disc radius, ~100,000 ly. */
const DISC_RADIUS_UNITS = 100_000 * 9.4607e12 / SCALE.UNIT_KM;

/**
 * Named landmarks, so the demo can talk about real places.
 * Distances in light-years from Sol.
 */
const LANDMARKS = {
  smbh: { name: 'Sagittarius A*', type: 'Supermassive black hole', ly: 26_000, blurb:
    'Four million solar masses of collapsed starlight, orbited by a million stars per '
    + 'century on orbits that take 15 to 30 million years. The orbits are what let us '
    + 'weigh it: we can see exactly where the stars should be if there were nothing '
    + 'invisible, and there is.',
    funFact:
    'The Event Horizon Telescope imaged its shadow in 2022 by linking radio telescopes '
    + 'across Earth into a single planet-sized dish — the largest virtual instrument ever built.' },
  center: { name: 'Galactic Centre', type: 'Direction to Sgr A*', ly: 26_000, blurb:
    'The brightest region of the Milky Way from inside it: billions of stars packed into '
    + 'a few light-years, plus the molecular clouds where new stars are forming right now.',
    funFact:
    'If the Sun were an average star in a city, the Galactic Centre would be the '
    + 'downtown a hundred kilometres away — except it is thirty thousand light-years wide in every direction.' },
  sun: { name: 'The Sun', type: 'Sol — our home', ly: 0, blurb:
    'A G2V star on the Orion Spur, 26,000 light-years from the Galactic Centre. The '
    + 'camera for this scene starts here.',
    funFact:
    'The Sun completes one galactic orbit in about 230 million years, having been '
    + 'born alongside roughly half the stars you can see tonight.' },
  edge: { name: 'Galactic Halo', type: 'Sparse outer region', ly: 100_000, blurb:
    'Beyond the disc lies the halo: globular clusters, dark matter, and the '
    + 'accreted remnants of galaxies the Milky Way has eaten.',
    funFact:
    'The halo is mostly invisible. Its gravity is inferred from how fast stars orbit '
    + 'where there is nothing to orbit — the first direct evidence for dark matter.' },
};

export class GalaxyScene extends SceneBase {
  constructor() {
    super({
      id: 'galaxy',
      title: 'The Milky Way',
      subtitle: 'A hundred thousand light-years',
      verb: 'Milky Way',
    });

    this.scene.background = new THREE.Color(0x04060f);
    this.scene.fog = null;

    /** @type {Map<string, THREE.Points>} */
    this.layers = new Map();
    this.warp = 0;
    this._warpTarget = 0;

    this.limits = {
      min: DISC_RADIUS_UNITS * 0.004,
      max: DISC_RADIUS_UNITS * 4.5,
      far: DISC_RADIUS_UNITS * 24,
      fov: RENDERER.fov,
    };

    // Start out on the Sun's orbit, looking inward at the bulge — the single
    // most informative framing of a galaxy.
    this.homeView = {
      focus: new THREE.Vector3(0, 0, 0),
      radius: SUN_RADIUS_UNITS * 1.05,
      theta: Math.PI * 0.5,
      // Just above the disc plane: edge-on enough to see the bulge, inclined
      // enough to see the spiral winding.
      phi: Math.PI * 0.40,
    };

    this._tmp = new THREE.Vector3();
  }

  async prepare() {
    this._buildGalaxy();
    this._buildSmbh();
    this._buildBackgroundStars();
    this._buildLandmarks();
    this.emit('prepared');
    return this;
  }

  /* ----------------------------------------------------------------- build -- */

  /**
   * Build the star cloud.
   *
   * Population split matters more than count: 70% of stars sit in the disc with
   * a roughly exponential surface density (most of them in the inner disc), and
   * the rest form the bulge and halo. Drawing uniform random radii gives a flat
   * disc that looks nothing like a real galaxy.
   */
  _buildGalaxy() {
    const count = GALAXY_UNIFORM_DEFAULTS.uCount.value;
    const geometry = new THREE.BufferGeometry();

    const seed = new Float32Array(count);
    const radius = new Float32Array(count);
    const arm = new Float32Array(count);
    const angle = new Float32Array(count);
    const height = new Float32Array(count);
    const bright = new Float32Array(count);
    const color = new Float32Array(count * 3);

    // Arm names are used only for the HUD label, but assigning real indices here
    // documents which is which: Perseus, Sagittarius, Scutum–Centaurus, Norma.
    const armCount = GALAXY_UNIFORM_DEFAULTS.uArmCount.value;

    const coreColor = new THREE.Color().fromArray(GALAXY_UNIFORM_DEFAULTS.uCoreColor.value);
    const armColor = new THREE.Color().fromArray(GALAXY_UNIFORM_DEFAULTS.uArmColor.value);
    const _c = new THREE.Color();

    for (let i = 0; i < count; i++) {
      seed[i] = i;

      const isHalo = i % 100 < 12;
      const isBulge = !isHalo && i % 100 < 30;

      if (isHalo) {
        // Halo: a sparse, roughly spherical population well beyond the disc.
        const r = DISC_RADIUS_UNITS * (1 + Math.pow(Math.random(), 0.4) * 2.2);
        radius[i] = r / DISC_RADIUS_UNITS;
        arm[i] = -1;
        angle[i] = Math.random() * TWO_PI;
        // Rayleigh-distributed thickness: a thin disc, not a thin shell.
        height[i] = gaussian() * 0.22;
        _c.copy(coreColor).lerp(new THREE.Color(0xfff0d0), 0.5);
      } else if (isBulge) {
        // Boxy/peanut bulge: flattened spheroid, thicker than the disc.
        const u = Math.random();
        const r = DISC_RADIUS_UNITS * 0.16 * Math.pow(u, 0.7);
        radius[i] = r / DISC_RADIUS_UNITS;
        arm[i] = -1;
        angle[i] = Math.random() * TWO_PI;
        height[i] = gaussian() * 0.075;
        _c.copy(coreColor);
      } else {
        // Disc population.
        // Exponential surface density, P(r) ∝ r·e^(-r/h), sampled by inverse CDF
        // over the visible disc. Rejection sampling on this form is wasteful;
        // inverting is exact and cheap.
        const u = Math.random();
        const h = 0.19;                                    // scale length
        const r = (h * 0.5) * (-Math.log(1 - u * (1 - Math.exp(-2 / h))))
          * DISC_RADIUS_UNITS;
        radius[i] = Math.min(r / DISC_RADIUS_UNITS, 1.4);

        // 78% of disc stars follow the arms; the rest fill the inter-arm space,
        // which is what keeps the arms from looking like clean paint strokes.
        if (Math.random() < 0.78) {
          arm[i] = Math.floor(Math.random() * armCount);
          // Scatter along the arm with a spread that widens outward — arms are
          // sharper near the centre and fray as they wind out.
          angle[i] = (Math.random() - 0.5) * (0.30 + radius[i] * 0.75);
        } else {
          arm[i] = -2;                                    // inter-arm
          angle[i] = Math.random() * TWO_PI;
        }
        // Vertical scale height, growing with radius (flaring disc).
        height[i] = gaussian() * (0.014 + radius[i] * 0.02);
        _c.copy(armColor).lerp(coreColor, Math.pow(1 - radius[i], 2.2) * 0.7);
      }

      // Luminosity: a steep power law, so a few stars dominate. Uniform
      // brightness is the giveaway of a particle effect.
      bright[i] = 0.16 + Math.pow(Math.random(), 3.4) * 0.84;

      // Spectral colour jitter — real scatter in the arms is wide.
      _c.offsetHSL((Math.random() - 0.5) * 0.06, (Math.random() - 0.5) * 0.18, (Math.random() - 0.5) * 0.14);
      color[i * 3] = _c.r;
      color[i * 3 + 1] = _c.g;
      color[i * 3 + 2] = _c.b;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    for (const name of GALAXY_ATTRIBUTES) {
      geometry.setAttribute(name, new THREE.BufferAttribute(
        name === 'aColor' ? color
          : name === 'aSeed' ? seed
            : name === 'aRadius' ? radius
              : name === 'aArm' ? arm
                : name === 'aAngle' ? angle
                  : name === 'aHeight' ? height
                    : bright,
        1,
      ));
    }
    // The shader computes every position from the attributes, so the vertex
    // buffer itself can stay at the origin. A generous bounding sphere is still
    // required or Three will frustum-cull the whole galaxy.
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(0, 0, 0),
      DISC_RADIUS_UNITS * 1.5,
    );

    this.uniforms = structuredClone(GALAXY_UNIFORM_DEFAULTS);
    this.uniforms.uCount.value = count;

    const material = new THREE.ShaderMaterial({
      vertexShader: GALAXY_VERTEX,
      fragmentShader: GALAXY_FRAGMENT,
      uniforms: this.uniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.galaxy = new THREE.Points(geometry, material);
    this.galaxy.renderOrder = 2;
    this.galaxy.scale.setScalar(DISC_RADIUS_UNITS);
    this.scene.add(this.galaxy);
    this.layers.set('disc', this.galaxy);
  }

  /**
   * Sagittarius A*: an accretion torus plus the event-horizon shadow.
   *
   * The shadow is a discard, not a black disc — a black disc catches the light
   * that should be lensed around it and reads as a painted hole.
   */
  _buildSmbh() {
    const size = DISC_RADIUS_UNITS * 0.055;
    const geometry = new THREE.PlaneGeometry(size, size);
    this.smbhUniforms = {
      uTime: { value: 0 },
      uIntensity: { value: 1 },
      uColor: { value: new THREE.Color(0xffb469) },
    };
    const material = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main(){
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: SMBH_FRAGMENT,
      uniforms: this.smbhUniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    this.smbh = new THREE.Mesh(geometry, material);
    this.smbh.renderOrder = 6;
    this.scene.add(this.smbh);

    this.addBody('smbh', {
      label: LANDMARKS.smbh.name,
      type: LANDMARKS.smbh.type,
      focusRadius: size,
      radius: size,
      blurb: LANDMARKS.smbh.blurb,
      funFact: LANDMARKS.smbh.funFact,
      facts: LANDMARKS.smbh,
      period: null,
      data: LANDMARKS.smbh,
      landmark: true,
    });
  }

  /**
   * Distant galaxies and foreground stars.
   *
   * These are the fixed reference frame: without them, rotating through the
   * Milky Way gives no absolute sense of turning, because the galaxy itself is
   * nearly axisymmetric.
   */
  _buildBackgroundStars() {
    const count = 9000;
    const geometry = new THREE.BufferGeometry();
    const offset = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const phase = new Float32Array(count);
    const brightness = new Float32Array(count);
    const color = new Float32Array(count * 3);

    const shell = DISC_RADIUS_UNITS * 16;
    for (let i = 0; i < count; i++) {
      // Uniform on a sphere: cos(θ) uniform beats θ uniform, which would clump
      // everything at the poles.
      const u = Math.random() * 2 - 1;
      const theta = Math.random() * TWO_PI;
      const s = Math.sqrt(1 - u * u);
      offset[i * 3] = Math.cos(theta) * s * shell;
      offset[i * 3 + 1] = u * shell;
      offset[i * 3 + 2] = Math.sin(theta) * s * shell;
      size[i] = 0.35 + Math.pow(Math.random(), 3) * 1.5;
      phase[i] = Math.random() * TWO_PI;
      brightness[i] = 0.2 + Math.pow(Math.random(), 2.6) * 0.8;

      // A few percent are obviously "galaxies": dimmer, redder, wider.
      const distant = Math.random() < 0.035;
      const c = new THREE.Color();
      if (distant) c.setHSL(0.05 + Math.random() * 0.08, 0.42, 0.42 + Math.random() * 0.2);
      else c.setHSL(0.55 + Math.random() * 0.1, 0.35, 0.72 + Math.random() * 0.25);
      color[i * 3] = c.r; color[i * 3 + 1] = c.g; color[i * 3 + 2] = c.b;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aOffset', new THREE.BufferAttribute(offset, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geometry.setAttribute('aBrightness', new THREE.BufferAttribute(brightness, 1));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(color, 3));

    this.bgUniforms = {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uSizeScale: { value: 1 },
      uParallax: { value: 0.04 },
      uWarp: { value: 0 },
      uPointSizeMax: { value: 8 },
      uTwinkle: { value: 0.35 },
    };
    const material = new THREE.ShaderMaterial({
      vertexShader: STARFIELD_VERTEX,
      fragmentShader: STARFIELD_FRAGMENT,
      uniforms: this.bgUniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.background = new THREE.Points(geometry, material);
    this.background.renderOrder = 1;
    this.scene.add(this.background);
    this.layers.set('background', this.background);
  }

  _buildLandmarks() {
    const _place = (id, ly, offsetY = 0) => {
      const lm = LANDMARKS[id];
      const r = (ly / 100_000) * DISC_RADIUS_UNITS;
      const p = new THREE.Vector3(r, offsetY, 0);
      this.addBody(id, {
        label: lm.name,
        type: lm.type,
        focusRadius: DISC_RADIUS_UNITS * 0.01,
        radius: DISC_RADIUS_UNITS * 0.01,
        blurb: lm.blurb,
        funFact: lm.funFact,
        facts: lm,
        period: null,
        data: lm,
        landmark: true,
        position: p,
      });
      return p;
    };

    // `smbh` is already registered by _buildSmbh() with the torus geometry, so
    // only its position needs setting here.
    this.bodies.get('smbh').position = new THREE.Vector3(0, 0, 0);
    _place('center', 0, DISC_RADIUS_UNITS * 0.001);
    this.sunPosition = _place('sun', 26_000, DISC_RADIUS_UNITS * 0.0016);
    _place('edge', 100_000, DISC_RADIUS_UNITS * 0.02);
  }

  /* ---------------------------------------------------------------- update -- */

  /**
   * @param {number} dt
   * @param {number} elapsed
   * @param {Object} [view]
   */
  update(dt, elapsed, view = {}) {
    // Ease toward the target so warp ramps in and out instead of snapping.
    this.warp += (this._warpTarget - this.warp) * Math.min(1, dt * 2.2);

    if (this.uniforms) {
      this.uniforms.uTime.value = elapsed;
      this.uniforms.uWarp.value = this.warp;
      this.uniforms.uPixelRatio.value = view.pixelRatio ?? 1;
      // Fade the point size down as we fly out, or 220k sprites overlap into a
      // solid sheet and bloom eats the whole frame.
      this.uniforms.uSizeScale.value = view.qualityScale ?? 1;
      this.uniforms.uStarSize.value = 1 - this.warp * 0.25;
    }
    if (this.smbhUniforms) {
      this.smbhUniforms.uTime.value = elapsed;
      // Fade the torus out at extreme distances; the shadow alone reads better
      // than a bright ring seen from far enough away to lose its shape.
      this.smbhUniforms.uIntensity.value = 1 - clamp01(this.warp * 1.2);
    }
    if (this.bgUniforms) {
      this.bgUniforms.uTime.value = elapsed;
      this.bgUniforms.uWarp.value = this.warp;
      this.bgUniforms.uPixelRatio.value = view.pixelRatio ?? 1;
    }
  }

  /* ----------------------------------------------------------------- focus -- */

  /**
   * @param {string} id
   * @returns {THREE.Vector3|null}
   */
  focus(id) {
    const body = this.bodies.get(id);
    if (!body) return null;
    this.selected = id;
    return body.position ? body.position.clone() : new THREE.Vector3(0, 0, 0);
  }

  /** @returns {string} */
  get activeId() { return this.selected ?? 'center'; }

  /**
   * @param {number} amount 0..1
   */
  setWarp(amount) {
    this._warpTarget = amount;
  }

  /**
   * Warp is exposed to the audio so the drone brightens with speed.
   * @returns {number}
   */
  get warpAmount() { return this.warp; }
}

/** Gaussian sample via Box–Muller. */
function gaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v);
}