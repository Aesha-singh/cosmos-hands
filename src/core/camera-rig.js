/**
 * Camera rig — the thing that makes gesture control feel physical.
 *
 * The rig owns four things a naive `camera.position = …` never does:
 *
 *  1. **A focus target.** Everything orbits *that*, not the world origin, which
 *     is why flying to Saturn keeps Saturn centred no matter how far away it is.
 *  2. **Velocity with inertia.** Gesture deltas go into an angular/linear
 *     velocity; the velocity decays exponentially every frame. Releasing your
 *     hand does not stop the camera — it glides.
 *  3. **Critically-damped springs.** The focus point and the distance chase their
 *     targets with frame-rate-independent damping, so a 120 Hz display and a
 *     60 Hz display feel identical.
 *  4. **A brake.** The fist gesture multiplies velocity decay, which is the only
 *     interaction design that makes momentum feel safe.
 *
 * Coordinate convention: spherical around the focus, `theta` = azimuth (radians),
 * `phi` = polar angle from +Y, `radius` = distance. We keep `phi` clamped away
 * from the poles so the camera never gimbal-flips.
 *
 * @module core/camera-rig
 */

import * as THREE from 'three';
import { CAMERA, RENDERER } from '../config.js';
import { clamp, damp, shortestAngle, TAU, DEG } from '../utils/math.js';
import { Emitter } from '../utils/dom.js';

const EPS = 1e-6;

/**
 * @typedef {Object} RigState
 * @property {number} theta
 * @property {number} phi
 * @property {number} radius
 * @property {THREE.Vector3} focus
 */

export class CameraRig extends Emitter {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {Object} [opts]
   */
  constructor(camera, opts = {}) {
    super();
    this.camera = camera;

    /** Where the camera is looking. */
    this.focus = new THREE.Vector3();
    /** Where it is heading. */
    this.focusTarget = new THREE.Vector3();

    this.theta = Math.PI * 0.25;
    this.phi = Math.PI * 0.36;
    this.radius = 400;

    this.thetaTarget = this.theta;
    this.phiTarget = this.phi;
    this.radiusTarget = this.radius;

    /** Angular velocity, radians/second. */
    this.angularVelocity = new THREE.Vector2();
    /** Radial velocity, units/second (logarithmic). */
    this.zoomVelocity = 0;
    /** Roll, radians. */
    this.roll = 0;
    this.rollTarget = 0;
    this.rollVelocity = 0;

    /** When true, the fist gesture multiplies decay. */
    this.braking = false;
    /** True while a scripted flight is playing — input is ignored. */
    this.cinematic = false;

    /** Closest and farthest the camera may get from its focus. */
    this.minDistance = opts.minDistance ?? CAMERA.minDistance;
    this.maxDistance = opts.maxDistance ?? CAMERA.maxDistance;
    /** Distance beyond which the far plane must grow (scene 3 goes to 4e7 units). */
    this.dynamicFar = false;

    /** Tunables, live-editable from the debug panel. */
    this.tuning = {
      orbitGain: 1.0,
      zoomGain: 1.0,
      panGain: 1.0,
      rollGain: 1.0,
      damping: CAMERA.damping,
      brakeDamping: CAMERA.brakeDamping,
      followDamping: CAMERA.followDamping,
    };

    this._tmp = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');

    this.apply();
  }

  /* ---------------------------------------------------------------- input -- */

  /**
   * Add angular velocity from a drag / open-palm move.
   *
   * @param {number} dx Horizontal delta, normalised (-1..1 per frame).
   * @param {number} dy Vertical delta, normalised.
   * @param {number} [dt] Frame time, seconds — pass it for frame-rate independence.
   */
  orbit(dx, dy, dt = 1 / 60) {
    if (this.cinematic) return;
    const gain = this.tuning.orbitGain * 4.2;
    this.angularVelocity.x += dx * gain * dt * 60;
    this.angularVelocity.y += dy * gain * dt * 60;
    // Clamp so a single wild frame cannot launch the camera into a spin.
    this.angularVelocity.x = clamp(this.angularVelocity.x, -6, 6);
    this.angularVelocity.y = clamp(this.angularVelocity.y, -6, 6);
  }

