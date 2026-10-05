/**
 * Aggressive GPU-resource disposal.
 *
 * Switching between four scenes while holding a few hundred thousand particles
 * will leak catastrophically if you merely drop the reference: WebGL keeps the
 * buffer alive until `dispose()` is called, and an orphaned 200k-point
 * BufferGeometry costs ~10 MB of VRAM each time.
 *
 * Everything that can be disposed goes through {@link disposeObject}. Scene
 * modules call it from their own `dispose()` and rely on this to walk children,
 * materials, textures and render targets.
 *
 * @module utils/dispose
 */

import * as THREE from 'three';

/** Textures are often shared across materials; dispose each one only once. */
const seenTextures = new WeakSet();

/**
 * Dispose every GPU resource reachable from `root`.
 *
 * Handles: BufferGeometry, Material (and its texture slots), Texture, render
 * targets, InstancedMesh instance buffers, and SkinnedMesh skeletons.
 *
 * @param {THREE.Object3D | THREE.Material | THREE.Texture | THREE.BufferGeometry} root
 * @param {{ keepTextures?: Set<THREE.Texture>, keepMaterials?: Set<THREE.Material> }} [opts]
 *        Objects to preserve — handy when a material outlives one scene.
 */
export function disposeObject(root, opts = {}) {
  if (!root) return;
  const keepTextures = opts.keepTextures ?? new Set();
  const keepMaterials = opts.keepMaterials ?? new Set();

  if (root instanceof THREE.Texture) {
    if (!keepTextures.has(root) && !seenTextures.has(root)) {
      seenTextures.add(root);
      root.dispose();
    }
    return;
  }

  if (root instanceof THREE.BufferGeometry) {
    root.dispose();
    return;
  }

  if (root instanceof THREE.Material || root instanceof THREE.ShaderMaterial) {
    if (keepMaterials.has(root)) return;
    disposeMaterial(root);
    return;
  }

  if (typeof root.traverse === 'function') {
    root.traverse((child) => {
      child.geometry?.dispose?.();
      const mat = child.material;
      if (Array.isArray(mat)) mat.forEach((m) => disposeMaterial(m, keepTextures));
      else if (mat) disposeMaterial(mat, keepTextures);
      // InstancedMesh keeps its per-instance attributes on the geometry, but a
      // detached instanceMatrix needs an explicit delete on some backends.
      if (child.isInstancedMesh) child.dispose?.();
      child.skeleton?.dispose?.();
    });
    root.clear?.();
  }
}

/**
 * Dispose a material and every texture it references.
 *
 * @param {THREE.Material} material
 * @param {Set<THREE.Texture>} [keep]
 */
export function disposeMaterial(material, keep = new Set()) {
  if (!material) return;
  for (const key of Object.keys(material)) {
    const value = material[key];
    if (value && value.isTexture && !keep.has(value) && !seenTextures.has(value)) {
      seenTextures.add(value);
      value.dispose();
    }
  }
  // Uniform-driven textures live outside the enumerable slots.
  if (material.uniforms) {
    for (const u of Object.values(material.uniforms)) {
      const t = u?.value;
      if (t && t.isTexture && !keep.has(t) && !seenTextures.has(t)) {
        seenTextures.add(t);
        t.dispose();
      }
    }
  }
  material.dispose();
}

/**
 * Convenience: recursively dispose a THREE.Object3D and detach it from its
 * parent so lingering references cannot resurrect it.
 *
 * @param {THREE.Object3D} object
 */
export function destroyObject(object) {
  if (!object) return;
  disposeObject(object);
  object.parent?.remove(object);
}

/**
 * Trailing-edge cleanup: give the browser a few frames to finish uploading any
 * resources we just released before the next scene allocates its own.
 *
 * @param {number} [frames]
 * @returns {Promise<void>}
 */
export function flushGpu(frames = 2) {
  return new Promise((resolve) => {
    let n = frames;
    const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

/**
 * WebGL resource snapshot, for the debug panel.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @returns {{ geometries: number, textures: number, programs?: number }}
 */
export function gpuInfo(renderer) {
  const info = renderer?.info;
  return {
    geometries: info?.memory?.geometries ?? 0,
    textures: info?.memory?.textures ?? 0,
  };
}
