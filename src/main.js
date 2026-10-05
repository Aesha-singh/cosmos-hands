/**
 * COSMOS HANDS — application entry point.
 *
 * This module is the wiring, and deliberately contains almost no logic of its
 * own. Everything it does is:
 *
 *   1. build the systems in dependency order,
 *   2. translate events between them,
 *   3. run one frame function that ticks everything in the right sequence,
 *   4. tear it all down on unload.
 *
 * The frame order in `frame()` is the part worth reading. It is not arbitrary:
 *
 *   tracker → controller → scene update → camera rig → post uniforms → render
 *
 * The rig must update *after* the scene, because a scene's `update` moves bodies
 * and the rig needs their post-move positions to follow them. The controller
 * must update *before* the rig, because gestures feed the rig's velocities.
 * Hand inference runs first so a frame of tracking latency never shows up as
 * input lag.
 *
 * @module main
 */

import * as THREE from 'three';

import { TIME_PRESETS, UX, DEBUG } from './config.js';

import { Renderer, WebGLUnsupportedError } from './core/renderer.js';
import { PostPipeline } from './core/postprocessing.js';
import { CameraRig } from './core/camera-rig.js';
import { Loop } from './core/loop.js';
import { QualityManager } from './core/quality-manager.js';
import { SceneManager } from './scenes/scene-manager.js';
import { SCENE_CLASSES } from './scenes/registry.js';

import { HandTracker } from './gestures/hand-tracker.js';
import { GestureController } from './gestures/gesture-controller.js';
import { ScreenSpaceHands } from './gestures/screen-space-hands.js';
import { GESTURES } from './gestures/gesture-vocabulary.js';

import { Hud } from './ui/hud.js';
import { InfoPanel } from './ui/info-panel.js';
import { Calibration } from './ui/calibration.js';
import { CheatSheet, DebugPanel, KeyboardShortcuts } from './ui/panels.js';
import { Gates } from './ui/gates.js';

import { Ambience } from './audio/ambience.js';
import { J2000_MS, epochToDate } from './utils/orbits.js';
import { clamp01 } from './utils/math.js';
import { flushGpu, gpuInfo } from './utils/dispose.js';
import { on } from './utils/dom.js';

class CosmosHands {
  constructor() {
    this.gates = new Gates();
    /** Time rate index lives here so the module-level `RATE` can read it. */
    this.rateIndex = UX.defaultRateIndex ?? 5;

    /** Simulated seconds since J2000. Seeded from the wall clock so the solar
     *  system opens at today's actual planetary configuration. */
    this.simSeconds = (Date.now() - J2000_MS) / 1000;

    this.paused = false;
    this.muted = false;
    this.showLabels = true;
    this.showOrbits = true;
    this.realScale = false;
    this.cameraOn = false;
    this.ready = false;

    this._pointer = new THREE.Vector2();
    this._raycaster = new THREE.Raycaster();
    this._tmp = new THREE.Vector3();
    this._disposers = [];
  }

  /* ================================================================= boot === */

  async boot() {
    this.gates.setLoader('probing gpu');
    await frameGap();

    // --- graphics ---------------------------------------------------------
    try {
      this.renderer = new Renderer();
    } catch (err) {
      this._fatal(err);
      return;
    }

    this.pipeline = new PostPipeline(this.renderer.gl);
    this.rig = new CameraRig(this.renderer.camera);
    this.scenes = new SceneManager({ renderer: this.renderer, rig: this.rig });
    this.quality = new QualityManager({
      renderer: this.renderer, pipeline: this.pipeline, loop: null,
    });

    // --- gestures ---------------------------------------------------------
    this.tracker = new HandTracker();
    this.controller = new GestureController({ tracker: this.tracker, rig: this.rig });
    this.hands = new ScreenSpaceHands($('canvas#hand-overlay'), this.tracker);

    // --- ui ---------------------------------------------------------------
    this.hud = new Hud({ tracker: this.tracker });
    this.info = new InfoPanel();
    this.calibration = new Calibration({ tracker: this.tracker });
    this.sheet = new CheatSheet();
    this.debugPanel = new DebugPanel();
    this.audio = new Ambience();
    this.keys = new KeyboardShortcuts(this.hud);

    this.gates.setLoader('compiling shaders');
    await frameGap();

    this._buildScenes();
    this._wireEvents();
    this._bindPointer();
    this._initDebug();

    // --- frame loop -------------------------------------------------------
    this.loop = new Loop({
      onFrame: (dt) => this.frame(dt),
      maxDelta: 1 / 15,
    });
    this.quality.loop = this.loop;

    this.gates.setLoader('loading the sky');
    await frameGap();

    // Build the first scene before revealing anything, so the reveal is not a
    // stutter. Later scenes build lazily on switch.
    await this.scenes.goTo(0, { animate: false });
    this.hud.setScene(0, SCENE_CLASSES.length, this.scenes.current.title);

    this.loop.start();
    this.ready = true;
    this.gates.hideLoader();
    this.hud.show();

    if (UX.debugPanel) this.debugPanel.show();

    // The intro is shown last so the scene is already warm behind it.
    if (UX.intro) {
      this.gates.intro.hidden = false;
    } else {
      this.gates.hideIntro();
    }
  }

