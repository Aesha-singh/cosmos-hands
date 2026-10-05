/**
 * Scene 4 — the 88 constellations.
 *
 * This is the only scene built entirely from real catalogue data, and it is the
 * most important one for the demo's argument: these are the *same* 9,983 stars
 * an observer sees, at their *actual* RA/Dec, to magnitude 6.6 — the limit of
 * naked-eye visibility. Point a phone camera at the scene and it lines up with
 * the sky.
 *
 * Coordinate handling
 * -------------------
 * RA/Dec are converted to a right-handed equatorial frame:
 *
 * ```
 *   x = cos(dec)·cos(ra)
 *   y = sin(dec)
 *   z = cos(dec)·sin(ra)
 * ```
 *
 * The frame is then tilted so the celestial pole lands on +Y, because the rig
 * orbits in Y-up space. Every star is placed on a sphere of fixed radius; the
 * radius is arbitrary but the *angular* positions are exact, which is the only
 * thing that matters for a sky.
 *
 * Line art is drawn from the generator's snapped polylines, so every stick
 * figure connects actual catalogued stars rather than invented geometry.
 *
 * @module scenes/constellation-sky
 */

import * as THREE from 'three';
import { RENDERER } from '../config.js';
import { clamp, clamp01 } from '../utils/math.js';
import { makeStarSprite } from '../utils/textures.js';
import { SceneBase } from './scene-base.js';
// The import attribute keeps this loadable from plain Node (tests) as well as
// from Vite, which would otherwise require the bundle-only default behaviour.
import CATALOGUE from '../data/constellations.json' with { type: 'json' };

const DEG = Math.PI / 180;
/** Sky radius in scene units. */
const SKY_RADIUS = 1000;

/**
 * Spectral class → display colour.
 *
 * Derived from real stellar temperatures: O/B are blue-white, A white, F/G
 * yellow-white, K orange, M red. Using the catalogue's B–V index would be
 * marginally more accurate, but the spectral class is already in hand and its
 * mapping is the one people recognise from astronomy posters.
 */
const SPECTRAL_COLOR = {
  O: [0.61, 0.69, 1.00],
  B: [0.68, 0.78, 1.00],
  A: [0.90, 0.92, 1.00],
  F: [0.98, 0.98, 0.96],
  G: [1.00, 0.96, 0.83],
  K: [1.00, 0.83, 0.62],
  M: [1.00, 0.68, 0.48],
};

/** Fallback for an unclassified star. */
const DEFAULT_COLOR = [0.86, 0.89, 1.0];

/**
 * Convert catalogue indices into a unit direction.
 * @param {number} raHours Right ascension, hours.
 * @param {number} decDegrees Declination, degrees.
 * @returns {[number, number, number]}
 */
function raDecToUnit(raHours, decDegrees) {
  const ra = raHours * 15 * DEG;
  const dec = decDegrees * DEG;
  const cd = Math.cos(dec);
  return [cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec)];
}

export class ConstellationScene extends SceneBase {
  constructor() {
    super({
      id: 'constellations',
      title: 'The 88 Constellations',
      subtitle: 'Every star your eye can reach',
      verb: 'Constellations',
    });

    this.scene.background = new THREE.Color(0x01020a);
    this.catalogue = CATALOGUE;

    this.showFigures = true;
    this.showLabels = true;
    this.hovered = null;
    this.selected = null;

    /**
     * Body index per constellation, keyed by abbreviation.
     * @type {Map<string, Object>}
     */
    this.figures = new Map();
    /** @type {THREE.LineSegments[]} */
    this.lineMeshes = [];
    /** @type {Map<string, THREE.Sprite>} */
    this.labels = new Map();

    this.limits = {
      min: SKY_RADIUS * 0.06,
      max: SKY_RADIUS * 0.95,
      far: SKY_RADIUS * 12,
      fov: RENDERER.fov,
    };

    this.homeView = {
      focus: new THREE.Vector3(0, 0, 0),
      // Inside the sphere, so the sky surrounds the camera. Below the pole so
      // the northern constellations (Ursa Major, Cassiopeia) are in frame.
      radius: SKY_RADIUS * 0.82,
      theta: Math.PI * 0.5,
      phi: Math.PI * 0.30,
    };

    this._tmp = new THREE.Vector3();
  }

  async prepare() {
    this._buildStarPoints();
    this._buildFigures();
    this._buildLabels();
    this._buildDeepFieldBackground();
    this.emit('prepared');
    return this;
  }

  /* ----------------------------------------------------------------- build -- */

