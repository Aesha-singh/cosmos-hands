/**
 * Shared GLSL chunks.
 *
 * These strings are concatenated into the individual shaders; keeping the noise
 * implementations here guarantees the Sun, the atmospheres and the galaxy all
 * share one coherent visual language.
 *
 * @module shaders/common
 */

/** Classic Ashima/Gustavson simplex noise (3-D), MIT licensed. */
export const SIMPLEX_3D = /* glsl */ `
vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

/** Fractal Brownian motion built on {@link SIMPLEX_3D}. */
export const FBM = /* glsl */ `
float fbm(vec3 p, int octaves, float lacunarity, float gain){
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 8; i++){
    if (i >= octaves) break;
    sum  += amp * snoise(p);
    norm += amp;
    amp  *= gain;
    p    *= lacunarity;
  }
  return sum / max(norm, 1e-4);
}

float fbm(vec3 p, int octaves){
  return fbm(p, octaves, 2.02, 0.5);
}

// Ridged multifractal: sharp crests, for solar filaments and cosmic-web threads.
float ridged(vec3 p, int octaves, float lacunarity, float gain){
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 8; i++){
    if (i >= octaves) break;
    float n = 1.0 - abs(snoise(p));
    n *= n;
    sum  += amp * n;
    norm += amp;
    amp  *= gain;
    p    *= lacunarity;
  }
  return sum / max(norm, 1e-4);
}

// GLSL has no default arguments, so the two-argument form callers want is an
// overload rather than a default.
float ridged(vec3 p, int octaves){
  return ridged(p, octaves, 2.05, 0.5);
}
`;

/** Domain warping — the difference between "noise" and "looks like plasma". */
export const DOMAIN_WARP = /* glsl */ `
vec3 warp(vec3 p, float amount){
  return p + amount * vec3(
    snoise(p + vec3(11.3, 4.1,  7.7)),
    snoise(p + vec3( 3.9, 19.7, 2.3)),
    snoise(p + vec3( 8.1, 1.7, 15.4))
  );
}
`;

/** Blackbody-ish colour ramp, 1000 K → 40000 K. */
export const BLACKBODY = /* glsl */ `
vec3 blackbody(float t){
  // Cheap approximation of Planck's law, normalised to peak 1.
  float x = clamp(t, 1000.0, 40000.0) / 1000.0;
  vec3 c;
  c.r = clamp(1.0 - 0.0 * x, 0.0, 1.0);
  c.g = clamp(0.39 * log(x * 5.0) + 0.02, 0.0, 1.0);
  c.b = clamp(0.55 * log(x * 2.4) - 0.30, 0.0, 1.0);
  return c;
}
`;

/**
 * A star's colour from its B−V index.
 *
 * B−V is the standard photometric colour index: 0 is hot blue-white (A0), +2 is
 * cool red (M5). The piecewise fit reproduces the main-sequence locus well enough
 * to be instantly recognisable — Betelgeuse orange, Rigel blue-white, the Sun
 * yellow-white.
 */
export const BV_TO_RGB = /* glsl */ `
vec3 bvToColor(float bv){
  bv = clamp(bv, -0.4, 2.0);
  vec3 c;
  if (bv < 0.0)       c = mix(vec3(0.61,0.69,1.00), vec3(0.79,0.84,1.00), (bv + 0.4) / 0.4);
  else if (bv < 0.3)  c = mix(vec3(0.79,0.84,1.00), vec3(0.96,0.96,1.00), bv / 0.3);
  else if (bv < 0.6)  c = mix(vec3(0.96,0.96,1.00), vec3(1.00,0.98,0.92), (bv - 0.3) / 0.3);
  else if (bv < 1.0)  c = mix(vec3(1.00,0.98,0.92), vec3(1.00,0.90,0.72), (bv - 0.6) / 0.4);
  else if (bv < 1.5)  c = mix(vec3(1.00,0.90,0.72), vec3(1.00,0.79,0.55), (bv - 1.0) / 0.5);
  else               c = mix(vec3(1.00,0.79,0.55), vec3(1.00,0.63,0.42), (bv - 1.5) / 0.5);
  return c;
}
`;

/** sRGB-ish helpers and a filmic tonemap. */
export const COLOR_UTILS = /* glsl */ `
vec3 saturateColor(vec3 c, float amount){
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return mix(vec3(l), c, amount);
}

// ACES filmic approximation (Narkowicz). Keeps highlights from going to mush
// when the Sun and 200 000 additive stars share a frame.
vec3 acesTonemap(vec3 x){
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// Ordered dithering: kills banding in the 8-bit nebula gradients, which is
// extremely visible on OLED laptops in a dark room.
float dither(vec2 fragCoord){
  return fract(sin(dot(fragCoord, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
}

vec2 rotate2D(vec2 v, float a){
  float s = sin(a), c = cos(a);
  return vec2(v.x * c - v.y * s, v.x * s + v.y * c);
}
`;

/** Cheap integer-free hashes. Sin-based, stable across drivers. */
export const HASH = /* glsl */ `
float hash11(float p){
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

vec3 hash31(float p){
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

float hash21(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/** Convenience bundle used by most fragment shaders. */
export const COMMON_FRAGMENT = SIMPLEX_3D + FBM + DOMAIN_WARP + COLOR_UTILS + HASH;

/** Bundle for vertex shaders: no fragment-only colour helpers. */
export const COMMON_VERTEX = HASH;

/** Every uniform the app keeps in sync, as a template. */
export const TIME_UNIFORMS = /* glsl */ `
uniform float uTime;
uniform float uWarp;      // 0..1 warp-drive intensity
`;
