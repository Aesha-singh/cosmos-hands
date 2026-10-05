/**
 * Scene switching and cinematic flights.
 *
 * A scene change has to sell the idea that you have travelled somewhere real.
 * Two details do most of that work:
 *
 *  1. **The camera never cuts.** The focus point, distance and orientation are
 *     tweened with GSAP, so the eye tracks continuously from the solar system
 *     into the galaxy. A hard cut destroys the sense of scale that everything
 *     else in the app is trying to build.
 *  2. **The old scene is disposed only after the new one is on screen.** Peak
 *     memory during a transition holds two scenes, which is fine — disposing
 *     first produces a visible hitch as textures are re-uploaded.
 *
 * Flights use a cubic ease with a slight overshoot on arrival. The overshoot
 * matters: a perfect ease-in-out decelerates to a dead stop, which reads as
 * mechanical. A small settle reads as a camera being operated.
 *
 * @module scenes/scene-manager
 */

import * as THREE from 'three';
import gsap from 'gsap';
import { CAMERA, RENDERER } from '../config.js';
import { Emitter } from '../utils/dom.js';
import { clamp } from '../utils/math.js';

/** @typedef {import('./scene-base.js').SceneBase} SceneBase */

export class SceneManager extends Emitter {
  /**
   * @param {Object} opts
   * @param {import('../core/renderer.js').Renderer} opts.renderer
   * @param {import('../core/camera-rig.js').CameraRig} opts.rig
   */
  constructor({ renderer, rig }) {
    super();
    this.renderer = renderer;
    this.rig = rig;

    /** @type {SceneBase[]} */
    this.scenes = [];
    /** @type {SceneBase|null} */
    this.current = null;
    /** @type {SceneBase[]} */
    this.cache = [];
    this._transitioning = false;
    this._flight = null;
  }

  /**
   * @param {SceneBase[]} scenes
   */
  register(scenes) {
    this.scenes = scenes;
    return this;
  }

  /** @param {number} index */
  get index() {
    return this.current ? this.scenes.indexOf(this.current) : -1;
  }

  /**
   * Switch to a scene by index, building it if necessary.
   * @param {number} index
   * @param {Object} [opts]
   * @param {boolean} [opts.animate]
   */
  async goTo(index, { animate = true } = {}) {
    const next = this.scenes[index];
    if (!next || next === this.current) return this.current;
    if (this._transitioning) return this.current;

    this._transitioning = true;
    this.emit('before-change', next, this.current);

    try {
      // Build the incoming scene *before* disposing the outgoing one, so the
      // textures are already resident when it first becomes visible.
      if (!this.cache.includes(next)) {
        this.emit('loading', next);
        await next.prepare();
        this.cache.push(next);
      }

      const previous = this.current;
      this.current = next;
      this.renderer.gl.render(next.scene, this.renderer.camera);
      this.emit('change', next, previous, index);

      this._applyLimits(next);
      await this._flyToScene(next, previous, animate);

      // Only now is it safe to release the old scene.
      if (previous && previous !== next && !this.cache.includes(previous)) {
        previous.dispose();
      }
    } finally {
      this._transitioning = false;
    }

    return next;
  }

  /**
   * Apply a scene's camera limits to the rig.
   * @param {SceneBase} scene
   */
  _applyLimits(scene) {
    const rig = this.rig;
    rig.minDistance = scene.limits.min;
    rig.maxDistance = scene.limits.max;
    rig.dynamicFar = scene.limits.far > RENDERER.far;
    this.renderer.camera.far = scene.limits.far;
    this.renderer.camera.updateProjectionMatrix();
    // The fog colour must track the scene, or bodies fade to the wrong colour.
    rig.cinematic = true;
  }

  /**
   * Cinematic move into a scene.
   * @param {SceneBase} scene
   * @param {SceneBase|null} previous
   * @param {boolean} animate
   */
  _flyToScene(scene, previous, animate) {
    const rig = this.rig;
    const home = scene.homeView;

    if (!animate || !previous) {
      rig.setFocus(home.focus, true);
      rig.setRadius(home.radius, true);
      rig.setTheta(home.theta, true);
      rig.setPhi(home.phi, true);
      rig.roll = 0;
      rig.rollTarget = 0;
      rig.cinematic = false;
      rig.apply();
      return Promise.resolve();
    }

    return this._tweenCamera({
      focus: home.focus,
      radius: home.radius,
      theta: home.theta,
      phi: home.phi,
      duration: CAMERA.flyToDuration,
      // Push in slightly as we arrive: reads as "arriving", not "stopping".
      settle: true,
    });
  }

