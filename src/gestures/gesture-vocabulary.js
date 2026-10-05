/**
 * Hand-gesture vocabulary and classifier.
 *
 * MediaPipe ships a 21-landmark hand skeleton and a separate canned gesture
 * model, but the canned model only knows a closed vocabulary (and costs extra
 * WASM to load). A small hand-rolled classifier off the skeleton is both more
 * responsive and gives us *continuous* values — pinch strength, hand openness,
 * spread angle — which is what actually makes continuous camera control feel
 * good. Binarised "Pinch" would give you a steppy zoom; continuous pinch gives
 * you a smooth one.
 *
 * Every discrete gesture is decided with **hysteresis**: it needs a different
 * number of normalised finger extensions to enter than to stay. Without that,
 * a hand resting near a threshold flickers between two states and the camera
 * stutters.
 *
 * Landmark indices follow MediaPipe Hands:
 *
 * ```
 *  0 wrist        5 index_mcp     9  middle_mcp    13 ring_mcp    17 pinky_mcp
 *  1 thumb_cmc    6 index_pip    10  middle_pip   14  ring_pip    18  pinky_pip
 *  2 thumb_mcp    7 index_dip    11  middle_dip   15  ring_dip    19  pinky_dip
 *  3 thumb_ip     8 index_tip    12  middle_tip   16  ring_tip    20  pinky_tip
 *  4 thumb_tip
 * ```
 *
 * @module gestures/gesture-vocabulary
 */

import { Vector3 } from 'three';
import { clamp, clamp01, lerp, smoothstep, TAU } from '../utils/math.js';

export const LM = Object.freeze({
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
});

/**
 * @typedef {Object} FingerState
 * @property {boolean} extended Whether the finger counts as extended.
 * @property {number}  curl      0 (straight) → 1 (fully curled).
 */

/**
 * @typedef {Object} HandFeatures
 * @property {FingerState[]} fingers  [thumb, index, middle, ring, pinky]
 * @property {number} openness        Mean curl of the four fingers, 0 open → 1 closed.
 * @property {number} pinch           0 → 1 pinch strength.
 * @property {number} pinchDistance   Raw thumb-tip ↔ index-tip distance, normalised.
 * @property {number} spread          Angle between index and pinky, radians.
 * @property {boolean} palmFacing     Palm normal points toward the camera.
 * @property {Vector3} palmNormal     Unit palm normal in world/camera space.
 * @property {Vector3} palmCentre     Average of wrist and the four MCPs.
 * @property {Vector3} indexTip
 * @property {Vector3} middleTip
 * @property {boolean} thumbExtended
 */

/** Named gestures the app reacts to. */
export const GESTURES = Object.freeze({
  OPEN_PALM: 'open_palm',
  FIST: 'fist',
  PINCH: 'pinch',
  PEACE: 'peace',
  POINT: 'point',
  THUMBS_UP: 'thumbs_up',
});

export const GESTURE_LABELS = Object.freeze({
  [GESTURES.OPEN_PALM]: { label: 'Open Palm', hint: 'Orbit the universe', icon: '✋' },
  [GESTURES.FIST]: { label: 'Fist', hint: 'Brake — stop all motion', icon: '✊' },
  [GESTURES.PINCH]: { label: 'Pinch', hint: 'Zoom in and out', icon: '🤏' },
  [GESTURES.PEACE]: { label: 'Peace', hint: 'Switch scene forward', icon: '✌️' },
  [GESTURES.POINT]: { label: 'Point', hint: 'Aim and select', icon: '☝️' },
  [GESTURES.THUMBS_UP]: { label: 'Thumbs Up', hint: 'Cycle scenes back', icon: '👍' },
});

/** Flexion angles bounding the curl remap, radians. */
const CURL = Object.freeze({
  /** Below this a finger counts as straight. */
  straightRad: 0.42,
  /** At or above this a finger counts as fully folded. */
  foldedRad: 1.25,
});

