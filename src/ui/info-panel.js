/**
 * Celestial info panel.
 *
 * Shows the physical facts about whatever is focused: type, name, alternate
 * designations, a short blurb, a table of measurements, one genuinely
 * interesting fact, and the orbital period.
 *
 * Numbers count up rather than appearing instantly. It is a small thing, but
 * it does two useful jobs: it stops the layout jumping as long numbers land,
 * and it gives the eye time to follow the magnitude change — which is the
 * actual payload of a solar-system app.
 *
 * The "portrait" is a small canvas rendering of the body's own procedural
 * texture, so a planet panel looks like *that planet* without shipping a single
 * photograph.
 *
 * @module ui/info-panel
 */

import { $ } from '../utils/dom.js';
import { Emitter, el, on } from '../utils/dom.js';
import { formatDistance, formatDuration } from './hud.js';

/** @typedef {Object} BodyInfo
 * @property {string} id
 * @property {string} label
 * @property {string} type Display class, e.g. "STAR", "GAS GIANT".
 * @property {string} name Proper name, e.g. "Sol".
 * @property {string} [alt] Alternate designations.
 * @property {string} blurb
 * @property {string} funfact
 * @property {Record<string, string|number>} facts
 * @property {number} [periodDays] Orbital period, days.
 * @property {number} [periodSeconds]
 * @property {number} [diameterKm]
 * @property {string} [texture] Colour hint used for the portrait.
 */

export class InfoPanel extends Emitter {
  constructor() {
    super();
    this.root = $('#info-panel');
    this.type = $('#info-type');
    this.name = $('#info-name');
    this.alt = $('#info-alt');
    this.blurb = $('#info-blurb');
    this.facts = $('#info-facts');
    this.funfact = $('#info-funfact');
    this.period = $('#info-period');
    this.periodFill = $('#info-period-fill');
    this.portrait = $('#info-portrait');

    this._body = null;
    this._countAnim = null;

    on($('#info-close'), 'click', () => this.hide());
  }

  /** @returns {boolean} */
  get isOpen() { return Boolean(this.root) && !this.root.hidden; }

  /**
   * @param {BodyInfo} body
   */
  show(body) {
    if (!this.root) return;
    this._body = body;
    this.root.hidden = false;
    // Restart the slide-in animation.
    this.root.classList.remove('is-in');
    void this.root.offsetWidth;
    this.root.classList.add('is-in');

    if (this.type) this.type.textContent = body.type ?? '';
    if (this.name) this.name.textContent = body.name ?? body.label;
    if (this.alt) {
      this.alt.textContent = body.alt ?? '';
      this.alt.hidden = !body.alt;
    }
    if (this.blurb) this.blurb.textContent = body.blurb ?? '';
    if (this.funfact) this.funfact.textContent = body.funfact ?? '';

    this._renderFacts(body.facts ?? {});
    this._renderPeriod(body);

    this._drawPortrait(body);
    this.emit('open', body);
  }

  hide() {
    if (!this.root) return;
    this.root.hidden = true;
    this._stopCount();
    this._body = null;
    this.emit('close');
  }

  /**
   * Replace the fact table, animating numeric values into place.
   * @param {Record<string, string|number>} facts
   */
  _renderFacts(facts) {
    if (!this.facts) return;
    this.facts.innerHTML = '';
    this._stopCount();

    const numeric = [];
    for (const [key, value] of Object.entries(facts)) {
      const dt = el('dt', {}, [document.createTextNode(key.toUpperCase())]);
      const dd = el('dd', {}, [
        typeof value === 'number'
          ? document.createTextNode('0')
          : document.createTextNode(String(value)),
      ]);
      this.facts.appendChild(dt);
      this.facts.appendChild(dd);
      if (typeof value === 'number') {
        numeric.push({ node: dd.firstChild, from: 0, to: value });
      }
    }

    if (!numeric.length) return;

    // requestAnimationFrame rather than CSS so the final value is exact.
    const started = performance.now();
    const duration = 1350;
    const tick = (now) => {
      const t = Math.min((now - started) / duration, 1);
      // easeOutCubic: fast start, gentle settle.
      const e = 1 - (1 - t) ** 3;
      for (const item of numeric) {
        item.node.nodeValue = this._formatFact(item.to * e);
      }
      if (t < 1) {
        this._countAnim = requestAnimationFrame(tick);
      } else {
        this._countAnim = null;
      }
    };
    this._countAnim = requestAnimationFrame(tick);
  }

