/**
 * Six-step calibration.
 *
 * The problem calibration solves is not "is the model accurate" but "does the
 * *active region* match where this particular person can comfortably reach".
 * A model works fine for a 1.9 m user with long arms and badly for a 1.5 m user
 * seated at a laptop, because the mapping from screen to camera response is
 * fixed but their comfortable hand span is not.
 *
 * The steps collect:
 *   1. Open palm — establishes that tracking works at all, and gives a
 *      baseline palm size and position.
 *   2–5. The four corners of the reachable region, in order. These determine
 *      the active box.
 *   6. Pinch — confirms pinch is detectable and calibrates its threshold,
 *      because pinch distance is the one gesture whose scale varies most
 *      between hands and camera positions.
 *
 * Each step requires the pose to be *held* for a duration rather than merely
 * detected once, because users are still moving when a step appears.
 *
 * @module ui/calibration
 */

import { GESTURES, GESTURE_LABELS } from '../gestures/gesture-vocabulary.js';
import { $, el, on, setText, toggle } from '../utils/dom.js';
import { Emitter } from '../utils/dom.js';
import { clamp01 } from '../utils/math.js';

/** @typedef {Object} CalibStep
 * @property {string} id
 * @property {string} title
 * @property {string} hint
 * @property {string} gesture Gesture that satisfies the step.
 * @property {number} holdMs
 * @property {'corner'|'spread'|'none'} capture What to record while holding.
 * @property {string} [corner] Which corner, when capture is 'corner'.
 */

/** @type {CalibStep[]} */
export const CALIBRATION_STEPS = [
  {
    id: 'open',
    title: 'Open palm',
    hint: 'Hold your open palm toward the camera, about an arm\'s length away.',
    gesture: GESTURES.OPEN_PALM,
    holdMs: 900,
    capture: 'none',
  },
  {
    id: 'tl',
    title: 'Top left',
    hint: 'Move your open palm to the top-left of the frame and hold.',
    gesture: GESTURES.OPEN_PALM,
    holdMs: 700,
    capture: 'corner',
    corner: 'tl',
  },
  {
    id: 'tr',
    title: 'Top right',
    hint: 'Now the top-right.',
    gesture: GESTURES.OPEN_PALM,
    holdMs: 700,
    capture: 'corner',
    corner: 'tr',
  },
  {
    id: 'br',
    title: 'Bottom right',
    hint: 'Now the bottom-right.',
    gesture: GESTURES.OPEN_PALM,
    holdMs: 700,
    capture: 'corner',
    corner: 'br',
  },
  {
    id: 'bl',
    title: 'Bottom left',
    hint: 'And finally the bottom-left.',
    gesture: GESTURES.OPEN_PALM,
    holdMs: 700,
    capture: 'corner',
    corner: 'bl',
  },
  {
    id: 'pinch',
    title: 'Pinch',
    hint: 'Pinch thumb to index finger and hold, so we learn your pinch scale.',
    gesture: GESTURES.PINCH,
    holdMs: 900,
    capture: 'pinch',
  },
];

export class Calibration extends Emitter {
  /**
   * @param {Object} opts
   * @param {import('../gestures/hand-tracker.js').HandTracker} opts.tracker
   */
  constructor({ tracker }) {
    super();
    this.tracker = tracker;

    this.root = $('#calibration');
    this.index = $('#calib-index');
    this.total = $('#calib-total');
    this.glyph = $('#calib-glyph');
    this.title = $('#calib-title');
    this.hint = $('#calib-hint');
    this.meter = $('#calib-meter-fill');
    this.status = $('#calib-status');
    this.nextBtn = $('#btn-calib-next');
    this.skipBtn = $('#btn-calib-skip');
    this.video = $('#calib-video');

    /** @type {number} */
    this.step = -1;
    /** ms the current pose has been held. */
    this._heldMs = 0;
    this._active = false;

    /** Collected samples, handed to the controller when done. */
    this.samples = { points: [], pinch: null };

    this._bind();
  }

  _bind() {
    on(this.nextBtn, 'click', () => this.advance());
    on(this.skipBtn, 'click', () => this.finish({ skipped: true }));
  }

