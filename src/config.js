/**
 * COSMOS HANDS — single source of truth for every tunable value.
 *
 * Rule of thumb for this codebase: if a number affects behaviour or look, it
 * lives here. Scene code reads from CONFIG, never from a literal.
 *
 * @module config
 */

/** @typedef {'low'|'medium'|'high'} QualityTier */

/* -------------------------------------------------------------------------- */
/* Brand                                                                       */
/* -------------------------------------------------------------------------- */
export const BRAND = {
  name: 'COSMOS HANDS',
  tagline: 'A universe you steer with your hands',
  colors: {
    void: '#050816',
    deepNavy: '#0a1030',
    gold: '#D4AF37',
    goldLight: '#E8D5A3',
    cyan: '#6FE3FF',
    cyanSoft: '#9BD8E8',
    warn: '#FFB454',
    danger: '#FF6B6B',
    ok: '#7CFFB2',
  },
  fonts: {
    display: '"Cormorant Garamond", "Iowan Old Style", Georgia, serif',
    mono: '"SF Mono", "JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace',
  },
};

/* -------------------------------------------------------------------------- */
/* World scales                                                                */
/* -------------------------------------------------------------------------- */
/**
 * The renderer works in "scene units". 1 unit = 1 000 000 km (1 Gm), which puts
 * Mercury at 58 units and Neptune at 4 500 units — comfortable float precision
 * while keeping real proportions intact.
 */
export const SCALE = {
  /** Kilometres per scene unit. */
  UNIT_KM: 1e6,
  /** Astronomical unit in kilometres (IAU 2012 definition). */
  AU_KM: 1_495_978_707,
  /** Scene units per astronomical unit. */
  get AU() { return this.AU_KM / this.UNIT_KM; },
  /** Scene units per light-year. */
  get LY() { return 9.4607e12 / this.UNIT_KM; },
  /** Scene units per parsec. */
  get PC() { return 3.0857e13 / this.UNIT_KM; },
  /** Scene units per megaparsec. */
  get MPC() { return 3.0857e19 / this.UNIT_KM; },
  /** Earth radii, the natural unit for the atmosphere shaders. */
  EARTH_RADIUS_KM: 6371,
};

/* -------------------------------------------------------------------------- */
/* Renderer                                                                    */
/* -------------------------------------------------------------------------- */
export const RENDERER = {
  maxPixelRatio: 2,
  /** Device-pixel-ratio ceiling used by the adaptive quality manager. */
  minPixelRatio: 0.75,
  clearColor: BRAND.colors.void,
  toneMappingExposure: 1.0,
  /** Camera far plane, in scene units — reaches past the Local Group. */
  far: 4e7,
  near: 1e-4,
  fov: 52,
  /** Enable shadows on the sun's point light. Costly; off by default. */
  shadows: false,
};

/* -------------------------------------------------------------------------- */
/* Post-processing                                                             */
/* -------------------------------------------------------------------------- */
/** Radial chromatic aberration, in UV units at the frame edge, per tier. */
const CHROMATIC = { high: 0.0022, medium: 0.0011, low: 0 };

export const POST = {
  bloom: {
    strength: 0.95,
    radius: 0.55,
    threshold: 0.62,
  },
  chromaticAberration: CHROMATIC.high,
  vignette: {
    offset: 0.28,
    darkness: 1.05,
  },
  grain: {
    intensity: 0.045,
    speed: 12.0,
  },
  /** Anamorphic streak strength for the sun. */
  streak: 0.28,
  /** Per-tier overrides applied by the quality manager. */
  tiers: {
    high: { bloom: true, streak: true, chromaticAberration: CHROMATIC.high },
    medium: { bloom: true, streak: false, chromaticAberration: CHROMATIC.medium },
    low: { bloom: false, streak: false, chromaticAberration: CHROMATIC.low },
  },
};

/* -------------------------------------------------------------------------- */
/* Adaptive quality                                                            */
/* -------------------------------------------------------------------------- */
export const QUALITY = {
  /** Rolling FPS window length (samples). */
  windowSize: 90,
  /** Below this average FPS we step down one tier. */
  downgradeFps: 40,
  /** Above this average FPS (sustained) we may step back up. */
  upgradeFps: 55,
  /** Cooldown between tier changes, ms — prevents oscillation. */
  cooldownMs: 4000,
  tiers: {
    high: {
      galaxyParticles: 220_000,
      beltRocks: 52_000,
      nebulaSegments: 96,
      constellationStars: 9983,
      pixelRatio: 2,
      starfieldStars: 14_000,
      softParticles: true,
    },
    medium: {
      galaxyParticles: 110_000,
      beltRocks: 26_000,
      nebulaSegments: 64,
      constellationStars: 5200,
      pixelRatio: 1.35,
      starfieldStars: 8000,
      softParticles: true,
    },
    low: {
      galaxyParticles: 48_000,
      beltRocks: 9000,
      nebulaSegments: 40,
      constellationStars: 2600,
      pixelRatio: 0.85,
      starfieldStars: 4200,
      softParticles: false,
    },
  },
};

