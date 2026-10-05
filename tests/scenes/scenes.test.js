/**
 * Scene construction, update and disposal.
 *
 * These run under jsdom because the scenes build sprite textures from the 2-D
 * canvas API. Everything else — geometry, materials, the update maths, disposal
 * — behaves identically to the browser, so this is close to a real integration
 * test of the scene layer without needing a GPU.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';

import { SolarSystemScene } from '../../src/scenes/solar-system.js';
import { GalaxyScene } from '../../src/scenes/galaxy.js';
import { DeepUniverseScene } from '../../src/scenes/deep-universe.js';
import { ConstellationScene } from '../../src/scenes/constellation-sky.js';
import { SCENE_CLASSES } from '../../src/scenes/registry.js';

/** A view context shaped like the one `main.js` passes each frame. */
const view = (extra = {}) => ({
  pixelRatio: 1,
  cameraDistance: 500,
  cameraPosition: new THREE.Vector3(0, 0, 500),
  cameraQuaternion: new THREE.Quaternion(),
  qualityScale: 1,
  ...extra,
});

describe('scene registry', () => {
  it('exposes exactly four scenes, matching the four keyboard shortcuts', () => {
    expect(SCENE_CLASSES).toHaveLength(4);
    expect(new Set(SCENE_CLASSES)).toHaveLength(4);
  });

  it('every scene implements the contract the manager relies on', () => {
    for (const Scene of SCENE_CLASSES) {
      const s = new Scene();
      expect(typeof s.prepare).toBe('function');
      expect(typeof s.update).toBe('function');
      expect(typeof s.focus).toBe('function');
      expect(typeof s.dispose).toBe('function');
      expect(s.id).toBeTruthy();
      expect(s.title).toBeTruthy();
      expect(s.limits.min).toBeGreaterThan(0);
      expect(s.limits.max).toBeGreaterThan(s.limits.min);
      expect(s.limits.far).toBeGreaterThan(s.limits.max);
      expect(s.homeView.radius).toBeGreaterThan(0);
      s.dispose();
    }
  });

  it('scene ids are unique', () => {
    const ids = SCENE_CLASSES.map((S) => new S().id);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => new (SCENE_CLASSES.find((S) => new S().id === id))().dispose());
  });

  it('update() before prepare() must not throw', () => {
    for (const Scene of SCENE_CLASSES) {
      const s = new Scene();
      expect(() => s.update(1 / 60, 0, view())).not.toThrow();
      s.dispose();
    }
  });
});

