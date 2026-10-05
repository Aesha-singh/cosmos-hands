/**
 * Scene 3 — deep universe.
 *
 * The widest scene: a 100-megaparsec box, 1.5 × 10²⁰ km across. Everything here
 * is built to convey three things that the solar-system scene cannot — that
 * space is mostly empty, that structure persists on every scale, and that the
 * light in this frame began its journey before Earth existed.
 *
 * Three layers, back to front:
 *
 *  1. **Nebula dome** — a camera-locked inverted sphere running FBM domain
 *     warping in three emission-line colours (Hα red, OIII teal, reflection
 *     blue). It never moves, because it represents emission scattered light at
 *     effectively infinite distance; making it parallax would break the cue that
 *     it is "sky" rather than "object".
 *
 *  2. **Cosmic web** — the large-scale structure of the universe. Real cosmic
 *     web simulations produce filaments and voids; the stand-in here is a
 *     Poisson-ish node field connected to its nearest neighbours, rendered as
 *     camera-facing quads so each filament keeps a constant screen width at any
 *     distance. The nodes are deliberately sparse and clumped into a few
 *     superclusters, because a uniform node lattice reads as a net, not as a
 *     universe.
 *
 *  3. **Quasar field** — the brightest points in the real deep field. Quasars
 *     are so distant that they predate most of the universe's current contents;
 *     the HUD reads out that light-travel delay, which is the single most
 *     effective way to make an abstract number feel enormous.
 *
 * @module scenes/deep-universe
 */

import * as THREE from 'three';
import { SCALE, RENDERER } from '../config.js';
import { clamp01, lerp } from '../utils/math.js';
import {
  NEBULA_VERTEX, NEBULA_FRAGMENT,
  STARFIELD_VERTEX, STARFIELD_FRAGMENT,
  SHOOTING_VERTEX, SHOOTING_FRAGMENT,
} from '../shaders/nebula.js';
import { WEB_VERTEX, WEB_FRAGMENT } from '../shaders/post.js';
import { SceneBase } from './scene-base.js';

const TWO_PI = Math.PI * 2;

/** Half-width of the cosmic-web box, in scene units (50 Mpc). */
const WEB_HALF = SCALE.MPC * 50;

/** Named deep-field objects, with lookback times in years. */
const DEEP_FIELDS = {
  andromeda: { name: 'Andromeda (M31)', type: 'Nearest large galaxy', ly: 2_537_000, redshift: 0, blurb:
    'The nearest spiral galaxy of comparable size to the Milky Way, approaching us at '
    + '110 km/s. In roughly four billion years the two will merge — that future galaxy '
    + 'is already informally called "Milkomeda".',
    funFact:
    'At 2.5 million light-years it is the most distant object most people will ever '
    + 'see with the naked eye, from a dark site with good eyes.' },
  sombrero: { name: 'Sombrero Galaxy (M104)', type: 'Lenticular galaxy', ly: 29_000_000, blurb:
    'A galaxy with a bulge far larger than its disc, seen almost exactly edge-on. Its '
    + 'famous bright band is not the disc itself but a torus of dust cutting across '
    + 'the line of sight.',
    funFact:
    'It is bright enough to show a bulge, dust lane and globular clusters through a '
    + '200 mm lens — the best "deep sky" target for a small telescope.' },
  omega: { name: 'Omega Centauri', type: 'Globular cluster', ly: 15_800, blurb:
    'Ten million stars in a ball 150 light-years across, orbiting the Milky Way as a '
    + 'single system.',
    funFact:
    'It is almost certainly the stripped core of a dwarf galaxy the Milky Way ate. '
    + 'Its stars are among the oldest known anywhere, formed before the galaxy that '
    + 'now contains them.' },
  quasar: { name: 'A Quasar', type: 'Active galactic nucleus', ly: 11_900_000_000, blurb:
    'The most luminous objects in the universe, powered by matter falling into a '
    + 'supermassive black hole and blasting it back out as light.',
    funFact:
    'The light from the most distant quasars left when the universe was under 800 '
    + 'million years old — younger than the time it took the first galaxies to form.' },
  cosmic_microwave: { name: 'The Cosmic Microwave Background', type: 'Relic radiation', ly: 45_600_000_000, blurb:
    'The afterglow of the Big Bang itself: 2.7 kelvin radiation, released 380,000 '
    + 'years after the beginning, still arriving from every direction.',
    funFact:
    'It is the oldest light it is possible to see. Every other object in this scene is '
    + 'younger than the light that would destroy your eyes if it were microwaved '
    + 'instead of visible.' },
};