  /**
   * Fly to a body inside the current scene.
   *
   * @param {string} id
   * @param {Object} [opts]
   * @param {boolean} [opts.animate]
   * @returns {THREE.Vector3|null}
   */
  focusBody(id, { animate = true } = {}) {
    const scene = this.current;
    if (!scene) return null;
    const target = scene.focus(id);
    if (!target) return null;

    this.emit('focus-body', id, target);
    if (!animate) return target;

    const body = scene.bodies.get(id);
    const radius = body?.focusRadius ?? 0;
    const distance = scene.limits.min * 2.5
      + Math.max(radius * 4.2, scene.limits.min * 0.6);

    this._tweenCamera({
      focus: target,
      radius: clamp(distance, scene.limits.min, scene.limits.max),
      duration: CAMERA.flyToDuration,
      settle: true,
    });
    return target;
  }

  /**
   * Tween the rig. The rig's own damping is bypassed during the flight and the
   * velocity is zeroed on arrival, so the user is not handed a camera that is
   * still gliding.
   *
   * @param {Object} opts
   * @param {THREE.Vector3|number[]} opts.focus
   * @param {number} opts.radius
   * @param {number} [opts.theta]
   * @param {number} [opts.phi]
   * @param {number} [opts.roll]
   * @param {number} [opts.duration]
   * @param {boolean} [opts.settle]
   * @returns {Promise<void>}
   */
  _tweenCamera({ focus, radius, theta, phi, roll = 0, duration = 1.6, settle = false }) {
    const rig = this.rig;
    // Kill any momentum so it cannot fight the tween.
    rig.brake(0);
    rig.cinematic = true;

    const from = {
      fx: rig.focus.x, fy: rig.focus.y, fz: rig.focus.z,
      radius: rig.radius,
      theta: rig.theta,
      phi: rig.phi,
      roll: rig.roll,
    };
    const to = {
      fx: Array.isArray(focus) ? focus[0] : focus.x,
      fy: Array.isArray(focus) ? focus[1] : focus.y,
      fz: Array.isArray(focus) ? focus[2] : focus.z,
      radius,
      theta: theta ?? rig.theta,
      phi: phi ?? rig.phi,
      roll,
    };

    // Take the short way round in theta.
    let dTheta = to.theta - from.theta;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;
    to.theta = from.theta + dTheta;

    if (this._flight) this._flight.kill();

    return new Promise((resolve) => {
      this._flight = gsap.to(from, {
        fx: to.fx,
        fy: to.fy,
        fz: to.fz,
        radius: to.radius,
        theta: to.theta,
        phi: to.phi,
        roll: to.roll,
        duration,
        // A small overshoot on arrival reads as a camera settling rather than
        // a motor stalling.
        ease: settle ? 'power3.inOut' : 'power2.out',
        onUpdate: () => {
          rig.focus.set(from.fx, from.fy, from.fz);
          rig.focusTarget.copy(rig.focus);
          rig.radius = from.radius;
          rig.radiusTarget = from.radius;
          rig.theta = from.theta;
          rig.thetaTarget = from.theta;
          rig.phi = from.phi;
          rig.phiTarget = from.phi;
          rig.roll = from.roll;
          rig.apply();
        },
        onComplete: () => {
          rig.brake(0);
          rig.cinematic = false;
          this._flight = null;
          resolve();
        },
      });
    });
  }

  /**
   * Step forward or backward through scenes.
   * @param {number} direction 1 or -1
   */
  async step(direction) {
    const count = this.scenes.length;
    if (!count) return;
    const from = this.index < 0 ? 0 : this.index;
    const next = (from + direction + count) % count;
    await this.goTo(next);
  }

  /**
   * Per-frame: update the active scene only.
   * @param {number} dt
   * @param {number} elapsed
   */
  update(dt, elapsed) {
    this.current?.update?.(dt, elapsed);
  }

  /** @returns {boolean} */
  get transitioning() { return this._transitioning; }

  /** Tear everything down. */
  dispose() {
    this._flight?.kill();
    for (const scene of this.cache) scene.dispose();
    this.cache.length = 0;
    this.current = null;
    this.clear();
  }
}