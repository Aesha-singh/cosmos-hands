/**
 * Renderer + scene + camera bootstrap.
 *
 * Owns the WebGL context, the canvas, tone mapping and the resize policy.
 * Deliberately thin: everything visual lives in `scenes/`, everything temporal
 * in `loop.js`.
 *
 * @module core/renderer
 */

import * as THREE from 'three';
import { BRAND, RENDERER } from '../config.js';
import { $ } from '../utils/dom.js';

/** A fatal, user-visible capability error. */
export class WebGLUnsupportedError extends Error {
  /**
   * @param {string} message
   * @param {string} [detail]
   */
  constructor(message, detail) {
    super(message);
    this.name = 'WebGLUnsupportedError';
    this.detail = detail;
  }
}

/**
 * Detect WebGL 2 support without leaving a context behind where possible.
 *
 * @returns {{ ok: boolean, reason?: string, renderer?: string }}
 */
export function probeWebGL() {
  if (typeof WebGL2RenderingContext === 'undefined') {
    return { ok: false, reason: 'This browser does not implement WebGL 2.' };
  }
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
    if (!gl) return { ok: false, reason: 'WebGL 2 context could not be created.' };

    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);

    // Half-float render targets are non-negotiable: bloom and HDR need them.
    const colorBufferFloat = !!gl.getExtension('EXT_color_buffer_float')
      || !!gl.getExtension('EXT_color_buffer_half_float');
    if (!colorBufferFloat) {
      return { ok: false, reason: 'Floating-point render targets are unavailable, which the bloom pipeline requires.', renderer };
    }
    if (gl.getParameter(gl.MAX_TEXTURE_SIZE) < 4096) {
      return { ok: false, reason: `Only ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}px textures are supported; 4096 is required for the solar maps.`, renderer };
    }

    // Release the probe context immediately — browsers cap concurrent contexts.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { ok: true, renderer: String(renderer) };
  } catch (err) {
    return { ok: false, reason: `WebGL initialisation threw: ${err.message}` };
  }
}

/**
 * The core rendering context.
 */
export class Renderer {
  constructor() {
    /** @type {HTMLCanvasElement} */
    this.canvas = $('canvas#stage');

    const probe = probeWebGL();
    if (!probe.ok) throw new WebGLUnsupportedError(probe.reason, probe.renderer);
    this.gpu = probe.renderer;

    /** @type {THREE.WebGLRenderer} */
    this.gl = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      // Keep the drawing buffer for post-processing passes to read from.
      preserveDrawingBuffer: false,
      stencil: false,
      depth: true,
    });

    this.gl.setClearColor(new THREE.Color(BRAND.colors.void), 1);
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = RENDERER.toneMappingExposure;
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.autoClear = true;
    this.gl.sortObjects = true;
    this.gl.shadowMap.enabled = RENDERER.shadows;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;

    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, RENDERER.maxPixelRatio);
    this.pixelRatio = this.maxPixelRatio;
    this.gl.setPixelRatio(this.pixelRatio);

    /** @type {THREE.Scene} */
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BRAND.colors.void);

    /** @type {THREE.PerspectiveCamera} */
    this.camera = new THREE.PerspectiveCamera(
      RENDERER.fov,
      window.innerWidth / Math.max(window.innerHeight, 1),
      RENDERER.near,
      RENDERER.far,
    );
    this.camera.position.set(0, 0, 300);
    this.camera.lookAt(0, 0, 0);

    /** @type {THREE.Clock} */
    this.clock = new THREE.Clock();

    /** Viewport size in CSS pixels. */
    this.width = window.innerWidth;
    this.height = Math.max(window.innerHeight, 1);

    /** Set when the WebGL context is lost so the loop can halt cleanly. */
    this.contextLost = false;

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize, { passive: true });
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      console.warn('[renderer] WebGL context lost');
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      console.info('[renderer] WebGL context restored');
    });

    this._onResize();
  }

  /** Recompute size and aspect, honouring the current pixel ratio. */
  _onResize() {
    this.width = window.innerWidth;
    this.height = Math.max(window.innerHeight, 1);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.gl.setPixelRatio(this.pixelRatio);
    this.gl.setSize(this.width, this.height, false);
    this.onResize?.(this.width, this.height, this.pixelRatio);
  }

  /**
   * Change the device-pixel ratio (used by the quality manager).
   * @param {number} ratio
   */
  setPixelRatio(ratio) {
    const next = Math.max(RENDERER.minPixelRatio, Math.min(ratio, this.maxPixelRatio));
    if (Math.abs(next - this.pixelRatio) < 1e-3) return false;
    this.pixelRatio = next;
    this.gl.setPixelRatio(next);
    this.gl.setSize(this.width, this.height, false);
    this.onResize?.(this.width, this.height, this.pixelRatio);
    return true;
  }

  /** @returns {{ width: number, height: number, pixelRatio: number }} */
  get viewport() {
    return { width: this.width, height: this.height, pixelRatio: this.pixelRatio };
  }

  /** Release every GPU resource and DOM listener. */
  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.gl.dispose();
  }
}
