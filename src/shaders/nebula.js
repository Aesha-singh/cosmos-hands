/**
 * Nebula backdrop + procedural starfield + shooting stars.
 *
 * These three live together because they are all "the sky behind everything":
 * a cube-mapped nebula that renders in one pass, an instanced starfield with
 * per-star twinkle, and a small pool of shooting-star streaks.
 *
 * @module shaders/nebula
 */

import { COMMON_FRAGMENT, COMMON_VERTEX, BV_TO_RGB } from './common.js';

/* -------------------------------------------------------------------------- */
/* Nebula dome                                                                */
/* -------------------------------------------------------------------------- */

export const NEBULA_VERTEX = /* glsl */ `
varying vec3 vDir;
varying vec3 vPos;

void main(){
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

/**
 * A full-dome nebula. Sits inside the far plane, follows the camera, and is
 * drawn first with depth writes off.
 *
 * Real nebulae are emission (Hα red, OIII teal, Hβ blue) plus reflection (blue)
 * plus dark dust. Sampling three independent noise fields and combining them
 * with a colour ramp reproduces that palette convincingly.
 */
export const NEBULA_FRAGMENT = /* glsl */ `
precision highp float;

${COMMON_FRAGMENT}
${BV_TO_RGB}

uniform float uTime;
uniform vec3  uColorA;      // Hα / emission red
uniform vec3  uColorB;      // OIII / ionisation teal
uniform vec3  uColorC;      // reflection blue
uniform float uIntensity;
uniform float uScale;
uniform float uWarp;

varying vec3 vDir;

void main(){
  vec3 d = normalize(vDir);

  // Slowly evolve: the sky should feel alive but never obviously animated.
  vec3 p = d * uScale;
  float t = uTime * 0.008;

  // Large cloud masses.
  float clouds = fbm(warp(p + vec3(t), 0.35), 5, 2.1, 0.55);
  // Filamentary structure: the ridged variant is what makes it read as gas
  // rather than fog.
  float filaments = ridged(p * 2.3 + vec3(t * 1.6), 4, 2.05, 0.5);
  // Fine detail.
  float fine = fbm(p * 7.5 - vec3(t * 2.2), 3);

  float density = clamp(clouds * 0.5 + 0.5, 0.0, 1.0);
  density = pow(density, 2.2);

  // Emission regions only where the filament density is genuinely high.
  float emission = pow(clamp(filaments, 0.0, 1.0), 3.4);
  float reflection = density * (0.4 + fine * 0.6);

  // Dark dust: subtractive, and it must be *darkest where emission is brightest*
  // or the whole thing looks like a lava lamp.
  float dust = clamp(ridged(p * 1.4 + 21.0, 3) * 1.4 - 0.35, 0.0, 1.0);

  vec3 col = vec3(0.0);
  col += uColorA * emission * 0.9;
  col += uColorB * density * 0.45;
  col += uColorC * reflection * 0.30;
  col *= (1.0 - dust * 0.75);

  // A faint band of unresolved starlight along the galactic plane.
  float plane = exp(-pow(d.y * 3.4, 2.0));
  col += vec3(0.16, 0.17, 0.22) * plane * 0.35;

  // Warp drive streaks the nebula into lines.
  if (uWarp > 0.001){
    float streak = fbm(vec3(d.x * 40.0, d.y * 4.0, d.z * 40.0 - uTime * 6.0), 2);
    col = mix(col, vec3(0.6, 0.75, 1.0) * streak, uWarp * 0.65);
  }

  float a = clamp(dot(col, vec3(0.3333)) * uIntensity, 0.0, 1.0);
  gl_FragColor = vec4(col * uIntensity, a);
}
`;

/* -------------------------------------------------------------------------- */
/* Starfield                                                                  */
/* -------------------------------------------------------------------------- */

export const STARFIELD_VERTEX = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uPixelRatio;
uniform float uSizeScale;
uniform float uParallax;     // how much the field lags the camera
uniform float uWarp;
uniform float uPointSizeMax;
uniform float uTwinkle;

attribute vec3  aOffset;
attribute float aSize;
attribute float aPhase;
attribute float aBrightness;
attribute vec3  aColor;

varying vec3  vColor;
varying float vBright;

${COMMON_VERTEX}

void main(){
  // Parallax: stars are effectively at infinity, so we keep them centred on the
  // camera and push them out by a fixed radius. Slight per-star lag creates
  // depth without breaking the illusion.
  vec3 pos = aOffset;
  pos.x += sin(uTime * 0.05 + aPhase) * uParallax;
  pos.y += cos(uTime * 0.043 + aPhase * 1.7) * uParallax;

  // Twinkle: real stars scintillate because of atmospheric turbulence. Two
  // incommensurate frequencies avoid an obvious repeat.
  float tw = 1.0 + uTwinkle * (sin(uTime * 2.1 + aPhase * 9.0) * 0.5
                             + sin(uTime * 3.7 + aPhase * 21.0) * 0.5) * 0.28;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  float dist = max(-mv.z, 1.0);

  // Warp drive: stars stretch along the view axis.
  float stretch = 1.0 + uWarp * 26.0 * hash11(aPhase * 13.7);
  gl_PointSize = clamp(aSize * uSizeScale * uPixelRatio * tw * (900.0 / dist) * stretch,
                       0.5, uPointSizeMax);

  vColor = aColor;
  vBright = aBrightness * tw;

  gl_Position = projectionMatrix * mv;
}
`;