/** Thresholds. Distances are in palm widths; angles are radians. */
const THRESHOLDS = {
  /** Finger counts as extended when tip is beyond the PIP joint this far. */
  extendOn: 0.98,
  extendOff: 0.84,
  /** Finger counts as curled when the tip falls this close to the palm centre. */
  curlOn: 0.62,
  curlOff: 0.78,
  /** Thumb/index tips are pinching below this distance. */
  pinchOn: 0.38,
  pinchOff: 0.55,
  /** Finger-extension counts that define each pose. */
  palmOn: 4, palmOff: 3,
  fistOn: 0, fistOff: 1,
  peaceOn: 2, peaceOff: 3,
  pointOn: 1, pointOff: 2,
  /** Palm normal dot product with the view direction. */
  palmFacingOn: 0.35, palmFacingOff: 0.05,
  /** Thumb direction along the palm axis needed to call it a thumbs-up. */
  thumbUpOn: 0.35,
};

// Scratch vectors — the classifier runs 30×/second for two hands, so it must
// not allocate.
const _a = new Vector3();
const _b = new Vector3();
const _n = new Vector3();
const _mcp = new Vector3();
const _mcpMean = new Vector3();

/** Distance between two landmark arrays, in normalised image space. */
function dist(lm, i, j) {
  return Math.hypot(lm[i].x - lm[j].x, lm[i].y - lm[j].y, lm[i].z - lm[j].z);
}

/**
 * Classify one hand.
 *
 * @param {ReadonlyArray<{x:number,y:number,z:number}>} landmarks 21 landmarks.
 * @param {Object} [state] Previously returned state, mutated for hysteresis.
 * @returns {{ features: HandFeatures, discrete: string, metrics: Object }}
 */