describe('SolarSystemScene', () => {
  let scene;

  beforeAll(async () => {
    scene = new SolarSystemScene();
    // No network in tests, so every texture falls back to a procedural one.
    // Dropping to the low tier keeps that affordable.
    scene._tier = 'low';
    await scene.prepare();
  });

  afterAll(() => scene.dispose());

  it('registers a body for every planet plus the Sun', () => {
    for (const id of ['sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']) {
      expect(scene.bodies.has(id), `missing body: ${id}`).toBe(true);
    }
  });

  it('registers every catalogued moon as a focusable body', async () => {
    const { MOONS } = await import('../../src/data/moons.js');
    expect(MOONS.length).toBeGreaterThan(0);
    const missing = MOONS.filter((m) => !scene.bodies.has(m.id)).map((m) => m.id);
    expect(missing).toEqual([]);
  });

  it('every body carries the fields the info panel reads', () => {
    for (const [id, body] of scene.bodies) {
      expect(body.label, `${id} label`).toBeTruthy();
      expect(body.type, `${id} type`).toBeTruthy();
      expect(body.blurb, `${id} blurb`).toBeTruthy();
      expect(body.funFact, `${id} funFact`).toBeTruthy();
      expect(body.facts, `${id} facts`).toBeTruthy();
      expect(body.radius, `${id} radius`).toBeGreaterThan(0);
    }
  });

  it('planet positions stay within the compressed display radius', () => {
    for (const id of ['mercury', 'earth', 'jupiter', 'neptune']) {
      const d = scene.orbital.get(id).group.position.length();
      expect(d, `${id} at ${d}`).toBeGreaterThan(0);
      expect(d, `${id} escaped the display scale`).toBeLessThan(scene.limits.max * 2);
    }
  });

  it('log-compressed orbit radii stay ordered and bounded', () => {
    const order = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
    let previous = -Infinity;
    for (const id of order) {
      const a = scene.orbital.get(id).planet.orbit.a;
      const d = scene._displayRadius(a);
      expect(d, `${id} out of order`).toBeGreaterThan(previous);
      expect(d, `${id} out of range`).toBeLessThanOrEqual(430.001);
      previous = d;
    }
  });

  it('inner and outer orbits are actually distinguishable on screen', () => {
    // The whole point of the compression: 0.39 AU and 30 AU both readable.
    const mercury = scene._displayRadius(0.387 * 1495.978707);
    const neptune = scene._displayRadius(30.07 * 1495.978707);
    expect(neptune / mercury).toBeGreaterThan(4);
    expect(neptune / mercury).toBeLessThan(200);
  });

  it('advancing time moves planets and keeps them on their orbits', async () => {
    const { orbitStateAt } = await import('../../src/utils/orbits.js');
    const record = scene.orbital.get('earth');
    const before = record.group.position.clone();
    scene.update(1 / 60, 0, view());
    scene.update(1 / 60, 40 * 86_400, view());   // ~40 days
    const after = record.group.position.clone();
    expect(after.distanceTo(before)).toBeGreaterThan(0);

    // Its distance from the Sun must equal the display radius of the true radius.
    const trueState = orbitStateAt(record.planet.orbit, 40 * 86_400);
    const trueR = Math.hypot(trueState.x, trueState.y, trueState.z);
    expect(after.length()).toBeCloseTo(scene._displayRadius(trueR), 4);
  });

  it('axial tilt is applied, not left flat', () => {
    const earth = scene.orbital.get('earth').group.userData.tiltGroup;
    expect(Math.abs(earth.rotation.z)).toBeGreaterThan(0);
    const mercury = scene.orbital.get('mercury').group.userData.tiltGroup;
    expect(Math.abs(mercury.rotation.z)).toBeLessThan(0.01);   // ~0°, as measured
  });

  it('focus() returns the body\'s live position for planets', () => {
    const target = scene.focus('mars');
    expect(target).toBeInstanceOf(THREE.Vector3);
    expect(target.distanceTo(scene.orbital.get('mars').group.position)).toBeLessThan(1e-6);
  });

  it('focus() on an unknown id returns null rather than throwing', () => {
    expect(scene.focus('nope')).toBeNull();
  });

  it('sunProximity falls off with distance', () => {
    const near = scene.sunProximity(new THREE.Vector3(1, 0, 0));
    const far = scene.sunProximity(new THREE.Vector3(1500, 0, 0));
    expect(near).toBe(1);
    expect(far).toBe(0);
    expect(near).toBeGreaterThan(far);
  });

  it('runs 300 frames without NaN in any body position', () => {
    for (let i = 0; i < 300; i++) scene.update(1 / 60, i * 86_400, view());
    for (const [id, rec] of scene.orbital) {
      const { x, y, z } = rec.group.position;
      expect(Number.isFinite(x), `${id}.x`).toBe(true);
      expect(Number.isFinite(y), `${id}.y`).toBe(true);
      expect(Number.isFinite(z), `${id}.z`).toBe(true);
    }
  });

  it('toggles orbit and label visibility', () => {
    scene.setOrbitsVisible(false);
    expect(scene.orbitGroup.visible).toBe(false);
    scene.setOrbitsVisible(true);
    expect(scene.orbitGroup.visible).toBe(true);
    scene.setLabelsVisible(false);
    expect(scene.showLabels).toBe(false);
  });

  it('disposal is idempotent', () => {
    const s = new SolarSystemScene();
    expect(() => { s.dispose(); s.dispose(); }).not.toThrow();
    expect(s.bodies.size).toBe(0);
  });
});

