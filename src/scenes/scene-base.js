/**
 * Scene contract.
 *
 * Every scene owns one `THREE.Scene`, its own bodies, and its own camera
 * limits. The manager swaps them without the app knowing, so a scene only has
 * to answer five questions:
 *
 *   • What is in it?          → `bodies` (focusable objects) and `railItems`
 *   • What does time do here? → `update(dt, elapsed)`
 *   • Where can I go?         → `limits` (min/max camera distance, far plane)
 *   • What does a flight to X look like? → `focus(id)`
 *   • How do I clean up?      → `dispose()`
 *
 * Scenes are built lazily and never block the frame loop: `prepare()` returns a
 * promise and the manager waits behind a loading state, so a slow scene never
 * freezes the render loop.
 *
 * @module scenes/scene-base
 */

import * as THREE from 'three';
import { RENDERER } from '../config.js';
import { Emitter } from '../utils/dom.js';
import { disposeObject } from '../utils/dispose.js';

export class SceneBase extends Emitter {
  /**
   * @param {Object} meta
   * @param {string} meta.id
   * @param {string} meta.title
   * @param {string} meta.subtitle
   * @param {string} [meta.verb] Used in the switcher.
   */
  constructor(meta) {
    super();
    this.id = meta.id;
    this.title = meta.title;
    this.subtitle = meta.subtitle ?? '';
    this.verb = meta.verb ?? meta.title;

    /** @type {THREE.Scene} */
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(RENDERER.clearColor);
    this.scene.fog = null;

    /**
     * Focusable bodies.
     * @type {Map<string, Object>}
     */
    this.bodies = new Map();

    /**
     * Camera limits for this scene.
     * @type {{ min: number, max: number, far: number, fov: number }}
     */
    this.limits = {
      min: 0.05,
      max: 2.2e6,
      far: RENDERER.far,
      fov: RENDERER.fov,
    };

    // Invariant every scene must hold: the far plane has to be reachable, and
    // wide enough to contain the camera at any permitted distance. Violating it
    // produces a scene that renders fine until you zoom out, then goes black.
    if (this.limits.far <= this.limits.max) {
      throw new RangeError(
        `${this.id}: limits.far (${this.limits.far}) must exceed limits.max `
        + `(${this.limits.max}), otherwise the far plane clips the scene.`,
      );
    }

    /** Default framing applied when the scene opens. */
    this.homeView = { focus: new THREE.Vector3(), radius: 400, theta: Math.PI * 0.28, phi: Math.PI * 0.42 };

    /** Set while the scene is animating in, to suppress input. */
    this.entering = false;

    this._disposed = false;
  }

  /**
   * Async construction. Override to load textures and build geometry.
   * @param {Object} [ctx]
   * @returns {Promise<SceneBase>}
   */
  async prepare() {
    return this;
  }

  /**
   * Per-frame update.
   * @param {number} _dt Seconds.
   * @param {number} _elapsed Simulated seconds since J2000.
   */
  update(_dt, _elapsed) {}

  /**
   * Move to a body.
   * @param {string} _id
   * @returns {THREE.Vector3|null} the new focus point, or null if unknown
   */
  focus(_id) { return null; }

  /** @returns {string} id of the body currently framed */
  get activeId() { return this._activeId ?? ''; }

  /**
   * Register a focusable body.
   * @param {string} id
   * @param {Object} body
   */
  addBody(id, body) {
    this.bodies.set(id, body);
    return body;
  }

  /**
   * Items for the object navigator rail.
   * @returns {Array<{ id: string, label: string, type: string }>}
   */
  get railItems() {
    return [...this.bodies.entries()].map(([id, b]) => ({
      id,
      label: b.label ?? id,
      type: b.type ?? 'body',
    }));
  }

  /** Release every GPU resource this scene owns. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    disposeObject(this.scene);
    this.bodies.clear();
    this.clear();
  }
}