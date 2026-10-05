/**
 * Gesture → camera mapping.
 *
 * This is the layer that decides what a gesture *means*, and it is where the
 * feel of the whole app is won or lost. The rules it follows:
 *
 *  • **Relative, not absolute.** An open palm drives the camera by its
 *    *velocity*, not its position. This is why it feels like a joystick instead
 *    of a mouse: your hand can rest anywhere comfortable.
 *  • **Continuous where continuous matters.** Pinch strength and hand openness
 *    feed zoom continuously. Binarised "is pinching" gives a steppy, unusable
 *    zoom.
 *  • **Inertia, then a brake.** Motion persists after the hand stops, and a fist
 *    kills it. Momentum without a brake makes users seasick.
 *  • **One gesture, one job.** Discrete gestures (peace, thumbs-up, point) are
 *    debounced and rate-limited so a held pose fires exactly once.
 *
 * Calibration is deliberately narrow by default. Most users can comfortably
 * reach only the middle of the frame, and mapping the full frame means the user
 * has to strain at the edges to hit the extremes. The active box shrinks that
 * to a comfortable region and centres it on wherever the user is actually
 * moving.
 *
 * @module gestures/gesture-controller
 */

import * as THREE from 'three';
import { CAMERA, GESTURES as GESTURE_CONFIG } from '../config.js';
import { GESTURES, HandSmoother, interHandAngle } from './gesture-vocabulary.js';
import { Emitter } from '../utils/dom.js';
import { clamp, clamp01 } from '../utils/math.js';

export class GestureController extends Emitter {
  /**
   * @param {Object} opts
   * @param {import('./hand-tracker.js').HandTracker} opts.tracker
   * @param {import('../core/camera-rig.js').CameraRig} opts.rig
   */
  constructor({ tracker, rig }) {
    super();
    this.tracker = tracker;
    this.rig = rig;

    this.smoother = new HandSmoother({ response: 0.085 });

    /**
     * Active region, in normalised image coordinates.
     * @type {{ x: number, y: number, w: number, h: number }}
     */
    this.activeBox = { x: 0.2, y: 0.18, w: 0.6, h: 0.64 };

    /** Last accepted position per hand, for velocity estimation. */
    this._last = { Left: null, Right: null };
    /** Velocity per hand, normalised units per second. */
    this._vel = { Left: new THREE.Vector2(), Right: new THREE.Vector2() };
    /** Previous two-hand angle, for twist rate. */
    this._lastAngle = null;
    this._lastTwoHandSpread = null;

    /** Gesture edges: the set of gestures active on the previous frame. */
    this._prevGestures = new Set();
    /** Rate-limit each discrete gesture so a held pose fires once. */
    this._lastFire = new Map();

    /** Held-duration accumulator for point-select. */
    this._selectHeldMs = 0;
    /** Two-hand reset hold. */
    this._resetHeldMs = 0;

    /** Multipliers the debug panel can tweak live. */
    this.gains = {
      orbit: 1,
      zoom: 1,
      pan: 1,
      twist: 1,
    };

    /** True while a selection ray should be drawn. */
    this.aiming = false;
    /** Latest aim point in normalised device coordinates. */
    this.aimPoint = new THREE.Vector2();
    /** Current UI mode: 'navigate' or 'aim'. */
    this.mode = 'navigate';
  }

  /**
   * Run one frame.
   * @param {number} dt Seconds.
   */
  update(dt) {
    const frame = this.tracker.controlFrame();
    const now = performance.now();

    // Velocity is derived from position change per second, then decayed. This
    // is the "joystick" feel: the camera keeps moving while the hand holds still
    // in one place, and stops when the hand stops.
    for (const label of ['Left', 'Right']) {
      const point = frame.points.find((p) => p.handedness === label);
      if (!point) {
        this._last[label] = null;
        this._vel[label].set(0, 0);
        continue;
      }

      const mapped = this._toActive(point.x, point.y);
      const prev = this._last[label];
      if (prev && dt > 1e-4) {
        // Clamp per-frame delta so a re-acquired hand cannot produce a
        // teleport-level velocity spike.
        const dx = clamp((mapped.x - prev.x) / dt, -6, 6);
        const dy = clamp((mapped.y - prev.y) / dt, -6, 6);
        this._vel[label].set(dx, dy);
      } else {
        this._vel[label].set(0, 0);
      }
      this._last[label] = mapped;
    }

    const gestures = this._gatherGestures();
    this._handleDiscrete(gestures, frame, now, dt);
    this._handleContinuous(frame, gestures, dt);
  }