  _buildScenes() {
    this.scenes.register(SCENE_CLASSES.map((C) => new C()));
  }

  /* ================================================================ wiring == */

  _wireEvents() {
    const d = (emitter, type, fn) => this._disposers.push(emitter.on(type, fn));

    /* ------------------------------------------------------------- gates -- */
    d(this.gates, 'begin-camera', () => this.startCamera());
    d(this.gates, 'begin-mouse', () => this.startPointerOnly());
    d(this.gates, 'grant-camera', () => this.startCamera());
    d(this.gates, 'skip-camera', () => {
      this.hud.setCoarsePointer?.();
      this.hud.showTooltip('Camera off — mouse and touch active', 'warn');
    });

    /* ----------------------------------------------------------- tracker -- */
    d(this.tracker, 'status', (status, error) => {
      if (status === 'ready') {
        this.cameraOn = true;
        this.hud.toggles.cam = true;
        this.gates.hidePermission();
        this.gates.setLoader('starting camera');
      } else if (status === 'idle' || status === 'loading') {
        this.gates.setLoader('loading hand model');
      } else if (status === 'denied' || status === 'error') {
        this.cameraOn = false;
        this.hud.toggles.cam = false;
        // A denied camera is recoverable: the mouse path still works.
        this.gates.showPermission(
          error?.name === 'NotAllowedError'
            ? 'Permission was declined. The universe still works with your mouse — '
              + 'you can grant camera access any time from the toolbar.'
            : 'The camera or hand model could not start.',
        );
      }
    });

    d(this.tracker, 'hands', (hands) => {
      this.handsVisible = hands.length > 0;
    });

    d(this.tracker, 'gesture', (stable, visible) => {
      this.gesture = visible ? stable : null;
    });

    d(this.tracker, 'inference-error', (err) => console.warn('[tracker]', err));

    /* -------------------------------------------------------- controller -- */
    d(this.controller, 'gesture-fired', (gesture, direction) => this.onGesture(gesture, direction));
    d(this.controller, 'scene-step', (direction) => this.scenes.step(direction));
    d(this.controller, 'reset-view', () => this.resetView());
    d(this.controller, 'select', (ndc) => this.selectAt(ndc));
    d(this.controller, 'calibrated', (box) => {
      this.hands.setActiveBox(box);
      this.hud.showTooltip('Calibrated — hands map to the inner box', 'ok');
    });

    /* ------------------------------------------------------- scene manager */
    d(this.scenes, 'loading', (scene) => this.gates.setLoader(`loading ${scene.title.toLowerCase()}`));
    d(this.scenes, 'change', (scene, previous, index) => {
      this.gates.hideLoader();
      this.audio.whoosh();
      this.hud.setScene(index, SCENE_CLASSES.length, scene.title);
      this.hud.setRail(scene.railItems, scene.activeId);
      this.info.hide();
      this.selectedId = null;
      // The solar system's orbit display is scene-specific; do not let a toggle
      // from one scene silently blank another.
      if (scene.setOrbitsVisible) scene.setOrbitsVisible(this.showOrbits);
      if (scene.setLabelsVisible) scene.setLabelsVisible(this.showLabels);
      if (scene.setFiguresVisible) scene.setFiguresVisible(this.showOrbits);
      if (scene.setWebVisible) scene.setWebVisible(true);
    });

    /* --------------------------------------------------------------- hud -- */
    d(this.hud, 'scene', (index) => this.goToScene(index));
    d(this.hud, 'focus', (id) => this.focusBody(id));
    d(this.hud, 'rate', (_value, preset) => {
      this.rateIndex = TIME_PRESETS.indexOf(preset);
      this.hud.setRateIndex(this.rateIndex);
      this.paused = preset.value === 0;
    });
    d(this.hud, 'toggle', (key, value) => this.onToggle(key, value));

    /* -------------------------------------------------------------- info -- */
    d(this.info, 'close', () => {
      this.selectedId = null;
      this.scenes.current?.bodies?.forEach?.((b) => {
        if (b.lines) b.lines.material.opacity = 0.42;
      });
    });

    /* ------------------------------------------------------- calibration -- */
    d(this.calibration, 'finish', (result) => {
      this.calibration.cancel();
      if (result.skipped) {
        this.hud.showTooltip('Calibration skipped — using the default active box', 'warn');
        return;
      }
      this.controller.calibrate(result.samples);
      this.hud.showTooltip('Calibration saved', 'ok');
    });

    /* -------------------------------------------------------------- loop -- */
    d(this.loop, 'visibility', (hidden) => {
      if (hidden) this.audio.pause();
      else if (this.audio.ready) this.audio.resume();
    });

    /* ------------------------------------------------------------- audio -- */
    d(this.audio, 'ready', () => console.info('[audio] ambience started'));
    d(this.audio, 'unsupported', () => {
      this.hud.showTooltip('Audio unavailable in this browser', 'warn');
    });

    /* ------------------------------------------------------------ unload -- */
    on(window, 'beforeunload', () => this.dispose(), { once: true });
  }

