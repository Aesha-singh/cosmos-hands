/**
 * Procedural surface synthesis.
 *
 * This module is the reason COSMOS HANDS has no hard asset dependency: if
 * `npm run assets` was never run, every planet, moon and star still has a
 * *believable* surface because we synthesise one.
 *
 * The trick that makes it seamless: noise is sampled on the **unit sphere**
 * (3-D gradient noise evaluated at the surface direction), never on the
 * equirectangular UV plane. There is therefore no seam at the ±180° meridian
 * and no pole pinching, and rotating the planet does not reveal the mapping.
 *
 * Performance: one pass computes a shared height/detail field as a Float32Array,
 * then colourisation is pure arithmetic over that buffer. At 512² a planet
 * costs ~35 ms — imperceptible during a lazy scene load.
 *
 * @module utils/procedural
 */

import * as THREE from 'three';
import { makeNoise3D, clamp01, smoothstep, lerp, TAU } from './math.js';
import { canvasTexture } from './textures.js';

const noise = makeNoise3D(0xc0ffee);
const noiseB = makeNoise3D(0x5eed17);

/* -------------------------------------------------------------------------- */
/* Shared field generation                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Sample 3-D gradient noise across the whole sphere into flat Float32 buffers.
 *
 * Fields are computed once per texture and shared by the colour recipe, so the
 * expensive fBm evaluation happens exactly `res²` times, not `res² × recipes`.
 *
 * @param {number} res Texture resolution (square).
 * @param {{ octaves?: number, gain?: number, lacunarity?: number, freq?: number,
 *           warp?: number }} [opts]
 * @returns {{ base: Float32Array, detail: Float32Array, ridge: Float32Array,
 *             lat: Float32Array, lon: Float32Array, res: number }}
 */
function sphereFields(res, opts = {}) {
  const {
    octaves = 5, gain = 0.5, lacunarity = 2.03, freq = 1.6, warp = 0,
  } = opts;

  const n = res * res;
  const base = new Float32Array(n);
  const detail = new Float32Array(n);
  const ridge = new Float32Array(n);
  const lat = new Float32Array(n);
  const lon = new Float32Array(n);

  for (let y = 0; y < res; y++) {
    const theta = ((y + 0.5) / res) * Math.PI;          // 0 at +Y pole
    const sy = Math.cos(theta);
    const sr = Math.sin(theta);
    const row = y * res;
    for (let x = 0; x < res; x++) {
      const lambda = ((x + 0.5) / res) * TAU - Math.PI;
      const sx = sr * Math.cos(lambda);
      const sz = sr * Math.sin(lambda);

      let px = sx, py = sy, pz = sz;
      if (warp > 0) {
        // Domain-warp with a second noise field: breaks up the "cloudy" look
        // of raw fBm and gives ridged, geologically plausible structure.
        px += noiseB.fbm(sx * 2.1, sy * 2.1, sz * 2.1, 3) * warp;
        py += noiseB.fbm(sx * 2.1 + 5.2, sy * 2.1 + 1.3, sz * 2.1 + 9.1, 3) * warp;
        pz += noiseB.fbm(sx * 2.1 - 3.7, sy * 2.1 + 7.8, sz * 2.1 + 2.4, 3) * warp;
      }

      const i = row + x;
      base[i] = noise.fbm(px * freq, py * freq, pz * freq, octaves, lacunarity, gain);
      detail[i] = noise.fbm(px * freq * 6.5, py * freq * 6.5, pz * freq * 6.5, 3, 2.1, 0.55);
      ridge[i] = noise.ridged(px * freq * 2.2, py * freq * 2.2, pz * freq * 2.2, 4, 2.05, 0.5);
      lat[i] = sy;                                      // latitude in [-1, 1]
      lon[i] = lambda;
    }
  }
  return { base, detail, ridge, lat, lon, res };
}

/* -------------------------------------------------------------------------- */
/* Colour helpers                                                             */
/* -------------------------------------------------------------------------- */

