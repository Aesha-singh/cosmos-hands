/**
 * Vitest configuration.
 *
 * Two environments, because the codebase is two kinds of code:
 *
 *  • `node` for pure logic — orbital mechanics, the gesture classifier, audio
 *    envelope maths. These tests must stay fast and must not accidentally grow a
 *    dependency on the DOM, which is why they stay on the node environment.
 *
 *  • `jsdom` for anything that touches `document` or `canvas`. The texture and
 *    UI helpers generate images with the 2-D canvas API, and every scene builds
 *    sprites from those helpers, so without jsdom the scenes cannot be exercised
 *    at all.
 *
 * Three's geometry, materials and shaders all construct without a real GL
 * context, so a whole scene graph can be built, updated and torn down in a test.
 * Only actual pixel output needs a browser, and that is exactly what
 * `tools/validate-shaders.mjs` covers — so shader correctness is proven by a
 * separate tool rather than mocked here.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['tests/**/*.test.js'],
    reporters: ['default'],
    // Shader-linked scene construction is slow enough that a tight per-test
    // timeout produces flaky failures on a loaded machine.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    projects: [
      {
        test: {
          name: 'logic',
          environment: 'node',
          testTimeout: 20_000,
          hookTimeout: 20_000,
          include: [
            'tests/gesture-vocabulary.test.js',
            'tests/orbits.test.js',
            'tests/constellations-data.test.js',
            'tests/audio.test.js',
            'tests/scene-manager.test.js',
          ],
        },
      },
      {
        test: {
          name: 'dom',
          environment: 'jsdom',
          setupFiles: ['tests/setup/canvas-stub.js','tests/setup/image-stub.js'],
          testTimeout: 20_000,
          // Scene construction generates fallback textures synchronously.
          hookTimeout: 60_000,
          include: [
            'tests/scenes/*.test.js',
            'tests/ui/*.test.js',
          ],
        },
      },
    ],
  },
});