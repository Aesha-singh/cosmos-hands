import { defineConfig } from 'vite';

/**
 * Vite configuration for COSMOS HANDS.
 *
 * Notable choices:
 *  - `base: './'` so the built bundle works from any GitHub Pages sub-path.
 *  - MediaPipe ships a pre-bundled ESM + CJS pair; pre-bundling it removes the
 *    "createFromOptions is not a function" breakage seen with unoptimised deps.
 *  - `assetsInlineLimit` is 0 for media/data, so the 560 KB constellation
 *    catalogue is fetched on demand rather than inlined.
 */
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    open: true,
    // getUserMedia needs a secure context; localhost qualifies.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  preview: { port: 4173 },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 1400,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        /** Split the heavy vendor code so the shell paints in < 1 s. */
        manualChunks: {
          three: ['three'],
          mediapipe: ['@mediapipe/tasks-vision'],
          gsap: ['gsap'],
        },
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
  optimizeDeps: {
    include: ['three', '@mediapipe/tasks-vision', 'gsap'],
    exclude: ['@mediapipe/tasks-vision/wasm'],
  },
  worker: { format: 'es' },
  define: {
    __COSMOS_VERSION__: JSON.stringify(process.env.npm_package_version ?? '1.0.0'),
    __COSMOS_BUILD__: JSON.stringify(new Date().toISOString()),
  },
});