const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** A small palette generator: dark → mid → light, with a gamma knob. */
const ramp = (dark, mid, light, t) =>
  t < 0.5 ? mix3(dark, mid, t * 2) : mix3(mid, light, (t - 0.5) * 2);

/* -------------------------------------------------------------------------- */
/* Surface recipes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} SurfaceRecipe
 * @property {(f: ReturnType<typeof sphereFields>, i: number) => number[]} shade
 *   Returns `[r, g, b]` in 0..255 for field index `i`.
 * @property {(f: ReturnType<typeof sphereFields>, i: number) => number} [height]
 *   Optional bump height 0..1.
 * @property {Object} [opts] Extra options forwarded to `canvasTexture`.
 */

/** Every recipe in one lookup table, keyed by body id. */
export const SURFACES = {
  /* ---------------------------------------------------------------- rocky -- */
  mercury: (f, i) => {
    const t = clamp01(f.base[i] * 0.5 + 0.5);
    const d = clamp01(f.detail[i] * 0.5 + 0.5);
    let c = ramp([58, 54, 50], [116, 110, 102], [178, 172, 162], t);
    // Bright ray systems from young impacts, plus dark basin material.
    const basin = smoothstep(-0.42, -0.62, f.base[i]);
    c = mix3(c, [42, 40, 39], basin * 0.7);
    const ray = smoothstep(0.62, 0.86, f.detail[i]) * (1 - basin);
    c = mix3(c, [206, 202, 194], ray * 0.5);
    const speck = 1 + (d - 0.5) * 0.14;
    return [c[0] * speck, c[1] * speck, c[2] * speck];
  },

  venusSurface: (f, i) => {
    const t = clamp01(f.base[i] * 0.5 + 0.5);
    return ramp([122, 88, 48], [186, 148, 86], [236, 210, 150], t);
  },

  venusAtmosphere: (f, i) => {
    // Thick sulphuric-acid cloud deck: strong zonal shear, few discrete features.
    const warp = f.lon[i] * 1.6 + f.lat[i] * 5.0 + f.base[i] * 3.4;
    const s = Math.sin(warp * 2.1) * 0.5 + 0.5;
    const t = clamp01(s * 0.62 + f.detail[i] * 0.24 + 0.22);
    return ramp([196, 158, 96], [232, 200, 142], [252, 236, 194], t);
  },

  mars: (f, i) => {
    const t = clamp01(f.base[i] * 0.5 + 0.5);
    let c = ramp([92, 42, 24], [166, 84, 46], [214, 140, 92], t);
    // Polar caps — Mars' caps are CO2/water ice, and they are seasonal, but a
    // static renderer gets latitude and elevation.
    const cap = smoothstep(0.86, 0.97, Math.abs(f.lat[i]) - f.ridge[i] * 0.05);
    c = mix3(c, [244, 246, 248], cap);
    // Valles Marineris analogue: a long low-elevation gash near the equator.
    const rift = smoothstep(0.045, 0.0, Math.abs(f.lat[i] + 0.11))
      * smoothstep(0.25, 0.7, f.detail[i]);
    c = mix3(c, [64, 30, 20], rift * 0.55);
    // Dark basaltic sand in the lowlands.
    c = mix3(c, [70, 38, 26], smoothstep(-0.15, -0.45, f.base[i]) * 0.5);
    return c;
  },

  moon: (f, i) => {
    const t = clamp01(f.base[i] * 0.5 + 0.5);
    let c = ramp([44, 42, 40], [124, 120, 114], [198, 196, 190], t);
    // Maria: large, dark, smooth basalt floods.
    const maria = smoothstep(0.18, 0.48, f.base[i]);
    c = mix3(c, [46, 45, 44], maria * 0.82);
    // Crater rays from Tycho-like impacts.
    const rays = smoothstep(0.55, 0.8, f.detail[i]) * (1 - maria * 0.6);
    c = mix3(c, [212, 210, 204], rays * 0.42);
    return c;
  },

  pluto: (f, i) => {
    const t = clamp01(f.base[i] * 0.5 + 0.5);
    // Tombaugh Regio (the bright "heart") vs. the dark Cthulhu Macula belt.
    let c = ramp([64, 40, 30], [150, 116, 92], [226, 208, 186], t);
    const heart = smoothstep(0.1, 0.55, f.detail[i]) * smoothstep(0.3, -0.1, f.lat[i]);
    c = mix3(c, [244, 232, 214], heart * 0.75);
    const dark = smoothstep(0.25, -0.35, f.base[i]);
    c = mix3(c, [48, 30, 24], dark * 0.6);
    return c;
  },

  /* ----------------------------------------------------------------- ice --- */
  europa: (f, i) => {
    // Europa is the most interesting ice moon to fake: lineae (the "cracked
    // ice" that cracked the Europa Clipper mission) are the whole visual story.
    const t = clamp01(f.base[i] * 0.5 + 0.5);
    let c = ramp([196, 186, 168], [226, 222, 210], [248, 247, 242], t);
    const l1 = Math.abs(Math.sin((f.lon[i] * 3.1 + f.base[i] * 7.4)));
    const l2 = Math.abs(Math.sin((f.lon[i] * -2.2 + f.detail[i] * 9.0 + 2.1)));
    const linea = smoothstep(0.965, 0.999, l1) + smoothstep(0.975, 0.999, l2) * 0.8;
    c = mix3(c, [132, 82, 56], clamp01(linea) * 0.75);
    return c;
  },

  ganymede: (f, i) => {
    const t = clamp01(f.base[i] * 0.5 + 0.5);
    let c = ramp([76, 70, 66], [140, 132, 124], [196, 190, 182], t);
    // Grooved terrain: bright parallel ridge systems, the signature of Ganymede.
    const groove = Math.abs(Math.sin((f.lon[i] * 5.5 + f.base[i] * 11) * 3.0));
    c = mix3(c, [216, 212, 204], smoothstep(0.82, 0.99, groove) * 0.5);
    const dark = smoothstep(-0.1, -0.5, f.base[i]);
    c = mix3(c, [52, 48, 46], dark * 0.55);
    return c;
  },

  callisto: (f, i) => {
    // The most heavily cratered object known: dark, saturated, no relief.
    const t = clamp01(f.base[i] * 0.5 + 0.5);
    let c = ramp([34, 28, 24], [78, 66, 56], [128, 114, 98], t);
    const craters = smoothstep(0.3, 0.7, f.detail[i]);
    c = mix3(c, [166, 156, 142], craters * 0.42);
    c = mix3(c, [232, 228, 220], smoothstep(0.72, 0.95, f.detail[i]) * 0.5);
    return c;
  },

  io: (f, i) => {
    // Io: the most colour-saturated body in the solar system. Sulphur (yellow),
    // SO2 frost (white), and volcanic silicate deposits (orange-red-black).
    const t = clamp01(f.base[i] * 0.5 + 0.5);
    let c = ramp([126, 76, 24], [226, 178, 62], [246, 234, 168], t);
    const frost = smoothstep(0.42, 0.78, f.detail[i]);
    c = mix3(c, [250, 248, 236], frost * 0.7);
    const volcano = smoothstep(0.55, 0.88, f.ridge[i]);
    c = mix3(c, [58, 26, 16], volcano * 0.8);
    const sulfur = smoothstep(-0.05, 0.45, f.base[i]);
    c = mix3(c, [240, 206, 74], sulfur * 0.35);
    return c;
  },

  titan: (f, i) => {
    // Titan is a featureless orange haze from orbit — and faking that faithfully
    // (boring!) is the correct choice. Only a faint equatorial dune field shows.
    const t = clamp01(f.base[i] * 0.5 + 0.5);
    let c = ramp([178, 118, 52], [214, 162, 84], [238, 204, 140], t);
    const dune = smoothstep(0.3, 0.8, Math.abs(Math.sin(f.lon[i] * 22))) * smoothstep(0.35, 0.05, Math.abs(f.lat[i]));
    c = mix3(c, [166, 112, 54], dune * 0.3);
    const northHaze = smoothstep(0.3, 0.95, f.lat[i]);
    c = mix3(c, [246, 224, 178], northHaze * 0.35);
    return c;
  },

  /* ----------------------------------------------------- Earth's fallback -- */
  earthSurface: (f, i) => {
    const t = clamp01(f.base[i] * 0.5 + 0.5);
    // Ocean floor below sea level, continents above: threshold the elevation.
    const sea = 0.52;
    const land = smoothstep(sea - 0.01, sea + 0.05, t);
    let c;
    if (t < sea) {
      const depth = (sea - t) / sea;
      c = mix3([16, 52, 108], [4, 18, 58], depth * 0.9);
      // Shallow shelf water.
      c = mix3([72, 148, 190], c, smoothstep(0, 0.12, sea - t));
    } else {
      const h = (t - sea) / (1 - sea);
      let ground = ramp([64, 96, 48], [122, 128, 78], [188, 176, 148], h);
      // Deserts around |lat| ≈ 0.25, ice at the poles, forest in between.
      const desert = smoothstep(0.05, 0.3, Math.abs(f.lat[i])) * (1 - smoothstep(0.4, 0.6, Math.abs(f.lat[i])))
        * smoothstep(0.35, 0.6, f.detail[i]);
      ground = mix3(ground, [206, 178, 118], desert * 0.6);
      const ice = smoothstep(0.72, 0.9, Math.abs(f.lat[i]) + f.ridge[i] * 0.08);
      ground = mix3(ground, [246, 248, 250], ice);
      c = ground;
    }
    return mix3([16, 52, 108], c, land);
  },

  earthNight: (f, i) => {
    // City lights clustered on land, near coasts, in the temperate band.
    const t = clamp01(f.base[i] * 0.5 + 0.5);
    if (t < 0.52) return [0, 0, 0];
    const coastal = smoothstep(0.52, 0.62, t);
    const temperate = 1 - smoothstep(0.6, 0.86, Math.abs(f.lat[i]));
    const cluster = smoothstep(0.15, 0.72, f.detail[i]);
    const grid = 0.5 + 0.5 * Math.sin(f.lon[i] * 190) * Math.sin(f.lat[i] * 150);
    const v = coastal * temperate * cluster * (0.35 + 0.65 * grid);
    return [255 * v, 208 * v, 138 * v];
  },

  earthClouds: (f, i) => {
    // Alpha-only layer: white cloud, transparent gaps. Banded by latitude to
    // suggest the Hadley cells and the mid-latitude storm tracks.
    const band = 0.5 + 0.5 * Math.cos(f.lat[i] * 11.0);
    const w = smoothstep(0.28, 0.82, f.detail[i] * 0.7 + f.base[i] * 0.5 + band * 0.22);
    const v = clamp01(w) * 255;
    return [255, 255, 255, v];
  },

  /* ------------------------------------------------------------- giants --- */
  jupiter: (f, i) => {
    // Real banded structure: alternating light zones and dark belts, sheared by
    // zonal winds and interrupted by turbulent festoons at the boundaries.
    const lat = f.lat[i];
    const shear = f.base[i] * 0.5 + f.detail[i] * 0.16;
    const band = Math.sin(lat * 21.0 + shear * 5.5);
    const t = clamp01(band * 0.5 + 0.5);
    let c = ramp([148, 106, 78], [206, 172, 132], [238, 214, 176], t);
    // The Great Red Spot: an anticyclone at −22° latitude.
    const spot = smoothstep(0.30, 0.0, Math.hypot((lat + 0.38) * 1.6, (f.lon[i] - 2.1) * 0.55));
    c = mix3(c, [186, 96, 62], spot * 0.85);
    c = mix3(c, [142, 62, 44], smoothstep(0.14, 0.0, Math.hypot((lat + 0.38) * 1.6, (f.lon[i] - 2.1) * 0.55)) * 0.7);
    // Polar hoods are darker and greyer.
    c = mix3(c, [104, 96, 92], smoothstep(0.72, 0.99, Math.abs(lat)) * 0.65);
    return c;
  },

  saturn: (f, i) => {
    const lat = f.lat[i];
    const band = Math.sin(lat * 15.0 + f.base[i] * 3.0 + f.detail[i] * 0.6);
    const t = clamp01(band * 0.5 + 0.5);
    let c = ramp([176, 148, 104], [222, 200, 154], [244, 228, 188], t);
    // The north polar hexagon is a real, persistent, hexagonal jet stream.
    const hexPhase = f.lon[i] - Math.floor(lat / 0.02) * 0;
    const hex = Math.abs(Math.sin(f.lon[i] * 3.0));
    c = mix3(c, [126, 152, 158], smoothstep(0.72, 0.93, Math.abs(lat)) * smoothstep(0.86, 0.99, hex) * 0.7);
    void hexPhase;
    return c;
  },

  uranus: (f, i) => {
    // Uranus is famously bland: a featureless cyan methane haze with faint bands.
    const band = Math.sin(f.lat[i] * 9.0 + f.detail[i] * 0.5);
    const t = clamp01(band * 0.5 + 0.5);
    let c = ramp([130, 196, 202], [166, 218, 220], [196, 234, 234], t);
    c = mix3(c, [212, 240, 240], smoothstep(0.6, 0.98, Math.abs(f.lat[i])) * 0.5);
    return c;
  },

  neptune: (f, i) => {
    const t = clamp01(f.base[i] * 0.5 + 0.5);
    let c = ramp([28, 62, 148], [56, 104, 196], [104, 156, 226], t);
    // The Great Dark Spot plus bright methane cirrus streaks.
    const spot = smoothstep(0.26, 0.02, Math.hypot((f.lat[i] + 0.32) * 1.9, (f.lon[i] + 1.2) * 0.5));
    c = mix3(c, [14, 32, 88], spot * 0.85);
    const cirrus = smoothstep(0.72, 0.94, f.detail[i]);
    c = mix3(c, [224, 238, 252], cirrus * 0.5);
    return c;
  },

  /* --------------------------------------------------------------- sun ---- */
  sun: (f, i) => {
    // The photosphere is granulation, not noise: convection cells with bright
    // lanes between them, plus a few darker sunspot umbrae.
    const gran = f.detail[i] * 0.5 + 0.5;
    const cell = smoothstep(0.35, 0.85, gran);
    let c = ramp([196, 62, 6], [255, 156, 26], [255, 244, 190], cell);
    const spot = smoothstep(0.72, 0.93, f.ridge[i]);
    c = mix3(c, [96, 26, 4], spot * 0.85);
    c = mix3(c, [30, 8, 2], smoothstep(0.86, 0.99, f.ridge[i]) * 0.9);
    return c;
  },

  /** Generic rocky asteroid — used 52 000 times, so it must stay cheap. */
  asteroid: (f, i) => {
    const t = clamp01(f.base[i] * 0.5 + 0.5);
    const c = ramp([46, 42, 38], [96, 88, 80], [148, 140, 128], t);
    const dark = smoothstep(0.6, 0.9, f.detail[i]) * 0.4;
    return mix3(c, [40, 30, 26], dark);
  },
};

