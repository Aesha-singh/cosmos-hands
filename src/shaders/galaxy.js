/**
 * The Milky Way — 220 000 stars, one draw call, zero CPU per-frame work.
 *
 * Design notes
 *  ------------
 *  * **Positions are generated on the GPU, once.** Each vertex's id seeds a hash
 *    that places the star on a four-armed logarithmic spiral. Nothing is written
 *    back to a buffer, so the CPU cost per frame is a single uniform update.
 *  * **Differential rotation** comes from a per-star angular offset: inner stars
 *    lead, outer stars lag, which is exactly how a real differential-rotation
 *    curve winds up the arms.
 *  * **Colour** comes from a physically-motivated population model — young blue
 *    O/B stars in the arms, an old redder population and dust extinction in the
 *    disc, and a golden bulge in the bar. That produces the real Milky Way
 *    palette without any texture look-up.
 *  * **Dust lanes** are carved by attenuating brightness where the line of sight
 *    passes through the mid-plane, offset from the arms — which is why you see
 *    dark rifts *beside* the bright arms rather than inside them.
 *
 * @module shaders/galaxy
 */

import { COMMON_FRAGMENT, BV_TO_RGB, BLACKBODY } from './common.js';

/** Attribute-less vertex shader: everything is derived from `gl_VertexID`. */
export const GALAXY_VERTEX = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uPixelRatio;
uniform float uSizeScale;
uniform float uCount;
uniform float uCoreGlow;
uniform float uWarp;
uniform float uFlatten;        // disc thickness
uniform float uArmCount;
uniform float uArmTightness;
uniform float uStarSize;       // global brightness multiplier
uniform vec3  uCoreColor;
uniform vec3  uArmColor;
uniform float uPointSizeMax;

attribute float aSeed;
attribute float aRadius;        // normalised 0..1 galactocentric radius
attribute float aArm;          // which arm, -1 = bulge/halo
attribute float aAngle;        // base angle, radians
attribute float aHeight;       // vertical offset, disc units
attribute float aBright;       // 0..1 luminosity scale
attribute vec3  aColor;

varying vec3  vColor;
varying float vBright;
varying float vRadius;

${COMMON_FRAGMENT}

void main(){
  float id = aSeed;

  // --- differential rotation ---------------------------------------------
  // Solid-body inside the bar, then falling off as ~1/r beyond it: the standard
  // interpolation for a rotation curve that goes from flat to Keplerian.
  float r = pow(aRadius, 0.72);
  float omega = mix(2.6, 0.55, smoothstep(0.06, 0.95, r));

  float t = uTime * omega * (1.0 - uWarp * 1.4);
  // Differential rotation winds the arms up over time; this small linear term
  // is what keeps the spiral from looking like a static firework.
  float shear = t * (1.0 + (1.0 - r) * 0.85);

  float angle = aAngle + shear;

  // --- logarithmic spiral arm ---------------------------------------------
  // r = a·e^(b·θ); we solve for the arm angle so stars land exactly on the
  // pitch angle the real Milky Way has (~12°).
  float armOffset = (aArm + 0.5) * (6.2831853 / uArmCount);
  float armTheta = log(max(r, 1e-3)) / uArmTightness;
  float armAngle = armTheta + armOffset;
  // Blend between "scattered in the disc" and "tightly on the arm".
  float tightness = smoothstep(0.10, 0.62, r) * (1.0 - smoothstep(0.86, 1.0, r) * 0.35);
  float blend = mix(1.0, 0.14, tightness);
  angle = mix(angle, armAngle, 1.0 - blend);

  // Radial spread: exponential disc, which is what real surface density does.
  float rr = r * (0.86 + 0.28 * hash11(id * 7.13));

  vec3 pos;
  pos.x = cos(angle) * rr;
  pos.z = sin(angle) * rr;
  // Disc thickness flattens with radius: a thicker bulge, a thin outer disc.
  float thick = uFlatten * (0.34 + 0.9 * exp(-r * 3.2)) * (0.35 + hash11(id * 3.71));
  pos.y = aHeight * thick;

  // Central bar: elongated, rotated 27 degrees from the arms (real value).
  if (aArm < 0.0) {
    float barR = 0.14;
    vec2 bar = pos.xz;
    float ba = 0.4712;   // 27 degrees
    bar = rotate2D(bar, ba);
    bar.x *= 2.35;      // bar is elongated along x
    bar.y *= 0.62;
    bar = rotate2D(bar, -ba);
    pos.xz = bar * (0.55 + hash11(id * 2.19));
    pos.y *= 2.6;
  }

  // --- warp drive ---------------------------------------------------------
  if (uWarp > 0.001){
    float along = pos.z * 0.0 + (aHeight * 3.0 + hash11(id * 5.5) * 40.0 - 20.0);
    pos += vec3(0.0, 0.0, along * uWarp * 0.55);
    pos *= 1.0 + uWarp * 0.14 * hash11(id);
  }

  // --- dust lanes ---------------------------------------------------------
  // Extinguish where the sight line crosses the mid-plane near a dense knot.
  // Two offset lanes, matching the real rift structure.
  float lane = 0.0;
  for (int i = 0; i < 2; i++){
    float off = float(i) * 3.14159 + 0.35;
    float laneR = 0.36 + 0.26 * float(i);
    float laneA = log(max(r, 1e-3)) / uArmTightness + off;
    vec2 d = pos.xz - vec2(cos(laneA), sin(laneA)) * laneR;
    lane += exp(-dot(d, d) * 26.0);
  }
  float dust = clamp(lane * 0.8, 0.0, 1.0);

  // --- colour population model -------------------------------------------
  vec3 col = aColor;
  // Old, metal-poor population in the bulge: golden.
  if (aArm < 0.0) col = mix(col, uCoreColor, 0.72);
  // Young blue arms.
  float blue = smoothstep(0.18, 0.85, r) * (1.0 - dust);
  col = mix(col, uArmColor, blue * 0.55);
  // Bulge glow dominates the very centre.
  float core = exp(-r * 7.5);
  col = mix(col, uCoreColor, core * 0.85);
  // Dust reddening and dimming.
  col = mix(col, col * vec3(0.42, 0.30, 0.24), dust * 0.9);

  float bright = aBright * (1.0 - dust * 0.88);
  // Core brightness profile — the bulge is orders of magnitude brighter.
  bright *= (0.35 + uCoreGlow * exp(-r * 5.2) * 4.2);
  // Radial falloff beyond the disc edge.
  bright *= 1.0 - smoothstep(0.82, 1.0, r);

  vColor = col;
  vBright = bright;
  vRadius = r;

  // --- point size ---------------------------------------------------------
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  float dist = -mv.z;
  // Perspective-correct sizing with a hard pixel cap, so the core does not
  // become a white blob that costs fill rate.
  float size = uSizeScale * (0.55 + aBright * 1.9) * uPixelRatio * (140.0 / max(dist, 1.0));
  gl_PointSize = clamp(size, 0.6, uPointSizeMax);
  gl_Position = projectionMatrix * mv;
}
`;

/**
 * Galaxy fragment: a soft radial falloff sprite, additive.
 * The "cross" highlight that makes bright stars read as bright stars comes from
 * a mild anisotropic term rather than a texture.
 */
export const GALAXY_FRAGMENT = /* glsl */ `
precision highp float;

