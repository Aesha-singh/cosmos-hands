/**
 * Scene 1 — the solar system.
 *
 * Every planet's position comes from real Keplerian elements solved against the
 * simulation clock, so the configuration on screen is the actual configuration
 * for the displayed date: Mars really is where it is. That is the whole reason
 * this scene exists — a decorative orrery would not teach anything.
 *
 * Three rendering decisions carry the scene:
 *
 *  • **Logarithmic orbit lines.** Earth's orbit at 1 unit/M-km is 149.6 M-km
 *    across. Draw orbit rings as true-radius lines and Neptune's is 30× the
 *    screen; the inner system becomes a single unresolvable dot. So orbit
 *    ellipses are drawn on a radius-compressed scale (`orbitRadius`), which
 *    keeps every ring visible and evenly spaced, while the planets
 *    themselves ride the true radius. The gap between the two is disclosed in
 *    the ruler readout, never hidden.
 *
 *  • **Bodies are point-sprite-plus-mesh at two scales.** At solar-system scale
 *    Earth would be 6 pixels wide; at 10 units away it would fill the screen. Each
 *    body gets a screen-size floor so it never disappears, plus a real mesh when
 *    close enough to show detail.
 *
 *  • **One shared point light at the Sun.** Physically correct and it makes the
 *    terminator move as bodies orbit, which is the single most convincing cue
 *    that this is a simulation and not a poster.
 *
 * @module scenes/solar-system
 */

import * as THREE from 'three';
import { SCALE, RENDERER } from '../config.js';
import { PLANETS, PLANETS_BY_ORBIT, planetRadiusUnits } from '../data/planets.js';
import { MOONS, moonOrbit } from '../data/moons.js';
import { DAY, orbitStateAt, spinAngle, sampleOrbit } from '../utils/orbits.js';
import { clamp, clamp01 } from '../utils/math.js';
import { loadOrProcedural, makeStarSprite, setProceduralResolution } from '../utils/textures.js';
import { makeSurfaceTexture, makeCloudTexture, makeNightLightsTexture, makeSaturnRingTexture } from '../utils/procedural.js';
import { SUN_VERTEX, SUN_SURFACE_FRAGMENT, SUN_CORONA_FRAGMENT, SUN_UNIFORM_DEFAULTS } from '../shaders/sun.js';
import { ATMOSPHERE_VERTEX, ATMOSPHERE_FRAGMENT, ATMOSPHERE_UNIFORM_DEFAULTS, RING_VERTEX, RING_FRAGMENT } from '../shaders/atmosphere.js';
import { SceneBase } from './scene-base.js';

const TWO_PI = Math.PI * 2;

/** Atmospheric rim colours, keyed by planet. */
const ATMOSPHERES = {
  venus: 0xffd9a0, earth: 0x6fa8ff, mars: 0xd98c6a,
  jupiter: 0xffd9a8, saturn: 0xffe9b0, uranus: 0x9ff0e6, neptune: 0x7fa8ff,
};

export class SolarSystemScene extends SceneBase {
  constructor() {
    super({
      id: 'solar',
      title: 'The Solar System',
      subtitle: 'Real orbits, real dates',
      verb: 'Solar System',
    });

    this.scene.background = new THREE.Color(0x03040c);

    /**
     * @type {Map<string, {group: THREE.Group, mesh: THREE.Object3D, planet: Object, state: Object}>}
     */
    this.orbital = new Map();
    this.lights = new THREE.Group();
    this.orbitGroup = new THREE.Group();
    this.labelGroup = new THREE.Group();
    // Populated by prepare(); declared here so update() is safe before it runs.
    /** @type {Map<string, THREE.Sprite>} */
    this.labels = new Map();
    /** @type {Map<string, THREE.Group>} */
    this.moonGroups = new Map();

    this.showOrbits = true;
    this.showLabels = true;
    this.hovered = null;
    this.selected = null;

    this._clock = 0;
    this._tmpV = new THREE.Vector3();

    this.limits = {
      min: 0.02,
      max: 1.1e4,
      far: 4e5,
      fov: RENDERER.fov,
    };
    this.homeView = {
      focus: new THREE.Vector3(0, 0, 0),
      // Pulled back far enough to hold Jupiter's orbit ring comfortably.
      radius: 620,
      theta: Math.PI * 0.22,
      phi: Math.PI * 0.40,
    };

    this.scene.add(this.lights, this.orbitGroup, this.labelGroup);

    /** Quality tier, set by the app before `prepare()`; drives texture cost. */
    this._tier = 'high';
    /** Texture resolution in effect, set during `prepare()`. */
    this._texRes = 1024;

    this._buildLights();
  }