/** Per-body tuning of the shared field generator. */
const FIELD_OPTS = {
  mercury: { octaves: 6, freq: 2.6, warp: 0.16 },
  venusSurface: { octaves: 4, freq: 1.1, warp: 0.1 },
  venusAtmosphere: { octaves: 3, freq: 0.7, warp: 0 },
  mars: { octaves: 6, freq: 1.9, warp: 0.2 },
  moon: { octaves: 6, freq: 2.8, warp: 0.1 },
  pluto: { octaves: 5, freq: 1.6, warp: 0.24 },
  europa: { octaves: 4, freq: 1.4, warp: 0.3 },
  ganymede: { octaves: 5, freq: 2.1, warp: 0.22 },
  callisto: { octaves: 6, freq: 3.4, warp: 0.08 },
  io: { octaves: 5, freq: 2.2, warp: 0.3 },
  titan: { octaves: 4, freq: 1.0, warp: 0.05 },
  earthSurface: { octaves: 6, freq: 1.5, warp: 0.26 },
  earthNight: { octaves: 6, freq: 1.5, warp: 0.26 },
  earthClouds: { octaves: 5, freq: 2.4, warp: 0.4 },
  jupiter: { octaves: 4, freq: 0.9, warp: 0.34 },
  saturn: { octaves: 4, freq: 0.8, warp: 0.26 },
  uranus: { octaves: 3, freq: 0.8, warp: 0.08 },
  neptune: { octaves: 4, freq: 1.0, warp: 0.18 },
  sun: { octaves: 4, freq: 5.5, warp: 0.12 },
  asteroid: { octaves: 4, freq: 3.0, warp: 0.14 },
};