  /**
   * Add zoom velocity. `amount` is positive to zoom in.
   * @param {number} amount
   */
  zoom(amount) {
    if (this.cinematic) return;
    this.zoomVelocity = clamp(this.zoomVelocity + amount * this.tuning.zoomGain * 3.2, -7, 7);
  }

  /**
   * Pan the focus point in screen space — the pinch-drag "grab the scene" feel.
   *
   * @param {number} dx
   * @param {number} dy
   * @param {number} [dt]
   */
  pan(dx, dy, dt = 1 / 60) {
    if (this.cinematic) return;
    // Pan speed must scale with distance or the scene feels like it is on
    // different rails at different zooms.
    const scale = this.radius * 0.9 * this.tuning.panGain;
    this._right.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this._up.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.focusTarget.addScaledVector(this._right, -dx * scale * dt * 60);
    this.focusTarget.addScaledVector(this._up, dy * scale * dt * 60);
  }

  /**
   * Roll the camera (two-hand twist).
   * @param {number} amount Radians of delta.
   */
  rollBy(amount) {
    if (this.cinematic) return;
    this.rollVelocity = clamp(this.rollVelocity + amount * this.tuning.rollGain, -5, 5);
  }

  /**
   * Kill all momentum — the fist gesture, or the end of a flight.
   * @param {number} [factor] 0 = instant stop, 1 = normal damping.
   */
  brake(factor = 0) {
    if (factor <= 0) {
      this.angularVelocity.set(0, 0);
      this.zoomVelocity = 0;
      this.rollVelocity = 0;
      return;
    }
    this.angularVelocity.multiplyScalar(factor);
    this.zoomVelocity *= factor;
    this.rollVelocity *= factor;
  }

  /** Set the brake mode used by decay. */
  setBraking(on) {
    if (this.braking === on) return;
    this.braking = on;
    this.emit('brake', on);
  }

  /* --------------------------------------------------------------- targets -- */

  /**
   * Move the focus point.
   * @param {THREE.Vector3|number[]} target
   * @param {boolean} [immediate] Skip the spring (used on first frame).
   */
  setFocus(target, immediate = false) {
    const v = Array.isArray(target) ? this._tmp.fromArray(target) : this._tmp.copy(target);
    this.focusTarget.copy(v);
    if (immediate) {
      this.focus.copy(this.focusTarget);
      this.apply();
    }
  }

  /**
   * Set the orbital distance directly, clamped.
   * @param {number} radius
   * @param {boolean} [immediate]
   */
  setRadius(radius, immediate = false) {
    this.radiusTarget = clamp(radius, this.minDistance, this.maxDistance);
    if (immediate) {
      this.radius = this.radiusTarget;
      this.apply();
    }
  }

  /**
   * Set the azimuth, taking the short way round.
   * @param {number} theta
   * @param {boolean} [immediate]
   */
  setTheta(theta, immediate = false) {
    this.thetaTarget = theta;
    if (immediate) {
      this.theta = theta;
      this.apply();
    }
  }

  /**
   * Set the polar angle.
   * @param {number} phi
   * @param {boolean} [immediate]
   */
  setPhi(phi, immediate = false) {
    // Never let the camera pass the poles: the flip is nauseating.
    const limit = Math.PI / 2 - 0.02;
    this.phiTarget = clamp(phi, -limit, limit);
    if (immediate) {
      this.phi = this.phiTarget;
      this.apply();
    }
  }

  /** Frame a sphere of `radius` units so it fills the frame nicely. */
  frameRadius(radius, padding = 2.6) {
    const fov = this.camera.fov * DEG;
    const d = (radius * padding) / Math.sin(Math.min(fov, 1.2) / 2);
    return clamp(d, this.minDistance, this.maxDistance);
  }

  /* ---------------------------------------------------------------- update -- */