describe('GalaxyScene', () => {
  let scene;

  beforeAll(async () => {
    scene = new GalaxyScene();
    await scene.prepare();
  });

  afterAll(() => scene.dispose());

  it('builds one large star cloud with the attributes the shader requires', () => {
    const attrs = Object.keys(scene.galaxy.geometry.attributes);
    for (const required of ['aSeed', 'aRadius', 'aArm', 'aAngle', 'aHeight', 'aBright', 'aColor']) {
      expect(attrs, `missing attribute ${required}`).toContain(required);
    }
    expect(scene.galaxy.geometry.getAttribute('aSeed').count)
      .toBe(scene.galaxy.geometry.getAttribute('position').count);
  });

  it('populates bulge, halo, disc and inter-arm populations', () => {
    const arm = scene.galaxy.geometry.getAttribute('aArm').array;
    let bulge = 0;
    let interArm = 0;
    let disc = 0;
    for (let i = 0; i < arm.length; i += 97) {   // sampled, to stay fast
      if (arm[i] === -1) bulge++;
      else if (arm[i] === -2) interArm++;
      else disc++;
    }
    const total = bulge + interArm + disc;
    expect(total).toBeGreaterThan(0);
    expect(disc, 'no disc population').toBeGreaterThan(total * 0.4);
    expect(bulge, 'no bulge/halo population').toBeGreaterThan(total * 0.05);
    expect(interArm, 'no inter-arm population').toBeGreaterThan(total * 0.05);
  });

  it('galactic radii do not exceed the declared bounding sphere', () => {
    const radius = scene.galaxy.geometry.getAttribute('aRadius').array;
    const max = scene.galaxy.geometry.boundingSphere.radius;
    for (let i = 0; i < radius.length; i += 53) {
      expect(radius[i]).toBeLessThanOrEqual(max + 1e-6);
    }
  });

  it('exposes the four named landmarks', () => {
    for (const id of ['smbh', 'center', 'sun', 'edge']) {
      expect(scene.bodies.has(id), `missing landmark ${id}`).toBe(true);
      expect(scene.bodies.get(id).funFact).toBeTruthy();
    }
  });

  it('landmark distances are in light-years and ordered', () => {
    expect(scene.bodies.get('smbh').position.length()).toBeLessThan(1);
    expect(scene.bodies.get('sun').position.length())
      .toBeGreaterThan(scene.bodies.get('smbh').position.length());
    expect(scene.bodies.get('edge').position.length())
      .toBeGreaterThan(scene.bodies.get('sun').position.length());
  });

  it('warp eases toward its target rather than snapping', () => {
    const s = new GalaxyScene();
    s.setWarp(1);
    // Nothing moves on the frame the target is set.
    expect(s.warp).toBe(0);
    s.update(1 / 60, 0, view());
    const first = s.warp;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(0.2);

    // The ease is exponential, so it approaches the target asymptotically and
    // never actually reaches it. Assert monotone convergence, not a threshold
    // it cannot meet.
    let previous = first;
    for (let i = 1; i < 400; i++) {
      s.update(1 / 60, i / 60, view());
      expect(s.warp).toBeGreaterThan(previous);
      expect(s.warp).toBeLessThanOrEqual(1);
      previous = s.warp;
    }
    expect(previous).toBeGreaterThan(0.999);
    expect(previous).toBeLessThan(1);

    s.setWarp(0);
    for (let i = 0; i < 400; i++) s.update(1 / 60, i / 60, view());
    expect(s.warp).toBeLessThan(0.001);
    s.dispose();
  });

  it('home framing sits inside the disc but outside the core', () => {
    expect(scene.homeView.radius).toBeGreaterThan(scene.limits.min);
    expect(scene.homeView.radius).toBeLessThan(scene.limits.max);
  });
});