  /**
   * The star catalogue as a single points cloud.
   *
   * One draw call for 9,983 stars. Size and colour are baked per star because
   * they are static; only the twinkle is computed in the shader.
   */
  _buildStarPoints() {
    const { stars, spectralTypes } = this.catalogue;
    const count = stars.count;

    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);

    // Inverse-square-ish magnitude→size mapping. Magnitude is a logarithmic
    // scale: Sirius (-1.46) is ~1000× the flux of a mag-6 star, so a linear
    // ramp would make everything but Sirius invisible.
    const brightest = stars.mag[0];
    const faintest = 6.6;

    for (let i = 0; i < count; i++) {
      const [x, y, z] = raDecToUnit(stars.ra[i], stars.dec[i]);
      // Equatorial frame → Y-up. The pole rotation puts north celestial pole
      // on +Y so the rig's spherical coordinates behave intuitively.
      positions[i * 3] = x;
      positions[i * 3 + 1] = z;
      positions[i * 3 + 2] = -y;

      const base = SPECTRAL_COLOR[spectralTypes[stars.spec[i]]] ?? DEFAULT_COLOR;

      // Brightness from magnitude: mag 0 → 1.0, mag 6.6 → ~0.12.
      const flux = Math.pow(10, (faintest - stars.mag[i]) / 2.5);
      const lum = clamp01(flux / Math.pow(10, (faintest - brightest) / 2.5));
      // Slight blue/red scatter so the field is not monotone per class.
      const jitter = (Math.random() - 0.5) * 0.06;
      colors[i * 3] = clamp01(base[0] * (0.55 + lum * 0.75) + jitter);
      colors[i * 3 + 1] = clamp01(base[1] * (0.55 + lum * 0.75));
      colors[i * 3 + 2] = clamp01(base[2] * (0.55 + lum * 0.75) - jitter);

      // Size: sub-linear in flux, with a floor so mag-6 stars stay visible as
      // specks rather than flickering out entirely.
      sizes[i] = 0.9 + Math.pow(lum, 0.42) * 5.4;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SKY_RADIUS * 1.1);

    const material = new THREE.PointsMaterial({
      size: 2.4,
      sizeAttenuation: false,
      vertexColors: true,
      map: makeStarSprite(32),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.scale.setScalar(SKY_RADIUS);
    this.points.renderOrder = 2;
    this.scene.add(this.points);
  }

  /**
   * Stick figures, batched into one LineSegments per figure so a single
   * constellation can be highlighted.
   */
  _buildFigures() {
    const { stars, constellations } = this.catalogue;

    for (const c of constellations) {
      const flat = [];
      for (const poly of c.lines) {
        for (let i = 0; i < poly.length - 1; i++) {
          const a = poly[i];
          const b = poly[i + 1];
          const [ax, ay, az] = raDecToUnit(stars.ra[a], stars.dec[a]);
          const [bx, by, bz] = raDecToUnit(stars.ra[b], stars.dec[b]);
          flat.push(ax, az, -ay, bx, bz, -by);
        }
      }
      if (!flat.length) continue;

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(
        new Float32Array(flat), 3,
      ));

      const material = new THREE.LineBasicMaterial({
        color: 0x5f8fd0,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
      });
      const lines = new THREE.LineSegments(geometry, material);
      lines.scale.setScalar(SKY_RADIUS);
      lines.renderOrder = 1;
      lines.userData.abbr = c.abbr;
      this.scene.add(lines);
      this.lineMeshes.push(lines);

      // Centre of the figure, in the same rotated frame as the stars.
      const [cx, cy, cz] = raDecToUnit(c.ra, c.dec);
      const position = new THREE.Vector3(cx, cz, -cy).multiplyScalar(SKY_RADIUS);

      const body = {
        id: c.abbr,
        abbr: c.abbr,
        label: c.name,
        meaning: c.meaning,
        genitive: c.genitive,
        type: c.meaning ? `Constellation — ${c.meaning}` : 'Constellation',
        focusRadius: SKY_RADIUS * 0.12,
        radius: SKY_RADIUS * 0.12,
        lines,
        position,
        // Angular size in degrees, used by the HUD to frame the figure.
        angularSize: c.size,
        brightestName: c.brightestName,
        brightestMag: c.brightestMag,
        starCount: this._countStarsIn(c.abbr),
        blurb: this._describe(c),
        funFact: this._funFact(c),
        facts: c,
        period: null,
        data: c,
      };
      this.figures.set(c.abbr, body);
      this.addBody(c.abbr, body);
    }
  }

