/**
 * Webcam hand tracking.
 *
 * Wraps MediaPipe Tasks Vision and turns it into something the rest of the app
 * can consume without knowing anything about MediaPipe.
 *
 * Design notes that matter:
 *
 *  • **The video never leaves the page.** There is no network call after the
 *    WASM and model files load. Frames go from the camera element straight to
 *    the WASM graph and the landmark array goes straight to our code.
 *  • **Models and WASM are served locally** from `public/`, not a CDN. A third
 *    party seeing your webcam request would be a privacy problem, and a CDN
 *    being unreachable would break the demo entirely.
 *  • **Inference is rate-limited** to ~30 fps and runs *outside* the render
 *    frame budget. Hand landmarks do not need 60 Hz; spending half the frame
 *    budget on them would halve the render rate.
 *  • **Loss is normal, not exceptional.** People drop hands constantly. The
 *    tracker treats "no hands" as a routine state and keeps the camera
 *    coasting on momentum rather than freezing.
 *
 * @module gestures/hand-tracker
 */

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { Emitter } from '../utils/dom.js';
import { GestureDebouncer, classifyHand } from './gesture-vocabulary.js';
import { LandmarkFilterBank } from './oneEuroFilter.js';
import { RateLimiter } from '../core/loop.js';
import { GESTURES as GESTURE_CONFIG, HANDS } from '../config.js';

/** Landmark indices MediaPipe defines; used for the skeleton overlay. */
export const HAND_CONNECTIONS = Object.freeze([
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
]);

/** @typedef {'Left'|'Right'} Handedness */

export class HandTracker extends Emitter {
  constructor() {
    super();

    /** @type {HTMLVideoElement|null} */
    this.video = null;
    /** @type {MediaStream|null} */
    this.stream = null;
    /** @type {HandLandmarker|null} */
    this.landmarker = null;

    /** 'idle' | 'loading' | 'ready' | 'denied' | 'unsupported' | 'error' */
    this.status = 'idle';
    /** @type {Error|null} */
    this.error = null;

    /** Latest filtered frames, keyed by handedness. */
    this.hands = /** @type {Record<Handedness, Object>} */ ({});

    /** When the last hand was seen, ms. Drives the "hands lost" UI. */
    this.lastSeen = 0;
    /** Timestamp of the previous inference call, for the filter timestep. */
    this.lastFrameMs = 0;
    /** True while at least one hand is visible. */
    this.visible = false;

    this.limiter = new RateLimiter(HANDS.inferenceFps);
    this.filtersConfig = HANDS.filter;
    // Discrete gestures must be held before they fire; the config owns the
    // timing so it stays tunable from the debug panel.
    this.debouncer = new GestureDebouncer({
      holdMs: GESTURE_CONFIG.enterMs,
      minFrames: 2,
    });

    /** One filter bank per hand. Sized 21; re-created if handedness changes. */
    this.filters = {
      Left: new LandmarkFilterBank(21, HANDS.filter),
      Right: new LandmarkFilterBank(21, HANDS.filter),
    };

    /** Per-hand hysteresis state for the classifier. */
    this.classifyState = { Left: {}, Right: {} };

    /** Last inference timestamps, for the debug panel. */
    this.lastInferenceMs = 0;
    this.inferenceFps = 0;
    /** True once the user has been asked and refused. */
    this.permissionDenied = false;
  }

  /* ------------------------------------------------------------ lifecycle -- */

