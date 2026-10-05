/**
 * The scene registry.
 *
 * This is the single source of truth for *which* scenes exist and in what order.
 * `main.js`, the tests and the HUD scene switcher all read from here, so adding
 * a fifth scene is a one-line change rather than an edit in three files.
 *
 * Order is the demo's narrative: outward from the one place we know intimately,
 * to the Milky Way, to the deep field, then back to a naked-eye sky with no
 * simulation at all. That last step is deliberate — after three scenes of
 * simulated physics, showing the *real* catalogue lands harder.
 *
 * @module scenes/registry
 */

import { SolarSystemScene } from './solar-system.js';
import { GalaxyScene } from './galaxy.js';
import { DeepUniverseScene } from './deep-universe.js';
import { ConstellationScene } from './constellation-sky.js';

/** @type {Array<typeof import('./scene-base.js').SceneBase>} */
export const SCENE_CLASSES = [
  SolarSystemScene,
  GalaxyScene,
  DeepUniverseScene,
  ConstellationScene,
];

export default SCENE_CLASSES;