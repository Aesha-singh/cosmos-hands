/**
 * One Euro Filter — Casiez, Roussel & Vogel (CHI 2012).
 *
 * The right tool for hand tracking, and the reason this project does not feel
 * like a 1998 screensaver.
 *
 * A plain low-pass filter forces you to choose between jitter and lag: heavy
 * smoothing gives you a rock-steady hand but a cursor that trails behind your
 * actual finger. One Euro solves that by making the cutoff frequency depend on
 * the *speed* of the signal:
 *
 *     cutoff = minCutoff + beta · |dx/dt|
 *
 * So when your hand is still, the cutoff is low (maximum smoothing → no jitter);
 * when it moves fast, the cutoff rises (minimum smoothing → no lag). The result
 * is a signal that is smooth at rest and immediate in motion, from a single pair
 * of constants.
 *
 * Every one of the 42 landmarks in a two-hand frame gets its own filter
 * instance (x, y, z), which is why this module is written to be allocation-free
 * after construction.
 *
 * @module gestures/oneEuroFilter
 */

import { TAU } from '../utils/math.js';

/**
 * First-order low-pass with an exponential coefficient derived from a cutoff.
 *
 * @param {number} alpha Cutoff frequency in Hz.
 * @param {number} dt Sampling interval in seconds.
 * @returns {number} Smoothing factor in (0, 1].
 */
export function smoothingFactor(alpha, dt) {
  const tau = 1 / (TAU * alpha);
  return 1 / (1 + tau / dt);
}

/**
 * Scalar One Euro filter.
 */
export class LowPass {
  /**
   * @param {number} [alpha] Initial smoothing factor.
   */
  constructor(alpha = 1) {
    this.alpha = alpha;
    /** @type {number|null} */
    this.y = null;
  }

  /**
   * @param {number} value
   * @param {number} alpha Smoothing factor in (0, 1].
   * @returns {number} Filtered value.
   */
  filter(value, alpha) {
    const a = alpha ?? this.alpha;
    this.y = this.y === null ? value : a * value + (1 - a) * this.y;
    return this.y;
  }

  /** Forget history (e.g. when a hand disappears and reappears). */
  reset() {
    this.y = null;
  }

  /** @param {number} alpha */
  setAlpha(alpha) {
    this.alpha = alpha;
  }

  /** @returns {boolean} whether a value has been seen. */
  get initialised() {
    return this.y !== null;
  }
}

/**
 * One Euro filter over a 3-vector (x, y, z).
 *
 * @typedef {[number, number, number]} Vec3
 */