/* -------------------------------------------------------------------------- */
/* Time control                                                                */
/* -------------------------------------------------------------------------- */
/**
 * Simulated-seconds per real-second for each preset on the time bar.
 * `1 year / sec` is what makes Neptune crawl and Mercury blur.
 */
export const TIME_PRESETS = [
  { label: 'PAUSE', value: 0, short: '❚❚' },
  { label: '1 s / s', value: 1, short: '1×' },
  { label: '1 min / s', value: 60, short: '60×' },
  { label: '1 hour / s', value: 3600, short: '1 h/s' },
  { label: '1 day / s', value: 86400, short: '1 d/s' },
  { label: '1 week / s', value: 604800, short: '1 w/s' },
  { label: '1 month / s', value: 2_629_800, short: '1 mo/s' },
  { label: '1 year / s', value: 31_557_600, short: '1 yr/s' },
  { label: '10 yr / s', value: 315_576_000, short: '10 yr/s' },
];

/** Multiplier applied when "real scale" is toggled on (1 = truthful periods). */
export const REAL_SCALE = {
  /** Orbits are sped by T^1.5 (Kepler) and rotations by true sidereal rate. */
  rotationSpeedup: 1,
  orbitSpeedup: 1,
  /** Label shown in the HUD. */
  label: 'REAL SCALE',
};

/* -------------------------------------------------------------------------- */
/* Camera rig                                                                  */
/* -------------------------------------------------------------------------- */
export const CAMERA = {
  fov: RENDERER.fov,
  minDistance: 0.05,
  maxDistance: 2.2e6,
  /** Damping factor per second for the spring that follows the focus point. */
  followDamping: 6.5,
  /** Velocity retained per second when the user lets go (inertia). */
  damping: 0.86,
  /** Extra damping applied by the "brake" gesture. */
  brakeDamping: 0.72,
  /** Radians per second at which a swipe flips to the next target. */
  swipeSensitivity: 1.4,
  /** Duration of the cinematic flight between bodies, seconds. */
  flyToDuration: 2.4,
  /** Damping used by the pointer fallback controls. */
  pointerDamping: 0.9,
  /** Rotation applied by the two-hand twist gesture, radians per normalised unit. */
  twistSensitivity: 2.6,
  /** Zoom rate for two-hand spread, in log2 units per normalised palm-width/s. */
  spreadSensitivity: 1.9,
};

/* -------------------------------------------------------------------------- */
/* Hand tracking                                                               */
/* -------------------------------------------------------------------------- */
export const HANDS = {
  /** Webcam constraints. 60 fps at 640x480 keeps MediaPipe comfortably real-time. */
  video: { width: 640, height: 480, facingMode: 'user' },
  /** Requested capture rate for the video stream. */
  videoFps: 60,
  /** Target inference rate for the tracking loop. */
  targetFps: 30,
  /** Alias used by the tracker's rate limiter. */
  inferenceFps: 30,
  /** Number of hands to track (2 = two-hand gestures). */
  maxHands: 2,
  /**
   * Confidence thresholds. MediaPipe's defaults are permissive; the presence
   * and tracking gates are what stop a hand that has merely grazed the edge of
   * frame from registering as a target.
   */
  detectionConfidence: 0.55,
  presenceConfidence: 0.55,
  trackingConfidence: 0.55,
  /**
   * How long a hand may be missing before it is dropped entirely, ms. Within
   * this window the last state is retained so the overlay and the One Euro
   * filters fade out instead of popping.
   */
  lostGraceMs: 180,
  /** Landmark smoothing — One Euro filter. */
  filter: {
    /** Position cutoff at low speed: higher = smoother when still. */
    minCutoff: 1.7,
    /** Speed cutoff: higher = less lag when moving fast. */
    beta: 0.012,
    /** Derivative cutoff. */
    dCutoff: 1.0,
  },
  /** Local model first, CDN second. */
  modelPaths: {
    handLandmarker: 'models/hand_landmarker.task',
    gestureRecognizer: 'models/gesture_recognizer.task',
  },
  wasmPaths: {
    local: 'mediapipe/wasm',
    cdn: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm',
  },
  delegate: 'GPU',
};

