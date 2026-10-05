/**
 * Synthetic hand skeletons for tests.
 *
 * MediaPipe hands are hard to record as fixtures (privacy, and the landmark
 * arrays are large), so we build plausible ones analytically. Each pose is
 * generated from the same geometry the real model produces: wrist, four MCPs
 * across the palm, three joints per finger. `curl` interpolates between the
 * straight and folded configurations so tests can probe the hysteresis
 * boundaries instead of only the two extremes.
 *
 * @module tests/helpers/syntheticHands
 */

import { LM } from '../../src/gestures/gesture-vocabulary.js';

/** MCP positions for a right hand, palm facing the camera, in image space. */
const MCP_X = [0.42, 0.45, 0.48, 0.51, 0.53];

/**
 * Build a 21-landmark hand.
 *
 * @param {Object} [opts]
 * @param {number[]} [opts.curl] Per-finger curl 0 straight → 1 folded.
 * @param {number} [opts.palmWidthScale] Widen the palm. Narrows pinch *relative to
 *   palm width*, which is the correct behaviour but surprising if unnamed.
 * @param {number} [opts.pinch] Pinch thumb onto the index tip, 0 → 1.
 * @param {boolean} [opts.palmAway] Rotate the palm so it faces away.
 * @param {number} [opts.x] Palm centre X.
 * @param {number} [opts.y] Palm centre Y.
 * @param {number} [opts.scale] Hand size multiplier.
 * @param {boolean} [opts.thumbTuck] Lay the thumb across the palm, as a fist does.
 * @param {boolean} [opts.thumbUp] Point the thumb straight up, as a thumbs-up does.
 * @returns {Array<{x:number,y:number,z:number}>}
 */