  /* ----------------------------------------------------------------- build -- */

  _buildLights() {
    const sun = PLANETS[0];
    // The point light is the only real light source; everything else is emissive
    // or lit by the ambient term.
    const point = new THREE.PointLight(
      sun.visual?.lightColor ?? 0xfff3d6,
      sun.visual?.lightIntensity ?? 3.6,
      0, // infinite range
      0, // no falloff cutoff
    );
    point.position.set(0, 0, 0);
    this.lights.add(point);
    this.sunLight = point;

    // A very dim ambient so night sides are not pure black. Pure black hides
    // the terminator entirely and flattens every sphere into a disc.
    this.lights.add(new THREE.AmbientLight(0x243056, 0.16));

    this.scene.add(new THREE.HemisphereLight(0x1a2a55, 0x0a0d1c, 0.1));
  }

  async prepare() {
    // Procedural fallbacks are generated at the tier's resolution, so dropping
    // quality on a weak GPU also cuts texture memory — not just pixel count.
    const res = setProceduralResolution(this._tier ?? 'high');
    // Publish it before anything builds: the planet helpers read `this._texRes`.
    this._texRes = res;

    // Texture assets, keyed by the file the download script provides. Anything
    // missing falls back to a procedural surface, so a partial asset set still
    // renders — a blank planet is much worse than a stylised one.
    const map = {
      mercury: '/textures/2k_mercury.jpg',
      venus: '/textures/2k_venus_surface.jpg',
      earth: '/textures/2k_earth_daymap.jpg',
      mars: '/textures/2k_mars.jpg',
      jupiter: '/textures/2k_jupiter.jpg',
      saturn: '/textures/2k_saturn.jpg',
      uranus: '/textures/2k_uranus.jpg',
      neptune: '/textures/2k_neptune.jpg',
    };
    const loaded = new Map();
    await Promise.all(Object.entries(map).map(async ([id, url]) => {
      try {
        loaded.set(id, await loadOrProcedural(url, () => makeSurfaceTexture(id, res)));
      } catch (err) {
        console.warn(`[solar] texture fallback for ${id}`, err);
        loaded.set(id, makeSurfaceTexture(id, Math.min(res, 512)));
      }
    }));

    // Optional overlays. These improve the render when present but the scene is
    // complete without them, so a failure here is logged and ignored rather than
    // aborting the build.
    const optional = {};
    await Promise.all(Object.entries({
      clouds: '/textures/2k_earth_clouds.jpg',
      night: '/textures/2k_earth_nightmap.jpg',
      rings: '/textures/2k_saturn_ring_alpha.png',
      venusAtmosphere: '/textures/2k_venus_atmosphere.jpg',
      moon: '/textures/2k_moon.jpg',
    }).map(async ([key, url]) => {
      try {
        optional[key] = await loadOrProcedural(url, () => null);
      } catch {
        console.info(`[solar] optional texture absent, using procedural: ${url}`);
      }
    }));

    this._buildSun();
    for (const planet of PLANETS_BY_ORBIT) {
      if (planet.id === 'sun') continue;
      this._buildPlanet(planet, loaded.get(planet.id), {
        clouds: optional.clouds,
        night: optional.night,
        rings: optional.rings,
      });
      this._buildOrbit(planet);
    }
    this._moonMap = optional.moon;
    this._buildMoons();
    if ((this._beltCount ?? 7000) > 0) this._buildAsteroidBelt();
    this._buildLabels();

    this.emit('prepared');
    return this;
  }