export function classifyHand(landmarks, state = {}) {
  if (!landmarks || landmarks.length < 21) {
    return { features: emptyFeatures(), discrete: GESTURES.OPEN_PALM, metrics: {} };
  }

  // --- scale reference -----------------------------------------------------
  // Palm width (index MCP → pinky MCP) is the natural unit: it does not change
  // as a hand rotates, unlike distance from the wrist, so every threshold below
  // is stable whether the hand is 30 cm or 2 m from the camera.
  const palmWidth = Math.max(dist(landmarks, LM.INDEX_MCP, LM.PINKY_MCP), 1e-4);

  // --- palm frame ----------------------------------------------------------
  _mcpMean.set(0, 0, 0);
  for (const idx of [LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP]) {
    _mcp.set(landmarks[idx].x, landmarks[idx].y, landmarks[idx].z);
    _mcpMean.add(_mcp);
  }
  _mcpMean.multiplyScalar(0.25);

  // Palm normal from the cross product of two palm-plane vectors. Using the MCP
  // quad rather than (wrist, middle MCP) keeps it stable when the wrist flexes.
  _a.set(
    landmarks[LM.INDEX_MCP].x - landmarks[LM.PINKY_MCP].x,
    landmarks[LM.INDEX_MCP].y - landmarks[LM.PINKY_MCP].y,
    landmarks[LM.INDEX_MCP].z - landmarks[LM.PINKY_MCP].z,
  );
  _b.set(
    landmarks[LM.WRIST].x - landmarks[LM.MIDDLE_MCP].x,
    landmarks[LM.WRIST].y - landmarks[LM.MIDDLE_MCP].y,
    landmarks[LM.WRIST].z - landmarks[LM.MIDDLE_MCP].z,
  );
  _n.crossVectors(_a, _b);
  if (_n.lengthSq() < 1e-10) _n.set(0, 0, 1); else _n.normalize();

  // --- finger extension ----------------------------------------------------
  // A finger is extended when its tip sits further from the wrist than its PIP
  // joint does, measured along the finger's own axis. Comparing 3-D distances
  // from the wrist (rather than a 2-D screen-space test) is what lets this work
  // when the palm faces the camera *or* the user.
  const fingers = [
    curlOf(landmarks, LM.THUMB_MCP, LM.THUMB_IP, LM.THUMB_TIP),
    curlOf(landmarks, LM.INDEX_MCP, LM.INDEX_PIP, LM.INDEX_TIP),
    curlOf(landmarks, LM.MIDDLE_MCP, LM.MIDDLE_PIP, LM.MIDDLE_TIP),
    curlOf(landmarks, LM.RING_MCP, LM.RING_PIP, LM.RING_TIP),
    curlOf(landmarks, LM.PINKY_MCP, LM.PINKY_PIP, LM.PINKY_TIP),
  ];

  const prev = /** @type {boolean[]} */ (state.extended ?? [false, false, false, false, false]);

  // Hysteresis: a finger switches on at curlOn and off at curlOff, so a hand
  // hovering at the boundary does not chatter.
  const extended = fingers.map((f, i) => {
    const wasExtended = prev[i];
    return wasExtended ? f.curl <= THRESHOLDS.curlOff : f.curl < THRESHOLDS.curlOn;
  });
  state.extended = extended;

  const [thumb, index, middle, ring, pinky] = extended;
  const fingerCount = extended.reduce((n, e) => n + (e ? 1 : 0), 0);
  const nonThumbCount = (index ? 1 : 0) + (middle ? 1 : 0) + (ring ? 1 : 0) + (pinky ? 1 : 0);

  // Openness: the *mean curl* of the four fingers, not a boolean. This is the
  // continuous signal the camera uses, so a half-open hand moves smoothly.
  const openness = clamp01((fingers[1].curl + fingers[2].curl + fingers[3].curl + fingers[4].curl) / 4);

  // --- pinch ---------------------------------------------------------------
  const pinchDistance = dist(landmarks, LM.THUMB_TIP, LM.INDEX_TIP) / palmWidth;
  const wasPinching = state.pinching ?? false;
  const pinching = wasPinching
    ? pinchDistance < THRESHOLDS.pinchOff
    : pinchDistance < THRESHOLDS.pinchOn;
  state.pinching = pinching;
  // Continuous 0..1: 0 wide open, 1 fully closed. Drives smooth zoom.
  const pinch = 1 - smoothstep(THRESHOLDS.pinchOff * 0.6, THRESHOLDS.pinchOn * 1.5, pinchDistance);

  // --- spread --------------------------------------------------------------
  // The fan angle between the index and pinky fingers: the angle between the
  // direction each points away from its knuckle. Measuring it between the
  // index and pinky *knuckles* relative to the palm centre does not work — the
  // palm centre sits between them, so those two vectors are anti-parallel and
  // the angle is always pi regardless of the pose.
  _a.set(
    landmarks[LM.INDEX_PIP].x - landmarks[LM.INDEX_MCP].x,
    landmarks[LM.INDEX_PIP].y - landmarks[LM.INDEX_MCP].y,
    landmarks[LM.INDEX_PIP].z - landmarks[LM.INDEX_MCP].z,
  );
  _b.set(
    landmarks[LM.PINKY_PIP].x - landmarks[LM.PINKY_MCP].x,
    landmarks[LM.PINKY_PIP].y - landmarks[LM.PINKY_MCP].y,
    landmarks[LM.PINKY_PIP].z - landmarks[LM.PINKY_MCP].z,
  );
  const spread = _a.lengthSq() < 1e-9 || _b.lengthSq() < 1e-9
    ? 0
    : Math.acos(clamp(_a.normalize().dot(_b.normalize()), -1, 1));


  // --- palm facing hysteresis ---------------------------------------------
  const wasFacing = state.palmFacing ?? false;
  const faceNow = wasFacing
    ? _n.z < THRESHOLDS.palmFacingOff
    : _n.z < -THRESHOLDS.palmFacingOn;
  state.palmFacing = faceNow;

  const features = {
    fingers: fingers.map((f, i) => ({ extended: extended[i], curl: f.curl })),
    openness,
    pinch,
    pinchDistance,
    spread,
    palmFacing: faceNow,
    palmNormal: _n.clone(),
    palmCentre: _mcpMean.clone(),
    indexTip: new Vector3(landmarks[LM.INDEX_TIP].x, landmarks[LM.INDEX_TIP].y, landmarks[LM.INDEX_TIP].z),
    middleTip: new Vector3(landmarks[LM.MIDDLE_TIP].x, landmarks[LM.MIDDLE_TIP].y, landmarks[LM.MIDDLE_TIP].z),
    thumbExtended: thumb,
  };

  // --- thumbs up vs. a tucked thumb ----------------------------------------
  // Curl alone cannot separate them: in a fist the thumb is *visible* and only
  // partly curled, exactly as in a thumbs-up. What differs is direction. A
  // thumbs-up points the thumb away from the palm, roughly along the fingers'
  // axis; a fist tucks it across the palm. So compare the thumb's direction with
  // the palm's own "up".
  _a.set(landmarks[LM.THUMB_TIP].x - _mcpMean.x, landmarks[LM.THUMB_TIP].y - _mcpMean.y, landmarks[LM.THUMB_TIP].z - _mcpMean.z);
  _b.set(
    landmarks[LM.MIDDLE_MCP].x - landmarks[LM.WRIST].x,
    landmarks[LM.MIDDLE_MCP].y - landmarks[LM.WRIST].y,
    landmarks[LM.MIDDLE_MCP].z - landmarks[LM.WRIST].z,
  );
  const thumbUpScore = _a.lengthSq() < 1e-9 || _b.lengthSq() < 1e-9
    ? 0
    : clamp(_a.normalize().dot(_b.normalize()), -1, 1);

  const discrete = decideDiscrete({
    thumb, index, middle, ring, pinky, nonThumbCount, pinching, spread, thumbUpScore,
  }, state);

  return {
    features,
    discrete,
    metrics: {
      fingerCount, nonThumbCount, pinchDistance, openness, palmWidth,
      palmFacing: faceNow, thumbUpScore: +thumbUpScore.toFixed(3),
    },
  };
}