  /** Show the flow. */
  start() {
    this.samples = { points: [], pinch: null };
    this.step = -1;
    this._active = true;
    toggle(this.root, true, 'is-live');
    this.root.hidden = false;
    if (this.total) setText(this.total, String(CALIBRATION_STEPS.length));
    // Route the tracker's stream into the preview so users see themselves.
    if (this.video && this.tracker.video?.srcObject) {
      this.video.srcObject = this.tracker.video.srcObject;
      this.video.play().catch(() => { /* autoplay of a muted stream */ });
    }
    this._nextStep();
    this.emit('start');
  }

  /** Hide without collecting anything. */
  cancel() {
    this._active = false;
    this.root.hidden = true;
    this.root.classList.remove('is-live');
    this.emit('cancel');
  }

  _nextStep() {
    this.step++;
    if (this.step >= CALIBRATION_STEPS.length) {
      this.finish({ skipped: false });
      return;
    }
    const step = CALIBRATION_STEPS[this.step];
    this._heldMs = 0;

    if (this.index) setText(this.index, String(this.step + 1));
    if (this.title) setText(this.title, step.title);
    if (this.hint) setText(this.hint, step.hint);
    if (this.glyph) setText(this.glyph, GESTURE_LABELS[step.gesture]?.icon ?? '✋');
    if (this.status) setText(this.status, 'show me');
    if (this.nextBtn) {
      this.nextBtn.disabled = true;
      this.nextBtn.textContent = step === CALIBRATION_STEPS.length - 1 ? 'Finish' : 'Skip this step';
    }
    if (this.meter) this.meter.style.width = '0%';
  }

  /** Skip the current step without recording it. */
  advance() {
    this._nextStep();
  }

  /**
   * Called every frame while active.
   * @param {number} dt Seconds.
   */
  update(dt) {
    if (!this._active || this.step < 0) return;
    const step = CALIBRATION_STEPS[this.step];
    if (!step) return;

    const hand = this.tracker.hands.Left ?? this.tracker.hands.Right;
    const satisfied = Boolean(hand) && hand.gesture === step.gesture;

    if (satisfied) {
      this._heldMs += dt * 1000;
      this._capture(step, hand);
      if (this.status) {
        setText(this.status, `hold… ${Math.max(0, step.holdMs - this._heldMs) / 1000 | 0}s`);
      }
    } else {
      // Decay rather than reset: one dropped frame mid-hold should not throw
      // away two seconds of progress.
      this._heldMs = Math.max(0, this._heldMs - dt * 900);
      if (this.status) {
        setText(this.status, hand
          ? `show me: ${GESTURE_LABELS[step.gesture]?.label.toLowerCase() ?? step.gesture}`
          : 'looking for your hand…');
      }
    }

    const progress = clamp01(this._heldMs / step.holdMs);
    if (this.meter) this.meter.style.width = `${(progress * 100).toFixed(1)}%`;
    if (this.nextBtn) this.nextBtn.disabled = progress < 0.999;

    if (progress >= 1) this._nextStep();
  }

  /**
   * Record what this step is measuring.
   * @param {CalibStep} step
   * @param {Object} hand
   */
  _capture(step, hand) {
    const c = hand.features.palmCentre;
    // Mirrored, because the preview and the overlay are mirrored.
    const point = { x: 1 - c.x, y: c.y };

    switch (step.capture) {
      case 'corner':
        this.samples.points.push(point);
        break;
      case 'pinch':
        this.samples.pinch = {
          distance: hand.features.pinchDistance,
          palmWidth: hand.metrics.palmWidth,
          pinch: hand.features.pinch,
        };
        break;
      case 'none':
      default:
        break;
    }
  }

  /**
   * @param {Object} [opts]
   * @param {boolean} [opts.skipped]
   */
  finish({ skipped = false } = {}) {
    this._active = false;
    this.root.hidden = true;
    this.root.classList.remove('is-live');
    // Detach the preview stream so the HUD mini-preview keeps its own.
    if (this.video) this.video.srcObject = null;

    const result = {
      points: this.samples.points,
      pinch: this.samples.pinch,
      skipped,
      complete: this.samples.points.length >= 4,
    };
    this.emit('finish', result);
    return result;
  }

  /** @returns {boolean} */
  get active() { return this._active; }

  /** @returns {number} 0..1 */
  get progress() {
    if (!this._active || this.step < 0) return 0;
    const step = CALIBRATION_STEPS[this.step];
    return clamp01((this.step + (step ? this._heldMs / step.holdMs : 0)) / CALIBRATION_STEPS.length);
  }
}