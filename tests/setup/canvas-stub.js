/**
 * A minimal 2-D canvas context for tests.
 *
 * jsdom does not implement canvas rendering — `getContext('2d')` returns null —
 * so every module that generates a texture procedurally would throw. Rather than
 * install a native canvas binding, this stubs just enough of the API for the
 * texture helpers to run.
 *
 * What this does and does not prove
 * ---------------------------------
 * It proves the *code path* executes: the noise fields are sampled, the palettes
 * are chosen, the geometry and materials get built, nothing throws, and nothing
 * leaks. It proves nothing about the resulting pixels.
 *
 * Pixels are verified separately, by `tools/validate-shaders.mjs`, which compiles
 * every shader against a real WebGL 2 context in headless Chrome. Splitting it
 * this way keeps the unit tests fast while still holding the shaders to a real
 * compiler.
 */

/** No-op gradient with the one method the helpers use. */
const gradient = () => ({ addColorStop() {} });

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {object} A stub 2-D context.
 */
function makeContext(canvas) {
  const ctx = {
    canvas,
    // State that the helpers write to; read back only by assertions.
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',

    // --- pixel access ----------------------------------------------------
    createImageData(w, h) {
      return {
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
      };
    },
    getImageData(x, y, w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData() {},

    // --- drawing ---------------------------------------------------------
    fillRect() {},
    strokeRect() {},
    clearRect() {},
    fillText() {},
    strokeText() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    arcTo() {},
    ellipse() {},
    rect() {},
    quadraticCurveTo() {},
    bezierCurveTo() {},
    fill() {},
    stroke() {},
    clip() {},

    // --- transforms ------------------------------------------------------
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    scale() {},
    transform() {},
    setTransform() {},

    // --- gradients -------------------------------------------------------
    createLinearGradient: () => gradient(),
    createRadialGradient: () => gradient(),
    createPattern: () => null,

    // --- text ------------------------------------------------------------
    measureText(text) {
      // A fixed per-character width is enough: nothing asserts on real metrics.
      return { width: String(text).length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 };
    },
  };
  return ctx;
}

/** Install the stub onto jsdom's canvas prototype. */
export function installCanvasStub() {
  const proto = globalThis.HTMLCanvasElement?.prototype;
  if (!proto) throw new Error('canvas stub: no HTMLCanvasElement — wrong environment?');
  if (proto.__cosmosStubbed) return;
  proto.getContext = function getContext(kind) {
    if (kind !== '2d') return null;   // WebGL contexts stay unsupported
    // One context per canvas: the helpers read pixels back after drawing.
    if (!this.__ctx2d) this.__ctx2d = makeContext(this);
    return this.__ctx2d;
  };
  proto.toDataURL = function toDataURL() {
    return 'data:image/png;base64,';
  };
  proto.__cosmosStubbed = true;
}

installCanvasStub();