/**
 * Curl of a single finger, 0 straight → 1 folded.
 *
 * The measure is how far the tip sits from the palm centre, relative to the
 * distance the finger reaches when fully straight. Folding brings the tip back
 * toward the palm, so the ratio rises — and it is independent of finger length,
 * which matters because a pinky is 40 % shorter than a middle finger.
 *
 * @param {ReadonlyArray<{x:number,y:number,z:number}>} lm
 * @param {number} mcp
 * @param {number} pip
 * @param {number} tip
 * @param {number} palmWidth
 * @param {Vector3} palmCentre
 * @returns {FingerState}
 */
function curlOf(lm, mcp, pip, tip) {
  // Direction the finger travels as it leaves the knuckle, then the direction it
  // travels after crossing the PIP joint. Both point the same way when straight.
  _a.set(lm[pip].x - lm[mcp].x, lm[pip].y - lm[mcp].y, lm[pip].z - lm[mcp].z);
  _b.set(lm[tip].x - lm[pip].x, lm[tip].y - lm[pip].y, lm[tip].z - lm[pip].z);
  const la = _a.length();
  const lb = _b.length();
  if (la < 1e-6 || lb < 1e-6) return { extended: false, curl: 1 };

  // 0 rad = perfectly straight; ~1.5 rad = the knuckle folded right over.
  const angle = Math.acos(clamp(_a.dot(_b) / (la * lb), -1, 1));
  const curl = clamp01((angle - CURL.straightRad) / (CURL.foldedRad - CURL.straightRad));
  return { extended: curl < THRESHOLDS.extendOn, curl };
}

/**
 * Pick the named pose from the finger configuration, with hysteresis on the
 * finger count so poses do not flap.
 *
 * @param {Object} f
 * @param {Object} state
 * @returns {string} one of GESTURES
 */
function decideDiscrete(f, state) {
  const { thumb, index, middle, ring, pinky, nonThumbCount, pinching, spread, thumbUpScore } = f;
  const last = state.discrete ?? GESTURES.OPEN_PALM;

  // Ordering matters: pinch is checked before peace and point because pinching
  // the thumb and index while holding up two fingers is a real and common
  // gesture, and users expect it to zoom.
  if (pinching) return GESTURES.PINCH;

  const anyExtended = nonThumbCount >= 1;

  // Thumbs up: fist plus a thumb that *points upward*. Checked before fist so a
  // thumbs-up is not swallowed by it, and gated on direction so an ordinary
  // fist with a visible thumb is not mistaken for one.
  if (!anyExtended && thumb && thumbUpScore > THRESHOLDS.thumbUpOn) return GESTURES.THUMBS_UP;

  if (!anyExtended && !thumb) return GESTURES.FIST;

  // Peace: index + middle only. Requiring ring and pinky to be folded is what
  // separates a peace sign from an open hand.
  if (index && middle && !ring && !pinky) return GESTURES.PEACE;

  // Point: index alone.
  if (index && !middle && !ring && !pinky) return GESTURES.POINT;

  // Wide index+ring+middle with an extended thumb reads as an open palm even
  // when the pinky is lazy, which is most people's actual "open hand".
  const widePalm = nonThumbCount >= 3 && (thumb || spread > 0.7);
  if (widePalm) return GESTURES.OPEN_PALM;

  // Nothing matched: hold the previous gesture rather than flickering to
  // OPEN_PALM. Debouncing by default is what stops the camera from stuttering
  // during a half-transition.
  return last === GESTURES.FIST && anyExtended ? GESTURES.OPEN_PALM : last;
}

