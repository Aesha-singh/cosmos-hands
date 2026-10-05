/**
 * The render loop.
 *
 * Three clocks, deliberately separated:
 *
 *  1. **Render loop** — `requestAnimationFrame`, target 60 fps. Advances the
 *     camera rig, updates scene uniforms, draws.
 *  2. **Simulation clock** — decoupled from frames. `dt` is clamped to 50 ms so
 *     a tab-switch or a GC pause can never teleport the planets.
 *  3. **Hand-tracking loop** — its own cadence (30 fps), in `gestures/`. Hand
 *     inference must never be allowed to steal render frames.
 *
 * The loop also handles tab visibility (stop rendering entirely) and reports a
 * rolling FPS average to the quality manager.
 *
 * @module core/loop
 */

import { Emitter } from '../utils/dom.js';
import { clamp } from '../utils/math.js';

/**
 * @typedef {Object} LoopStats
 * @property {number} fps        Rolling average frames per second.
 * @property {number} frameMs    Rolling average milliseconds per frame.
 * @property {number} delta      Seconds for this frame (clamped).
 * @property {number} elapsed    Total seconds since start.
 * @property {number} frames     Total frames rendered.
 * @property {boolean} running
 */

export class Loop extends Emitter {
  /**
   * @param {Object} opts
   * @param {(dt: number, elapsed: number) => void} opts.onFrame
   * @param {number} [opts.maxDelta] Largest simulated step, seconds.
   * @param {number} [opts.fpsWindow] Samples in the rolling average.
   */
  constructor({ onFrame, maxDelta = 0.05, fpsWindow = 90 }) {
    super();
    this.onFrame = onFrame;
    this.maxDelta = maxDelta;
    this.fpsWindow = fpsWindow;

    /** @type {LoopStats} */
    this.stats = {
      fps: 60, frameMs: 16.7, delta: 0, elapsed: 0, frames: 0, running: false,
    };

    this._raf = 0;
    this._last = 0;
    this._samples = new Float32Array(fpsWindow);
    this._sampleIdx = 0;
    this._sampleCount = 0;
    this._boundTick = this._tick.bind(this);

    this._onVisibility = () => {
      if (document.hidden) this.stop();
      else this.start();
    };
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  /** Begin rendering. */
  start() {
    if (this.stats.running) return;
    this.stats.running = true;
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._boundTick);
    this.emit('start');
  }

  /** Stop rendering. The simulation clock also stops — no jump on resume. */
  stop() {
    if (!this.stats.running) return;
    this.stats.running = false;
    cancelAnimationFrame(this._raf);
    this.emit('stop');
  }

  /**
   * One frame.
   * @param {number} now High-resolution timestamp, ms.
   */
  _tick(now) {
    if (!this.stats.running) return;

    const rawMs = now - this._last;
    this._last = now;

    // Rolling average, using a circular buffer: O(1), no allocation per frame.
    this._samples[this._sampleIdx] = rawMs;
    this._sampleIdx = (this._sampleIdx + 1) % this.fpsWindow;
    if (this._sampleCount < this.fpsWindow) this._sampleCount++;

    let sum = 0;
    for (let i = 0; i < this._sampleCount; i++) sum += this._samples[i];
    const avgMs = sum / Math.max(this._sampleCount, 1);

    this.stats.frameMs = avgMs;
    this.stats.fps = avgMs > 0 ? 1000 / avgMs : 0;
    // Clamp the simulation step: a 4-second GC pause must not fling Neptune
    // into the Sun.
    this.stats.delta = clamp(rawMs / 1000, 0, this.maxDelta);
    this.stats.elapsed += this.stats.delta;
    this.stats.frames++;

    try {
      this.onFrame(this.stats.delta, this.stats.elapsed, this.stats);
    } catch (err) {
      this.stop();
      this.emit('error', err);
      throw err;
    }

    this._raf = requestAnimationFrame(this._boundTick);
  }

  /**
   * Force an immediate frame — used after a resize so the user does not see a
   * one-frame stretched image.
   */
  kick() {
    if (this.stats.running) {
      cancelAnimationFrame(this._raf);
      this._last = performance.now();
      this._raf = requestAnimationFrame(this._boundTick);
    }
  }

  /** @returns {LoopStats} */
  snapshot() {
    return {
      fps: +this.stats.fps.toFixed(1),
      frameMs: +this.stats.frameMs.toFixed(2),
      frames: this.stats.frames,
      elapsed: +this.stats.elapsed.toFixed(2),
    };
  }

  /** Tear down. */
  dispose() {
    this.stop();
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.clear();
  }
}

/**
 * A fixed-rate scheduler for the hand tracker.
 *
 * MediaPipe inference is expensive (10–20 ms). Running it inside rAF would
 * halve the render rate; running it too fast would saturate the GPU. This
 * scheduler ticks from rAF but only *runs work* when the budget has elapsed,
 * which keeps it aligned with the compositor without over-sampling.
 */
export class RateLimiter {
  /**
   * @param {number} targetFps
   */
  constructor(targetFps = 30) {
    this.intervalMs = 1000 / targetFps;
    this.last = 0;
  }

  /** @param {number} targetFps */
  setTarget(targetFps) {
    this.intervalMs = 1000 / Math.max(targetFps, 1);
  }

  /**
   * @param {number} now High-resolution timestamp, ms.
   * @returns {boolean} true if work should run now.
   */
  shouldRun(now) {
    if (now - this.last < this.intervalMs) return false;
    this.last = now;
    return true;
  }

  /** Actual achieved rate, for the debug panel. */
  get achievedFps() {
    return this.intervalMs > 0 ? 1000 / this.intervalMs : 0;
  }
}
