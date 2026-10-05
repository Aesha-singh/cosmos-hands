/**
 * Post-processing chain.
 *
 * RenderPass → UnrealBloomPass → FilmGradePass → OutputPass
 *
 * The grade pass is custom (`src/shaders/post.js`): chromatic aberration,
 * vignette, film grain, radial warp blur and a transition flash, all in one
 * full-screen pass so we never pay for two extra framebuffer copies.
 *
 * Bloom runs in linear HDR *before* tone mapping, which is the whole reason the
 * Sun looks like the Sun instead of like a white disc.
 *
 * @module core/postprocessing
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { POST } from '../config.js';
import { QUAD_VERTEX, FILM_GRADE_FRAGMENT, GRADE_UNIFORM_DEFAULTS } from '../shaders/post.js';
import { Emitter } from '../utils/dom.js';

/** The grade pass as a ShaderMaterial-compatible definition. */
export const FilmGradeShader = {
  name: 'FilmGradeShader',
  uniforms: {
    tDiffuse: { value: null },
    ...structuredCloneUniforms(GRADE_UNIFORM_DEFAULTS),
  },
  vertexShader: QUAD_VERTEX,
  fragmentShader: FILM_GRADE_FRAGMENT,
};

/** Deep-clone the uniform defaults so each instance owns its own objects. */
function structuredCloneUniforms(src) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = { value: Array.isArray(v.value) ? [...v.value] : v.value };
  }
  return out;
}

export class PostPipeline extends Emitter {
  /**
   * @param {import('./renderer.js').Renderer} renderer
   */
  constructor(renderer) {
    super();
    this.renderer = renderer;
    this.gl = renderer.gl;
    this.scene = renderer.scene;
    this.camera = renderer.camera;

    this.enabled = true;
    this.bloomEnabled = true;

    this.composer = new EffectComposer(this.gl);
    this.composer.setPixelRatio(renderer.pixelRatio);
    this.composer.setSize(renderer.width, renderer.height);

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(renderer.width, renderer.height),
      POST.bloom.strength,
      POST.bloom.radius,
      POST.bloom.threshold,
    );
    this.composer.addPass(this.bloomPass);

    this.gradePass = new ShaderPass(FilmGradeShader);
    this.gradePass.material.transparent = false;
    this.composer.addPass(this.gradePass);

    // Tone mapping + sRGB conversion happen here, last.
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    this._resize = (w, h, pr) => {
      this.composer.setPixelRatio(pr);
      this.composer.setSize(w, h);
      this.bloomPass.setSize(w * pr, h * pr);
      const u = this.gradePass.material.uniforms;
      u.uResolution.value = [w * pr, h * pr];
    };
    renderer.onResize = this._resize;
    this._resize(renderer.width, renderer.height, renderer.pixelRatio);

    /** Current warp intensity 0..1 — the 🤟 easter egg. */
    this.warp = 0;
    this._warpTarget = 0;
    /** Transition flash 0..1. */
    this._flash = 0;
    this._flashDecay = 1;
  }

  /** Point the composer at a new scene/camera without rebuilding the chain. */
  setScene(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
  }

  /**
   * Per-frame uniform sync.
   * @param {number} dt
   * @param {number} time Total elapsed seconds.
   */
  update(dt, time) {
    const u = this.gradePass.material.uniforms;
    u.uTime.value = time;

    // Warp eases in and out rather than snapping, so the 🤟 gesture has weight.
    const k = 1 - Math.exp(-6 * dt);
    this.warp += (this._warpTarget - this.warp) * k;
    u.uWarp.value = this.warp;

    if (this._flash > 0) {
      this._flash = Math.max(0, this._flash - dt * this._flashDecay);
      u.uFlash.value = this._flash;
    }
  }

  /**
   * Trigger the scene-change flash.
   * @param {number} [amount] 0..1
   * @param {number[]} [color] RGB 0..1
   * @param {number} [decay] Per-second decay rate.
   */
  flash(amount = 0.55, color = [0.85, 0.78, 0.6], decay = 1.6) {
    const u = this.gradePass.material.uniforms;
    u.uFlashColor.value = color;
    this._flash = amount;
    u.uFlash.value = amount;
    this._flashDecay = decay;
  }

  /** Enable or disable the warp-drive easter egg. */
  setWarp(on) {
    this._warpTarget = on ? 1 : 0;
    this.bloomPass.strength = on ? POST.bloom.strength * 1.35 : POST.bloom.strength;
    this.emit('warp', on);
  }

  /** @param {boolean} on */
  get warpActive() { return this._warpTarget > 0.5; }

  /** Apply a quality tier to the whole chain. */
  applyTier(tierName) {
    const tier = POST.tiers[tierName] ?? POST.tiers.high;
    this.bloomEnabled = tier.bloom;
    this.bloomPass.enabled = tier.bloom;
    this.gradePass.material.uniforms.uChromatic.value = tier.chromaticAberration;
    this.gradePass.material.uniforms.uGrainIntensity.value = tier.bloom ? POST.grain.intensity : 0.03;
    this.emit('tier', tierName);
  }

  /** Live-tune a grade uniform from the debug panel. */
  setUniform(name, value) {
    const u = this.gradePass.material.uniforms;
    if (!u[name]) return false;
    u[name].value = value;
    return true;
  }

  /** @returns {Object} uniform snapshot for the debug panel */
  snapshot() {
    const u = this.gradePass.material.uniforms;
    return {
      bloom: this.bloomPass.enabled,
      strength: +this.bloomPass.strength.toFixed(3),
      chromatic: u.uChromatic.value,
      grain: u.uGrainIntensity.value,
      vignette: u.uVignetteDarkness.value,
      warp: +this.warp.toFixed(3),
    };
  }

  /** Render one frame. */
  render(dt) {
    if (!this.enabled) {
      this.gl.render(this.scene, this.camera);
      return;
    }
    this.composer.render(dt);
  }

  /** Dispose the composer and every render target in the chain. */
  dispose() {
    this.composer.passes.forEach((p) => p.dispose?.());
    this.composer.renderTarget1?.dispose();
    this.composer.renderTarget2?.dispose();
    this.bloomPass.dispose?.();
    this.gradePass.material.dispose();
    this.renderer.onResize = null;
  }
}
