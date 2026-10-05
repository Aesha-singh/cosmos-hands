/**
 * Asset loading with graceful degradation.
 *
 * Every texture in COSMOS HANDS has a procedural twin. If the network is down,
 * `npm run assets` was never run, or the user is offline on GitHub Pages, the app
 * still looks intentional — it just gets synthesised maps instead of
 * photograph-derived ones.
 *
 * @module utils/textures
 */

import * as THREE from 'three';

/** Resolution per quality tier for procedural textures. */
const PROC_RES = { high: 1024, medium: 512, low: 256 };

/** @type {{ high: number, medium: number, low: number }} */
let resolution = PROC_RES.high;

/**
 * Set the resolution used for procedural textures.
 * @param {string} tier Quality tier name.
 * @returns {number} The resolution now in effect, pixels per side.
 */
export function setProceduralResolution(tier) {
  resolution = PROC_RES[tier] ?? PROC_RES.medium;
  return resolution;
}

const cache = new Map();

/**
 * Load a texture, falling back to `fallback` (or null) on any error.
 *
 * @param {string} url Path relative to the site root.
 * @param {Object} [opts]
 * @param {boolean} [opts.srgb] Treat colour data as sRGB (default true).
 * @param {boolean} [opts.repeat] Enable wrap-repeat (default true).
 * @param {THREE.Texture|null} [opts.fallback] Returned if the load fails.
 * @param {(t: THREE.Texture) => void} [opts.onLoad] Called on success only.
 * @returns {Promise<THREE.Texture|null>}
 */
export function loadTexture(url, opts = {}) {
  const { srgb = true, repeat = true, fallback = null, onLoad } = opts;
  const cacheKey = `${url}|${srgb}|${repeat}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const promise = new Promise((resolve) => {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(
      url,
      (tex) => {
        configure(tex, { srgb, repeat });
        onLoad?.(tex);
        resolve(tex);
      },
      undefined,
      () => {
        // Not an error state worth a console trace: procedural covers it.
        if (import.meta.env?.DEV) console.debug(`[textures] using procedural fallback for ${url}`);
        resolve(fallback);
      },
    );
  });

  cache.set(cacheKey, promise);
  return promise;
}

/**
 * Load several textures in parallel.
 *
 * @param {Record<string, string>} map name → url
 * @param {Object} [opts]
 * @returns {Promise<Record<string, THREE.Texture|null>>}
 */
export async function loadTextures(map, opts = {}) {
  const entries = await Promise.all(
    Object.entries(map).map(async ([k, url]) => [k, await loadTexture(url, opts)]),
  );
  return Object.fromEntries(entries);
}

/** Apply colour space + wrapping to an existing texture. */
export function configure(tex, { srgb = true, repeat = true, aniso = 8 } = {}) {
  if (!tex) return tex;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Build a Texture from an offscreen canvas.
 *
 * @param {number} width
 * @param {number} height
 * @param {(ctx: CanvasRenderingContext2D, w: number, h: number) => void} draw
 * @param {Object} [opts]
 * @returns {THREE.CanvasTexture}
 */
export function canvasTexture(width, height, draw, opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  draw(ctx, width, height);
  const tex = new THREE.CanvasTexture(canvas);
  configure(tex, { srgb: opts.srgb ?? true, repeat: opts.repeat ?? true });
  tex.anisotropy = opts.anisotropy ?? 8;
  tex.userData.canvas = canvas;
  return tex;
}

/**
 * A seamlessly tiling 1×N gradient strip — used for Saturn's rings and the
 * galaxy's arm colour ramp.
 *
 * @param {(t: number) => [number, number, number]} colorFn Colour at t ∈ [0,1].
 * @param {number} [width]
 * @param {number} [height]
 * @returns {THREE.CanvasTexture}
 */
export function gradientTexture(colorFn, width = 512, height = 4) {
  return canvasTexture(width, height, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    for (let x = 0; x < w; x++) {
      const [r, g, b] = colorFn(x / (w - 1));
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4;
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, { srgb: true, repeat: true });
}

/**
 * A soft, additive star sprite generated at runtime.
 *
 * Better than a downloaded PNG: no mip seams, correct alpha falloff for bloom,
 * and a subtle 4-point diffraction cross that reads as "photographic".
 *
 * @param {number} [size]
 * @returns {THREE.CanvasTexture}
 */
export function makeStarSprite(size = 128) {
  return canvasTexture(size, size, (ctx, w, h) => {
    const c = w / 2;
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (x - c) / c;
        const dy = (y - c) / c;
        const r = Math.hypot(dx, dy);
        // Core: sharp gaussian. Halo: wide, faint. Cross: 4-point diffraction.
        const core = Math.exp(-r * r * 26);
        const halo = Math.exp(-r * 2.6) * 0.32;
        const cross = (Math.exp(-Math.abs(dx) * 26) + Math.exp(-Math.abs(dy) * 26))
          * Math.exp(-r * 2.2) * 0.16;
        const a = Math.min(1, core + halo + cross);
        const i = (y * w + x) * 4;
        img.data[i] = 255;
        img.data[i + 1] = 252;
        img.data[i + 2] = 244;
        img.data[i + 3] = a * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, { srgb: true, repeat: false });
}

/**
 * Load a texture or synthesise one — the single entry point every scene uses.
 *
 * @param {string} url
 * @param {(ctx: CanvasRenderingContext2D, w: number, h: number) => void} procedural
 * @param {Object} [opts]
 * @returns {Promise<THREE.Texture>}
 */
export async function loadOrProcedural(url, procedural, opts = {}) {
  const res = resolution;
  const loaded = await loadTexture(url, { ...opts, fallback: null });
  if (loaded) return loaded;
  return canvasTexture(res, res, procedural, opts);
}

/** Empty the module-level cache (used when tearing a scene down). */
export function clearTextureCache() {
  cache.clear();
}