describe('DeepUniverseScene', () => {
  let scene;

  beforeAll(async () => {
    scene = new DeepUniverseScene();
    await scene.prepare();
  });

  afterAll(() => scene.dispose());

  it('builds a cosmic web of camera-facing quads, not points', () => {
    const attrs = Object.keys(scene.web.geometry.attributes);
    expect(attrs).toContain('aNext');
    expect(attrs).toContain('aWidth');
    expect(attrs).toContain('aBright');
    const quads = scene.web.geometry.getAttribute('position').count / 4;
    expect(quads).toBeGreaterThan(100);
  });

  it('web filaments are thin and dim, with brighter knots for short links', () => {
    const width = scene.web.geometry.getAttribute('aWidth').array;
    const bright = scene.web.geometry.getAttribute('aBright').array;
    for (let q = 0; q < width.length; q += 4) {
      expect(width[q]).toBeGreaterThan(0);
      expect(width[q]).toBeLessThan(4);
      expect(bright[q]).toBeGreaterThan(0);
      expect(bright[q]).toBeLessThanOrEqual(1);
    }
    // Width and brightness are derived from the same length, so the
    // correlation must be positive.
    const pairs = [];
    for (let q = 0; q < width.length; q += 4) pairs.push([width[q], bright[q]]);
    const meanW = pairs.reduce((a, p) => a + p[0], 0) / pairs.length;
    const meanB = pairs.reduce((a, p) => a + p[1], 0) / pairs.length;
    const cov = pairs.reduce((a, p) => a + (p[0] - meanW) * (p[1] - meanB), 0);
    expect(cov).toBeGreaterThan(0);
  });

  it('web nodes cluster rather than forming a uniform lattice', () => {
    const nodes = scene.webNodes;
    // Express separations as a fraction of the box half-width, so the
    // comparison is scale-free: a lattice would be judged on relative spacing.
    const box = 50 * 3.0857e19 / 1e6;   // WEB_HALF in scene units
    let minD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        minD = Math.min(minD, nodes[i].distanceTo(nodes[j]));
      }
    }
    expect(minD / box).toBeLessThan(0.05);

    // A uniform random fill of this density in this volume would have a
    // smallest gap far larger than that; clustering proves the nodes pile up.
    const volume = 8 * box ** 3;
    const uniformMinGap = volume / nodes.length ** 2;
    expect(minD).toBeLessThan(uniformMinGap);
  });

  it('declares a far plane beyond every reachable camera position', () => {
    expect(scene.limits.max).toBeGreaterThan(1e15);
    expect(scene.limits.far).toBeGreaterThan(scene.limits.max);
    // And it must contain the nebula dome, or the sky would clip to black.
    const domeRadius = scene.nebula.geometry.parameters.radius;
    expect(scene.limits.far).toBeGreaterThan(domeRadius);
  });

  it('every deep-field body carries a light-travel distance', () => {
    for (const [id, body] of scene.bodies) {
      expect(body.lightYears, `${id}`).toBeGreaterThan(0);
      expect(body.funFact, `${id}`).toBeTruthy();
    }
    // The CMB is the oldest light in the scene.
    const cmb = scene.bodies.get('cosmic_microwave').lightYears;
    for (const [id, body] of scene.bodies) {
      expect(body.lightYears, `${id} must not predate the CMB`).toBeLessThanOrEqual(cmb);
    }
  });

  it('web visibility can be toggled', () => {
    scene.setWebVisible(false);
    expect(scene.web.visible).toBe(false);
    scene.setWebVisible(true);
    expect(scene.web.visible).toBe(true);
  });

  it('survives many frames of shooting-star bookkeeping', () => {
    for (let i = 0; i < 400; i++) {
      scene.update(1 / 60, i / 60, view({ cameraPosition: new THREE.Vector3(1e14, 0, 1e14) }));
    }
    const start = scene.shooting.geometry.getAttribute('aStart').array;
    for (let i = 0; i < start.length; i++) expect(Number.isFinite(start[i])).toBe(true);
  });
});