  /**
   * Pointer / touch fallback.
   *
   * This is not a consolation prize — it is the primary path for anyone without
   * a camera, and every gesture has a pointer equivalent.
   */
  _bindPointer() {
    const canvas = this.renderer.canvas;
    let dragging = false;
    let panning = false;
    let lastX = 0;
    let lastY = 0;
    let movedPx = 0;

    const down = (e) => {
      if (this.rig.cinematic) return;
      canvas.setPointerCapture?.(e.pointerId);
      dragging = true;
      // Shift or right-click pans; plain drag orbits.
      panning = e.shiftKey || e.button === 2 || e.button === 1;
      lastX = e.clientX;
      lastY = e.clientY;
      movedPx = 0;
    };

    const move = (e) => {
      const rect = canvas.getBoundingClientRect();
      this._pointer.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      if (this.hud.cursor) {
        this.hud.moveCursor(this._pointer.x, this._pointer.y, true, false);
      }

      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      movedPx += Math.abs(dx) + Math.abs(dy);

      const rect2 = canvas.getBoundingClientRect();
      // Normalise by element size so the feel is identical on any screen.
      if (panning) this.rig.pan(dx / rect2.width, dy / rect2.height, 1 / 60);
      else this.rig.orbit(dx / rect2.width, dy / rect2.height, 1 / 60);
    };

    const up = (e) => {
      canvas.releasePointerCapture?.(e.pointerId);
      // A click, not a drag: treat it as a selection.
      if (movedPx < 6) this.selectAt(this._pointer.clone());
      dragging = false;
      panning = false;
    };

    on(canvas, 'pointerdown', down);
    on(canvas, 'pointermove', move);
    on(canvas, 'pointerup', up);
    on(canvas, 'pointercancel', up);
    on(canvas, 'pointerleave', () => {
      this.hud.moveCursor(this._pointer.x, this._pointer.y, false);
    });
    on(canvas, 'contextmenu', (e) => e.preventDefault());
    on(canvas, 'wheel', (e) => {
      e.preventDefault();
      // deltaMode 1 is lines, 2 is pages; normalise both to pixels.
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      this.rig.zoom(e.deltaY * scale * 0.0016);
    }, { passive: false });

    // A coarse pointer (touch) means no hover and no right-click, so pan needs
    // its own gesture: two fingers.
    let pinchStart = 0;
    let twoFinger = false;
    on(canvas, 'touchstart', (e) => {
      if (e.touches.length !== 2) return;
      twoFinger = true;
      pinchStart = touchDistance(e.touches);
    }, { passive: true });
    on(canvas, 'touchmove', (e) => {
      if (!twoFinger || e.touches.length !== 2) return;
      e.preventDefault();
      const d = touchDistance(e.touches);
      this.rig.zoom((pinchStart - d) * 0.006);
      pinchStart = d;
      // Dragging the midpoint pans.
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      this.rig.pan((mx - (this._panX ?? mx)) / 800, (my - (this._panY ?? my)) / 800, 1 / 60);
      this._panX = mx;
      this._panY = my;
    }, { passive: false });
    on(canvas, 'touchend', () => {
      twoFinger = false;
      this._panX = undefined;
      this._panY = undefined;
    }, { passive: true });

    // Keyboard events the HUD does not own.
    on(window, 'keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.sheet.isOpen) this.sheet.hide();
        else if (this.info.isOpen) this.info.hide();
        else if (this.calibration.active) this.calibration.cancel();
      }
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) this.sheet.toggle();
      if (e.key.toLowerCase() === 'i') this.calibration.start();
    });
  }

  _initDebug() {
    const DEBUG_ROWS = [
      ['fps', 'fps'], ['frame', 'frame ms'], ['tier', 'quality'], ['gpu', 'gpu'],
      ['scene', 'scene'], ['focus', 'focus'], ['radius', 'radius'],
      ['theta', 'theta'], ['phi', 'phi'], ['vel', 'angular vel'],
      ['zoomVel', 'zoom vel'], ['hands', 'hands'], ['gesture', 'gesture'],
      ['rate', 'time rate'], ['simdate', 'sim date'], ['audio', 'audio'],
      ['tracker', 'tracker'], ['pixelRatio', 'pixel ratio'], ['draws', 'draw calls'],
      ['tris', 'triangles'], ['warp', 'warp'],
    ];
    for (const [key, label] of DEBUG_ROWS) this.debugPanel.addRow(key, label);
    this.debugPanel.set('gpu', gpuInfo(this.renderer.gl));

    if (UX.debugPanel === true || window.location.hash === '#debug') this.debugPanel.show();
  }

  /* ============================================================== actions == */

  /** @returns {Promise<void>} */
  async startCamera() {
    try {
      await this.tracker.start();
      this.cameraOn = true;
      // Audio must start inside the gesture handler's call stack or the browser
      // blocks it, so it is kicked off here and allowed to resolve later.
      this.audio.start();
    } catch (err) {
      console.warn('[camera]', err);
      this.gates.showPermission(
        'The camera could not start. Everything still works with the mouse and '
        + 'keyboard — or reload and allow camera access.',
      );
    }
  }

  startPointerOnly() {
    this.cameraOn = false;
    this.audio.start();
    this.hud.showTooltip('Camera off — drag to orbit, scroll to zoom', 'ok');
  }

  /** @param {number} index */
  async goToScene(index) {
    if (this.scenes.transitioning) return;
    await this.scenes.goTo(index);
  }

  /** @param {string} id */
  focusBody(id) {
    const scene = this.scenes.current;
    if (!scene) return;
    const target = scene.focus(id);
    if (!target) return;
    this.selectedId = id;
    this.hud.setActiveRail(id);
    const body = scene.bodies.get(id);
    this.info.show(body ?? { label: id, facts: {}, data: {} });
    this.audio.blip({ freq: 520, decay: 0.2 });

    // The constellation scene can frame the whole figure; the others need a
    // distance derived from the body's own size.
    if (scene.frameDistance) this.rig.setRadius(scene.frameDistance(id));
    else if (body?.focusRadius) this.rig.setRadius(Math.max(body.focusRadius * 4.2, scene.limits.min * 3));
  }

  /**
   * Feedback for a recognised gesture.
   *
   * The *effects* of the pose (scene stepping, selection, reset) already arrive
   * as their own events, because the controller emits those independently —
   * handling them again here would double-fire every transition.
   *
   * @param {string} gesture
   * @param {number} direction
   */
  onGesture(gesture, direction) {
    // Distinct pitch per direction, so you can hear which way you went.
    const forward = direction >= 0;
    this.audio.blip({
      freq: gesture === GESTURES.THUMBS_UP ? 560 : 760,
      decay: 0.13,
      type: forward ? 'triangle' : 'sine',
    });
  }

  resetView() {
    const scene = this.scenes.current;
    if (!scene) return;
    const home = scene.homeView;
    this.rig.setFocus(home.focus.clone(), true);
    this.rig.setRadius(home.radius, true);
    this.rig.setTheta(home.theta, true);
    this.rig.setPhi(home.phi, true);
    this.rig.roll = 0;
    this.rig.rollTarget = 0;
    this.hud.showTooltip('View reset', 'ok');
    this.audio.blip({ freq: 440, decay: 0.25 });
  }

  /** @param {THREE.Vector2} ndc */
  selectAt(ndc) {
    const scene = this.scenes.current;
    if (!scene) return;
    this._raycaster.setFromCamera(ndc, this.renderer.camera);

    let id = null;
    if (scene.pick) id = scene.pick(this._raycaster);

    if (!id) {
      this.info.hide();
      this.selectedId = null;
      return;
    }

    const body = scene.bodies.get(id);
    if (!body) return;
    this.selectedId = id;
    this.hud.setActiveRail(id);
    this.info.show(body);
    this.scenes.focusBody(id);
    this.audio.blip({ freq: 880, decay: 0.22 });
  }

  /** @param {string} key @param {boolean} value */
  onToggle(key, value) {
    switch (key) {
      case 'cam':
        if (value) this.startCamera();
        else if (this.tracker) {
          this.tracker.stop?.();
          this.cameraOn = false;
        }
        break;
      case 'mute':
        this.muted = this.audio.setMuted(value);
        break;
      case 'labels':
        this.showLabels = value;
        this.scenes.current?.setLabelsVisible?.(value);
        break;
      case 'orbits':
        this.showOrbits = value;
        this.scenes.current?.setOrbitsVisible?.(value);
        this.scenes.current?.setFiguresVisible?.(value);
        break;
      case 'debug':
        if (value) this.debugPanel.show(); else this.debugPanel.hide();
        break;
      case 'realscale':
        this.realScale = value;
        break;
      default:
        break;
    }
  }

  /* ================================================================= frame == */

  /** @param {number} dt */
  frame(dt) {
    const scene = this.scenes.current;
    if (!scene) return;

    // --- simulation clock -------------------------------------------------
    const rate = this.paused ? 0 : TIME_PRESETS[this.rateIndex].value;
    if (rate > 0) this.simSeconds += dt * rate;

    // --- gesture pipeline (must precede the rig) ---------------------------
    this.tracker.update(performance.now());
    this.controller.update(dt);
    if (this.controller.mode === 'aim') {
      this.hud.moveCursor(this.controller.aimPoint.x, this.controller.aimPoint.y, true, true);
    }

    // --- scene ------------------------------------------------------------
    scene.update(dt, this.simSeconds, {
      pixelRatio: this.renderer.gl.getPixelRatio(),
      cameraDistance: this.rig.radius,
      cameraPosition: this.renderer.camera.position,
      cameraQuaternion: this.renderer.camera.quaternion,
      qualityScale: this.quality.tier === 'low' ? 0.7 : 1,
    });

    // --- camera -----------------------------------------------------------
    this.rig.update(dt);

    // --- audio ------------------------------------------------------------
    const sceneAudio = scene.warpAmount ?? 0;
    this.audio.update({
      altitude: clamp01(this.rig.radius / scene.limits.max),
      speed: Math.hypot(this.rig.angularVelocity.x, this.rig.angularVelocity.y),
      warp: sceneAudio,
    });
    this.pipeline.setWarp(sceneAudio > 0.05);
    if (scene.setWarp && this.controller.mode === 'aim') {
      // The rock gesture is the easter-egg warp trigger.
      scene.setWarp(this.gesture === 'rock' ? 1 : 0);
    }

    // --- hud --------------------------------------------------------------
    this.hands.render(performance.now());
    const cameraDistanceKm = this.rig.radius * 1e6;
    this.hud.update({
      gesture: this.gesture,
      handsVisible: Boolean(this.tracker.hands.length),
      date: epochToDate(this.simSeconds),
      rateValue: rate,
      distanceKm: cameraDistanceKm,
      scaleLabel: this.scaleLabel(),
    });

    if (this.debugPanel.isOpen) this._updateDebug(dt);

    // --- render -----------------------------------------------------------
    this.quality.update(dt, this.loop.stats);
    this.pipeline.render(dt);
  }

  _updateDebug() {
    const rig = this.rig;
    const info = this.renderer.gl.info;
    this.debugPanel.setMany({
      fps: this.loop.stats.fps.toFixed(0),
      frame: this.loop.stats.frameMs.toFixed(2),
      tier: `${this.quality.tier}${this.quality.locked ? ' (locked)' : ''}`,
      scene: this.scenes.current?.title ?? '—',
      focus: `${this.selectedId ?? '—'}`,
      radius: rig.radius.toExponential(2),
      theta: `${rig.theta.toFixed(3)}`,
      phi: `${rig.phi.toFixed(3)}`,
      vel: `${Math.hypot(rig.angularVelocity.x, rig.angularVelocity.y).toFixed(3)}`,
      zoomVel: rig.zoomVelocity.toFixed(3),
      hands: this.tracker.hands.length,
      gesture: this.gesture ?? '—',
      rate: TIME_PRESETS[this.rateIndex].short,
      simdate: epochToDate(this.simSeconds).toISOString().slice(0, 10),
      audio: this.audio.isPlaying ? 'on' : this.muted ? 'muted' : 'off',
      tracker: this.tracker.status ?? '—',
      pixelRatio: this.renderer.gl.getPixelRatio().toFixed(2),
      draws: info.render.calls,
      tris: info.render.triangles.toLocaleString(),
      warp: (this.scenes.current?.warpAmount ?? 0).toFixed(2),
    });
  }

  /** A short human label for the current camera distance. */
  scaleLabel() {
    const r = this.rig.radius;
    const km = r * 1e6;
    if (km < 1e7) return `${(km / 1e6).toFixed(2)} million km`;
    if (km < 1e11) return `${(km / 1e9).toFixed(2)} billion km`;
    if (km < 9e15) return `${(km / 9.4607e12).toFixed(2)} light-years`;
    if (km < 3e19) return `${(km / 3.0857e16).toFixed(2)} thousand light-years`;
    return `${(km / 3.0857e19).toFixed(2)} megaparsecs`;
  }

  /* ================================================================ fatal == */

  _fatal(err) {
    console.error(err);
    this.gates.hideLoader();
    if (err instanceof WebGLUnsupportedError) {
      this.gates.showFatal(
        { message: `${err.message}. COSMOS HANDS needs WebGL 2, which every current `
          + 'version of Chrome, Firefox, Safari and Edge supports. If you are seeing '
          + 'this, hardware acceleration is probably disabled in your browser settings.' },
        { title: 'This browser cannot run COSMOS HANDS', showTrace: false },
      );
      return;
    }
    this.gates.showFatal(err, { showTrace: true });
  }

  /* =============================================================== dispose == */

  dispose() {
    for (const off of this._disposers) off?.();
    this._disposers.length = 0;
    this.keys?.dispose();
    this.hands?.dispose();
    this.tracker?.dispose();
    this.scenes?.dispose();
    this.audio?.dispose();
    this.pipeline?.dispose();
    this.loop?.stop();
    this.loop?.dispose();
    flushGpu();
  }
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Yield to the compositor so the loader text actually paints. */
const frameGap = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/** Distance between two touches. */
function touchDistance(touches) {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}

/* -------------------------------------------------------------------------- */
/* go                                                                          */
/* -------------------------------------------------------------------------- */

const app = new CosmosHands();

app.boot().catch((err) => {
  console.error(err);
  app._fatal(err);
});

// Exposed for the debug panel, and so the app can be driven from the console
// during a demo (e.g. `COSMOS.scenes.goTo(2)`).
if (DEBUG.expose) window.COSMOS = app;