  /** @param {number} value */
  _formatFact(value) {
    const a = Math.abs(value);
    if (a >= 1e5) return value.toExponential(2);
    if (a >= 1000) return Math.round(value).toLocaleString('en-US');
    if (a >= 10) return value.toFixed(1);
    if (a >= 0.01) return value.toFixed(3);
    return value.toPrecision(3);
  }

  /** @param {BodyInfo} body */
  _renderPeriod(body) {
    if (!this.period) return;
    const seconds = body.periodSeconds ?? (body.periodDays ? body.periodDays * 86400 : null);
    if (seconds == null) {
      this.period.textContent = '—';
      this.periodFill.style.width = '0%';
      return;
    }
    this.period.textContent = formatDuration(seconds);
    // Bar length: log scale, because the range spans Mercury (88 d) to Neptune
    // (60 000 yr). A linear bar would render every outer planet as zero.
    const days = seconds / 86400;
    const pct = days > 1
      ? Math.min(100, (Math.log10(days) / Math.log10(6e7)) * 100)
      : (days * 100);
    this.periodFill.style.width = `${pct.toFixed(1)}%`;
  }

  /**
   * Draw the body's surface into the small portrait canvas.
   *
   * Uses a lat/long gradient rather than the 3-D texture: re-uploading a
   * planet's texture into a 2-D canvas means a GPU readback, and this panel
   * only needs to read as "this is Jupiter", not as a photograph.
   *
   * @param {BodyInfo} body
   */
  _drawPortrait(body) {
    const canvas = this.portrait;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const size = canvas.width;
    const r = size / 2;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, r - 1, 0, Math.PI * 2);
    ctx.clip();

    const colors = PORTRAIT_PALETTE[body.type] ?? ['#2b3550', '#6a7590'];
    const grad = ctx.createRadialGradient(
      r * 0.68, r * 0.62, r * 0.08,
      r, r, r * 1.25,
    );
    grad.addColorStop(0, colors[1]);
    grad.addColorStop(1, colors[0]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // Latitude banding: gas giants get bands, rocky worlds get nothing.
    const bands = PORTRAIT_BANDS[body.type] ?? 0;
    for (let i = 0; i < bands; i++) {
      const y = (i + 0.5) * (size / bands);
      const h = (size / bands) * (0.22 + 0.2 * Math.abs(Math.sin(i * 2.3)));
      ctx.fillStyle = `rgba(255, 255, 255, ${0.03 + 0.04 * Math.abs(Math.cos(i * 1.7))})`;
      ctx.fillRect(0, y - h / 2, size, h);
    }

    // A ring for anything that has one.
    if (body.hasRings) {
      ctx.strokeStyle = 'rgba(230, 214, 186, 0.5)';
      ctx.lineWidth = size * 0.02;
      ctx.beginPath();
      ctx.ellipse(r, r, r * 0.98, r * 0.3, -0.42, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Terminator: shade the lower-right limb.
    const shade = ctx.createRadialGradient(
      r * 0.72, r * 0.68, r * 0.1,
      r, r, r * 1.05,
    );
    shade.addColorStop(0, 'rgba(0,0,0,0)');
    shade.addColorStop(0.72, 'rgba(0,0,0,0.15)');
    shade.addColorStop(1, 'rgba(0,0,0,0.72)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, size, size);
    ctx.restore();

    // Crisp limb.
    ctx.beginPath();
    ctx.arc(r, r, r - 1, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 231, 196, 0.28)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  _stopCount() {
    if (this._countAnim) {
      cancelAnimationFrame(this._countAnim);
      this._countAnim = null;
    }
  }

  /** @returns {Object|null} */
  get body() { return this._body; }
}

/** Colours per body class, used for the portrait gradient. */
const PORTRAIT_PALETTE = {
  STAR: ['#6b3a00', '#ffd98a'],
  ROCKY: ['#3a2f28', '#b7a08c'],
  DESERT: ['#4a2c14', '#e0b183'],
  ICE: ['#2d4658', '#cfe4ef'],
  'GAS GIANT': ['#4a2f1d', '#dcb98c'],
  'ICE GIANT': ['#1d3a52', '#9dc7dd'],
  MOON: ['#33302c', '#a8a099'],
  DWARF: ['#3a2c22', '#c0a084'],
  NEBULA: ['#160d2a', '#8f6fd0'],
  STARFIELD: ['#050816', '#2b3a66'],
  GALAXY: ['#0a1030', '#7fa8e0'],
  CONSTELLATION: ['#050816', '#33406b'],
  BLACK_HOLE: ['#000000', '#6b4a1a'],
};

/** Horizontal bands, for the gas giants. */
const PORTRAIT_BANDS = {
  'GAS GIANT': 11,
  'ICE GIANT': 7,
  NEBULA: 0,
};

export { formatDistance };