/* -------------------------------------------------------------------------- */
/* Gesture engine                                                              */
/* -------------------------------------------------------------------------- */
export const GESTURES = {
  /** A gesture must be continuously detected this long to become ACTIVE. */
  enterMs: 120,
  /** …and must be lost this long before it is released. */
  exitMs: 80,
  /** Debounce between discrete (non-continuous) gesture firings, ms. */
  fireDebounceMs: 420,
  /** Hold time for "point + hold" selection. */
  selectHoldMs: 600,
  /** Hold time for the two-palm reset. */
  resetHoldMs: 1000,
  /** Motion threshold for a swipe, in normalised palm-widths per second. */
  swipeVelocity: 1.15,
  /** Minimum gap between swipes. */
  swipeCooldownMs: 700,
  /** Pinch hysteresis: enter at this ratio of thumb-index distance to palm size. */
  pinchOn: 0.42,
  pinchOff: 0.58,
  /** Fingers count thresholds, as (tip→wrist) / palm-size ratios. */
  fingerExtend: 0.62,
  fingerFold: 0.45,
  /** Palm-facing test: mean fingertip z relative to the palm centre. */
  palmFacingZ: 0.045,
  /** Gestures are ignored below this overall detection confidence. */
  minConfidence: 0.55,
  /** Mirror the webcam so moving right moves the cursor right. */
  mirrored: true,
};

/** Landmark topology: 21 MediaPipe points, grouped by digit. */
export const HAND_LANDMARKS = {
  WRIST: 0,
  THUMB: { CMC: 1, MCP: 2, IP: 3, TIP: 4 },
  INDEX: { MCP: 5, PIP: 6, DIP: 7, TIP: 8 },
  MIDDLE: { MCP: 9, PIP: 10, DIP: 11, TIP: 12 },
  RING: { MCP: 13, PIP: 14, DIP: 15, TIP: 16 },
  PINKY: { MCP: 17, PIP: 18, DIP: 19, TIP: 20 },
  /** Bone pairs for the constellation skeleton overlay. */
  BONES: [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17],
  ],
  /** Fingertips, for comet trails. */
  TIPS: [4, 8, 12, 16, 20],
};

/** The single authoritative gesture map. Drives UI, engine and cheat sheet. */
export const GESTURE_MAP = [
  { id: 'OPEN_PALM',     label: 'Open palm + move',      hint: 'Orbit camera',                  emoji: '🖐', continuous: true,  hands: 1, category: 'camera' },
  { id: 'PINCH_DRAG',    label: 'Pinch + drag',          hint: 'Pan / grab the scene',          emoji: '🤏', continuous: true,  hands: 1, category: 'camera' },
  { id: 'TWO_HAND_ZOOM', label: 'Two-hand spread',       hint: 'Zoom in / out',                 emoji: '🙌', continuous: true,  hands: 2, category: 'camera' },
  { id: 'TWO_HAND_TWIST',label: 'Two-hand twist',        hint: 'Roll the camera',               emoji: '🔄', continuous: true,  hands: 2, category: 'camera' },
  { id: 'POINT',         label: 'Point',                 hint: 'Aim the cursor',                emoji: '☝️', continuous: true,  hands: 1, category: 'select' },
  { id: 'POINT_HOLD',    label: 'Point + hold 0.6 s',    hint: 'Select and fly to object',      emoji: '🎯', continuous: false, hands: 1, category: 'select' },
  { id: 'FIST',          label: 'Closed fist',           hint: 'Brake / freeze momentum',       emoji: '✊', continuous: true,  hands: 1, category: 'camera' },
  { id: 'SWIPE_LR',      label: 'Swipe left / right',    hint: 'Previous / next body',          emoji: '↔️', continuous: false, hands: 1, category: 'navigate' },
  { id: 'SWIPE_UD',      label: 'Swipe up / down',       hint: 'Speed up / slow down time',     emoji: '↕️', continuous: false, hands: 1, category: 'navigate' },
  { id: 'PEACE',         label: 'Peace sign',            hint: 'Toggle orbit lines + labels',   emoji: '✌️', continuous: false, hands: 1, category: 'view' },
  { id: 'THUMBS_UP',     label: 'Thumbs up',             hint: 'Open info panel',               emoji: '👍', continuous: false, hands: 1, category: 'panel' },
  { id: 'THUMBS_DOWN',   label: 'Thumbs down',           hint: 'Close panels / go back',        emoji: '👎', continuous: false, hands: 1, category: 'panel' },
  { id: 'TWO_PALM_RESET',label: 'Both palms, hold 1 s',  hint: 'Reset the view',                emoji: '👐', continuous: false, hands: 2, category: 'view' },
  { id: 'ROCK',          label: 'Rock sign',             hint: 'Warp speed (easter egg)',       emoji: '🤟', continuous: true,  hands: 1, category: 'fun' },
];

