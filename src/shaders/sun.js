/**
 * The Sun — a photosphere of convecting granulation, limb darkening, a
 * multi-layer corona, active-region loops, prominences and an anamorphic
 * streak. The shader is the scene's key light as well as its hero object.
 *
 * Three draw passes make up the visual:
 *   1. `surfaceMaterial`  — the visible disc (raymarched a little above r=1)
 *   2. `coronaMaterial`   — additive back-faced shell for the glow
 *   3. `flareMaterial`    — additive streak billboards on the equatorial plane
 *
 * @module shaders/sun
 */

import { COMMON_FRAGMENT } from './common.js';

/** Shared vertex shader: pass world normal + view direction to the fragment stage. */
export const SUN_VERTEX = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vPosW;
varying vec2 vUv;

void main(){
  vUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vPosW = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * Photosphere.
 *
 * The interesting part is the *granulation + supergranulation* pairing: real
 * granule cells are ~1 000 km across and last 8 minutes, so at this scale they
 * animate far too fast to look right at 1× time. We therefore scale granule
 * advection with the simulation clock at a deliberately reduced rate.
 */
export const SUN_SURFACE_FRAGMENT = /* glsl */ `
precision highp float;

${COMMON_FRAGMENT}

uniform float uTime;
uniform float uIntensity;
uniform vec3  uColorCool;
uniform vec3  uColorHot;
uniform vec3  uColorFlare;

varying vec3 vNormalW;
varying vec3 vPosW;
varying vec2 vUv;

// Blackbody ramp tuned to the real photosphere: 4 300 K in the intergranular
// lanes up to 6 000 K in the granule centres.
vec3 photosphere(float t){
  t = clamp(t, 0.0, 1.0);
  vec3 c = mix(uColorCool, uColorHot, smoothstep(0.15, 0.85, t));
  return c;
}

void main(){
  vec3 n = normalize(vNormalW);
  vec3 viewDir = normalize(cameraPosition - vPosW);

  // --- limb darkening -----------------------------------------------------
  // The classic Eddington law: the disc is ~40% dimmer at the limb than at the
  // centre because we are looking through more of the ( cooler ) photosphere.
  float mu = clamp(dot(n, viewDir), 0.0, 1.0);
  float limb = 0.32 + 0.68 * pow(mu, 0.62);

  // --- convection: granulation + supergranulation ------------------------
  // Both sample the surface direction (not UV), so there is no pole pinch and
  // no seam; the Sun simply rotates underneath.
  vec3 sp = n * 3.4;
  float t = uTime * 0.06;

  // Supergranulation: the slow, large-scale cellular convection (~30 000 km).
  float superG = fbm(sp * 0.85 + vec3(0.0, 0.0, t * 0.25), 3);
  // Granulation: the fast, small-scale cells (~1 000 km).
  float gran = fbm(sp * 9.5 + vec3(t * 1.9, t * 1.4, t * 1.1), 4);
  // Supergranule lanes are darker and slightly depressed.
  float lanes = smoothstep(0.16, -0.30, superG);

  float heat = 0.52 + gran * 0.42 - lanes * 0.30;
  // Domain-warp the hottest regions so the surface reads as boiling plasma.
  vec3 wp = warp(sp * 6.0 + vec3(0.0, t * 2.2, 0.0), 0.28);
  float flicker = fbm(wp, 3);
  heat += flicker * 0.16;

  vec3 col = photosphere(clamp(heat, 0.0, 1.0));

  // --- sunspots ----------------------------------------------------------
  // Active regions sit at supergranule boundaries and show a dark umbra with a
  // brighter penumbra; they also anchor the magnetic loops in the corona.
  float spotField = ridged(sp * 1.25 + 17.0, 3);
  float umbra = smoothstep(0.86, 0.985, spotField) * smoothstep(0.10, -0.22, superG);
  float penumbra = smoothstep(0.74, 0.88, spotField) * smoothstep(0.16, -0.10, superG);
  col = mix(col, uColorFlare * 0.55, penumbra * 0.55);
  col = mix(col, vec3(0.09, 0.03, 0.01), umbra * 0.9);

  // --- faculae -----------------------------------------------------------
  // Bright magnetic filigree at the edges of active regions.
  float fac = smoothstep(0.62, 0.80, spotField) * smoothstep(0.2, 0.6, gran);
  col += vec3(1.0, 0.82, 0.5) * fac * 0.5;

  // --- spicules / chromospheric edge -------------------------------------
  float edge = pow(1.0 - mu, 3.0);
  float spicule = ridged(sp * 22.0 + uTime * 0.4, 3);
  col += uColorFlare * edge * (0.35 + spicule * 0.55);

  gl_FragColor = vec4(col * limb * uIntensity, 1.0);
}
`;

/**
 * Corona shell — additive, front-face-culled, rendered as a soft glow that
 * extends 4× the photosphere radius. Two noise layers give the streaming,
 * rope-like structure of the real corona.
 */
export const SUN_CORONA_FRAGMENT = /* glsl */ `
precision highp float;

${COMMON_FRAGMENT}

uniform float uTime;
uniform float uIntensity;
uniform vec3  uColor;

varying vec3 vNormalW;
varying vec3 vPosW;

void main(){
  vec3 n = normalize(vNormalW);
  vec3 viewDir = normalize(cameraPosition - vPosW);
  float mu = clamp(dot(n, viewDir), 0.0, 1.0);

  // Inverse falloff: the corona has no surface, it just thins out.
  float radial = pow(1.0 - mu, 2.6);

  // Streamers: the corona is full of radial "helmet" streamers shaped by the
  // large-scale magnetic field. Radial sampling of a noise field gives exactly
  // that look when the noise is stretched along the radius.
  vec3 sp = normalize(vPosW) * 2.1;
  float streamer = ridged(sp * 1.9 + vec3(0.0, uTime * 0.018, 0.0), 4);
  float fine = fbm(sp * 7.0 - vec3(uTime * 0.05), 3);

  // Equatorial streamers are longer than polar plumes — the corona is
  // dramatically prolate because of the solar dipole.
  float eq = 1.0 - abs(normalize(vPosW).y);
  float elongation = mix(1.0, 1.85, eq);

  float a = radial * uIntensity * (0.35 + streamer * 1.05) * (0.7 + fine * 0.5);
  a *= elongation;

  gl_FragColor = vec4(uColor * a, a);
}
`;

/**
 * Prominences and anamorphic lens flare.
 *
 * Rendered as additive quads in the Sun's equatorial plane: one wide
 * horizontal streak (anamorphic), plus a couple of hot spikes, plus expanding
 * ribbon loops anchored at the limb.
 */
export const SUN_FLARE_FRAGMENT = /* glsl */ `
precision highp float;

${COMMON_FRAGMENT}

uniform float uTime;
uniform float uIntensity;
uniform vec3  uColor;

varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vPosW;

void main(){
  vec2 uv = vUv * 2.0 - 1.0;

  // --- anamorphic horizontal streak --------------------------------------
  float streak = exp(-abs(uv.y) * 46.0) * exp(-abs(uv.x) * 1.55);
  // A pair of diagonal spikes reads as a real lens rather than a drawn flare.
  float spikeA = exp(-abs(uv.x * 0.7 + uv.y) * 62.0) * exp(-length(uv) * 2.0);
  float spikeB = exp(-abs(uv.x * 0.7 - uv.y) * 62.0) * exp(-length(uv) * 2.0);

  // --- prominence ribbons: arcs anchored at the limb ----------------------
  float r = length(uv);
  float ang = atan(uv.y, uv.x);
  float ribbonNoise = fbm(vec3(cos(ang) * 2.4, sin(ang) * 2.4, uTime * 0.09), 4);
  float loop = smoothstep(0.55, 0.85, ribbonNoise);
  // Prominences live in a narrow annulus just outside the disc.
  float shell = smoothstep(0.62, 0.80, r) * (1.0 - smoothstep(0.86, 1.05, r));
  float prominence = shell * loop * 1.5;

  float a = (streak * 0.9 + (spikeA + spikeB) * 0.4 + prominence) * uIntensity;
  a *= smoothstep(1.25, 0.2, r);   // fade the quad's own border

  gl_FragColor = vec4(uColor * a, a);
}
`;

/** Uniform defaults shared by the three passes. */
export const SUN_UNIFORM_DEFAULTS = {
  uTime: { value: 0 },
  uIntensity: { value: 1 },
  uWarp: { value: 0 },
  uColorHot: { value: [1.0, 0.86, 0.52] },
  uColorCool: { value: [1.0, 0.42, 0.08] },
  uColorFlare: { value: [1.0, 0.30, 0.10] },
  uColor: { value: [1.0, 0.72, 0.34] },
};
