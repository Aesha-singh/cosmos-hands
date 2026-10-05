/**
 * Post-processing stack.
 *
 * Chain order matters and is deliberate:
 *   RenderPass → UnrealBloomPass → FilmGradePass → OutputPass
 *
 * Bloom runs on the *linear HDR* buffer so a 4 000-intensity sun blooms the way
 * a real lens does; the grade pass then does chromatic aberration + vignette +
 * grain, and OutputPass performs tone mapping and sRGB conversion last. Doing
 * the grade in linear space would make the aberration invisible in shadows.
 *
 * @module shaders/post
 */

/** Shared uniform block for the grade pass. */
export const GRADE_UNIFORMS = /* glsl */ `
uniform float uTime;
uniform vec2  uResolution;
uniform float uChromatic;    // aberration strength, UV at frame edge
uniform float uVignetteOffset;
uniform float uVignetteDarkness;
uniform float uGrainIntensity;
uniform float uGrainSpeed;
uniform float uWarp;         // radial blur strength for the rock easter egg
uniform float uSaturation;
uniform float uContrast;
uniform float uFlash;        // white flash on scene change
uniform vec3  uFlashColor;
`;

/** Vertex shader shared by every full-screen pass. */
export const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;

void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * The film grade.
 *
 *  - **Chromatic aberration**: a real lens disperses blue more than red, so the
 *    channels are sampled at slightly different radial offsets. Scaled by r² so
 *    the centre of the frame stays perfectly sharp.
 *  - **Radial blur**: only active for the 🤟 warp easter egg, and only when the
 *    subject is near the centre — the signature Star Wars hyperspace feel.
 *  - **Vignette**: `smoothstep` on the radial distance, offset so it darkens the
 *    corners without crushing the subject.
 *  - **Film grain**: animated blue-ish noise. Real grain is stronger in
 *    midtones and absent in the deepest blacks and clipped whites, so we
 *    modulate by luminance.
 */
export const FILM_GRADE_FRAGMENT = /* glsl */ `
precision highp float;

${GRADE_UNIFORMS}

varying vec2 vUv;

uniform sampler2D tDiffuse;

float hash(vec2 p){
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

vec3 sampleAberrated(sampler2D tex, vec2 uv, float amount){
  if (amount <= 0.0) return texture2D(tex, uv).rgb;
  vec2 centred = uv - 0.5;
  float r2 = dot(centred, centred);
  // Displacement grows with r², as in a real lens.
  vec2 off = centred * r2 * amount;
  float rC = texture2D(tex, uv + off * 1.00).r;
  float gC = texture2D(tex, uv).g;
  float bC = texture2D(tex, uv - off * 1.15).b;
  return vec3(rC, gC, bC);
}

void main(){
  vec2 uv = vUv;
  vec3 col;

  if (uWarp > 0.001){
    // Radial blur toward the frame centre: the hyperspace look.
    vec2 dir = uv - 0.5;
    float amt = uWarp * 0.11;
    col = vec3(0.0);
    float total = 0.0;
    for (int i = 0; i < 12; i++){
      float t = float(i) / 11.0;
      float scale = 1.0 - t * amt;
      vec2 suv = 0.5 + dir * scale;
      float w = 1.0 - t * 0.55;
      col += sampleAberrated(tDiffuse, suv, uChromatic * 0.4) * w;
      total += w;
    }
    col /= total;
  } else {
    col = sampleAberrated(tDiffuse, uv, uChromatic);
  }

  // --- saturation / contrast ---------------------------------------------
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, uSaturation);
  col = (col - 0.5) * uContrast + 0.5;

  // --- vignette ----------------------------------------------------------
  vec2 vc = (vUv - 0.5) * vec2(uResolution.x / max(uResolution.y, 1.0), 1.0);
  float d = length(vc) / 1.42;
  float vig = 1.0 - smoothstep(uVignetteOffset, uVignetteOffset + 0.85, d) * uVignetteDarkness;
  col *= clamp(vig, 0.0, 1.0);

  // --- film grain --------------------------------------------------------
  // Modulated by luminance: grain lives in the midtones, as on real stock.
  float n = hash(uv * uResolution + fract(uTime * uGrainSpeed) * 137.0) - 0.5;
  float grainMask = smoothstep(0.0, 0.28, luma) * (1.0 - smoothstep(0.72, 1.0, luma));
  col += n * uGrainIntensity * grainMask;

  // --- flash -------------------------------------------------------------
  col = mix(col, uFlashColor, uFlash);

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

/**
 * Outline pass — the "selection reticle" glow around a hovered or focused body.
 * A depth-independent Sobel on a mask channel, cheap enough to run always-on.
 */
export const OUTLINE_FRAGMENT = /* glsl */ `
precision highp float;