export function makeHand({
  curl = [0, 0, 0, 0, 0],
  palmWidthScale = 0,
  pinch = 0,
  palmAway = false,
  x = 0.5,
  y = 0.5,
  scale = 1,
  thumbTuck = false,
  thumbUp = false,
} = {}) {
  const lm = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  const s = scale;

  // --- wrist ---------------------------------------------------------------
  lm[LM.WRIST] = pt(x, y + 0.16 * s, palmAway ? 0.02 : -0.02);

  // --- palm: four MCPs in an arc ------------------------------------------
  // MediaPipe spaces the knuckles apart (5, 9, 13, 17) with three joints between
  // each pair; they are not contiguous.
  const zBase = palmAway ? 0.03 : -0.03;
  const MCP_IDX = [LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];
  for (let i = 0; i < 4; i++) {
    const f = i / 3;
    lm[MCP_IDX[i]] = pt(
      x + (MCP_X[i] - 0.5 + palmWidthScale * (f - 0.5)) * s,
      y + (0.02 - f * 0.03) * s,
      zBase,
    );
  }

  // --- fingers -------------------------------------------------------------
  // Finger length in image units, longest in the middle as on a real hand.
  const lengths = [0, 0.105, 0.115, 0.10, 0.082];
  for (let f = 1; f <= 4; f++) {
    const mcp = 5 + (f - 1) * 4;
    const pip = mcp + 1;
    const dip = mcp + 2;
    const tip = mcp + 3;
    const c = curl[f] ?? 0;

    // Each joint rotates progressively toward the palm as curl increases, so
    // the tip comes back toward the wrist — which is what `curlOf` measures.
    const baseX = lm[mcp].x;
    const baseY = lm[mcp].y;
    const L = lengths[f] * s;

    const angles = [0, c * 1.15, c * 2.05, c * 2.85];
    let cx = baseX;
    let cy = baseY;
    const jointIdx = [pip, dip, tip];
    const segs = [L * 0.5, L * 0.3, L * 0.2];

    for (let j = 0; j < 3; j++) {
      // Finger angle from vertical, negative = curling into the palm.
      const a = -angles[j + 1];
      cx += Math.sin(a) * segs[j];
      cy -= Math.cos(a) * segs[j];
      lm[jointIdx[j]] = pt(cx, cy, zBase + c * 0.05);
    }
  }

  // --- thumb ---------------------------------------------------------------
  // The thumb sits off the side of the palm, angled ~55° from the fingers.
  const tAngle = -0.95;
  const tL = 0.10 * s;
  let tx = x + (MCP_X[0] - 0.5) * s;
  let ty = y + 0.06 * s;
  lm[LM.THUMB_MCP] = pt(tx, ty, zBase);
  const tc = curl[0] ?? 0;
  let px = tx, py = ty;
  const tSegs = [tL * 0.45, tL * 0.35, tL * 0.2];
  const tAngles = [-0.2 - tc * 0.15, -0.5 - tc * 0.3, -0.85 - tc * 0.5];
  const tIdx = [LM.THUMB_CMC, LM.THUMB_IP, LM.THUMB_TIP];
  for (let j = 0; j < 3; j++) {
    const a = tAngles[j];
    px += Math.sin(a) * tSegs[j];
    py -= Math.cos(a) * tSegs[j];
    lm[tIdx[j]] = pt(px, py, zBase - tc * 0.03);
  }

  // A real fist tucks the thumb *across* the folded fingers rather than leaving
  // it out to the side. That is the difference the classifier tests for, so the
  // fixture has to model it or the test proves nothing.
  if (thumbTuck) {
    const tipX = x + (MCP_X[2] - 0.5) * s + 0.01 * s;
    const tipY = y + 0.055 * s;
    lm[LM.THUMB_TIP] = pt(tipX, tipY, zBase + 0.02);
    lm[LM.THUMB_IP] = pt(
      lerpN(lm[LM.THUMB_IP].x, tipX, 0.5),
      lerpN(lm[LM.THUMB_IP].y, tipY, 0.5),
      zBase + 0.015,
    );
  }

  // Thumbs up: the thumb leaves the fist pointing upward, along the fingers'
  // axis rather than across the palm. Image y grows downward, so "up" is -y.
  if (thumbUp) {
    const upX = x - 0.055 * s;
    lm[LM.THUMB_IP] = pt(lerpN(lm[LM.THUMB_MCP].x, upX, 0.4), y - 0.10 * s, zBase + 0.01);
    lm[LM.THUMB_TIP] = pt(upX, y - 0.175 * s, zBase + 0.02);
  }

  // --- pinch: bring the thumb tip onto the index tip -----------------------
  if (pinch > 0) {
    const target = lm[LM.INDEX_TIP];
    lm[LM.THUMB_TIP] = pt(
      target.x + (lm[LM.THUMB_TIP].x - target.x) * (1 - pinch),
      target.y + (lm[LM.THUMB_TIP].y - target.y) * (1 - pinch),
      target.z + (lm[LM.THUMB_TIP].z - target.z) * (1 - pinch),
    );
    // Intermediate thumb joints follow, or the thumb teleports.
    lm[LM.THUMB_IP] = pt(
      lerpN(lm[LM.THUMB_IP].x, lm[LM.THUMB_TIP].x, 0.45),
      lerpN(lm[LM.THUMB_IP].y, lm[LM.THUMB_TIP].y, 0.45),
      lm[LM.THUMB_IP].z,
    );
  }

  return lm;
}

function pt(x, y, z) { return { x: round(x), y: round(y), z: round(z) }; }
function lerpN(a, b, t) { return a + (b - a) * t; }
function round(v) { return Math.round(v * 1e6) / 1e6; }

/** Curl values for a fully open hand. */
export const OPEN = [0, 0, 0, 0, 0];
/** Curl values for a closed fist — every finger folded. */
export const FIST = [1, 1, 1, 1, 1];
/** Peace sign: index and middle straight, rest folded. */
export const PEACE = [0.7, 0, 0, 1, 1];
/** Pointing: index straight only. */
export const POINT = [0.8, 0, 1, 1, 1];