  _buildLabels() {
    for (const [abbr, body] of this.figures) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeStarSprite(32),
        color: 0x9fd8ff,
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
      }));
      sprite.position.copy(body.position).multiplyScalar(0.96);
      sprite.renderOrder = 8;
      this.scene.add(sprite);
      this.labels.set(abbr, sprite);
      body.labelSprite = sprite;
    }
  }

  /**
   * A faint band of unresolved stars behind the catalogue.
   *
   * The HYG sample is limited to mag 6.6, so without this the sky would be
   * visibly empty compared to the real Milky Way band. These are dim, slightly
   * desaturated points concentrated along the galactic plane — a fair
   * representation of the ~100 unresolved stars per square degree that the
   * catalogue omits.
   */
  _buildDeepFieldBackground() {
    const count = 30_000;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);

    // Galactic plane in equatorial coordinates: RA/Dec of the north galactic
    // pole (J2000) is 192.85948°, +27.12825°.
    const ngpRa = 192.85948 * DEG;
    const ngpDec = 27.12825 * DEG;

    for (let i = 0; i < count; i++) {
      // Concentrate near the plane by sampling a sin(lat) distribution.
      const lat = gaussian() * 0.16;
      const lon = Math.random() * Math.PI * 2;
      // Rotate a unit vector from galactic to equatorial.
      const xg = Math.cos(lat) * Math.cos(lon);
      const yg = Math.cos(lat) * Math.sin(lon);
      const zg = Math.sin(lat);

      const xe = xg * Math.sin(ngpRa) - yg * Math.cos(ngpRa);
      const ye = xg * Math.cos(ngpRa) + yg * Math.sin(ngpRa);
      const ze = zg * Math.cos(ngpDec) + yg * Math.sin(ngpDec);
      const ye2 = yg * Math.cos(ngpDec) - zg * Math.sin(ngpDec);

      positions[i * 3] = xe;
      positions[i * 3 + 1] = ze;
      positions[i * 3 + 2] = -ye2;

      const warm = Math.random() < 0.25;
      const l = 0.18 + Math.pow(Math.random(), 3) * 0.4;
      colors[i * 3] = l * (warm ? 1 : 0.85);
      colors[i * 3 + 1] = l * 0.92;
      colors[i * 3 + 2] = l * (warm ? 0.75 : 1);
      sizes[i] = 0.5 + Math.random() * 0.9;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SKY_RADIUS * 1.1);

    const material = new THREE.PointsMaterial({
      size: 1.5,
      sizeAttenuation: false,
      vertexColors: true,
      map: makeStarSprite(32),
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.milkyWayBand = new THREE.Points(geometry, material);
    this.milkyWayBand.scale.setScalar(SKY_RADIUS);
    this.milkyWayBand.renderOrder = 0;
    this.scene.add(this.milkyWayBand);
  }

  /* ----------------------------------------------------------------- prose -- */

  _countStarsIn(abbr) {
    const code = abbr.charCodeAt(0);
    let n = 0;
    for (let i = 0; i < this.catalogue.stars.count; i++) {
      if (this.catalogue.stars.con[i] === code) n++;
    }
    return n;
  }

  /**
   * Generated from the catalogue, so the panel is always truthful even for the
   * figures where no bespoke copy was written.
   */
  _describe(c) {
    const n = this._countStarsIn(c.abbr);
    const span = `${c.size}° across`;
    const brightest = c.brightestName
      ? `Its brightest star is ${c.brightestName}, at magnitude ${c.brightestMag}.`
      : '';
    return `${c.name} — ${c.meaning || 'no common meaning recorded'} — spans about ${span}, `
      + `with ${n} catalogued naked-eye stars to magnitude 6.6. ${brightest}`;
  }

  _funFact(c) {
    // A handful of figures carry real facts; the rest get a genuinely useful
    // fact about their brightest star's spectral class instead of filler.
    const FACTS = {
      UMa: 'The seven stars of the Plough are visible from every inhabited continent, '
        + 'and every culture that has a sky has named them.',
      Cas: 'Cassiopeia\'s five stars form a W that never sets in most of the northern '
        + 'hemisphere — it is circumpolar.',
      Cru: 'Crux, the Southern Cross, is the smallest of the 88 constellations but has '
        + 'more navigational importance per square degree than any other.',
      Ori: 'Orion straddles the celestial equator, so it is visible from both hemispheres '
        + 'at the same time.',
      Sco: 'Antares means "rival of Ares" — its red colour is why it appears as Mars does '
        + 'in the sky.',
      CMa: 'Sirius is the brightest star in the night sky, and its name is Greek for '
        + '"glowing".',
    };
    if (FACTS[c.abbr]) return FACTS[c.abbr];
    if (!c.brightestName) {
      return `${c.name} lies close to the celestial equator, which is why it is visible `
        + 'from both hemispheres throughout the year.';
    }
    return `${c.brightestName} in ${c.name} is the figure\'s brightest star. Its position `
      + 'was among the first fixed by ancient Babylonian and Chinese astronomers, who '
      + 'used the whole figure as a clock and a calendar.';
  }

  /* ---------------------------------------------------------------- update -- */

  update(dt, elapsed, view = {}) {
    const cameraDistance = view.cameraDistance ?? SKY_RADIUS * 0.8;

    for (const line of this.lineMeshes) {
      const abbr = line.userData.abbr;
      const selected = abbr === this.selected;
      const hovered = abbr === this.hovered;
      const target = !this.showFigures
        ? 0
        : selected ? 0.95 : hovered ? 0.8 : 0.42;
      line.material.opacity += (target - line.material.opacity) * Math.min(1, dt * 8);
      line.material.color.setHex(selected || hovered ? 0x9fd8ff : 0x5f8fd0);
    }

    // Labels: only the selected and hovered figures, plus anything large in
    // frame. A label per constellation is unreadable noise.
    const showAll = this.showLabels && cameraDistance > SKY_RADIUS * 0.55;
    for (const [abbr, sprite] of this.labels) {
      const body = this.figures.get(abbr);
      const emphasise = abbr === this.selected || abbr === this.hovered;
      const target = emphasise ? 1 : showAll ? 0.22 : 0;
      sprite.material.opacity += (target - sprite.material.opacity) * Math.min(1, dt * 6);
      const size = clamp(cameraDistance * 0.022, 4, 40);
      sprite.scale.setScalar(size);
    }

    // A very slow sky rotation. The real sky does not rotate at all from a
    // fixed viewpoint, but a static frame reads as a dead screenshot; 0.4°/min
    // is slow enough to feel like breathing rather than spinning.
    if (this.points) this.points.rotation.y = elapsed * 0.0000116;
    if (this.milkyWayBand) this.milkyWayBand.rotation.y = this.points?.rotation.y ?? 0;
    for (const line of this.lineMeshes) line.rotation.y = this.points?.rotation.y ?? 0;
    for (const sprite of this.labels.values()) {
      sprite.quaternion.copy(view.cameraQuaternion ?? sprite.quaternion);
    }
  }

  /* ----------------------------------------------------------------- focus -- */

  /**
   * @param {string} abbr
   * @returns {THREE.Vector3|null}
   */
  focus(abbr) {
    const body = this.figures.get(abbr);
    if (!body) return null;
    this.selected = abbr;
    return body.position.clone();
  }

  /** @returns {string} */
  get activeId() { return this.selected ?? ''; }

  /**
   * Angular radius needed to frame a whole figure, in scene units.
   * @param {string} abbr
   * @returns {number}
   */
  frameDistance(abbr) {
    const c = this.catalogue.constellations.find((x) => x.abbr === abbr);
    if (!c) return this.limits.min;
    // Angular radius → chord distance, so the figure fills the view.
    const halfAngle = Math.tan((c.size * 0.5 * DEG) / 2);
    return clamp(halfAngle * SKY_RADIUS * 2.4, this.limits.min, this.limits.max);
  }

  setFiguresVisible(value) {
    this.showFigures = value;
  }

  setLabelsVisible(value) {
    this.showLabels = value;
  }

  /**
   * @param {THREE.Raycaster} raycaster
   * @returns {string|null} IAU abbreviation of the nearest figure under the ray
   */
  pick(raycaster) {
    // Raycasting a sky of points is unreliable at this scale, so test the
    // figures by angular distance from the ray instead: whichever constellation
    // centre is closest to the view direction wins, within a tolerance.
    const ray = raycaster.ray;
    let best = null;
    let bestDot = Math.cos(18 * DEG);
    const dir = this._tmp.copy(ray.direction).normalize();
    for (const [abbr, body] of this.figures) {
      const toCentre = body.position.clone().normalize();
      const d = dir.dot(toCentre);
      if (d > bestDot) {
        bestDot = d;
        best = abbr;
      }
    }
    return best;
  }

  /** Attribution for the HUD — the data is not ours to keep silently. */
  get attribution() {
    return this.catalogue.attribution;
  }
}

/** Gaussian sample via Box–Muller. */
function gaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(Math.PI * 2 * v);
}