// Three's ShaderPass does not inject samplers, so this must be declared here.
uniform sampler2D tDiffuse;

uniform vec3  uColor;
uniform float uStrength;
uniform vec2  uResolution;
uniform float uTime;

varying vec2 vUv;

void main(){
  vec2 texel = 1.0 / uResolution;
  // 4-tap cross is enough for a soft selection glow.
  vec4 c = texture2D(tDiffuse, vUv);
  vec4 l = texture2D(tDiffuse, vUv - vec2(texel.x, 0.0));
  vec4 r = texture2D(tDiffuse, vUv + vec2(texel.x, 0.0));
  vec4 u = texture2D(tDiffuse, vUv + vec2(0.0, texel.y));
  vec4 d = texture2D(tDiffuse, vUv - vec2(0.0, texel.y));

  float edge = abs(l.a - r.a) + abs(u.a - d.a);
  float glow = smoothstep(0.05, 0.5, edge) * uStrength;

  // Breathing pulse so a selected object reads as "live".
  glow *= 0.75 + 0.25 * sin(uTime * 3.4);

  gl_FragColor = vec4(mix(c.rgb, uColor, glow), c.a);
}
`;

/**
 * Cosmic-web material for the deep-universe scene: filaments drawn as
 * screen-space-thin tubes with a soft additive falloff.
 */
export const WEB_VERTEX = /* glsl */ `
attribute vec3 aNext;
attribute float aWidth;
attribute float aBright;

uniform float uPixelRatio;
uniform vec2  uResolution;

varying float vBright;
varying vec2  vUv;

void main(){
  vUv = uv;
  vBright = aBright;

  // Camera-facing quad between this point and the next, so the filament has
  // real screen-space width at any distance.
  vec4 mvA = modelViewMatrix * vec4(position, 1.0);
  vec4 mvB = modelViewMatrix * vec4(aNext, 1.0);
  vec4 clip = mix(mvA, mvB, uv.x);
  clip = projectionMatrix * clip;

  vec2 dir = normalize((projectionMatrix * mvB).xy / max((projectionMatrix * mvB).w, 1e-4)
                     - (projectionMatrix * mvA).xy / max((projectionMatrix * mvA).w, 1e-4));
  vec2 normal = vec2(-dir.y, dir.x) / uResolution;

  clip.xy += normal * (uv.y - 0.5) * aWidth * clip.w;

  gl_Position = clip;
}
`;

export const WEB_FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;

varying float vBright;
varying vec2  vUv;

void main(){
  // Soft round cross-section.
  float d = abs(vUv.y - 0.5) * 2.0;
  float a = exp(-d * d * 4.0);

  // Taper the ends so segments join invisibly.
  a *= smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.94, vUv.x);

  // Slow travelling pulse along the filament, like data in a fibre.
  float pulse = 0.72 + 0.28 * sin((vUv.x + uTime * 0.14) * 12.0);
  a *= pulse;

  a *= vBright * uOpacity;
  gl_FragColor = vec4(uColor * a, a);
}
`;

export const GRADE_UNIFORM_DEFAULTS = {
  uTime: { value: 0 },
  uResolution: { value: [1, 1] },
  uChromatic: { value: 0.0022 },
  uVignetteOffset: { value: 0.28 },
  uVignetteDarkness: { value: 1.05 },
  uGrainIntensity: { value: 0.045 },
  uGrainSpeed: { value: 12.0 },
  uWarp: { value: 0 },
  uSaturation: { value: 1.08 },
  uContrast: { value: 1.04 },
  uFlash: { value: 0 },
  uFlashColor: { value: [1, 1, 1] },
};
