/**
 * Orbital mechanics — Kepler's laws, solved properly.
 *
 * The solar system is simulated with the *real* two-body solution: the Sun sits
 * at a focus, orbits are ellipses with measured eccentricity and inclination,
 * and mean anomaly advances linearly with time. Kepler's equation
 *
 *     M = E − e·sin E
 *
 * is solved with Newton–Raphson (5 iterations converges to machine precision
 * for every e < 0.25 in the solar system; we fall back to bisection above that).
 *
 * All positions are returned in scene units (see SCALE in config.js).
 *
 * @module utils/orbits
 */

import { TAU, DEG, wrapTau } from './math.js';

/** Seconds in a Julian year (365.25 d), the unit of orbital period. */
export const JULIAN_YEAR = 31_557_600;
/** Seconds in a day. */
export const DAY = 86_400;
/** Seconds in an hour. */
export const HOUR = 3600;

/** Reference epoch: J2000.0 = 2000-01-01T12:00:00Z. */
export const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
/** Milliseconds in a Julian century. */
export const JULIAN_CENTURY_MS = 365.25 * DAY * 1000;

/**
 * A minimal orbit definition.
 *
 * @typedef {Object} OrbitElements
 * @property {number} a       Semi-major axis, in scene units.
 * @property {number} e       Eccentricity, dimensionless (0 = circle, 0.249 = Pluto).
 * @property {number} i       Inclination in degrees, from the ecliptic.
 * @property {number} [Ω]      Longitude of the ascending node, degrees.
 * @property {number} [ω]      Argument of periapsis, degrees.
 * @property {number} [M0]     Mean anomaly at J2000, degrees.
 * @property {number} period   Sidereal orbital period, in seconds.
 * @property {number} [speedup] Visual speed multiplier. 1 = true Keplerian rate.
 *   The scene data picks values that make Neptune's year watchable; set every
 *   orbit's speedup to 1 for REAL SCALE.
 */

/**
 * Result of solving an orbit at one instant.
 *
 * @typedef {Object} OrbitState
 * @property {[number, number, number]} position Heliocentric position, scene units.
 * @property {number} r       Orbital-plane radius, scene units.
 * @property {number} trueAnomaly      True anomaly, degrees.
 * @property {number} eccentricAnomaly Eccentric anomaly, degrees.
 * @property {number} meanAnomaly      Mean anomaly, degrees.
 * @property {number} speed   Speed from the vis-viva equation, scene units/second.
 */

/**
 * Solve Kepler's equation `M = E − e sin E` for the eccentric anomaly.
 *
 * Uses **safeguarded Newton–Raphson**. Because `f(E) = E − e·sin E − M` is
 * strictly increasing on `[0, 2π]` (its derivative `1 − e·cos E ≥ 1 − e > 0`),
 * we can maintain a bracket `[lo, hi]` and fall back to bisection whenever a
 * Newton step escapes it. That makes the solver unconditionally correct for
 * *any* 0 ≤ e < 1 — including the comet-like orbits used by the Kuiper belt —
 * where a bare Newton iteration famously diverges above e ≈ 0.9.
 *
 * @param {number} M Mean anomaly in radians.
 * @param {number} e Eccentricity, 0 ≤ e < 1.
 * @returns {number} Eccentric anomaly in radians, wrapped to [0, 2π).
 */
export function solveKepler(M, e) {
  if (e < 1e-10) return wrapTau(M);

  const M0 = wrapTau(M);
  let lo = 0;
  let hi = TAU;
  // f(0) = −e·sin M  ≤ 0 and f(2π) ≥ 0 for M ∈ [0, 2π], so this bracket holds.
  let E = M0 < Math.PI ? M0 : M0 - Math.PI * 0.5;

  for (let i = 0; i < 48; i++) {
    const f = E - e * Math.sin(E) - M0;
    if (f > 0) hi = E; else lo = E;

    const fp = 1 - e * Math.cos(E);
    let next = fp > 1e-12 ? E - f / fp : (lo + hi) / 2;

    // Safeguard: reject any step outside the bracket and bisect instead.
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    if (Math.abs(next - E) < 1e-14) { E = next; break; }
    E = next;
  }
  return wrapTau(E);
}

/**
 * Mean anomaly at a given simulated time.
 *
 * `M = M0 + n·t` with `n = 2π / period`, the direct consequence of Kepler's
 * second law (equal areas in equal times).
 *
 * @param {OrbitElements} el
 * @param {number} elapsedSeconds Seconds since J2000.
 * @returns {number} Mean anomaly in radians.
 */
export function meanAnomalyAt(el, elapsedSeconds) {
  const n = TAU / el.period;
  return wrapTau(el.M0 * DEG + n * elapsedSeconds * (el.speedup ?? 1));
}

/**
 * Full orbit state at a given time.
 *
 * Steps: mean anomaly → eccentric anomaly → true anomaly → perifocal position →
 * rotate by argument of periapsis, inclination and node into the ecliptic frame.
 *
 * @param {OrbitElements} el
 * @param {number} elapsedSeconds Seconds since J2000.
 * @returns {OrbitState}
 */