/* -------------------------------------------------------------------------- */
/* Hand visualisation                                                          */
/* -------------------------------------------------------------------------- */
export const HAND_VIS = {
  color: BRAND.colors.gold,
  glowColor: BRAND.colors.goldLight,
  boneOpacity: 0.85,
  pointSize: 7.5,
  tipTrailLength: 26,
  tipTrailFade: 0.86,
  /** Radius of the openness arc, as a fraction of viewport width. */
  palmRadius: 0.035,
  /** Accent per hand, mirroring the skeleton overlay. */
  handColors: {
    Left: 'rgba(120, 224, 255, 1)',
    Right: 'rgba(255, 214, 165, 1)',
  },
  /** Ripple emitted on pinch start. */
  ripple: { radius: 0.55, duration: 0.6, width: 0.06 },
  /** Distance of the hand layer from the camera, in camera-space units. */
  depth: 1.6,
};

/* -------------------------------------------------------------------------- */
/* Cosmic scale ladder (Scene 3 powers of ten)                                */
/* -------------------------------------------------------------------------- */
/**
 * Each rung is a real physical scale. `focusRadius` is the size of the thing we
 * are looking at, in scene units, which drives the ruler HUD.
 */
export const SCALE_LADDER = [
  { id: 'earth',      label: 'Earth',           radiusKm: 6371,        colour: BRAND.colors.cyan },
  { id: 'solar',      label: 'Solar System',    radiusKm: 9e11,        colour: BRAND.colors.gold },
  { id: 'galaxy',     label: 'Milky Way',      radiusKm: 4.9e17,      colour: BRAND.colors.goldLight },
  { id: 'localgroup', label: 'Local Group',     radiusKm: 4.5e20,      colour: BRAND.colors.cyanSoft },
  { id: 'universe',   label: 'Observable Un.',  radiusKm: 4.4e21,      colour: BRAND.colors.cyan },
];

/* -------------------------------------------------------------------------- */
/* Audio                                                                       */
/* -------------------------------------------------------------------------- */
export const AUDIO = {
  masterGain: 0.55,
  /** Drone base frequency, Hz — deep but audible on laptop speakers. */
  droneRoot: 41.2,          // E1
  droneGains: { osc: 0.30, noise: 0.085, sub: 0.22 },
  /** Ambience LFO rates, Hz. */
  lfo: { filter: 0.035, gain: 0.021, detune: 0.06 },
  /** Reverb impulse response. */
  reverb: { seconds: 4.2, decay: 2.6, wet: 0.42 },
  /** UI blip envelope, seconds. */
  blip: { attack: 0.004, decay: 0.14, peak: 0.22 },
  whoosh: { duration: 1.9, peak: 0.3 },
  /** Per-planet sonification: pitch tracks orbital period, gain tracks distance. */
  sonify: { baseFreq: 92, rangeSemitones: 22, gain: 0.10 },
  /** Coma-induced volume ramp, seconds. */
  fadeIn: 2.5,
};

/* -------------------------------------------------------------------------- */
/* Misc UX                                                                     */
/* -------------------------------------------------------------------------- */
export const UX = {
  introDuration: 5.6,
  labelFadeNear: 0.0,     // fraction of focus distance where labels start fading
  labelFadeFar: 1.0,
  /** Count-up animation duration for info-panel numbers, seconds. */
  countUp: 1.35,
  /** Cursor ray length in scene units. */
  cursorRayLength: 4000,
  /** Hover highlight radius as a fraction of the object radius. */
  hoverPadding: 2.4,
  debugPanel: false,
  startWithWebcam: true,
  /** Index into TIME_PRESETS the clock starts on. */
  defaultRateIndex: 5,
  /** Show the cinematic intro. */
  intro: true,
  /** Keyboard shortcuts. */
  keys: {
    debug: 'd',
    cheatsheet: '?',
    help: 'h',
    panels: 'i',
    labels: 'l',
    camera: 'c',
    reset: 'r',
    next: 'arrowright',
    prev: 'arrowleft',
    pause: ' ',
    scene1: '1', scene2: '2', scene3: '3', scene4: '4',
    mute: 'm',
    scaleUp: '=', scaleDown: '-',
  },
};

/* -------------------------------------------------------------------------- */
/* Debug                                                                       */
/* -------------------------------------------------------------------------- */
export const DEBUG = {
  /** Expose CONFIG on window for live tuning. */
  expose: true,
  /** Emit a JSON performance trace every N frames (0 = off). */
  traceEvery: 0,
};

export default {
  BRAND, SCALE, RENDERER, POST, QUALITY, TIME_PRESETS, REAL_SCALE,
  CAMERA, HANDS, GESTURES, GESTURE_MAP, HAND_LANDMARKS, HAND_VIS,
  SCALE_LADDER, AUDIO, UX, DEBUG,
};
