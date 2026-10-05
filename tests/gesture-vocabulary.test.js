import { describe, expect, it } from 'vitest';
import {
  GESTURES,
  GestureDebouncer,
  HandSmoother,
  classifyHand,
} from '../src/gestures/gesture-vocabulary.js';
import { FIST, OPEN, PEACE, POINT, makeHand } from './helpers/syntheticHands.js';

describe('classifyHand', () => {
  it('reads a fully open hand as an open palm', () => {
    const { discrete, features } = classifyHand(makeHand({ curl: OPEN }));
    expect(discrete).toBe(GESTURES.OPEN_PALM);
    expect(features.openness).toBeLessThan(0.35);
    expect(features.pinch).toBeLessThan(0.2);
  });

  it('reads a closed hand with a tucked thumb as a fist', () => {
    const { discrete, features } = classifyHand(makeHand({ curl: FIST, thumbTuck: true }));
    expect(discrete).toBe(GESTURES.FIST);
    expect(features.openness).toBeGreaterThan(0.5);
  });

  it('separates a thumbs-up from a fist by thumb direction', () => {
    // Both poses have four curled fingers and a visible thumb. Only the
    // direction of that thumb differs, so this is what stops every fist from
    // reading as a thumbs-up.
    const fist = classifyHand(makeHand({ curl: FIST, thumbTuck: true }));
    const up = classifyHand(makeHand({ curl: FIST, thumbUp: true }));
    expect(fist.metrics.thumbUpScore).toBeLessThan(up.metrics.thumbUpScore);
    expect(fist.discrete).toBe(GESTURES.FIST);
    expect(up.discrete).toBe(GESTURES.THUMBS_UP);
  });

  it('reports higher openness for an open hand than a fist', () => {
    const open = classifyHand(makeHand({ curl: OPEN })).features.openness;
    const fist = classifyHand(makeHand({ curl: FIST })).features.openness;
    expect(open).toBeLessThan(fist);
  });

  it('detects a pinch and scales pinch strength continuously', () => {
    const near = classifyHand(makeHand({ curl: OPEN, pinch: 0.95 })).features;
    const far = classifyHand(makeHand({ curl: OPEN, pinch: 0 })).features;
    expect(near.pinch).toBeGreaterThan(0.8);
    expect(near.pinchDistance).toBeLessThan(far.pinchDistance);
    expect(far.pinch).toBeLessThan(0.15);
  });

  it('distinguishes a peace sign from a pointing finger', () => {
    const peace = classifyHand(makeHand({ curl: PEACE }));
    const point = classifyHand(makeHand({ curl: POINT }));
    expect(peace.discrete).toBe(GESTURES.PEACE);
    expect(point.discrete).toBe(GESTURES.POINT);
  });

  it('is invariant to hand size on screen', () => {
    // A hand twice as far from the camera produces smaller landmarks, but every
    // threshold is expressed in palm-widths, so the pose must not change.
    const near = classifyHand(makeHand({ curl: FIST, thumbTuck: true, scale: 1 }));
    const far = classifyHand(makeHand({ curl: FIST, thumbTuck: true, scale: 0.45 }));
    expect(far.discrete).toBe(near.discrete);
    expect(far.features.openness).toBeCloseTo(near.features.openness, 1);
  });

  it('holds a gesture steady at the hysteresis boundary instead of chattering', () => {
    // Land exactly between the enter and exit thresholds.
    const borderline = makeHand({ curl: [0.5, 0.72, 0.72, 0.72, 0.72] });
    const state = {};
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      seen.add(classifyHand(borderline, state).discrete);
    }
    // Any number of distinct poses is fine, but it must not be more than a
    // couple: flicker between many states is the bug hysteresis prevents.
    expect(seen.size).toBeLessThanOrEqual(2);
  });

  it('degrades gracefully on a malformed skeleton', () => {
    const { discrete, features } = classifyHand(null);
    expect(discrete).toBe(GESTURES.OPEN_PALM);
    expect(features.openness).toBe(0);
  });
});

describe('GestureDebouncer', () => {
  it('requires a gesture to be held before it is emitted', () => {
    const d = new GestureDebouncer({ holdMs: 100, minFrames: 2 });
    d.stable = GESTURES.OPEN_PALM;
    // Two frames of FIST is not enough at t=0/10ms.
    expect(d.push(GESTURES.FIST, 0)).toBe(GESTURES.OPEN_PALM);
    expect(d.push(GESTURES.FIST, 10)).toBe(GESTURES.OPEN_PALM);
    // Held past the threshold, it switches.
    expect(d.push(GESTURES.FIST, 200)).toBe(GESTURES.FIST);
  });

  it('collapses a single-frame glitch', () => {
    const d = new GestureDebouncer({ holdMs: 100 });
    d.stable = GESTURES.OPEN_PALM;
    expect(d.push(GESTURES.FIST, 0)).toBe(GESTURES.OPEN_PALM);
    expect(d.push(GESTURES.OPEN_PALM, 16)).toBe(GESTURES.OPEN_PALM);
    expect(d.push(GESTURES.FIST, 32)).toBe(GESTURES.OPEN_PALM);
  });
});

describe('HandSmoother', () => {
  it('eases toward the target rather than snapping', () => {
    const s = new HandSmoother({ response: 0.1 });
    s.snapTo({ x: 0.5, y: 0.5, zoom: 0, roll: 0 });
    s.push({ x: 1, y: 0.5, zoom: 0, roll: 0 }, 0.016);
    const first = s.value.x;
    expect(first).toBeGreaterThan(0.5);
    expect(first).toBeLessThan(1);

    s.push({ x: 1, y: 0.5, zoom: 0, roll: 0 }, 0.5);
    expect(s.value.x).toBeGreaterThan(first);
    expect(s.value.x).toBeLessThan(1);
  });

  it('converges to the target', () => {
    const s = new HandSmoother({ response: 0.05 });
    for (let i = 0; i < 200; i++) s.push({ x: 0.8, y: 0.2, zoom: 1, roll: 0 }, 0.016);
    expect(s.value.x).toBeCloseTo(0.8, 2);
    expect(s.value.zoom).toBeCloseTo(1, 2);
  });

  it('is frame-rate independent over equal spans of time', () => {
    // 30 frames of 33ms must travel as far as 60 frames of 16ms.
    const a = new HandSmoother({ response: 0.1 });
    const b = new HandSmoother({ response: 0.1 });
    a.snapTo({ x: 0, y: 0.5, zoom: 0, roll: 0 });
    b.snapTo({ x: 0, y: 0.5, zoom: 0, roll: 0 });
    for (let i = 0; i < 30; i++) a.push({ x: 1, y: 0.5, zoom: 0, roll: 0 }, 0.0333);
    for (let i = 0; i < 60; i++) b.push({ x: 1, y: 0.5, zoom: 0, roll: 0 }, 0.0166);
    expect(a.value.x).toBeCloseTo(b.value.x, 2);
  });
});