/** An all-zero feature set, used when tracking drops out. */
function emptyFeatures() {
  return {
    fingers: Array.from({ length: 5 }, () => ({ extended: false, curl: 1 })),
    openness: 0, pinch: 0, pinchDistance: 1, spread: 0,
    palmFacing: false,
    palmNormal: new Vector3(0, 0, 1),
    palmCentre: new Vector3(0.5, 0.5, 0),
    indexTip: new Vector3(0.5, 0.5, 0),
    middleTip: new Vector3(0.5, 0.5, 0),
    thumbExtended: false,
  };
}

/**
 * Debounce a gesture stream: a new gesture must be held for `holdMs` before it
 * is emitted, which removes the last of the boundary chatter.
 *
 * @param {Object} opts
 * @param {number} [opts.holdMs]
 * @param {number} [opts.minFrames]
 */
export class GestureDebouncer {
  constructor({ holdMs = 110, minFrames = 2 } = {}) {
    this.holdMs = holdMs;
    this.minFrames = minFrames;
    /** @type {string} */
    this.stable = GESTURES.OPEN_PALM;
    this._candidate = GESTURES.OPEN_PALM;
    this._candidateSince = 0;
    this._candidateFrames = 0;
  }

  /**
   * @param {string} gesture
   * @param {number} now Performance timestamp, ms.
   * @returns {string} the debounced gesture.
   */
  push(gesture, now) {
    if (gesture !== this._candidate) {
      this._candidate = gesture;
      this._candidateSince = now;
      this._candidateFrames = 0;
    }
    this._candidateFrames++;

    const held = now - this._candidateSince;
    if (this._candidate !== this.stable && held >= this.holdMs && this._candidateFrames >= this.minFrames) {
      this.stable = this._candidate;
    }
    return this.stable;
  }

  /** Drop history — call when tracking is lost. */
  reset() {
    this._candidate = this.stable;
    this._candidateSince = 0;
    this._candidateFrames = 0;
  }
}

/**
 * Smooth the camera parameters derived from hands.
 *
 * Everything the user sees as a continuous value passes through here, so a
 * dropped inference frame does not produce a visible jump. Uses a critically
 * damped approach rather than a fixed lerp so the response time is the same in
 * seconds regardless of frame rate.
 */
export class HandSmoother {
  constructor({ response = 0.09 } = {}) {
    this.response = response;
    /** @type {{ x: number, y: number, zoom: number, roll: number }} */
    this.value = { x: 0.5, y: 0.5, zoom: 0, roll: 0 };
    this._target = { x: 0.5, y: 0.5, zoom: 0, roll: 0 };
  }

  /**
   * @param {{ x: number, y: number, zoom: number, roll: number }} target
   * @param {number} dt Seconds.
   */
  push(target, dt) {
    this._target = target;
    const k = 1 - Math.exp(-dt / Math.max(this.response, 1e-3));
    this.value.x = lerp(this.value.x, target.x, k);
    this.value.y = lerp(this.value.y, target.y, k);
    this.value.zoom = lerp(this.value.zoom, target.zoom, k);
    this.value.roll = lerp(this.value.roll, target.roll, k);
    return this.value;
  }

  /** @param {number} value */
  snapTo({ x = 0.5, y = 0.5, zoom = 0, roll = 0 } = {}) {
    this.value = { x, y, zoom, roll };
    this._target = { ...this.value };
  }

  reset() {
    this.snapTo();
  }
}

/** Normalised device coordinates → normalised image coordinates. */
export function ndcToImage(ndcX, ndcY) {
  return { x: ndcX * 0.5 + 0.5, y: ndcY * 0.5 + 0.5 };
}

/** Angle between the two index tips, used for the two-hand twist. */
export function interHandAngle(a, b) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  return ((ang % TAU) + TAU) % TAU;
}

export { THRESHOLDS };
