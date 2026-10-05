# COSMOS HANDS

> A universe you steer with your hands.

COSMOS HANDS is a real-time, browser-based experience that maps your bare hands to an astronomically plausible model of the cosmos. It combines [MediaPipe](https://developers.google.com/mediapipe) hand tracking, [Three.js](https://threejs.org/) and custom GLSL to explore the Solar System, the Milky Way, the cosmic web and the 88 IAU constellations — with nothing about your camera ever leaving your device.

[Demo (GitHub Pages)](https://aeshasingh.github.io/cosmos-hands/)
[Source](https://github.com/Aesha-singh/cosmos-hands)

## Features

- **Hands-only control.** Open palm to orbit, pinch to zoom, fist to brake, point+hold to select, two-hand twist/pan and both palms to reset. Every gesture has a mouse/touch fallback.
- **Four scientifically minded scenes.**
  1. **Solar System** — Real Kepler orbits solved against the simulation clock. Logarithmic orbit spacing keeps every planet visible while the bodies themselves travel the true radii. Includes major moons (with Luna mapped to its real 2k texture).
  2. **Milky Way** — 220,000 GPU-driven stars with differential rotation, four spiral arms, bulge/halo/inter-arm populations and an accretion torus for Sgr A*.
  3. **Deep Universe** — Cosmic web built from nearest-neighbour filaments, a camera-locked nebula dome, a quasar field and relic CMB landmarks with light-travel context.
  4. **88 Constellations** — 9,983 HYG stars to magnitude 6.6, all 88 IAU figures with snapped stick art, Milky Way band, and accurate RA/Dec.
- **Local-only by design.** Webcam frames and landmarks never leave your device. Models load from `public/models` and MediaPipe WASM from `public/mediapipe/wasm` — no runtime CDN required.
- **Production ready.** Vite 7 build, relative base for GitHub Pages, COOP/COEP headers, ES2022, vendor chunks, adaptive quality, post-processing (bloom/grade), Web Audio procedural ambience, and real WebGL2 shader validation.
- **Tested.** Vitest suite covers gesture classification and all four scenes. 15/15 shaders pass headless validation. Production build succeeds.

## Quick start

Prerequisites: Node 20+ (tested with Node 25.6.1, npm 11.9.0), a modern browser with WebGL 2 and camera access (HTTPS or `localhost`).

```bash
git clone https://github.com/Aesha-singh/cosmos-hands.git
cd cosmos-hands
npm ci
npm run dev
# open http://localhost:5173
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the Vite dev server (with COOP/COEP headers for MediaPipe). |
| `npm run build` | Production build to `dist/`. |
| `npm run preview` | Preview the production build locally. |
| `npm run check:shaders` | Validate all GLSL programs against WebGL2 (`tools/validate-shaders.mjs`). |
| `npm run test` | Run Vitest (logic + DOM projects). |
| `npm run check` | Run shaders, tests and a production build. |
| `npm run deploy` | Build and deploy to GitHub Pages (`vite build && gh-pages -d dist`). |

## Assets

- Textures downloaded via `scripts/fetch_textures.sh` (Solar System Scope, real Earth/Moon/Venus/Saturn/Sun maps where available).
- Constellations generated via `scripts/build_constellations.mjs` from HYG 4.1 + d3-celestial (CC BY-SA 4.0 / BSD-3-Clause attribution included).
- MediaPipe task models and WASM are staged under `public/` and served locally.

## Tech

- Vite 7 · Three.js 0.186.1 · @mediapipe/tasks-vision 1.0.1 · GSAP 3.13.0 · Vitest 3
- Vanilla ES modules, GLSL, Web Audio API (procedural, no MP3s)

## License

MIT