export class DeepUniverseScene extends SceneBase {
  constructor() {
    super({
      id: 'deep',
      title: 'Deep Universe',
      subtitle: 'One hundred megaparsecs',
      verb: 'Deep Universe',
    });

    this.scene.background = new THREE.Color(0x02030a);
    this.warp = 0;
    this._warpTarget = 0;
    this._cameraDistance = WEB_HALF;

    this.limits = {
      min: WEB_HALF * 0.002,
      max: WEB_HALF * 12,
      // The far plane must sit comfortably *beyond* maxDistance: if it does not,
      // the camera can legally fly outside it and the scene renders empty. It
      // also has to contain the nebula dome, which sits at 200 Mpc.
      far: WEB_HALF * 26,
      fov: RENDERER.fov,
    };

    this.homeView = {
      focus: new THREE.Vector3(0, 0, 0),
      radius: WEB_HALF * 1.5,
      theta: Math.PI * 0.18,
      phi: Math.PI * 0.46,
    };

    this.showWeb = true;
  }

  async prepare() {
    this._buildNebulaDome();
    this._buildStarfield();
    this._buildCosmicWeb();
    this._buildShootingStars();
    this._buildDeepFields();
    this.emit('prepared');
    return this;
  }

  /* ----------------------------------------------------------------- build -- */

  _buildNebulaDome() {
    const geometry = new THREE.SphereGeometry(SCALE.MPC * 200, 64, 40);
    this.nebulaUniforms = {
      uTime: { value: 0 },
      uColorA: { value: new THREE.Color(0.85, 0.16, 0.30) },   // Hα
      uColorB: { value: new THREE.Color(0.10, 0.72, 0.62) },   // OIII
      uColorC: { value: new THREE.Color(0.24, 0.38, 0.85) },   // reflection
      uIntensity: { value: 0.85 },
      uScale: { value: 2.1 },
      uWarp: { value: 0 },
    };
    const material = new THREE.ShaderMaterial({
      vertexShader: NEBULA_VERTEX,
      fragmentShader: NEBULA_FRAGMENT,
      uniforms: this.nebulaUniforms,
      side: THREE.BackSide,   // we are inside the dome
      depthWrite: false,
      depthTest: false,
      transparent: true,
      blending: THREE.AdditiveBlending,
    });
    this.nebula = new THREE.Mesh(geometry, material);
    this.nebula.renderOrder = -10;
    this.nebula.frustumCulled = false;
    this.scene.add(this.nebula);
  }

