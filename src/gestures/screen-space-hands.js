/**
 * Screen-space hand overlay.
 *
 * Drawn on a 2-D canvas above the WebGL canvas. It exists for three reasons:
 *
 *  1. **Feedback.** Without a visible skeleton, users cannot tell whether the
 *     problem is their hand, the lighting, or the model. Seeing your own hand
 *     tracked is what makes the calibration step trustworthy.
 *  2. **Calibration.** During calibration the active box is drawn, and the
 *     overlay colours the region the camera will actually respond to.
 *  3. **Legibility.** The active gesture is called out with a glyph and a name,
 *     so the vocabulary teaches itself.
 *
 * Drawing is deliberately cheap: one canvas, `setTransform` to go from pixel
 * space to normalised space, no per-frame allocation, no shadows.
 *
 * @module gestures/screen-space-hands
 */

import { GESTURE_LABELS, GESTURES } from './gesture-vocabulary.js';
import { HAND_CONNECTIONS } from './hand-tracker.js';
import { BRAND, HAND_VIS } from '../config.js';
import { clamp01 } from '../utils/math.js';



export class ScreenSpaceHands {
  /**
   * @param {HTMLCanvasElement} canvas Overlay canvas, sized to the viewport.
   * @param {import('./hand-tracker.js').HandTracker} tracker
   */
  constructor(canvas, tracker) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.tracker = tracker;