export const STARFIELD_FRAGMENT = /* glsl */ `
precision highp float;

varying vec3  vColor;
varying float vBright;

void main(){
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r = length(uv);
  if (r > 1.0) discard;

  float core = exp(-r * r * 8.0);
  float halo = exp(-r * 2.8) * 0.28;
  // Diffraction spikes on the brightest stars only.
  float cross = (exp(-abs(uv.x) * 15.0) + exp(-abs(uv.y) * 15.0)) * exp(-r * 3.4) * 0.22;
  float a = (core + halo + cross) * vBright;
  if (a < 0.003) discard;

  gl_FragColor = vec4(vColor * a, a);
}
`;

/* -------------------------------------------------------------------------- */
/* Shooting stars                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A shooting star is a short-lived, fast-moving streak with a bright head.
 * The pool is a single InstancedBufferGeometry; each instance gets a lifetime
 * uniform slot, and the shader does the ballistic motion so the CPU only
 * advances a float per event.
 */
export const SHOOTING_VERTEX = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uPixelRatio;

attribute vec3  aStart;
attribute vec3  aVelocity;
attribute float aBirth;
attribute float aLife;
attribute float aLength;
attribute float aSeed;

varying float vFade;
varying float vAlong;

void main(){
  float age = uTime - aBirth;
  if (age < 0.0 || age > aLife){
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // cull off-screen
    vFade = 0.0;
    vAlong = 0.0;
    return;
  }

  float t = age / aLife;
  // Ease-in: meteors accelerate as they ablate.
  float travel = t * t * (3.0 - 2.0 * t);
  vec3 head = aStart + aVelocity * travel;
  vec3 tail = head - normalize(aVelocity) * aLength;

  // Build a camera-facing ribbon between tail and head.
  vec3 axis = normalize(aVelocity);
  vec3 toCam = normalize(cameraPosition - head);
  vec3 side = normalize(cross(axis, toCam));

  float width = 0.55 * (1.0 - t * 0.7);
  vec3 pos = mix(tail, head, position.y + 0.5);
  pos += side * (position.x - 0.5) * width;

  vFade = (1.0 - t) * smoothstep(0.0, 0.12, t);
  vAlong = position.y + 0.5;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

export const SHOOTING_FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uIntensity;

varying float vFade;
varying float vAlong;

void main(){
  // Bright head, exponential tail.
  float head = pow(vAlong, 6.0);
  float tail = pow(vAlong, 1.6) * 0.4;
  float a = (head + tail) * vFade * uIntensity;
  gl_FragColor = vec4(uColor * a, a);
}
`;