  _buildStarfield() {
    const count = 24_000;
    const geometry = new THREE.BufferGeometry();
    const offset = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const phase = new Float32Array(count);
    const brightness = new Float32Array(count);
    const color = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const u = Math.random() * 2 - 1;
      const theta = Math.random() * TWO_PI;
      const s = Math.sqrt(1 - u * u);
      const r = SCALE.MPC * 60 * (0.55 + Math.random() * 0.45);
      offset[i * 3] = Math.cos(theta) * s * r;
      offset[i * 3 + 1] = u * r;
      offset[i * 3 + 2] = Math.sin(theta) * s * r;

      size[i] = 0.3 + Math.pow(Math.random(), 3.2) * 1.7;
      phase[i] = Math.random() * TWO_PI;
      brightness[i] = 0.18 + Math.pow(Math.random(), 2.8) * 0.82;

      const c = new THREE.Color();
      const hot = Math.random() < 0.06;
      if (hot) c.setHSL(0.58, 0.5, 0.86);          // blue supergiants
      else if (Math.random() < 0.08) c.setHSL(0.07, 0.55, 0.6); // red giants
      else c.setHSL(0.12, 0.08, 0.78 + Math.random() * 0.2);
      color[i * 3] = c.r; color[i * 3 + 1] = c.g; color[i * 3 + 2] = c.b;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aOffset', new THREE.BufferAttribute(offset, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geometry.setAttribute('aBrightness', new THREE.BufferAttribute(brightness, 1));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SCALE.MPC * 80);

    this.starUniforms = {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uSizeScale: { value: 1 },
      uParallax: { value: 0.1 },
      uWarp: { value: 0 },
      uPointSizeMax: { value: 9 },
      uTwinkle: { value: 0.5 },
    };
    const material = new THREE.ShaderMaterial({
      vertexShader: STARFIELD_VERTEX,
      fragmentShader: STARFIELD_FRAGMENT,
      uniforms: this.starUniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.stars = new THREE.Points(geometry, material);
    this.stars.renderOrder = -5;
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  /**
   * The cosmic web.
   *
   * Nodes are placed into a handful of superclusters, then connected to their k
   * nearest neighbours. Connecting *nearest neighbours* is the important part:
   * connecting to every node within a radius produces a uniform lattice, which
   * is visibly wrong. Real structure is filaments — short chains — separated by
   * voids.
   */
  _buildCosmicWeb() {
    const nodeCount = 420;
    const nodes = [];

    // Superclusters: each is a gaussian blob, and they are placed with enough
    // separation to leave genuine voids between them.
    const clusters = 9;
    const centres = [];
    for (let i = 0; i < clusters; i++) {
      centres.push(new THREE.Vector3(
        (Math.random() - 0.5) * WEB_HALF * 1.3,
        (Math.random() - 0.5) * WEB_HALF * 1.3,
        (Math.random() - 0.5) * WEB_HALF * 1.3,
      ));
    }

    for (let i = 0; i < nodeCount; i++) {
      const c = centres[i % clusters];
      const spread = WEB_HALF * 0.19;
      nodes.push(new THREE.Vector3(
        c.x + gaussian() * spread,
        c.y + gaussian() * spread,
        c.z + gaussian() * spread,
      ));
    }

    // Connect each node to its 3 nearest neighbours, de-duplicated.
    const seen = new Set();
    const pairs = [];
    for (let i = 0; i < nodes.length; i++) {
      const nearest = nodes
        .map((p, j) => ({ j, d: p.distanceTo(nodes[i]) }))
        .filter((e) => e.j !== i)
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
      for (const { j, d } of nearest) {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ a: nodes[i], b: nodes[j], d });
      }
    }

    const count = pairs.length;
    const geometry = new THREE.BufferGeometry();
    const position = new Float32Array(count * 4 * 3);
    const next = new Float32Array(count * 4 * 3);
    const width = new Float32Array(count * 4);
    const bright = new Float32Array(count * 4);
    const uvs = new Float32Array(count * 4 * 2);
    const index = new Uint32Array(count * 6);

    for (let i = 0; i < count; i++) {
      const { a, b, d } = pairs[i];
      // Thin, dim filaments for long links; brighter for short ones — short
      // links are the dense knots where matter is actually collapsing.
      const w = lerp(0.9, 3.4, clamp01(1 - d / (WEB_HALF * 0.55)));
      const br = lerp(0.22, 1.0, clamp01(1 - d / (WEB_HALF * 0.45)));
      for (let v = 0; v < 4; v++) {
        const p = i * 4 + v;
        position[p * 3] = a.x; position[p * 3 + 1] = a.y; position[p * 3 + 2] = a.z;
        next[p * 3] = b.x; next[p * 3 + 1] = b.y; next[p * 3 + 2] = b.z;
        width[p] = w;
        bright[p] = br;
      }
      uvs[i * 8] = 0; uvs[i * 8 + 1] = 0;
      uvs[i * 8 + 2] = 1; uvs[i * 8 + 3] = 0;
      uvs[i * 8 + 4] = 1; uvs[i * 8 + 5] = 1;
      uvs[i * 8 + 6] = 0; uvs[i * 8 + 7] = 1;
      const q = i * 4;
      index.set([q, q + 1, q + 2, q, q + 2, q + 3], i * 6);
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute('aNext', new THREE.BufferAttribute(next, 3));
    geometry.setAttribute('aWidth', new THREE.BufferAttribute(width, 1));
    geometry.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), WEB_HALF * 2);

    this.webUniforms = {
      uPixelRatio: { value: 1 },
      uResolution: { value: new THREE.Vector2(1920, 1080) },
      uColor: { value: new THREE.Color(0.42, 0.66, 1.0) },
      uOpacity: { value: 0.5 },
      uTime: { value: 0 },
    };
    const material = new THREE.ShaderMaterial({
      vertexShader: WEB_VERTEX,
      fragmentShader: WEB_FRAGMENT,
      uniforms: this.webUniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.web = new THREE.Mesh(geometry, material);
    this.web.renderOrder = -2;
    this.web.frustumCulled = false;
    this.scene.add(this.web);
    this.webNodes = nodes;
  }

  /** Meteor streaks for idle ambience; the CPU only spawns them. */
  _buildShootingStars() {
    const max = 6;
    const geometry = new THREE.BufferGeometry();
    const start = new Float32Array(max * 4 * 3);
    const velocity = new Float32Array(max * 4 * 3);
    const birth = new Float32Array(max * 4).fill(-1e9);
    const life = new Float32Array(max * 4).fill(1);
    const length = new Float32Array(max * 4).fill(1);
    const seed = new Float32Array(max * 4);
    const position = new Float32Array(max * 4 * 3);
    const index = new Uint32Array(max * 6);

    for (let i = 0; i < max; i++) {
      const q = i * 4;
      index.set([q, q + 1, q + 2, q, q + 2, q + 3], i * 6);
      for (let v = 0; v < 4; v++) seed[q + v] = Math.random();
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('aStart', new THREE.BufferAttribute(start, 3));
    geometry.setAttribute('aVelocity', new THREE.BufferAttribute(velocity, 3));
    geometry.setAttribute('aBirth', new THREE.BufferAttribute(birth, 1));
    geometry.setAttribute('aLife', new THREE.BufferAttribute(life, 1));
    geometry.setAttribute('aLength', new THREE.BufferAttribute(length, 1));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SCALE.MPC * 400);

    this.shootingUniforms = {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uColor: { value: new THREE.Color(0.85, 0.93, 1.0) },
      uIntensity: { value: 1 },
    };
    const material = new THREE.ShaderMaterial({
      vertexShader: SHOOTING_VERTEX,
      fragmentShader: SHOOTING_FRAGMENT,
      uniforms: this.shootingUniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.shooting = new THREE.Mesh(geometry, material);
    this.shooting.renderOrder = 4;
    this.shooting.frustumCulled = false;
    this.scene.add(this.shooting);
    this._shootingMax = max;
  }

  _buildDeepFields() {
    const at = (id, x, y, z) => {
      const f = DEEP_FIELDS[id];
      this.addBody(id, {
        label: f.name,
        type: f.type,
        focusRadius: WEB_HALF * 0.02,
        radius: WEB_HALF * 0.02,
        blurb: f.blurb,
        funFact: f.funFact,
        facts: f,
        period: null,
        data: f,
        landmark: true,
        // Light-travel time is the payload of this scene: the HUD renders it
        // as a date, so "11.9 billion years ago" becomes legible.
        lightYears: f.ly,
        position: new THREE.Vector3(x * WEB_HALF, y * WEB_HALF, z * WEB_HALF),
      });
    };

    at('cosmic_microwave', -0.85, 0.30, -0.60);
    at('quasar', 0.72, -0.45, 0.55);
    at('sombrero', -0.40, -0.62, 0.70);
    at('andromeda', 0.35, 0.55, 0.75);
    at('omega', 0.55, 0.15, -0.55);
  }

  /* ---------------------------------------------------------------- update -- */

  update(dt, elapsed, view = {}) {
    this.warp += (this._warpTarget - this.warp) * Math.min(1, dt * 2.2);
    this._cameraDistance = view.cameraDistance ?? this._cameraDistance;

    if (this.nebulaUniforms) {
      this.nebulaUniforms.uTime.value = elapsed;
      this.nebulaUniforms.uWarp.value = this.warp;
    }
    if (this.starUniforms) {
      this.starUniforms.uTime.value = elapsed;
      this.starUniforms.uWarp.value = this.warp;
      this.starUniforms.uPixelRatio.value = view.pixelRatio ?? 1;
      // Keep the dome and starfield centred on the camera: they are the sky.
      if (this.stars && view.cameraPosition) this.stars.position.copy(view.cameraPosition);
    }
    if (this.webUniforms) {
      this.webUniforms.uTime.value = elapsed;
      this.webUniforms.uPixelRatio.value = view.pixelRatio ?? 1;
      // Filaments: fade with distance and brighten with warp, so flying fast
      // makes the structure streak.
      this.webUniforms.uOpacity.value = this.showWeb
        ? 0.5 * (1 - this.warp * 0.35)
        : 0;
    }
    if (this.shootingUniforms) {
      this.shootingUniforms.uTime.value = elapsed;
      this.shootingUniforms.uPixelRatio.value = view.pixelRatio ?? 1;
      // Meteors during warp: the streaks are the speed cue.
      this.shootingUniforms.uIntensity.value = this.warp;
    }

    this._updateShootingStars(elapsed);
  }

  _updateShootingStars(elapsed) {
    const geo = this.shooting?.geometry;
    if (!geo) return;
    const start = geo.getAttribute('aStart');
    const velocity = geo.getAttribute('aVelocity');
    const birth = geo.getAttribute('aBirth');
    const life = geo.getAttribute('aLife');
    const length = geo.getAttribute('aLength');

    for (let s = 0; s < this._shootingMax; s++) {
      const q = s * 4;
      // Respawn on a stagger so they never all appear together.
      const cycle = 3.2 + (q % 4) * 0.9;
      const age = (elapsed + q * 1.7) % cycle;
      if (age > life[q]) continue;
      if (birth.array[q] < -1e8) {
        // Initialise this streak's ballistic parameters on first pass.
        const u = Math.random() * 2 - 1;
        const theta = Math.random() * TWO_PI;
        const sr = Math.sqrt(1 - u * u);
        const speed = SCALE.MPC * (2.2 + Math.random() * 2.6);
        const o = new THREE.Vector3(Math.cos(theta) * sr, u, Math.sin(theta) * sr)
          .multiplyScalar(SCALE.MPC * 60);
        const dir = new THREE.Vector3(
          Math.cos(theta + 0.9) * sr, u * 0.7, Math.sin(theta + 0.9) * sr,
        ).normalize().multiplyScalar(speed);
        for (let v = 0; v < 4; v++) {
          start.setXYZ(q + v, o.x, o.y, o.z);
          velocity.setXYZ(q + v, dir.x, dir.y, dir.z);
        }
        life.array[q] = 1.1 + Math.random() * 0.9;
        length.array[q] = 1;
        birth.array[q] = elapsed - age;
      }
    }
    start.needsUpdate = true;
    velocity.needsUpdate = true;
    birth.needsUpdate = true;
    life.needsUpdate = true;
    length.needsUpdate = true;
  }

  /* ----------------------------------------------------------------- focus -- */

  focus(id) {
    const body = this.bodies.get(id);
    if (!body) return null;
    this.selected = id;
    return body.position.clone();
  }

  /** @returns {string} */
  get activeId() { return this.selected ?? 'cosmic_microwave'; }

  setWebVisible(value) {
    this.showWeb = value;
    if (this.web) this.web.visible = value;
  }

  setWarp(amount) {
    this._warpTarget = amount;
  }

  /** @returns {number} */
  get warpAmount() { return this.warp; }
}

function gaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v);
}