    /** @type {{x:number,y:number,w:number,h:number}|null} */
    this.activeBox = null;
    /** Show the calibration box. */
    this.showBox = false;
    /** Opacity, faded by the intro/outro. */
    this.opacity = 1;
    /** True while the intro screen is up: dim the overlay. */
    this.dimmed = false;

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize, { passive: true });
    this._resize();
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = Math.max(window.innerHeight, 1);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.dpr = dpr;
  }

  /**
   * Draw one frame.
   * @param {number} time Seconds, for pulse animation.
   */
  render(time) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (this.opacity <= 0.01) return;

    ctx.save();
    ctx.globalAlpha = this.dimmed ? 0.25 : this.opacity;

    if (this.showBox && this.activeBox) this._drawActiveBox(time);

    const hands = Object.values(this.tracker.hands).filter(Boolean);
    for (const hand of hands) this._drawHand(hand, time);

    if (hands.length) this._drawGestureBadge(hands, time);

    ctx.restore();
  }

  /** @param {number} time */
  _drawActiveBox(time) {
    const ctx = this.ctx;
    const b = this.activeBox;
    const x = b.x * this.w;
    const y = b.y * this.h;
    const w = b.w * this.w;
    const h = b.h * this.h;
    const pulse = 0.5 + 0.5 * Math.sin(time * 1.6);

    ctx.save();
    ctx.strokeStyle = `rgba(255, 214, 165, ${0.28 + 0.22 * pulse})`;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(x, y, w, h);

    // Corner brackets read as a viewfinder rather than a rectangle.
    ctx.setLineDash([]);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = `rgba(255, 214, 165, ${0.55 + 0.3 * pulse})`;
    const c = Math.min(22, w * 0.2, h * 0.2);
    for (const [cx, cy, dx, dy] of [
      [x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(cx + dx * c, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + dy * c);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(255, 231, 196, 0.9)';
    ctx.font = `500 ${11}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText('ACTIVE REGION', x + 4, y - 7);
    ctx.restore();
  }

  /** @param {Object} hand @param {number} time */
  _drawHand(hand, time) {
    const ctx = this.ctx;
    const color = HAND_VIS.handColors[hand.handedness] ?? BRAND.colors.champagne;

    // Landmarks arrive mirrored (x in 0..1 from the camera's view); flip so the
    // skeleton lines up with the mirrored video preview.
    const px = (i) => (1 - hand.landmarks[i].x) * this.w;
    const py = (i) => hand.landmarks[i].y * this.h;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Bones. A darker, wider pass underneath gives the skeleton contrast over
    // a bright sun, and a thin bright pass on top keeps it legible over black.
    for (const pass of [
      { width: 6, color: 'rgba(0, 0, 0, 0.42)' },
      { width: 2.4, color: color.replace(/[\d.]+\)$/, '0.92)') },
    ]) {
      ctx.strokeStyle = pass.color;
      ctx.lineWidth = pass.width;
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.moveTo(px(a), py(a));
        ctx.lineTo(px(b), py(b));
      }
      ctx.stroke();
    }

    // Joints.
    for (let i = 0; i < hand.landmarks.length; i++) {
      const isTip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20;
      const r = isTip ? 4.2 : 2.4;
      ctx.beginPath();
      ctx.arc(px(i), py(i), r, 0, Math.PI * 2);
      ctx.fillStyle = isTip ? '#FFF6E6' : color.replace(/[\d.]+\)$/, '0.85)');
      ctx.fill();
      if (isTip) {
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // Pinch indicator: a line between thumb and index that brightens as the
    // pinch closes. Continuous feedback beats a binary icon here.
    if (hand.features.pinch > 0.05) {
      const strength = clamp01(hand.features.pinch);
      ctx.beginPath();
      ctx.moveTo(px(4), py(4));
      ctx.lineTo(px(8), py(8));
      ctx.strokeStyle = `rgba(255, 236, 200, ${0.25 + 0.7 * strength})`;
      ctx.lineWidth = 1 + 3 * strength;
      ctx.stroke();
    }

    // Openness arc around the palm centre — a quick read of how "open" the hand
    // is without counting fingers.
    const c = hand.features.palmCentre;
    const cx = (1 - c.x) * this.w;
    const cy = c.y * this.h;
    const r = HAND_VIS.palmRadius * this.w;
    const start = -Math.PI / 2;
    const sweep = (1 - hand.features.openness) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + sweep);
    ctx.strokeStyle = `rgba(120, 224, 255, 0.5)`;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.restore();

    // Handedness label, so "Left" means the user's left, not the model's.
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = '600 11px ui-sans-serif, system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(hand.handedness.toUpperCase(), cx, cy + r + 15);
    ctx.restore();
  }

  /**
   * The active gesture, called out once per frame in the centre-bottom.
   * @param {Object[]} hands
   * @param {number} time
   */
  _drawGestureBadge(hands, time) {
    // Show the left hand's gesture when both are present, for determinism.
    const hand = hands.find((h) => h.handedness === 'Left') ?? hands[0];
    const info = GESTURE_LABELS[hand.gesture];
    if (!info) return;

    const ctx = this.ctx;
    const x = this.w / 2;
    const y = this.h - 96;
    const pulse = 0.5 + 0.5 * Math.sin(time * 2.2);

    ctx.save();
    ctx.textAlign = 'center';

    // Frosted pill.
    const text = `${info.icon}  ${info.label}`;
    ctx.font = '600 15px ui-sans-serif, system-ui, -apple-system, sans-serif';
    const metrics = ctx.measureText(text);
    const padX = 18;
    const padY = 11;
    const boxW = metrics.width + padX * 2;
    const boxH = 34 + padY;

    ctx.beginPath();
    ctx.roundRect(x - boxW / 2, y - boxH / 2, boxW, boxH, boxH / 2);
    ctx.fillStyle = 'rgba(10, 14, 26, 0.55)';
    ctx.fill();
    ctx.strokeStyle = hand.gesture === GESTURES.FIST
      ? `rgba(255, 120, 120, ${0.4 + 0.3 * pulse})`
      : 'rgba(255, 231, 196, 0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = BRAND.colors.champagne;
    ctx.fillText(text, x, y - 4);

    ctx.font = '500 11px ui-sans-serif, system-ui, -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(200, 214, 240, 0.72)';
    ctx.fillText(info.hint, x, y + 12);

    ctx.restore();
  }

  /** Show or hide the calibration region. */
  setActiveBox(box) {
    this.activeBox = box ? { ...box } : null;
    this.showBox = Boolean(box);
  }

  /** Tear down. */
  dispose() {
    window.removeEventListener('resize', this._resize);
  }
}