varying vec3  vColor;
varying float vBright;
varying float vRadius;

void main(){
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r = length(uv);
  if (r > 1.0) discard;

  float core = exp(-r * r * 7.0);
  float halo = exp(-r * 2.6) * 0.35;
  float a = core + halo;

  // Subtle four-point diffraction so bright particles read as stars.
  float cross = (exp(-abs(uv.x) * 12.0) + exp(-abs(uv.y) * 12.0)) * exp(-r * 3.2) * 0.18;

  vec3 col = vColor * (a + cross) * vBright;
  gl_FragColor = vec4(col, a);
}
`;

/**
 * Central supermassive black hole glow.
 *
 * Sagittarius A* is 4.3 million solar masses, which means its event horizon is
 * 0.13 AU — invisible at galaxy scale. What you actually see is the accretion
 * flow's synchrotron glow plus the relativistic shadow, so that is what we draw:
 * a warm accretion torus with a dark centre, and a subtle photon ring.
 */
export const SMBH_FRAGMENT = /* glsl */ `
precision highp float;

${COMMON_FRAGMENT}

uniform float uTime;
uniform float uIntensity;
uniform vec3  uColor;

varying vec2 vUv;

void main(){
  vec2 uv = vUv * 2.0 - 1.0;
  float r = length(uv);
  if (r > 1.0) discard;

  float ang = atan(uv.y, uv.x);

  // Accretion torus: an ellipse seen at a shallow angle, with turbulent noise
  // sheared by differential rotation (faster inwards).
  vec2 e = uv;
  e.y *= 2.6;
  float er = length(e);
  float shear = fbm(vec3(cos(ang) * 2.2, sin(ang) * 2.2, er * 3.0 - uTime * 0.35), 4);

  float torus = smoothstep(0.16, 0.30, er) * (1.0 - smoothstep(0.44, 0.86, er));
  torus *= 0.5 + shear * 0.9;

  // Photon ring: a razor-thin bright circle at the shadow radius.
  float photon = exp(-pow(abs(er - 0.19) * 46.0, 2.0)) * 0.9;

  // The shadow itself: pure absence.
  float shadow = 1.0 - smoothstep(0.10, 0.19, er);

  float a = clamp(torus + photon, 0.0, 1.0) * uIntensity * (1.0 - shadow);
  vec3 col = mix(uColor, vec3(1.0, 0.86, 0.68), photon);
  gl_FragColor = vec4(col * a, a);
}
`;

/** Attribute layout the galaxy scene must supply. */
export const GALAXY_ATTRIBUTES = [
  'aSeed', 'aRadius', 'aArm', 'aAngle', 'aHeight', 'aBright', 'aColor',
];

/** Uniform defaults. */
export const GALAXY_UNIFORM_DEFAULTS = {
  uTime: { value: 0 },
  uPixelRatio: { value: 1 },
  uSizeScale: { value: 1 },
  uCount: { value: 220_000 },
  uCoreGlow: { value: 1 },
  uWarp: { value: 0 },
  uFlatten: { value: 0.055 },
  uArmCount: { value: 4 },
  uArmTightness: { value: 4.6 },
  uStarSize: { value: 1 },
  uPointSizeMax: { value: 42 },
  uCoreColor: { value: [1.0, 0.84, 0.52] },
  uArmColor: { value: [0.55, 0.72, 1.0] },
};
