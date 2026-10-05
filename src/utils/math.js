/**
 * Small, dependency-free maths helpers.
 *
 * Everything here is pure and unit-tested (`tests/math.test.js`).
 *
 * @module utils/math
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b - a === 0 ? 0 : (v - a) / (b - a));
export const mix = lerp;

/** Remap `v` from one range to another, clamped. */
export const remap = (v, inLo, inHi, outLo, outHi) =>
  lerp(outLo, outHi, clamp01(invLerp(inLo, inHi, v)));

/** Smooth Hermite step between two edges (GLSL `smoothstep` equivalent). */
export const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-9));
  return t * t * (3 - 2 * t);
};

/** Frame-rate independent exponential smoothing factor. */
export const damp = (current, target, lambda, dt) =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));

/** Shortest signed angular difference b - a, wrapped to (-π, π]. */
export function shortestAngle(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/** Wrap an angle into [0, 2π). */
export const wrapTau = (a) => ((a % TAU) + TAU) % TAU;

/** Wrap degrees into [0, 360). */
export const wrap360 = (d) => ((d % 360) + 360) % 360;

/** Dead-zone with soft re-normalisation, so tiny noise does not accumulate. */
export function deadzone(v, dz = 0.1) {
  const a = Math.abs(v);
  if (a < dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz));
}

/* -------------------------------------------------------------------------- */
/* Deterministic randomness                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Mulberry32 — a tiny, fast, well-distributed 32-bit PRNG.
 * Deterministic so every visitor sees the identical asteroid belt.
 *
 * @param {number} seed
 * @returns {() => number} generator producing [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A tiny bundle of shaped random helpers bound to one seed. */
export function makeRandom(seed = 0x5eed) {
  const r = mulberry32(seed);
  const api = {
    next: r,
    /** Uniform in [lo, hi). */
    range: (lo, hi) => lo + r() * (hi - lo),
    /** Integer in [lo, hi]. */
    int: (lo, hi) => Math.floor(lo + r() * (hi - lo + 1)),
    /** Standard normal (Box–Muller). */
    normal: (mean = 0, sd = 1) => {
      const u = Math.max(1e-9, r());
      const v = r();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
    },
    /** Uniform point on the unit sphere. */
    onSphere: () => {
      const z = r() * 2 - 1;
      const t = r() * TAU;
      const s = Math.sqrt(Math.max(0, 1 - z * z));
      return [s * Math.cos(t), s * Math.sin(t), z];
    },
    pick: (arr) => arr[Math.floor(r() * arr.length) % arr.length],
    /** True with probability p. */
    chance: (p) => r() < p,
  };
  return api;
}

/* -------------------------------------------------------------------------- */
/* 3-D value noise (CPU, for procedural textures)                             */
/* -------------------------------------------------------------------------- */

/** 2-D/3-D simplex-ish gradient noise from a seeded permutation table. */
export function makeNoise3D(seed = 1337) {
  const rnd = mulberry32(seed);
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const grads = new Float32Array(512 * 3);
  for (let i = 0; i < 512; i++) {
    const z = rnd() * 2 - 1;
    const t = rnd() * TAU;
    const s = Math.sqrt(Math.max(0, 1 - z * z));
    grads[i * 3] = s * Math.cos(t);
    grads[i * 3 + 1] = s * Math.sin(t);
    grads[i * 3 + 2] = z;
  }

  /** Fade curve 6t⁵-15t⁴+10t³. */
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp3 = (a, b, t) => a + (b - a) * t;

  /** Dot product of the gradient at `i` with the offset vector. */
  function gradDot(i, x, y, z) {
    const k = (perm[i & 255] & 255) * 3;
    return grads[k] * x + grads[k + 1] * y + grads[k + 2] * z;
  }

  /**
   * Gradient (Perlin-style) noise in [-1, 1].
   * @param {number} x @param {number} y @param {number} z
   */
  function noise(x, y, z) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = fade(x), v = fade(y), w = fade(z);

    const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z;
    const B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z;

    return lerp3(
      lerp3(
        lerp3(gradDot(AA, x, y, z), gradDot(BA, x - 1, y, z), u),
        lerp3(gradDot(AB, x, y - 1, z), gradDot(BB, x - 1, y - 1, z), u),
        v,
      ),
      lerp3(
        lerp3(gradDot(AA + 1, x, y, z - 1), gradDot(BA + 1, x - 1, y, z - 1), u),
        lerp3(gradDot(AB + 1, x, y - 1, z - 1), gradDot(BB + 1, x - 1, y - 1, z - 1), u),
        v,
      ),
      w,
    );
  }

  /** Fractal Brownian motion: `octaves` layers of `noise` at doubling frequency. */
  function fbm(x, y, z, octaves = 4, lacunarity = 2.0, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal — the sharp-crested variant, ideal for mountain chains. */
  function ridged(x, y, z, octaves = 5, lacunarity = 2.0, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(noise(x * freq, y * freq, z * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  return { noise, fbm, ridged };
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

const SI = [
  [1e24, 'yotta'], [1e21, 'zetta'], [1e18, 'exa'], [1e15, 'peta'],
  [1e12, 'tera'], [1e9, 'giga'], [1e6, 'mega'], [1e3, 'kilo'],
];

/** SI prefix for a value, e.g. 1.4e9 → "1.4 G". */
export function siPrefix(v) {
  const a = Math.abs(v);
  for (const [scale, name] of SI) {
    if (a >= scale) return `${(v / scale).toFixed(1)} ${name}`;
  }
  return v.toFixed(1);
}

/** Group thousands: 1234567 → "1 234 567". */
export const groupDigits = (v, sep = ' ') =>
  String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, sep);

/** Duration in seconds → "88 d", "27.3 yr", "1.41 hr". */
export function formatDuration(seconds) {
  const a = Math.abs(seconds);
  if (a < 60) return `${seconds.toFixed(1)} s`;
  if (a < 3600) return `${(seconds / 60).toFixed(1)} min`;
  if (a < 86400) return `${(seconds / 3600).toFixed(2)} hr`;
  if (a < 3.15e7) return `${(seconds / 86400).toFixed(1)} d`;
  return `${(seconds / 3.1557e7).toFixed(2)} yr`;
}

/** Distance in kilometres → human string, auto-scaling units. */
export function formatDistanceKm(km) {
  const a = Math.abs(km);
  if (a < 1000) return `${km.toFixed(0)} km`;
  if (a < 1e6) return `${groupDigits(km)} km`;
  if (a < 1e9) return `${siPrefix(km)}m`;
  if (a < 1.4e11) return `${(km / 1.495978707e8).toFixed(a < 1.4e10 ? 2 : 0)} AU`;
  return `${(km / 9.4607e12).toFixed(a < 9.4e13 ? 3 : 0)} ly`;
}

/** Julian epoch → "17 Oct 1994". */
export function formatEpoch(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${hh}:${mm} UTC`;
}

/** Camera angle → "12.4 Mkm" style distance for the HUD. */
export function formatSceneUnits(units, unitKm = 1e6) {
  const km = units * unitKm;
  return formatDistanceKm(km);
}