  _buildSun() {
    const sun = PLANETS[0];
    const radius = planetRadiusUnits(sun);

    const uniforms = structuredClone(SUN_UNIFORM_DEFAULTS);
    uniforms.uTime = { value: 0 };
    const surface = new THREE.ShaderMaterial({
      vertexShader: SUN_VERTEX,
      fragmentShader: SUN_SURFACE_FRAGMENT,
      uniforms,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), surface);

    // Corona: an additive, back-face-only shell. Rendering only the far side of
    // the shell means the glow always sits *behind* the photosphere, which
    // produces a halo instead of a wash over the disc.
    const coronaMat = new THREE.ShaderMaterial({
      vertexShader: SUN_VERTEX,
      fragmentShader: SUN_CORONA_FRAGMENT,
      uniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const corona = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.9, 64, 48), coronaMat);

    const group = new THREE.Group();
    group.add(mesh, corona);
    this.scene.add(group);

    const record = {
      group,
      mesh,
      planet: sun,
      uniforms,
      label: sun.name,
      type: 'Star',
      focusRadius: radius,
      // Focal distance: standing off the surface by a little over its own radius.
      radius: radius,
      blurb: sun.blurb,
      funFact: sun.funFact,
      facts: sun,
      period: sun.orbit.period,
      data: sun,
    };
    this.orbital.set('sun', record);
    this.sunMesh = mesh;
  }