  /**
   * Ask for the camera and load the model. Safe to call twice.
   * @param {Object} [opts]
   * @param {boolean} [opts.silent] Do not emit progress events.
   */
  async init({ silent = false } = {}) {
    if (this.status === 'ready' || this.status === 'loading') return this;

    if (!window.isSecureContext) {
      this._fail('unsupported', new Error(
        'Camera access requires HTTPS or localhost. Open the app on a secure origin.',
      ));
      return this;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this._fail('unsupported', new Error('This browser has no camera API.'));
      return this;
    }

    this.status = 'loading';
    if (!silent) this.emit('status', this.status);

    // Load model and WASM in parallel with the permission prompt. The prompt is
    // user-gated and can sit unanswered for a while, so there is no reason to
    // serialise it behind the download.
    const modelPromise = this._loadModel();
    const cameraPromise = this._openCamera();

    const [modelResult, cameraResult] = await Promise.allSettled([modelPromise, cameraPromise]);

    if (cameraResult.status === 'rejected') throw cameraResult.reason;
    if (modelResult.status === 'rejected') {
      this._stopCamera();
      throw modelResult.reason;
    }

    this.status = 'ready';
    if (!silent) this.emit('status', this.status);
    return this;
  }

  /** Load the WASM runtime and the landmark model from local assets. */
  async _loadModel() {
    const fileset = await FilesetResolver.forVisionTasks(HANDS.wasmPaths.local);
    this.landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: HANDS.modelPaths.handLandmarker,
        delegate: HANDS.delegate,
      },
      runningMode: 'VIDEO',
      numHands: HANDS.maxHands,
      minHandDetectionConfidence: HANDS.detectionConfidence,
      minHandPresenceConfidence: HANDS.presenceConfidence,
      minTrackingConfidence: HANDS.trackingConfidence,
    });
    return this.landmarker;
  }

  /** Request the webcam and attach it to a hidden video element. */
  async _openCamera() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: HANDS.video.width },
          height: { ideal: HANDS.video.height },
          frameRate: { ideal: HANDS.videoFps, max: HANDS.videoFps },
          facingMode: HANDS.video.facingMode,
        },
        audio: false,
      });
    } catch (err) {
      this.permissionDenied = err?.name === 'NotAllowedError'
        || err?.name === 'SecurityError';
      this._fail(this.permissionDenied ? 'denied' : 'error', err);
      throw err;
    }

    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    video.srcObject = this.stream;
    document.body.appendChild(video);
    this.video = video;

    // Wait for real dimensions; some browsers report 0 until metadata lands.
    if (video.readyState < 2) {
      await new Promise((resolve) => {
        video.addEventListener('loadeddata', resolve, { once: true });
      });
    }
    await video.play();

    // Mirror the preview, since a raw webcam image is unflipped and every
    // user's mental model is a mirror.
    if (video.style.display !== 'none') video.style.transform = 'scaleX(-1)';
  }

  /**
   * Run inference if the frame budget allows. Call once per rendered frame.
   * @param {number} nowMs High-resolution timestamp.
   */
  update(nowMs) {
    if (this.status !== 'ready' || !this.landmarker || !this.video) return null;
    if (this.video.readyState < 2) return null;
    if (!this.limiter.shouldRun(nowMs)) return null;

    const started = performance.now();
    let result;
    try {
      result = this.landmarker.detectForVideo(this.video, nowMs);
    } catch (err) {
      // A dropped frame is not fatal; log once and carry on.
      this.emit('inference-error', err);
      return null;
    }
    const elapsed = performance.now() - started;
    this.lastInferenceMs = elapsed;
    // Exponential moving average, so the reported rate is honest about jitter.
    this.inferenceFps = this.inferenceFps
      ? this.inferenceFps * 0.9 + (1000 / Math.max(elapsed, 1)) * 0.1
      : 1000 / Math.max(elapsed, 1);

    this._consume(result, nowMs);
    return result;
  }

  /**
   * Turn a MediaPipe result into our per-hand state.
   * @param {Object} result
   * @param {number} nowMs
   */
  _consume(result, nowMs) {
    const dt = this.lastFrameMs
      ? Math.min((nowMs - this.lastFrameMs) / 1000, 0.5)
      : 1 / HANDS.inferenceFps;
    this.lastFrameMs = nowMs;
    const raw = result?.landmarks ?? [];
    const handedness = result?.handedness ?? result?.handednesses ?? [];
    const worldLandmarks = result?.worldLandmarks ?? [];

    const seen = { Left: null, Right: null };

    for (let i = 0; i < raw.length; i++) {
      // MediaPipe reports handedness from the *camera's* point of view, which
      // is the opposite of what the user expects after mirroring. Flip it so
      // "Left" means the user's left hand on screen.
      const label = handedness[i]?.[0]?.categoryName === 'Left' ? 'Right' : 'Left';
      const bank = this.filters[label];
      const filtered = bank.filter(raw[i], dt);
      const { features, discrete, metrics } = classifyHand(raw[i], this.classifyState[label]);

      seen[label] = {
        handedness: label,
        landmarks: filtered,
        rawLandmarks: raw[i],
        worldLandmarks: worldLandmarks[i] ?? null,
        features,
        gesture: discrete,
        metrics,
        speed: bank.meanSpeed,
        score: handedness[i]?.[0]?.score ?? 1,
        since: nowMs,
      };
    }

    // Hands that vanished this frame keep their last state for a moment, with
    // the filters reset, so the overlay fades rather than popping.
    for (const label of ['Left', 'Right']) {
      if (seen[label]) {
        this.hands[label] = seen[label];
      } else if (this.hands[label]) {
        const gap = nowMs - this.hands[label].since;
        if (gap > HANDS.lostGraceMs) {
          this.filters[label].reset();
          this.classifyState[label] = {};
          this.hands[label] = null;
        }
      }
    }

    this.visible = Boolean(seen.Left || seen.Right);
    if (this.visible) this.lastSeen = nowMs;

    // Choose the dominant gesture across visible hands: left hand wins ties, so
    // the behaviour is deterministic when both hands show the same pose.
    let dominant = null;
    if (seen.Left) dominant = seen.Left;
    else if (seen.Right) dominant = seen.Right;

    const stable = dominant
      ? this.debouncer.push(dominant.gesture, nowMs)
      : this.debouncer.stable;

    this.emit('hands', this.hands);
    this.emit('gesture', stable, this.visible);
    void dt;
  }

  /** @param {number} nowMs */
  _fail(status, error) {
    this.status = status;
    this.error = error instanceof Error ? error : new Error(String(error));
    this.emit('status', status, this.error);
  }

  _stopCamera() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
      this.video = null;
    }
  }

  /** Release the camera and the WASM graph. */
  dispose() {
    this._stopCamera();
    this.landmarker?.close?.();
    this.landmarker = null;
    this.status = 'idle';
    this.clear();
  }

  /**
   * Screen-space hand positions, ready for the camera rig.
   *
   * Normalised image coordinates, mirrored to match the preview, with the
   * calibration box applied.
   *
   * @returns {{ points: Array<{ x: number, y: number, handedness: Handedness }>,
   *             gesture: string, twoHand: boolean }}
   */
  controlFrame() {
    const points = [];
    let gesture = this.debouncer.stable;

    if (this.visible) {
      if (this.hands.Left) {
        const c = this.hands.Left.features.palmCentre;
        points.push({ x: 1 - c.x, y: c.y, handedness: 'Left' });
        gesture = this.hands.Left.gesture;
      }
      if (this.hands.Right) {
        const c = this.hands.Right.features.palmCentre;
        points.push({ x: 1 - c.x, y: c.y, handedness: 'Right' });
        if (!this.hands.Left) gesture = this.hands.Right.gesture;
      }
    }

    return { points, gesture: this.debouncer.stable || gesture, twoHand: points.length === 2 };
  }

  /** @returns {Object} for the debug panel */
  snapshot() {
    return {
      status: this.status,
      visible: this.visible,
      hands: Object.values(this.hands).filter(Boolean).map((h) => ({
        hand: h.handedness,
        gesture: h.gesture,
        speed: +h.speed.toFixed(3),
        pinch: +h.features.pinch.toFixed(2),
      })),
      inferenceMs: +this.lastInferenceMs.toFixed(1),
      inferenceFps: +this.inferenceFps.toFixed(1),
      filterSpeed: +(this.filters.Left.meanSpeed || 0).toFixed(4),
    };
  }
}