/** Default resolutions — moons are smaller on screen, so they cost less. */
const RES_FOR = { asteroid: 128, sun: 512 };

/**
 * Synthesise an equirectangular texture for a named body.
 *
 * @param {keyof SURFACES} key
 * @param {number} [res] Square resolution. Defaults per body.
 * @param {{ srgb?: boolean, repeat?: boolean, anisotropy?: number }} [opts]
 * @returns {THREE.CanvasTexture}
 * @throws {Error} if `key` has no recipe.
 */
export function makeSurfaceTexture(key, res = RES_FOR[key] ?? 512, opts = {}) {
  const recipe = SURFACES[key];
  if (!recipe) throw new Error(`[procedural] no surface recipe for "${key}"`);

  const fields = sphereFields(res, FIELD_OPTS[key] ?? {});
  const { res: n } = fields;

  return canvasTexture(n, n, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    const px = img.data;
    for (let i = 0; i < w * h; i++) {
      const c = recipe(fields, i);
      const o = i * 4;
      px[o] = clamp01(c[0] / 255) * 255;
      px[o + 1] = clamp01(c[1] / 255) * 255;
      px[o + 2] = clamp01(c[2] / 255) * 255;
      px[o + 3] = c.length > 3 ? clamp01(c[3] / 255) * 255 : 255;
    }
    ctx.putImageData(img, 0, 0);
  }, { srgb: opts.srgb ?? true, repeat: opts.repeat ?? true, anisotropy: opts.anisotropy ?? 8 });
}

