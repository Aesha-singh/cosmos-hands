/**
 * Adaptive quality manager.
 *
 * COSMOS HANDS targets three tiers (high / medium / low) with hysteresis and a
 * cooldown, because a naive "if fps < 40 downgrade" oscillates: lowering the
 * pixel ratio raises the FPS, which immediately re-upgrades, and the user sees
 * a permanent flicker.
 *
 * The policy:
 *   • Track a rolling FPS average over a window.
 *   • Downgrade when the average stays below `downgradeFps` for the whole window.
 *   • Upgrade only when the average is comfortably above `upgradeFps` **and** we
 *     previously downgraded (never upgrade past the machine's detected ceiling).
 *   • Enforce a cooldown so a single hitch cannot cascade.
 *   • Never upgrade after a user-initiated manual override.
 *
 * It also exposes the current tier's particle budgets so scenes can rebuild
 * cheaply after a downgrade.
 *
 * @module core/quality-manager
 */

import { QUALITY } from '../config.js';
import { Emitter } from '../utils/dom.js';

/** @typedef {'high'|'medium'|'low'} QualityTier */

const ORDER = /** @type {QualityTier[]} */ (['low', 'medium', 'high']);

export class QualityManager extends Emitter {
  /**
   * @param {Object} opts
   * @param {import('./renderer.js').Renderer} opts.renderer
   * @param {import('./postprocessing.js').PostPipeline} [opts.pipeline]
   * @param {import('./loop.js').Loop} [opts.loop]
   */
  constructor({ renderer, pipeline, loop }) {
    super();
    this.renderer = renderer;
    this.pipeline = pipeline;
    this.loop = loop;

    /** @type {QualityTier} */
    this.tier = 'high';
    /** The best tier this machine has demonstrated it can hold. */
    this.ceiling = 'high';
    /** Set when the user pins a tier manually; disables auto-adjustment. */
    this.locked = false;
    /** Emitted once when FPS first drops, to show the perf notice. */
    this.warned = false;

    this._cooldownUntil = 0;
    this._downgradeStreak = 0;
    this._upgradeStreak = 0;
    this._now = 0;

    /** Initial guess from the device, so we do not start at 4K on a laptop. */
    this.tier = this._detectInitialTier();
    this.ceiling = this.tier;
    this._apply();
  }

  /**
   * Cheap heuristic for the starting tier. Deliberately conservative: it is
   * much better to start slightly low and step up than to stutter for five
   * seconds on load.
   *
   * @returns {QualityTier}
   */
  _detectInitialTier() {
    const mem = navigator.deviceMemory ?? 8;
    const cores = navigator.hardwareConcurrency ?? 8;
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (mobile || mem <= 4 || cores <= 4) return 'medium';
    // Reduced-motion users are often on lower-power machines.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 'medium';
    return 'high';
  }

  /** @returns {Object} budget numbers for the current tier */
  get budget() {
    return QUALITY.tiers[this.tier];
  }

  /** @returns {number} 0 = low, 1 = medium, 2 = high */
  get tierIndex() {
    return ORDER.indexOf(this.tier);
  }

  /**
   * Feed one frame's statistics.
   *
   * @param {number} dt Seconds.
   * @param {{ fps: number }} stats
   */
  update(dt, stats) {
    this._now += dt;
    if (this.locked) return;

    const fps = stats.fps;
    if (!Number.isFinite(fps) || fps <= 0) return;

    // --- downgrade streak --------------------------------------------------
    if (fps < QUALITY.downgradeFps) {
      this._downgradeStreak += dt;
      this._upgradeStreak = 0;
    } else if (fps > QUALITY.upgradeFps) {
      this._upgradeStreak += dt;
      this._downgradeStreak = 0;
    } else {
      // The dead band between the two thresholds resets both streaks, which is
      // what stops the oscillation described in the module docstring.
      this._downgradeStreak = 0;
      this._upgradeStreak = 0;
    }

    if (this._now < this._cooldownUntil) return;

    if (this._downgradeStreak >= QUALITY.windowSize / 60) {
      this._downgradeStreak = 0;
      if (this.tierIndex > 0) {
        this.setTier(ORDER[this.tierIndex - 1], 'auto-downgrade');
        if (!this.warned) {
          this.warned = true;
          this.emit('warn', this.tier);
        }
      } else {
        // Already at the floor: stop trying, and tell the user we cannot.
        this.emit('floor', fps);
      }
      return;
    }

    // Only ever upgrade back to a tier we have actually held before.
    if (this._upgradeStreak >= (QUALITY.windowSize / 60) * 3) {
      this._upgradeStreak = 0;
      if (this.tierIndex < ORDER.indexOf(this.ceiling)) {
        this.setTier(ORDER[this.tierIndex + 1], 'auto-upgrade');
      }
    }
  }

  /**
   * Apply a tier by name.
   *
   * @param {QualityTier} tier
   * @param {string} [reason] Surfaced in the debug panel.
   */
  setTier(tier, reason = 'manual') {
    if (!QUALITY.tiers[tier]) return false;
    const changed = tier !== this.tier;
    this.tier = tier;
    this._cooldownUntil = this._now + QUALITY.cooldownMs;
    this._apply();
    if (changed) this.emit('change', tier, reason);
    return changed;
  }

  /**
   * Pin a tier and stop auto-adjusting.
   * @param {QualityTier} tier
   */
  lock(tier) {
    this.locked = true;
    this.setTier(tier, 'locked');
    this.ceiling = tier;
  }

  /** Resume automatic adjustment. */
  unlock() {
    this.locked = false;
  }

  /**
   * Cycle low → medium → high → low, for the debug panel button.
   * @returns {QualityTier} the new tier
   */
  cycle() {
    const next = ORDER[(this.tierIndex + 1) % ORDER.length];
    this.lock(next);
    return next;
  }

  /** Push the tier's numbers into the renderer and the post pipeline. */
  _apply() {
    const b = this.budget;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, b.pixelRatio));
    this.pipeline?.applyTier(this.tier);
  }

  /** @returns {Object} for the debug panel */
  snapshot() {
    return {
      tier: this.tier,
      locked: this.locked,
      ceiling: this.ceiling,
      particles: this.budget.galaxyParticles,
      rocks: this.budget.beltRocks,
      pixelRatio: +this.renderer.pixelRatio.toFixed(2),
    };
  }
}