  /**
   * Map a normalised image point into the active box, 0..1 with 0.5 centred.
   * @param {number} x
   * @param {number} y
   */
  _toActive(x, y) {
    const b = this.activeBox;
    return {
      x: clamp01((x - b.x) / Math.max(b.w, 1e-3)),
      y: clamp01((y - b.y) / Math.max(b.h, 1e-3)),
    };
  }

  /**
   * Which gestures are currently active across all hands.
   * @param {Object} frame
   * @returns {Set<string>}
   */
  _gatherGestures() {
    const set = new Set();
    for (const hand of Object.values(this.tracker.hands)) {
      if (hand) set.add(hand.gesture);
    }
    // A pinch on either hand counts.
    if (!set.has(GESTURES.PINCH)) {
      for (const hand of Object.values(this.tracker.hands)) {
        if (hand?.features.pinch > 0.82) { set.add(GESTURES.PINCH); break; }
      }
    }
    return set;
  }

  /**
   * Discrete, one-shot reactions: brake, scene switching, selection, reset.
   * @param {Set<string>} gestures
   * @param {Object} frame
   * @param {number} now
   * @param {number} dt
   */
  _handleDiscrete(gestures, frame, now, dt) {
    // --- fist: brake -------------------------------------------------------
    // The brake is an edge, not a level: it engages on the transition into a
    // fist and releases when the fist ends.
    const braking = gestures.has(GESTURES.FIST);
    this.rig.setBraking(braking);

    // --- scene switching ---------------------------------------------------
    // Fired on entry only, and rate-limited, so holding a peace sign does not
    // cycle through every scene.
    for (const [gesture, direction] of [
      [GESTURES.PEACE, 1],
      [GESTURES.THUMBS_UP, -1],
    ]) {
      const entered = gestures.has(gesture) && !this._prevGestures.has(gesture);
      if (entered && this._mayFire(gesture, now)) {
        this.emit('scene-step', direction);
        this.emit('gesture-fired', gesture, direction);
      }
    }

    // --- point + hold: select ---------------------------------------------
    if (gestures.has(GESTURES.POINT)) {
      this.aiming = true;
      this.mode = 'aim';
      this._selectHeldMs += dt * 1000;
      const hand = this.tracker.hands.Left ?? this.tracker.hands.Right;
      if (hand) {
        // Aim from the index fingertip, in NDC.
        const tip = hand.features.indexTip;
        this.aimPoint.set((1 - tip.x) * 2 - 1, -(tip.y * 2 - 1));
      }
      if (this._selectHeldMs >= GESTURE_CONFIG.selectHoldMs && this._mayFire('select', now)) {
        this.emit('select', this.aimPoint.clone());
        this._selectHeldMs = -GESTURE_CONFIG.selectHoldMs; // Long cooldown after firing.
      }
    } else {
      this.aiming = false;
      this.mode = 'navigate';
      this._selectHeldMs = Math.max(0, this._selectHeldMs - dt * 2000);
    }

    // --- two open palms held: reset the view --------------------------------
    if (frame.twoHand && gestures.has(GESTURES.OPEN_PALM)) {
      this._resetHeldMs += dt * 1000;
      if (this._resetHeldMs >= GESTURE_CONFIG.resetHoldMs && this._mayFire('reset', now)) {
        this.emit('reset-view');
        this._resetHeldMs = -GESTURE_CONFIG.resetHoldMs;
      }
    } else {
      this._resetHeldMs = Math.max(0, this._resetHeldMs - dt * 2000);
    }

    this._prevGestures = gestures;
  }