export function orbitStateAt(el, elapsedSeconds) {
  const M = meanAnomalyAt(el, elapsedSeconds);
  const E = solveKepler(M, el.e);

  // True anomaly from the eccentric anomaly.
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const trueAnomaly = Math.atan2(
    Math.sqrt(1 - el.e * el.e) * sinE,
    cosE - el.e,
  );

  // Position in the orbital plane, perifocal frame (x → periapsis).
  const xp = el.a * (cosE - el.e);
  const yp = el.a * Math.sqrt(Math.max(0, 1 - el.e * el.e)) * sinE;
  const r = el.a * (1 - el.e * cosE);

  // Rotate perifocal → ecliptic: Rz(Ω) · Rx(i) · Rz(ω).
  const w = el.ω * DEG;
  const O = el.Ω * DEG;
  const inc = el.i * DEG;

  const cw = Math.cos(w), sw = Math.sin(w);
  const cO = Math.cos(O), sO = Math.sin(O);
  const ci = Math.cos(inc), si = Math.sin(inc);

  const x1 = cw * xp - sw * yp;          // Rz(ω)
  const y1 = sw * xp + cw * yp;
  const y2 = ci * y1;                    // Rx(i)
  const z2 = -si * y1;
  const x = cO * x1 - sO * y2;           // Rz(Ω)
  const y = sO * x1 + cO * y2;
  const z = z2;

  // Vis-viva: v² = GM(2/r − 1/a). Normalised by a, period and the speedup so
  // the reported speed matches what the animation actually does.
  const speedup = el.speedup ?? 1;
  const vOrb = (TAU * el.a / el.period) * speedup * Math.sqrt(
    Math.max(0, 2 / Math.max(r, 1e-9) - 1 / el.a),
  );

  return {
    position: [x, y, z],
    r,
    trueAnomaly: trueAnomaly / DEG,
    eccentricAnomaly: E / DEG,
    meanAnomaly: M / DEG,
    speed: vOrb,
  };
}

/**
 * Sample an orbit into a flat XYZ array of points for a `Line` geometry.
 *
 * @param {OrbitElements} el
 * @param {number} segments Number of segments (points = segments + 1).
 * @returns {Float32Array} Flat array of (segments + 1) * 3 floats.
 */
export function sampleOrbit(el, segments = 256) {
  const out = new Float32Array((segments + 1) * 3);
  for (let i = 0; i <= segments; i++) {
    // Sample uniformly in eccentric anomaly: perfectly even spacing on the
    // ellipse, unlike uniform-in-time sampling which bunches at periapsis.
    const E = (i / segments) * TAU;
    const xp = el.a * (Math.cos(E) - el.e);
    const yp = el.a * Math.sqrt(Math.max(0, 1 - el.e * el.e)) * Math.sin(E);
    const p = perifocalToEcliptic(xp, yp, el);
    out[i * 3] = p[0];
    out[i * 3 + 1] = p[1];
    out[i * 3 + 2] = p[2];
  }
  return out;
}

/**
 * Rotate a point from the perifocal orbital plane into the ecliptic frame.
 * Exposed separately so moons can share the planet's rotation chain.
 *
 * @param {number} xp Perifocal X.
 * @param {number} yp Perifocal Y.
 * @param {{i:number, Ω:number, ω:number}} el Orbit elements (i/Ω/ω in degrees).
 * @returns {[number, number, number]}
 */
export function perifocalToEcliptic(xp, yp, el) {
  const w = el.ω * DEG, O = el.Ω * DEG, inc = el.i * DEG;
  const cw = Math.cos(w), sw = Math.sin(w);
  const cO = Math.cos(O), sO = Math.sin(O);
  const ci = Math.cos(inc), si = Math.sin(inc);

  const x1 = cw * xp - sw * yp;
  const y1 = sw * xp + cw * yp;
  const y2 = ci * y1;
  const z2 = -si * y1;
  return [cO * x1 - sO * y2, sO * x1 + cO * y2, z2];
}

/**
 * Sidereal rotation angle of a body at a given time.
 *
 * @param {{rotationPeriod: number, rotationOffset?: number}} body
 *   `rotationPeriod` in seconds per rotation.
 * @param {number} elapsedSeconds Seconds since J2000.
 * @returns {number} Angle in radians.
 */
export function spinAngle(body, elapsedSeconds) {
  const T = body.rotationPeriod;
  if (!T || !Number.isFinite(T)) return 0;
  return wrapTau((TAU * elapsedSeconds) / T + (body.rotationOffset ?? 0));
}

/**
 * Julian centuries since J2000 — the standard argument for precession models.
 *
 * @param {number} ms Epoch in milliseconds.
 * @returns {number} Julian centuries since J2000.
 */
export const julianCenturies = (ms) => (ms - J2000_MS) / JULIAN_CENTURY_MS;

/**
 * Convert a simulation timestamp (ms since J2000) to a JS Date.
 *
 * @param {number} elapsedSeconds Seconds since J2000.
 * @returns {Date}
 */
export const epochToDate = (elapsedSeconds) => new Date(J2000_MS + elapsedSeconds * 1000);

/* -------------------------------------------------------------------------- */
/* Inclination-corrected rotation for the obliquity demo                      */
/* -------------------------------------------------------------------------- */

/**
 * Subsolar latitude for an axial tilt, used by the terminator on Earth-like
 * bodies: at `t` the Sun sits above the given declination.
 *
 * @param {number} obliquityDeg Axial tilt in degrees.
 * @param {number} spinRad Current spin angle in radians.
 * @returns {number} Subsolar latitude in degrees.
 */
export function subsolarLatitude(obliquityDeg, spinRad) {
  return obliquityDeg * Math.cos(spinRad);
}
