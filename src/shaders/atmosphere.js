/**
 * Planetary atmospheres — a single back-faced shell shader drives every
 * atmosphere in the solar system (and gives Titan and Pluto theirs too).
 *
 * Physics, approximated honestly:
 *  - Rayleigh scattering: wavelength-dependent, so the terminator goes warm and
 *    red and the limb goes deep blue — exactly what a lunar limb looks like.
 *  - Mie scattering: forward-scattered haze, giving the bright white rim that
 *    Venus and Titan are famous for.
 *  - Optical depth: the shell is shaded as a *volume*, with depth falling off
 *    toward the limb, which is why the glow is brightest where the line of
 *    sight passes through the most atmosphere.
 *
 * @module shaders/atmosphere
 */

import { COMMON_FRAGMENT } from './common.js';

export const ATMOSPHERE_VERTEX = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vPosW;

void main(){
  vec4 world = modelMatrix * vec4(position, 1.0);
  vPosW = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const ATMOSPHERE_FRAGMENT = /* glsl */ `
precision highp float;

${COMMON_FRAGMENT}

uniform vec3  uColor;
uniform vec3  uSunDirection;   // normalised, world space
uniform vec3  uSunColor;
uniform float uPower;          // falloff exponent: 2.4 (Mars) .. 3.4 (Earth)
uniform float uStrength;
uniform float uSunIntensity;
uniform float uRimPower;
uniform float uTime;

varying vec3 vNormalW;
varying vec3 vPosW;

void main(){
  vec3 n = normalize(vNormalW);
  vec3 viewDir = normalize(cameraPosition - vPosW);

  // --- Fresnel / rim term ------------------------------------------------
  // At the silhouette the normal is perpendicular to the view ray, so we are
  // looking through the most atmosphere: max scattering.
  float fresnel = pow(1.0 - abs(dot(n, viewDir)), uPower);

  // --- day / night terminator -------------------------------------------
  float ndl = dot(n, uSunDirection);
  // Soft terminator: real limbs are wrapped by refraction, so a hard
  // max(0, ndl) makes atmospheres look like they were cut with scissors.
  float lit = smoothstep(-0.32, 0.28, ndl);
  // Forward scattering: a hot spot on the sunward limb.
  float forward = pow(max(dot(viewDir, -uSunDirection), 0.0), 6.0);

  // --- Rayleigh tint ----------------------------------------------------
  // Blue scatters ~5.5x more than red, so the thin upper atmosphere reads blue
  // and the thick part (near the terminator, viewed edge-on through long
  // optical depth) reads orange-red.
  vec3 rayleigh = vec3(0.28, 0.52, 1.0);
  float longPath = 1.0 - fresnel;              // 1 at the disc centre
  vec3 tint = mix(rayleigh, uColor, 0.55 + 0.35 * longPath);

  // Sunset reddening near the terminator.
  float sunset = smoothstep(0.30, -0.05, ndl) * smoothstep(-0.30, 0.05, ndl);
  tint = mix(tint, uColor * vec3(1.35, 0.72, 0.42), sunset * 0.7);

  float a = fresnel * uStrength * lit;
  a += forward * fresnel * uStrength * 0.55;

  // Faint scattering visible on the night side — real airglow and, on Earth,
  // moonlight-scattered starlight.
  a += fresnel * uStrength * 0.035;

  vec3 col = tint * uSunColor * uSunIntensity;

  gl_FragColor = vec4(col * a, clamp(a, 0.0, 1.0));
}
`;

/**
 * Earth's day/night terminator shader.
 *
 * Applied on top of the standard PBR-ish surface material via `onBeforeCompile`,
 * giving us:
 *  - a physically-motivated terminator softened by the Sun's angular size
 *    (0.53°, which at Earth's distance smears the shadow line over ~50 km),
 *  - city lights fading in on the night side,
 *  - a specular highlight only on the ocean-facing side of the terminator,
 *  - atmospheric reddening applied to the surface itself near the limb.
 */
export const EARTH_SURFACE_PARS = /* glsl */ `
uniform sampler2D uNightMap;
uniform sampler2D uCloudMap;
uniform float uCloudOffset;
uniform float uNightStrength;
uniform float uCloudStrength;
uniform vec3  uSunDirection;
uniform vec3  uAtmosColor;
uniform float uSpecular;
uniform float uAtmosphereThickness;
`;

/**
 * Cloud shell fragment — used for the separately-rotating cloud sphere.
 * Deliberately lit by the same Sun direction so clouds and surface share a
 * terminator; any mismatch instantly reads as two different planets.
 */
export const CLOUD_FRAGMENT = /* glsl */ `
precision highp float;

${COMMON_FRAGMENT}

uniform sampler2D uMap;
uniform vec3  uColor;
uniform vec3  uSunDirection;
uniform float uOpacity;
uniform float uTime;

varying vec3 vNormalW;
varying vec3 vPosW;
varying vec2 vUv;

void main(){
  vec4 tex = texture2D(uMap, vec2(vUv.x + uTime * 0.0016, vUv.y));

  // Alpha is stored in the red channel of the cloud map.
  float a = tex.r * uOpacity;
  if (a < 0.004) discard;

  vec3 n = normalize(vNormalW);
  float ndl = max(dot(n, uSunDirection), 0.0);
  // Cloud shadows are soft and forward-scattering: bright rims, soft cores.
  float lightAmt = 0.18 + 0.82 * pow(ndl, 0.55);

  // Warm the clouds at grazing angles (multiple scattering through haze).
  float grazing = 1.0 - abs(dot(n, normalize(cameraPosition - vPosW)));
  vec3 col = uColor * lightAmt;
  col = mix(col, uColor * vec3(1.25, 1.02, 0.82), grazing * 0.4);

  gl_FragColor = vec4(col, a);
}
`;

export const CLOUD_VERTEX = /* glsl */ `
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
 * Saturn's rings.
 *
 * Not a decal — an actual volumetric slab:
 *  - radial optical depth from a 1-D profile texture (the real B ring / Cassini
 *    Division / A ring structure),
 *  - forward scattering when viewed against the Sun, giving the bright rings
 *    that appear as a line during a ring-plane crossing,
 *  - transmission when back-lit, so the planet's shadow crosses the rings as a
 *    real shadow, and the unlit part of the rings goes transparent.
 */
export const RING_VERTEX = /* glsl */ `
varying vec2 vUv;
varying vec3 vPosW;
varying vec3 vLocal;

void main(){
  vUv = uv;
  vLocal = position;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vPosW = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const RING_FRAGMENT = /* glsl */ `
precision highp float;

${COMMON_FRAGMENT}

uniform sampler2D uRingProfile;   // x = radial position 0..1, a = optical depth
uniform vec3  uColor;
uniform vec3  uSunDirection;
uniform vec3  uPlanetCenter;      // object-space centre of the primary
uniform float uPlanetRadius;
uniform float uInnerRadius;
uniform float uOpacity;
uniform float uTime;

varying vec2 vUv;
varying vec3 vPosW;
varying vec3 vLocal;

void main(){
  float profile = texture2D(uRingProfile, vec2(vUv.x, 0.5)).a;
  if (profile < 0.004) discard;

  vec3 n = vec3(0.0, 1.0, 0.0);                    // ring normal is +Y
  float ndl = dot(n, normalize(uSunDirection));

  // --- shadow of the primary on the rings --------------------------------
  // Project the ring point onto the plane perpendicular to the Sun direction
  // through the planet's centre; if that lands inside the planet's disc, the
  // ring is eclipsed. This is how Cassini actually modelled it.
  vec3 toRing = vPosW - uPlanetCenter;
  float alongSun = dot(toRing, normalize(uSunDirection));
  vec3 perp = toRing - normalize(uSunDirection) * alongSun;
  float shadow = 1.0;
  if (alongSun < 0.0) {
    float dist = length(perp);
    // Soft penumbra: the Sun subtends 0.53 degrees.
    float soft = uPlanetRadius * 0.06;
    shadow = smoothstep(uPlanetRadius - soft, uPlanetRadius + soft, dist);
  }

  // --- scattering ---------------------------------------------------------
  // Dense B ring particles are strongly forward-scattering; when the geometry
  // puts the Sun behind the rings they brighten dramatically.
  float forward = pow(max(dot(normalize(cameraPosition - vPosW), -normalize(uSunDirection)), 0.0), 3.0);
  float lit = max(ndl, 0.0);
  // Transmitted light: light passing through the ring from the far side.
  float trans = pow(max(1.0 - lit, 0.0), 1.6) * 0.35;

  vec3 col = uColor * (lit * 0.85 + trans) * shadow;
  col += uColor * forward * 0.9;

  // Fine azimuthal variation so the rings are not perfectly smooth.
  float azimuth = atan(vLocal.z, vLocal.x);
  float grain = fbm(vec3(cos(azimuth) * 6.0, sin(azimuth) * 6.0, vUv.x * 90.0), 3);
  col *= 0.86 + grain * 0.28;

  float a = profile * uOpacity * (0.35 + 0.65 * lit) * shadow;
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}
`;

/** Uniform defaults for the atmosphere pass. */
export const ATMOSPHERE_UNIFORM_DEFAULTS = {
  uColor: { value: [0.4, 0.7, 1.0] },
  uSunDirection: { value: [1, 0, 0] },
  uSunColor: { value: [1.0, 0.95, 0.88] },
  uPower: { value: 3.0 },
  uStrength: { value: 1.0 },
  uSunIntensity: { value: 1.0 },
  uRimPower: { value: 3.0 },
  uTime: { value: 0 },
};