export class OneEuroFilter3 {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.minCutoff] Cutoff at zero speed, Hz. Higher = smoother
   *   when the hand is still. Typical range 1.0–3.0.
   * @param {number} [opts.beta] Speed coefficient. Higher = less lag when
   *   moving fast. Typical range 0.005–0.05.
   * @param {number} [opts.dCutoff] Cutoff for the derivative estimate, Hz.
   */
  constructor({ minCutoff = 1.7, beta = 0.012, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;

    /** @type {LowPass[]} */
    this.x = [new LowPass(), new LowPass(), new LowPass()];
    /** Derivative filters, one per axis. */
    this.dx = [new LowPass(), new LowPass(), new LowPass()];
    /** @type {Vec3|null} */
    this.lastValue = null;
    /** @type {Vec3|null} */
    this.lastDerivative = null;
    /** Reusable derivative output, so no per-sample allocation. */
    this._derivHat = /** @type {Vec3} */ ([0, 0, 0]);
    /** Reusable output, likewise. */
    this._out = /** @type {Vec3} */ ([0, 0, 0]);
    /** Total speed magnitude, units/second — read by the debug panel. */
    this.speed = 0;
  }

  /**
   * Filter one sample.
   *
   * @param {Vec3} value `[x, y, z]` in normalised image coordinates (or any
   *   consistent unit; the filter does not care).
   * @param {number} dt Seconds since the previous sample. Clamped internally so
   *   a dropped frame cannot produce a NaN.
   * @returns {Vec3} Filtered `[x, y, z]`, written into a reusable array.
   */
  filter(value, dt) {
    // Guard: a 0 or negative dt (first frame, duplicate timestamp) would divide
    // by zero below.
    const h = Math.min(Math.max(dt, 1e-4), 0.5);
    const dAlpha = smoothingFactor(this.dCutoff, h);

    // --- pass 1: derivatives of the raw signal ---------------------------
    // All three axes must be filtered before we can know the total speed, since
    // the adaptive cutoff is driven by the *magnitude* of motion.
    for (let axis = 0; axis < 3; axis++) {
      const prev = this.lastValue ? this.lastValue[axis] : value[axis];
      const deriv = (value[axis] - prev) / h;
      this._derivHat[axis] = this.dx[axis].filter(deriv, dAlpha);
    }
    this.speed = Math.hypot(this._derivHat[0], this._derivHat[1], this._derivHat[2]);

    // --- pass 2: adaptive low pass ---------------------------------------
    const cutoff = this.minCutoff + this.beta * this.speed;
    const alpha = smoothingFactor(cutoff, h);
    for (let axis = 0; axis < 3; axis++) {
      this._out[axis] = this.x[axis].filter(value[axis], alpha);
    }

    this.lastValue = [value[0], value[1], value[2]];
    this.lastDerivative = [this._derivHat[0], this._derivHat[1], this._derivHat[2]];
    return this._out;
  }

  /** Forget all history — call when a hand is lost. */
  reset() {
    this.x.forEach((l) => l.reset());
    this.dx.forEach((l) => l.reset());
    this.lastValue = null;
    this.lastDerivative = null;
    this.speed = 0;
  }

  /** Live-tune from the debug panel. */
  setParams({ minCutoff, beta, dCutoff } = {}) {
    if (minCutoff !== undefined) this.minCutoff = minCutoff;
    if (beta !== undefined) this.beta = beta;
    if (dCutoff !== undefined) this.dCutoff = dCutoff;
  }
}

/**
 * A bank of One Euro filters — one per landmark of one hand.
 */
export class LandmarkFilterBank {
  /**
   * @param {number} count Number of landmarks (21 for MediaPipe Hands).
   * @param {{ minCutoff?: number, beta?: number, dCutoff?: number }} [opts]
   */
  constructor(count = 21, opts = {}) {
    this.count = count;
    this.opts = opts;
    /** @type {OneEuroFilter3[]} */
    this.filters = Array.from({ length: count }, () => new OneEuroFilter3(opts));
    /** Reusable output buffer — avoids 21 array allocations per frame. */
    this.out = Array.from({ length: count }, () => [0, 0, 0]);
    /** Mean landmark speed, for the debug panel. */
    this.meanSpeed = 0;
  }

  /**
   * Filter a whole hand.
   *
   * @param {ReadonlyArray<{x:number, y:number, z:number}>} landmarks
   * @param {number} dt Seconds since the previous frame.
   * @returns {Array<[number,number,number]>} Filtered landmarks (reused buffers).
   */
  filter(landmarks, dt) {
    const n = Math.min(landmarks.length, this.count);
    let speedSum = 0;
    for (let i = 0; i < n; i++) {
      const lm = landmarks[i];
      const filtered = this.filters[i].filter([lm.x, lm.y, lm.z], dt);
      this.out[i][0] = filtered[0];
      this.out[i][1] = filtered[1];
      this.out[i][2] = filtered[2];
      speedSum += this.filters[i].speed;
    }
    this.meanSpeed = n ? speedSum / n : 0;
    return this.out;
  }

  /** Reset every filter — used when the hand leaves the frame. */
  reset() {
    this.filters.forEach((f) => f.reset());
    this.meanSpeed = 0;
  }

  /** Live-tune from the debug panel. */
  setParams(params) {
    this.opts = { ...this.opts, ...params };
    this.filters.forEach((f) => f.setParams(params));
  }
}