/**
 * Synthesise a cloud alpha map with soft, physically-plausible edges.
 * Kept separate from {@link makeSurfaceTexture} because clouds need their own
 * noise basis and much softer contrast.
 *
 * @param {number} res
 * @returns {THREE.CanvasTexture}
 */
export function makeCloudTexture(res = 512) {
  return makeSurfaceTexture('earthClouds', res, { srgb: true });
}

/**
 * Synthesise the Earth night-lights emissive map.
 *
 * @param {number} res
 * @returns {THREE.CanvasTexture}
 */
export function makeNightLightsTexture(res = 512) {
  return makeSurfaceTexture('earthNight', res, { srgb: true });
}

/**
 * Saturn's ring system: a 1-D radial optical-depth profile.
 *
 * Real structure (from C ring inward): the C ring (dim, τ ≈ 0.1), the B ring
 * (the brightest, τ ≈ 2.5), the Cassini Division at 117 500 km (τ collapses to
 * ~0.1), the A ring (τ ≈ 0.6), then Encke and Keeler gaps.
 *
 * @param {number} [size]
 * @returns {THREE.DataTexture} RGBA, alpha = opacity, rgb = ring colour.
 */
export function makeSaturnRingTexture(size = 1024) {
  const data = new Uint8Array(size * 4);

  /** Inner and outer radii in kilometres (true values). */
  const RIN = 74_500;
  const ROUT = 140_220;
  const B_CASSINI = 117_580;
  const B_OUTER = 136_775;
  const B_INNER = 92_000;
  const ENCKE = 133_589;
  const KEELER = 136_505;

  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    const r = RIN + t * (ROUT - RIN);

    // Base optical depth profile with real gaps.
    let tau;
    if (r < B_INNER) {
      tau = 0.12 + 0.05 * Math.sin(t * 90);                 // C ring
    } else if (r < B_CASSINI) {
      tau = 2.4 * Math.exp(-Math.pow((r - 105_000) / 12_000, 2)) + 0.9; // B ring
    } else if (r < B_OUTER) {
      // Cassini Division — nearly empty, with a faint ringlet structure.
      tau = 0.08 + 0.06 * Math.sin(t * 420);
    } else {
      tau = 0.62 * Math.exp(-Math.pow((r - ROUT) / 4_500, 2));           // A ring
    }
    // Encke Gap: 325 km wide, and Keeler Gap: 42 km wide.
    tau *= 1 - 0.92 * Math.exp(-Math.pow((r - ENCKE) / 165, 2));
    tau *= 1 - 0.9 * Math.exp(-Math.pow((r - KEELER) / 22, 2));
    // Fine ringlet wave structure everywhere.
    tau *= 0.86 + 0.14 * Math.sin(r / 210) * Math.sin(r / 47.3);

    const alpha = clamp01(1 - Math.exp(-tau * 1.35));
    // Colour: the B ring is the most neutral, the C ring is duskier.
    const warm = 0.5 + 0.5 * Math.sin(r / 26_000);
    data[i * 4] = 232 - warm * 24;
    data[i * 4 + 1] = 214 - warm * 20;
    data[i * 4 + 2] = 184 - warm * 10;
    data[i * 4 + 3] = alpha * 255;
  }

  const tex = new THREE.DataTexture(data, size, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * A soft round sprite for particles (belt rocks are lit per-vertex, but the
 * galaxy uses additive sprites).
 *
 * @param {number} [size]
 * @returns {THREE.CanvasTexture}
 */
export function makeSoftDot(size = 64) {
  return canvasTexture(size, size, (ctx, w) => {
    const c = w / 2;
    const g = ctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, w);
  }, { srgb: false, repeat: false });
}