  _buildPlanet(planet, texture, extras = {}) {
    const radius = planetRadiusUnits(planet);
    const group = new THREE.Group();

    // Mesh resolution scales with apparent importance, not uniformly — a
    // uniformly high-poly Jupiter is a waste when Mercury is 1 pixel.
    const segments = planet.id === 'earth' ? 96 : planet.id === 'jupiter' || planet.id === 'saturn' ? 72 : 48;
    const material = new THREE.MeshStandardMaterial({
      map: texture ?? null,
      color: planet.visual?.color ?? 0xffffff,
      roughness: 0.92,
      metalness: 0.0,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, segments, segments / 2), material);
    mesh.userData.bodyId = planet.id;
    group.add(mesh);

    // Axial tilt. Without this every planet's pole points the same way, which
    // instantly reads as fake.
    const tilt = new THREE.Group();
    tilt.rotation.z = THREE.MathUtils.degToRad(planet.obliquityDeg ?? 0);
    tilt.add(group);
    group.userData.tiltGroup = tilt;

    if (planet.id === 'earth') this._buildEarthExtras(group, radius, extras);
    if (planet.id === 'saturn') this._buildRings(group, radius, extras.rings);
    const atmosphere = this._buildAtmosphere(group, radius, planet);

    // A screen-space floor: a sprite that only shows when the mesh gets small,
    // so the planet never disappears at solar-system zoom.
    const dot = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeStarSprite(64),
      color: planet.visual?.color ?? 0xcccccc,
      transparent: true,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    }));
    dot.renderOrder = 3;
    group.add(dot);

    this.scene.add(tilt);

    const state = { meanAnomaly: planet.orbit.M0 ?? 0 };
    const record = {
      group, mesh, planet, state, atmosphere, tilt: tilt.rotation.z,
      label: planet.name,
      type: planet.type,
      focusRadius: radius,
      radius,
      blurb: planet.blurb,
      funFact: planet.funFact,
      facts: planet,
      period: planet.orbit.period,
      data: planet,
      dot,
    };
    this.orbital.set(planet.id, record);
    this.addBody(planet.id, record);
  }

  _buildEarthExtras(group, radius, extras = {}) {
    // Cloud shell at 1.012× — a hair larger than the surface, or z-fighting
    // makes the clouds strobe as the camera moves.
    const clouds = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.012, 72, 48),
      new THREE.MeshStandardMaterial({
        map: extras.clouds ?? makeCloudTexture(this._texRes ?? 1024),
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
      }),
    );
    clouds.userData.isClouds = true;
    group.add(clouds);
    this.earthClouds = clouds;

    // Night-side city lights. Blending over the lit side would wash it out, so
    // these ride slightly above and are only visible where the sun is behind.
    const lights = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.006, 64, 40),
      new THREE.MeshBasicMaterial({
        map: extras.night ?? makeNightLightsTexture(this._texRes ?? 1024),
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    group.add(lights);
    this.earthLights = lights;

    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.045, 72, 48),
      new THREE.ShaderMaterial({
        vertexShader: ATMOSPHERE_VERTEX,
        fragmentShader: ATMOSPHERE_FRAGMENT,
        uniforms: {
          ...structuredClone(ATMOSPHERE_UNIFORM_DEFAULTS),
          uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
          uAtmosphereColor: { value: new THREE.Color(ATMOSPHERES.earth) },
        },
        transparent: true,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    group.add(glow);
    this.earthAtmosphere = glow;
  }

  _buildAtmosphere(group, radius, planet) {
    const color = ATMOSPHERES[planet.id];
    if (!color) return null;
    const mat = new THREE.ShaderMaterial({
      vertexShader: ATMOSPHERE_VERTEX,
      fragmentShader: ATMOSPHERE_FRAGMENT,
      uniforms: {
        ...structuredClone(ATMOSPHERE_UNIFORM_DEFAULTS),
        uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
        uAtmosphereColor: { value: new THREE.Color(color) },
      },
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.06, 48, 32), mat);
    group.add(mesh);
    return mesh;
  }

  /**
   * Saturn's rings, with a real radial density profile.
   *
   * The gap is the point: Cassini's division is what makes the rings readable as
   * structure rather than a flat disc.
   */
  _buildRings(group, radius, ringAlpha = null) {
    const inner = radius * 1.24;
    const outer = radius * 2.35;
    const geometry = new THREE.RingGeometry(inner, outer, 256, 1);
    const mat = new THREE.ShaderMaterial({
      vertexShader: RING_VERTEX,
      fragmentShader: RING_FRAGMENT,
      uniforms: {
        ...structuredClone(ATMOSPHERE_UNIFORM_DEFAULTS),
        uRingTexture: { value: ringAlpha ?? makeSaturnRingTexture(this._texRes ?? 1024) },
        uInnerRadius: { value: inner },
        uOuterRadius: { value: outer },
        uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const rings = new THREE.Mesh(geometry, mat);
    rings.rotation.x = Math.PI / 2 - THREE.MathUtils.degToRad(23.4);
    group.add(rings);
    this.saturnRings = rings;
  }

  /**
   * Orbit ellipse on the compressed radius scale.
   *
   * The vertices use the *true* eccentricity and inclination — only the
   * semi-major axis is remapped. That keeps each orbit's shape and orientation
   * accurate while making the spacing legible.
   */
  _buildOrbit(planet) {
    const el = planet.orbit;
    if (!el?.a) return;
    const display = this._displayRadius(el.a);
    const points = sampleOrbit({ ...el, a: display }, 256);
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({
      color: planet.visual?.color ?? 0x5566aa,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    }));
    line.userData.orbitFor = planet.id;
    this.orbitGroup.add(line);
  }

  /**
   * Compress orbital radii logarithmically.
   *
   * `log` keeps 0.39 AU (Mercury) and 30 AU (Neptune) both on screen with even
   * visual spacing; linear would bury everything inside Jupiter.
   *
   * @param {number} a True semi-major axis in scene units.
   * @returns {number} Display radius in scene units.
   */
  _displayRadius(a) {
    const min = 4.8;
    const max = 430;
    const au = a / SCALE.AU;
    const auMin = 0.30;
    const auMax = 32;
    const t = clamp01(Math.log(Math.max(au, auMin) / auMin) / Math.log(auMax / auMin));
    return min + t * (max - min);
  }

  _buildMoons() {
    /** @type {Map<string, THREE.Group>} */
    this.moonGroups = new Map();
    for (const moon of MOONS) {
      const parent = this.orbital.get(moon.parent);
      if (!parent) continue;

      const radius = moon.radiusKm / SCALE.UNIT_KM;
      // Luna is the one moon with a real map in the texture set; the rest are
      // procedural, which is a fair representation — the Galilean moons and
      // Titan are much smoother and darker than their recipe keys suggest.
      const proceduralKey = moon.proceduralKeys?.[0] ?? 'rocky';
      const map = moon.id === 'moon' && this._moonMap
        ? this._moonMap
        : makeSurfaceTexture(proceduralKey, 256);
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 24, 16),
        new THREE.MeshStandardMaterial({
          map,
          color: moon.visualColor ?? 0xbbbbbb,
          roughness: 0.95,
        }),
      );
      mesh.userData.bodyId = moon.id;

      const pivot = new THREE.Group();
      pivot.add(mesh);
      parent.group.add(pivot);

      this.moonGroups.set(moon.id, pivot);
      this.addBody(moon.id, {
        mesh,
        moon,
        label: moon.name,
        type: moon.type ?? 'Moon',
        focusRadius: radius,
        radius,
        blurb: moon.blurb,
        funFact: moon.funFact,
        facts: moon,
        period: Math.abs(moon.periodDays) * DAY,
        data: moon,
      });
    }
  }

  /**
   * The main asteroid belt, as a single points cloud.
   *
   * One draw call for ~7000 rocks. Individual meshes would be 7000 draw calls
   * for something that reads as a texture of dust at any real zoom.
   */
  _buildAsteroidBelt() {
    const count = this._beltCount ?? 7000;
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const colors = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      // Rejection-free scatter: uniform in area gives a visibly denser centre,
      // so instead sample `sqrt(u)` for uniform areal density, then apply the
      // belt's own central concentration with a second bias.
      const u = Math.random();
      const au = 2.15 + Math.pow(u, 0.72) * 0.85;
      const ecc = (Math.random() - 0.5) * 0.22;
      const theta = Math.random() * TWO_PI;
      const r = SCALE.AU * au * (1 + ecc);
      const y = (Math.random() - 0.5) * SCALE.AU * 0.08;
      positions[i * 3] = Math.cos(theta) * r;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = Math.sin(theta) * r;
      sizes[i] = 0.4 + Math.random() * 0.9;

      // Slight colour spread from grey to dull red, matching real taxonomic mix.
      const warm = Math.random();
      colors[i * 3] = 0.42 + warm * 0.22;
      colors[i * 3 + 1] = 0.40 + warm * 0.12;
      colors[i * 3 + 2] = 0.38 + warm * 0.04;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const belt = new THREE.Points(geometry, new THREE.PointsMaterial({
      size: 0.55,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    }));
    // Same compression as the orbit rings, so the belt sits between Mars and
    // Jupiter on screen rather than at 2.1 AU true.
    const beltAu = 2.6;
    belt.scale.setScalar(this._displayRadius(SCALE.AU * beltAu) / (SCALE.AU * beltAu));
    this.scene.add(belt);
    this.asteroidBelt = belt;
  }

  _buildLabels() {
    for (const [id, body] of this.orbital) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeStarSprite(32),
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthTest: false,
      }));
      sprite.renderOrder = 10;
      sprite.userData.labelFor = id;
      this.labelGroup.add(sprite);
      this.labels.set(id, sprite);
      body.labelSprite = sprite;
    }
  }

  /* ---------------------------------------------------------------- update -- */

  /**
   * @param {number} dt Real seconds.
   * @param {number} elapsed Simulated seconds since J2000.
   * @param {Object} [view] Camera state, for size-aware behaviour.
   */
  update(dt, elapsed, view = {}) {
    this._clock = elapsed;

    if (this.sunMesh) {
      // The Sun rotates once every ~25.4 days at the equator.
      this.sunMesh.rotation.y = spinAngle({ rotationPeriod: 25.38 * DAY }, elapsed) % TWO_PI;
    }

    for (const [id, record] of this.orbital) {
      if (id === 'sun') continue;
      const { planet, state } = record;
      const orbit = orbitStateAt(planet.orbit, elapsed);
      state.x = orbit.x;
      state.y = orbit.y;
      state.z = orbit.z;

      // The mesh rides the *display* radius so bodies stay spread out, but its
      // direction from the Sun is the true one. So the planet is correct in
      // direction and phase at all times.
      const dirLen = Math.hypot(orbit.x, orbit.y, orbit.z) || 1;
      const display = this._displayRadius(dirLen);
      record.group.position.set(
        (orbit.x / dirLen) * display,
        (orbit.y / dirLen) * display,
        (orbit.z / dirLen) * display,
      );

      // Rotation: sidereal period, falling back to a plausible value when a
      // body is tidally locked or has no measured period.
      if (record.mesh) {
        // `spinAngle` wants a rotation period in seconds; planets store days.
        record.mesh.rotation.y = (spinAngle(
          { rotationPeriod: (planet.dayHours ?? 24) * 3600 },
          elapsed,
        ) % TWO_PI);
      }

      this._updateAtmosphere(record, view);
      this._updateMoonsFor(record, elapsed);
      this._updateSizeFloor(record, view);
    }

    this._updateLabels(view);
  }

  _updateAtmosphere(record, view) {
    for (const shell of [record.atmosphere, this.earthAtmosphere]) {
      if (!shell) continue;
      const sunDir = this._tmpV.set(-record.group.position.x, -record.group.position.y, -record.group.position.z).normalize();
      shell.material.uniforms?.uSunDirection?.value.copy(sunDir);
    }
    void view;
  }

  _updateMoonsFor(record, elapsed) {
    for (const moon of MOONS) {
      if (moon.parent !== record.planet.id) continue;
      const pivot = this.moonGroups.get(moon.id);
      if (!pivot) continue;
      const orbit = moonOrbit(moon);
      const state = orbitStateAt(orbit, elapsed);
      pivot.position.set(state.x, state.y, state.z);
      const mesh = pivot.children[0];
      // Moons are tidally locked, so the spin faces the planet rather than the
      // star — pass the orbital period as the rotation period.
      if (mesh) mesh.rotation.y = (spinAngle({ rotationPeriod: orbit.period }, elapsed) % TWO_PI);
    }
  }

  /**
   * Keep bodies from vanishing when the mesh is sub-pixel.
   *
   * The dot's opacity ramps up as the mesh shrinks, and its world size is
   * recomputed each frame to hold a roughly constant pixel size. A fixed-size
   * sprite would need a per-frame distance calculation; doing it in the shader
   * via `sizeAttenuation: false` is cheaper, but then the dot never scales with
   * zoom and looks stuck, so the scale is set explicitly here instead.
   */
  _updateSizeFloor(record, view) {
    if (!record.dot) return;
    const distance = view.cameraDistance ?? 600;
    const apparent = record.radius / Math.max(distance, 1e-4);
    // Target: never smaller than ~2.5 px of a 1080p frame.
    const minApparent = 2.5 / 1080 * (view.fov ?? 52) * Math.PI / 180;
    const opacity = clamp01((minApparent * 3.4 - apparent) / (minApparent * 2.2));
    record.dot.material.opacity = opacity * 0.95;
    const want = distance * minApparent * 3.6;
    record.dot.scale.setScalar(Math.max(want, record.radius * 1.6));
  }

  _updateLabels(view) {
    const cameraDistance = view.cameraDistance ?? 600;
    const visible = this.showLabels && cameraDistance < 900;
    for (const [id, sprite] of this.labels) {
      const body = this.orbital.get(id);
      if (!body) continue;
      // Labels ride their body, at a size-independent offset so they do not
      // overlap the sphere at close range.
      const offset = Math.max(body.radius * 1.5, cameraDistance * 0.018);
      sprite.position.copy(body.group.position).add({ x: 0, y: offset, z: 0 });
      const want = clamp(cameraDistance * 0.012, 0.02, 4);
      sprite.scale.setScalar(want);
      const emphasised = id === this.selected || id === this.hovered;
      const target = visible ? (emphasised ? 1 : 0.55) : 0;
      sprite.material.opacity += (target - sprite.material.opacity) * 0.12;
    }
  }

  /* ----------------------------------------------------------------- focus -- */

  /**
   * @param {string} id
   * @returns {THREE.Vector3|null}
   */
  focus(id) {
    if (id === 'sun') {
      this.selected = 'sun';
      return new THREE.Vector3(0, 0, 0);
    }
    const record = this.orbital.get(id);
    if (record) {
      this.selected = id;
      // Focus on the body's current position, not a fixed origin — otherwise
      // flying to Jupiter leaves the camera pointed at where it used to be.
      return record.group.position.clone();
    }
    // A moon: focus follows the planet, which is where the moon is.
    const moon = MOONS.find((m) => m.id === id);
    if (moon) {
      const parent = this.orbital.get(moon.parent);
      if (parent) {
        this.selected = id;
        return parent.group.position.clone();
      }
    }
    return null;
  }

  /** @returns {string} */
  get activeId() { return this.selected ?? 'sun'; }

  /* ------------------------------------------------------------------ misc -- */

  setOrbitsVisible(value) {
    this.showOrbits = value;
    this.orbitGroup.visible = value;
    if (this.asteroidBelt) this.asteroidBelt.visible = value;
  }

  setLabelsVisible(value) {
    this.showLabels = value;
  }

  /**
   * Raycast against body meshes.
   * @param {THREE.Raycaster} raycaster
   * @returns {string|null}
   */
  pick(raycaster) {
    const targets = [];
    for (const [id, record] of this.orbital) {
      if (id === 'sun') continue;
      targets.push(record.mesh);
    }
    const hits = raycaster.intersectObjects(targets, false);
    return hits.length ? hits[0].object.userData.bodyId ?? null : null;
  }

  /**
   * Sunlight intensity at a camera position, for the audio's proximity ramp.
   * @param {THREE.Vector3} position
   * @returns {number} 0..1
   */
  sunProximity(position) {
    const d = position.length();
    return clamp01(1 - d / SCALE.AU * 6);
  }
}