  /**
   * Continuous camera control from velocity and pinch strength.
   * @param {Object} frame
   * @param {Set<string>} gestures
   * @param {number} dt
   */
  _handleContinuous(frame, gestures, dt) {
    const braking = gestures.has(GESTURES.FIST);
    if (braking) return;

    // --- one hand: orbit, or pinch to zoom --------------------------------
    if (!frame.twoHand) {
      const v = this._dominantVelocity();
      if (frame.points.length === 1) {
        // Image y grows downward; the camera's phi grows looking up, so the
        // vertical sign is inverted. Getting this wrong feels like the mouse
        // controls are upside down, and users do notice.
        this.rig.orbit(v.x * this.gains.orbit, v.y * this.gains.orbit, dt);
      }

      // Pinch zooms continuously. Strength, not a boolean, so a half-closed
      // pinch gives a gentle zoom.
      if (gestures.has(GESTURES.PINCH)) {
        const hand = this.tracker.hands.Left ?? this.tracker.hands.Right;
        const strength = hand?.features.pinch ?? 0;
        // Zoom in as the pinch closes: positive means closer.
        this.rig.zoom((strength - 0.5) * 2.4 * this.gains.zoom);
      }
      this._lastTwoHandSpread = null;
      return;
    }

    // --- two hands: twist to roll, spread to zoom, midpoint to pan ---------
    const [a, b] = frame.points;
    const pa = this._toActive(a.x, a.y);
    const pb = this._toActive(b.x, b.y);

    // Twist: rate of change of the angle between the palms.
    const angle = interHandAngle(pa, pb);
    if (this._lastAngle !== null && dt > 1e-4) {
      // Unwrap so crossing ±π does not spin the camera a full turn.
      let delta = angle - this._lastAngle;
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      this.rig.rollBy(delta * CAMERA.twistSensitivity * this.gains.twist);
    }
    this._lastAngle = angle;

    // Spread: distance between the palms, in normalised units. Zoom rate is the
    // *change* in that distance, so holding your hands apart does not zoom
    // forever.
    const spread = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    if (this._lastTwoHandSpread !== null && dt > 1e-4) {
      const rate = (spread - this._lastTwoHandSpread) / dt;
      this.rig.zoom(-rate * CAMERA.spreadSensitivity * this.gains.zoom);
    }
    this._lastTwoHandSpread = spread;

    // Pan: the midpoint moving drags the focus point.
    const midX = (pa.x + pb.x) / 2 - 0.5;
    const midY = (pa.y + pb.y) / 2 - 0.5;
    this.rig.pan(midX * this.gains.pan, midY * this.gains.pan, dt);
  }

  /** @returns {THREE.Vector2} the faster hand's velocity, normalised */
  _dominantVelocity() {
    const l = this._vel.Left.lengthSq();
    const r = this._vel.Right.lengthSq();
    return l >= r ? this._vel.Left : this._vel.Right;
  }

  /**
   * Rate limit for a discrete action.
   * @param {string} key
   * @param {number} now
   * @returns {boolean} true if it may fire
   */
  _mayFire(key, now) {
    const last = this._lastFire.get(key) ?? -Infinity;
    if (now - last < GESTURE_CONFIG.fireDebounceMs) return false;
    this._lastFire.set(key, now);
    return true;
  }

  /**
   * Recalibrate the active box to the region the user is actually using.
   * Called from the calibration flow.
   *
   * @param {Array<{x:number, y:number}>} samples Normalised image points.
   * @param {number} [padding]
   */
  calibrate(samples, padding = 0.12) {
    if (!samples.length) return this.activeBox;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const s of samples) {
      minX = Math.min(minX, s.x);
      maxX = Math.max(maxX, s.x);
      minY = Math.min(minY, s.y);
      maxY = Math.max(maxY, s.y);
    }
    const w = Math.max(maxX - minX, 0.08);
    const h = Math.max(maxY - minY, 0.08);
    this.activeBox = {
      x: clamp01(minX - w * padding),
      y: clamp01(minY - h * padding),
      w: clamp01(w * (1 + padding * 2)),
      h: clamp01(h * (1 + padding * 2)),
    };
    this.emit('calibrated', { ...this.activeBox });
    return this.activeBox;
  }

  /** Restore the default comfortable region. */
  resetCalibration() {
    this.activeBox = { x: 0.2, y: 0.18, w: 0.6, h: 0.64 };
    this.emit('calibrated', { ...this.activeBox });
  }

  /** @returns {Object} for the debug panel */
  snapshot() {
    return {
      mode: this.mode,
      gains: { ...this.gains },
      box: { ...this.activeBox },
      velocities: {
        Left: +this._vel.Left.length().toFixed(2),
        Right: +this._vel.Right.length().toFixed(2),
      },
      aiming: this.aiming,
      selectHeld: Math.round(this._selectHeldMs),
    };
  }
}

export { GESTURES };