/**
 * Milky Way dust-lane / nebula texture used by the galaxy scene's core glow and
 * by the deep-universe backdrop.
 *
 * @param {number} res
 * @param {number} seed
 * @returns {THREE.CanvasTexture}
 */
export function makeNebulaTexture(res = 512, seed = 7) {
  const n2 = makeNoise3D(seed);
  const n = res * res;
  const img = new Uint8ClampedArray(n * 4);

  for (let y = 0; y < res; y++) {
    const theta = ((y + 0.5) / res) * Math.PI;
    const sy = Math.cos(theta), sr = Math.sin(theta);
    for (let x = 0; x < res; x++) {
      const lambda = ((x + 0.5) / res) * TAU;
      const sx = sr * Math.cos(lambda), sz = sr * Math.sin(lambda);

      const base = n2.fbm(sx * 1.4, sy * 1.4, sz * 1.4, 6, 2.1, 0.55);
      const fil = n2.ridged(sx * 3.1, sy * 3.1, sz * 3.1, 4, 2.0, 0.5);

      // Filaments get the hot cores; voids stay dark.
      const d = clamp01(base * 0.5 + 0.5);
      const bright = clamp01(Math.pow(d, 2.4) * 1.9);
      const filament = clamp01(Math.pow(fil, 5.0) * 0.8);

      // Nebula colour ramp: magenta-red ionisation cores into teal hydrogen.
      const teal = [70, 190, 220];
      const magenta = [196, 96, 168];
      const gold = [232, 196, 130];
      let c = [0, 0, 0];
      const w1 = filament;
      const w2 = bright * (1 - filament * 0.6);
      c = [
        teal[0] * w1 + magenta[0] * w2 * 0.7 + gold[0] * bright * 0.25,
        teal[1] * w1 + magenta[1] * w2 * 0.7 + gold[1] * bright * 0.25,
        teal[2] * w1 + magenta[2] * w2 * 0.7 + gold[2] * bright * 0.25,
      ];
      const i = (y * res + x) * 4;
      img[i] = c[0];
      img[i + 1] = c[1];
      img[i + 2] = c[2];
      img[i + 3] = clamp01(bright * 0.9 + filament * 0.6) * 255;
    }
  }

  return canvasTexture(res, res, (ctx, w, h) => {
    ctx.putImageData(new ImageData(img, w, h), 0, 0);
  }, { srgb: true, repeat: true });
}