  /**
   * Integrate one frame.
   * @param {number} dt Seconds since the previous update.
   */
  update(dt) {
    if (dt <= 0) return;

    // --- momentum decay ----------------------------------------------------
    // Exponential decay, expressed as a per-second factor so it is frame-rate
    // independent: after 1 s only `damping` of the velocity survives.
    const d = this.braking ? this.tuning.brakeDamping : this.tuning.damping;
    const decay = Math.pow(d, dt);

    this.theta += this.angularVelocity.x * dt;
    this.phi += this.angularVelocity.y * dt;
    this.angularVelocity.multiplyScalar(decay);

    // Zoom is logarithmic: multiplying feels linear to the hand.
    this.radiusTarget *= Math.exp(-this.zoomVelocity * dt);
    this.zoomVelocity *= decay;
    this.radiusTarget = clamp(this.radiusTarget, this.minDistance, this.maxDistance);

    this.roll += this.rollVelocity * dt;
    this.rollVelocity *= decay;
    this.rollTarget = damp(this.rollTarget, this.rollTarget, 1, dt);

    // --- clamps ------------------------------------------------------------
    const limit = Math.PI / 2 - 0.02;
    if (this.phi > limit || this.phi < -limit) {
      this.phi = clamp(this.phi, -limit, limit);
      this.angularVelocity.y = 0;
    }
    this.theta = ((this.theta % TAU) + TAU) % TAU;

    // --- springs -----------------------------------------------------------
    this.focus.x = damp(this.focus.x, this.focusTarget.x, this.tuning.followDamping, dt);
    this.focus.y = damp(this.focus.y, this.focusTarget.y, this.tuning.followDamping, dt);
    this.focus.z = damp(this.focus.z, this.focusTarget.z, this.tuning.followDamping, dt);
    this.radius = damp(this.radius, this.radiusTarget, 7.0, dt);

    this.apply();
  }

  /** Write the current spherical state onto the THREE camera. */
  apply() {
    const sinPhi = Math.sin(this.phi);
    const x = this.focus.x + this.radius * sinPhi * Math.sin(this.theta);
    const y = this.focus.y + this.radius * Math.cos(this.phi);
    const z = this.focus.z + this.radius * sinPhi * Math.cos(this.theta);

    this.camera.position.set(x, y, z);
    this.camera.up.set(0, 1, 0);

    // Roll by tilting the up-vector around the view direction, which avoids the
    // gimbal problem you get from rotating the camera's local axes.
    if (Math.abs(this.roll) > EPS) {
      this._tmp.subVectors(this.focus, this.camera.position).normalize();
      this._quat.setFromAxisAngle(this._tmp, this.roll);
      this.camera.up.applyQuaternion(this._quat);
    }

    this.camera.lookAt(this.focus);

    // Grow the far plane with distance so scene 3 never clips the cosmic web,
    // while keeping maximum depth precision when zoomed in close to a planet.
    if (this.dynamicFar) {
      const need = Math.max(RENDERER.near * 100, this.radius * 60 + this.maxDistance);
      const clamped = clamp(need, RENDERER.near * 100, RENDERER.far);
      if (Math.abs(clamped - this.camera.far) / clamped > 0.02) {
        this.camera.far = clamped;
        this.camera.updateProjectionMatrix();
      }
    }
  }

  /**
   * Distance from the camera to its focus, for the HUD.
   * @returns {number}
   */
  get distance() { return this.radius; }

  /** Snapshot for debugging. */
  snapshot() {
    return {
      theta: +this.theta.toFixed(4),
      phi: +this.phi.toFixed(4),
      radius: +this.radius.toFixed(4),
      roll: +this.roll.toFixed(4),
      speed: +Math.hypot(this.angularVelocity.x, this.angularVelocity.y).toFixed(4),
      focus: this.focus.toArray().map((v) => +v.toFixed(2)),
      braking: this.braking,
      cinematic: this.cinematic,
    };
  }

  /**
   * Convert a normalised screen coordinate (-1..1, y up) into a world-space ray.
   * Used by the point gesture to aim at planets and stars.
   *
   * @param {number} ndcX
   * @param {number} ndcY
   * @param {THREE.Raycaster} [out]
   * @returns {THREE.Raycaster}
   */
  raycast(ndcX, ndcY, out = new THREE.Raycaster()) {
    out.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    out.far = Math.max(this.radius * 400, this.camera.far);
    return out;
  }

  /** Angle difference helper used by the swipe detector. */
  angleDelta(a, b) { return shortestAngle(a, b); }
}