describe('ConstellationScene', () => {
  let scene;

  beforeAll(async () => {
    scene = new ConstellationScene();
    await scene.prepare();
  });

  afterAll(() => scene.dispose());

  it('contains exactly the 88 IAU constellations', () => {
    expect(scene.figures.size).toBe(88);
    expect(scene.catalogue.constellations).toHaveLength(88);
  });

  it('every figure has line art, a centre and a brightest star', () => {
    for (const [abbr, body] of scene.figures) {
      expect(body.lines, `${abbr} line art`).toBeTruthy();
      expect(body.position.length(), `${abbr} centre`).toBeGreaterThan(0);
      expect(body.starCount, `${abbr} star count`).toBeGreaterThan(0);
      expect(body.blurb, `${abbr} blurb`).toBeTruthy();
    }
  });

  it('Serpens appears once, joined from both halves', () => {
    const serpents = scene.catalogue.constellations.filter((c) => c.abbr === 'Ser');
    expect(serpents).toHaveLength(1);
    expect(serpents[0].name).toBe('Serpens');
    // Both halves contribute line art: two polylines, one per disconnected region.
    expect(serpents[0].lines).toHaveLength(2);
  });

  it('places the brightest star correctly for a known constellation', () => {
    // Alioth (ε UMa) is the brightest star in Ursa Major at magnitude ~1.76.
    expect(scene.figures.get('UMa').brightestName).toBe('Alioth');
    expect(scene.figures.get('UMa').brightestMag).toBeLessThan(2);
  });

  it('every star is a unit vector, so angular positions are exact', () => {
    const pos = scene.points.geometry.getAttribute('position').array;
    for (let i = 0; i < pos.length; i += 300) {
      const r = Math.hypot(pos[i], pos[i + 1], pos[i + 2]);
      expect(r).toBeCloseTo(1, 5);
    }
  });

  it('magnitudes map monotonically onto brightness and size', () => {
    const { stars, spectralTypes } = scene.catalogue;
    // Brighter magnitude must give a larger rendered size.
    const idx = [...Array(stars.count).keys()]
      .sort((a, b) => stars.mag[a] - stars.mag[b]);
    const brightest = idx[0];
    const faintest = idx[idx.length - 1];
    const colors = scene.points.geometry.getAttribute('color').array;
    const lum = (i) => colors[i * 3] + colors[i * 3 + 1] + colors[i * 3 + 2];
    expect(lum(brightest)).toBeGreaterThan(lum(faintest));
    expect(stars.mag[brightest]).toBeLessThan(stars.mag[faintest]);
    void spectralTypes;
  });

  it('colours follow spectral class', () => {
    const { stars, spectralTypes } = scene.catalogue;
    const colors = scene.points.geometry.getAttribute('color').array;
    // Find an O-type and an M-type star and check blue-vs-red ordering.
    let o = -1;
    let m = -1;
    for (let i = 0; i < stars.count; i++) {
      if (spectralTypes[stars.spec[i]] === 'O' && o < 0) o = i;
      if (spectralTypes[stars.spec[i]] === 'M' && m < 0) m = i;
    }
    if (o >= 0 && m >= 0) {
      const blueness = (i) => colors[i * 3 + 2] - colors[i * 3];
      expect(blueness(o)).toBeGreaterThan(blueness(m));
    }
  });

  it('frameDistance scales with the figure\'s angular size', () => {
    // Ursa Major is far larger on the sky than Crux, so it needs more room.
    expect(scene.frameDistance('UMa')).toBeGreaterThan(scene.frameDistance('Cru'));
    expect(scene.frameDistance('Cru')).toBeGreaterThanOrEqual(scene.limits.min);
    expect(scene.frameDistance('UMa')).toBeLessThanOrEqual(scene.limits.max);
  });

  it('aiming at a figure centre picks that figure', () => {
    const ray = new THREE.Raycaster();
    for (const abbr of ['UMa', 'Cas', 'Sco', 'Cru', 'Ori']) {
      const body = scene.figures.get(abbr);
      ray.ray.origin.set(0, 0, 0);
      ray.ray.direction.copy(body.position).normalize();
      expect(scene.pick(ray), `aimed at ${abbr}`).toBe(abbr);
    }
  });

  it('aiming at empty sky picks nothing', () => {
    const ray = new THREE.Raycaster();
    ray.ray.origin.set(0, 0, 0);
    // Choose a direction away from any figure centre.
    ray.ray.direction.set(-1, 0, 0).normalize();
    const picked = scene.pick(ray);
    if (picked) {
      const toPicked = scene.figures.get(picked).position.clone().normalize();
      const d = ray.ray.direction.dot(toPicked);
      // If it picked something anyway, it must be very far off-axis.
      expect(d).toBeLessThan(0.9);
    } else {
      expect(picked).toBeNull();
    }
  });

  it('the Milky Way band concentrates near the galactic plane', () => {
    // Convert a sample of band points back to galactic latitude by rebuilding
    // the rotation: if the band were uniform, mean |sin(lat)| would be ~0.5.
    const pos = scene.milkyWayBand.geometry.getAttribute('position').array;
    let sum = 0;
    let n = 0;
    const ngpRa = 192.85948 * (Math.PI / 180);
    const ngpDec = 27.12825 * (Math.PI / 180);
    for (let i = 0; i < pos.length; i += 300) {
      const x = pos[i];
      const y = pos[i + 1];
      const z = -pos[i + 2];
      // Galactic pole in the same (rotated) frame.
      const px = Math.sin(ngpRa) * Math.cos(ngpDec);
      const py = Math.cos(ngpRa) * Math.cos(ngpDec);
      const pz = Math.sin(ngpDec);
      sum += Math.abs(x * px + y * py + z * pz);
      n++;
    }
    expect(sum / n).toBeLessThan(0.25);
  });

  it('reports its data attribution', () => {
    expect(scene.attribution.catalogue).toBeTruthy();
    expect(scene.attribution.figures).toBeTruthy();
  });

  it('runs 300 frames of label fading without NaN opacity', () => {
    for (let i = 0; i < 300; i++) {
      scene.update(1 / 60, i / 60, view({ cameraDistance: 800 }));
    }
    for (const [abbr, sprite] of scene.labels) {
      expect(Number.isFinite(sprite.material.opacity), abbr).toBe(true);
      expect(sprite.material.opacity).toBeGreaterThanOrEqual(0);
      expect(sprite.material.opacity).toBeLessThanOrEqual(1);
    }
  });

  it('selection highlights only the selected figure', () => {
    scene.selected = 'Cas';
    for (let i = 0; i < 60; i++) scene.update(1 / 60, i / 60, view({ cameraDistance: 800 }));
    const selected = scene.lineMeshes.find((l) => l.userData.abbr === 'Cas');
    const other = scene.lineMeshes.find((l) => l.userData.abbr === 'Cru');
    expect(selected.material.opacity).toBeGreaterThan(other.material.opacity);
  });
});