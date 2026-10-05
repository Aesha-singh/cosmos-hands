/**
 * The heads-up display.
 *
 * Owns everything that reports state: what we are looking at, how far away it
 * is, whether tracking is working, the simulated clock, the object navigator,
 * and the toggle chips.
 *
 * Two rules keep this readable rather than a wall of numbers:
 *
 *  1. **Write to the DOM only when the value changes.** `setText` on every
 *     frame causes layout thrash and, more visibly, makes text flicker when a
 *     value is momentarily `NaN` during a flight. Each field caches its last
 *     string and skips the write when identical.
 *  2. **Numbers are formatted for magnitude, not precision.** Switching from
 *     kilometres to astronomical units to light years as you zoom out is what
 *     makes the scale change legible; showing "1.000000e+09 km" instead would
 *     make the scale change invisible.
 *
 * @module ui/hud
 */

import { BRAND, TIME_PRESETS, UX } from '../config.js';
import { GESTURE_LABELS } from '../gestures/gesture-vocabulary.js';
import { $, el, on, setClass, setText, toggle } from '../utils/dom.js';
import { Emitter } from '../utils/dom.js';
import { clamp } from '../utils/math.js';

const AU_KM = 149_597_870.7;
const LY_KM = 9.4607e12;

export class Hud extends Emitter {
  /**
   * @param {Object} opts
   * @param {import('../gestures/hand-tracker.js').HandTracker} opts.tracker
   */
  constructor({ tracker }) {
    super();
    this.tracker = tracker;

    // --- cached element references -----------------------------------------
    this.root = $('#hud');
    this.sceneIndex = $('#scene-index');
    this.focusName = $('#focus-name');
    this.focusSub = $('#focus-sub');
    this.roDistance = $('#ro-distance');
    this.roScale = $('#ro-scale');

    this.trackDot = $('#track-dot');
    this.trackLabel = $('#track-label');
    this.gestureEmoji = $('#gesture-emoji');
    this.gestureName = $('#gesture-name');

    this.simDate = $('#sim-date');
    this.simRate = $('#sim-rate');
    this.timeTicks = $('#time-ticks');
    this.rail = $('#rail');

    this.perfWarning = $('#perf-warning');
    this.perfText = $('#perf-warning-text');

    this.tooltip = $('#tooltip');
    this.cursor = $('#cursor');

    // Last written values, to avoid pointless DOM writes.
    this._cache = new Map();
    /** @type {Array<{ id: string, label: string, type: string }>} */
    this.railItems = [];
    /** @type {HTMLElement|null} */
    this._activeRail = null;
    /** Current time-rate index into TIME_PRESETS. */
    this.rateIndex = UX.defaultRateIndex ?? 5;

    /** Toggle chip state, mirrored to `aria-pressed`. */
    this.toggles = {
      cam: true, mute: false, labels: true, orbits: true, debug: false,
    };

    this._buildTimeTicks();
    this._bindChips();
    this._bindTimeControls();
    this._bindSceneSwitcher();
  }

  /* ------------------------------------------------------------- utilities -- */

  /**
   * Write text only if it changed.
   * @param {Element|null} node
   * @param {string} value
   * @param {string} key
   */
  _write(node, value, key) {
    if (!node) return;
    if (this._cache.get(key) === value) return;
    this._cache.set(key, value);
    setText(node, value);
  }

  /* ------------------------------------------------------------ construction -- */

  _buildTimeTicks() {
    if (!this.timeTicks) return;
    this.timeTicks.innerHTML = '';
    this.tickNodes = TIME_PRESETS.map((preset, i) => {
      const tick = el('button', {
        class: 'ticks__tick',
        type: 'button',
        title: preset.label,
        'aria-label': `Set time rate to ${preset.label}`,
      });
      tick.addEventListener('click', () => this.setRateIndex(i));
      this.timeTicks.appendChild(tick);
      return tick;
    });
    this._paintTicks();
  }

  _paintTicks() {
    if (!this.tickNodes) return;
    this.tickNodes.forEach((node, i) => {
      setClass(node, 'is-active', i === this.rateIndex);
      setClass(node, 'is-passed', i < this.rateIndex);
    });
  }

  _bindChips() {
    this.root?.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-toggle]');
      if (!chip) return;
      const key = chip.dataset.toggle;
      if (key === 'debug') {
        // Debug is a panel, not a boolean preference.
        this.emit('toggle-debug');
        return;
      }
      this.toggles[key] = !this.toggles[key];
      setClass(chip, 'is-on', this.toggles[key]);
      chip.setAttribute('aria-pressed', String(this.toggles[key]));
      this.emit('toggle', key, this.toggles[key]);
    });

    // Reflect the initial state on the chips.
    this.root?.querySelectorAll('[data-toggle]').forEach((chip) => {
      const key = chip.dataset.toggle;
      if (key in this.toggles) {
        setClass(chip, 'is-on', this.toggles[key]);
        chip.setAttribute('aria-pressed', String(this.toggles[key]));
      }
    });
  }

  _bindTimeControls() {
    on($('#tbtn-slower'), 'click', () => this.stepRate(-1));
    on($('#tbtn-faster'), 'click', () => this.stepRate(1));
    on($('#tbtn-realscale'), 'click', () => this.emit('toggle-realscale'));
  }

  _bindSceneSwitcher() {
    const nav = $('#scene-switcher');
    if (!nav) return;
    nav.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-scene]');
      if (!btn) return;
      this.emit('scene', Number(btn.dataset.scene));
    });
  }

  /* ------------------------------------------------------------------ state -- */

  /** Reveal the HUD. */
  show() {
    toggle(this.root, true, 'is-live');
    this.root.hidden = false;
  }

  /** Hide the HUD entirely. */
  hide() {
    this.root.hidden = true;
  }

  /**
   * Update the scene indicator.
   * @param {number} index Zero-based.
   * @param {number} total
   * @param {string} name
   */
  setScene(index, total, name) {
    this._write(this.sceneIndex, String(index + 1).padStart(2, '0'), 'sceneIndex');
    this._write(this.focusSub, name.toUpperCase(), 'sceneName');
    $('#scene-switcher')?.querySelectorAll('[data-scene]').forEach((btn) => {
      setClass(btn, 'is-active', Number(btn.dataset.scene) === index);
    });
    void total;
  }

  /**
   * Update the focus readout.
   * @param {Object} body
   * @param {string} body.label Display name.
   * @param {string} body.subtitle One-line descriptor.
   * @param {number} body.distanceKm Camera distance in km, or null.
   * @param {number} [body.diameterKm] Body diameter, for the scale readout.
   */
  setFocus({ label, subtitle, distanceKm, diameterKm }) {
    this._write(this.focusName, label.toUpperCase(), 'focusName');
    this._write(this.focusSub, subtitle, 'focusSub');

    this._write(this.roDistance, distanceKm == null ? '—' : formatDistance(distanceKm), 'dist');

    this._write(
      this.roScale,
      diameterKm == null ? '—' : `${formatDistance(diameterKm)} across`,
      'scale',
    );
  }

  /**
   * Per-frame update of the parts that change continuously.
   * @param {Object} state
   */
  update({ gesture, handsVisible, date, rateValue, distanceKm, scaleLabel }) {
    // --- tracking ---------------------------------------------------------
    const label = !handsVisible
      ? 'no hand detected'
      : gesture ? (GESTURE_LABELS[gesture]?.label ?? gesture) : 'tracking';
    this._write(this.trackLabel, label, 'trackLabel');
    setClass(this.trackDot, 'is-live', handsVisible);
    setClass(this.trackDot, 'is-searching', !handsVisible);

    if (gesture) {
      const info = GESTURE_LABELS[gesture];
      this._write(this.gestureEmoji, info?.icon ?? '✋', 'gestureEmoji');
      this._write(this.gestureName, info?.label.toLowerCase() ?? gesture, 'gestureName');
    }

    // --- clock ------------------------------------------------------------
    if (date) this._write(this.simDate, formatDate(date), 'simDate');
    const preset = TIME_PRESETS[this.rateIndex];
    this._write(this.simRate, preset.value === 0 ? 'paused' : preset.label, 'simRate');

    if (distanceKm != null) {
      this._write(this.roDistance, formatDistance(distanceKm), 'dist');
    }
    if (scaleLabel) this._write(this.roScale, scaleLabel, 'scale');
    void rateValue;
  }

  /* --------------------------------------------------------------- the rail -- */

  /**
   * Rebuild the object navigator.
   * @param {Array<{ id: string, label: string, type: string }>} items
   * @param {string} [activeId]
   */
  setRail(items, activeId) {
    if (!this.rail) return;
    this.railItems = items;
    this.rail.innerHTML = '';
    this._activeRail = null;

    for (const item of items) {
      const btn = el('button', {
        class: 'rail__item',
        type: 'button',
        'data-id': item.id,
        'aria-label': `Focus ${item.label}`,
      }, [
        el('i', { class: `rail__dot rail__dot--${item.type}` }),
        el('span', { class: 'rail__label' }, [document.createTextNode(item.label)]),
      ]);
      btn.addEventListener('click', () => this.emit('focus', item.id));
      btn.addEventListener('pointerenter', () => this.showTooltip(item.label, item.type));
      btn.addEventListener('pointerleave', () => this.hideTooltip());
      this.rail.appendChild(btn);
    }
    this.setActiveRail(activeId);
  }

  /** @param {string} id */
  setActiveRail(id) {
    this._activeRail = id;
    this.rail?.querySelectorAll('.rail__item').forEach((node) => {
      setClass(node, 'is-active', node.dataset.id === id);
    });
  }

  /* ---------------------------------------------------------------- tooltip -- */

  /**
   * @param {string} text
   * @param {string} [kind]
   */
  showTooltip(text, kind = '') {
    if (!this.tooltip) return;
    setText(this.tooltip, text);
    this.tooltip.dataset.kind = kind;
    this.tooltip.hidden = false;
  }

  hideTooltip() {
    if (this.tooltip) this.tooltip.hidden = true;
  }

  /**
   * Move the custom cursor. Hidden on touch devices, where a fake cursor is
   * just a laggy finger.
   * @param {number} x CSS px
   * @param {number} y CSS px
   * @param {boolean} visible
   * @param {boolean} pointing
   */
  moveCursor(x, y, visible, pointing = false) {
    if (!this.cursor) return;
    if (this._coarse) return;
    this.cursor.hidden = !visible;
    if (!visible) return;
    this.cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    setClass(this.cursor, 'is-pointing', pointing);
  }

  /** Detect touch-first devices once, so the fake cursor stays out of the way. */
  setCoarsePointer() {
    this._coarse = window.matchMedia('(pointer: coarse)').matches;
  }

  /* ------------------------------------------------------------ perf notice -- */

  /** @param {string} message */
  showPerfWarning(message) {
    if (!this.perfWarning) return;
    setText(this.perfText, message);
    this.perfWarning.hidden = false;
  }

  hidePerfWarning() {
    if (this.perfWarning) this.perfWarning.hidden = true;
  }

  /* ------------------------------------------------------------------ rates -- */

  /** @param {number} index */
  setRateIndex(index) {
    const next = clamp(index, 0, TIME_PRESETS.length - 1);
    if (next === this.rateIndex) return;
    this.rateIndex = next;
    this._paintTicks();
    this.emit('rate', TIME_PRESETS[next].value, TIME_PRESETS[next]);
  }

  /** @param {number} direction -1 or +1 */
  stepRate(direction) {
    this.setRateIndex(this.rateIndex + direction);
  }

  /** @returns {number} Simulated seconds per real second. */
  get rate() {
    return TIME_PRESETS[this.rateIndex].value;
  }

  /** @returns {boolean} */
  get paused() {
    return TIME_PRESETS[this.rateIndex].value === 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Format a distance with a unit chosen by magnitude.
 *
 * @param {number} km
 * @returns {string}
 */
export function formatDistance(km) {
  const a = Math.abs(km);
  if (!Number.isFinite(a)) return '—';
  if (a === 0) return '0 km';
  if (a < 1e-3) return `${(km * 1e6).toFixed(0)} mm`;
  if (a < 1) return `${km.toFixed(2)} km`;
  if (a < 1000) return `${km.toFixed(0)} km`;
  if (a < 0.01 * AU_KM) return `${(km / 1000).toFixed(1)}k km`;
  if (a < 100 * AU_KM) return `${(km / AU_KM).toFixed(a < AU_KM ? 3 : 2)} AU`;
  // Thousands of AU read better grouped than in scientific notation.
  if (a < 1e6 * AU_KM) return `${Math.round(km / AU_KM).toLocaleString('en-US')} AU`;
  if (a < 0.1 * LY_KM) return `${(km / AU_KM).toExponential(1)} AU`;
  if (a < 1e6 * LY_KM) return `${(km / LY_KM).toFixed(a < LY_KM ? 3 : 2)} ly`;
  return `${(km / LY_KM).toExponential(1)} ly`;
}

/**
 * Format a duration in the largest sensible unit.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  const a = Math.abs(seconds);
  if (!Number.isFinite(a) || a === 0) return '0 s';
  if (a < 60) return `${seconds.toFixed(1)} s`;
  if (a < 3600) return `${(seconds / 60).toFixed(1)} min`;
  if (a < 86400) return `${(seconds / 3600).toFixed(1)} h`;
  if (a < 31557600) return `${(seconds / 86400).toFixed(1)} d`;
  if (a < 31557600 * 1000) return `${(seconds / 31557600).toFixed(2)} yr`;
  return `${(seconds / 31557600).toExponential(1)} yr`;
}

/**
 * Format a simulation date as an ISO-like UTC string.
 * @param {Date} date
 * @returns {string}
 */
export function formatDate(date) {
  const y = date.getUTCFullYear();
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const m = months[date.getUTCMonth()];
  const d = String(date.getUTCDate()).padStart(2, '0');
  if (y > 0) return `${d} ${m} ${y}`;
  // Before the common era, count down rather than printing a negative year.
  return `${d} ${m} ${1 - y} BCE`;
}

export { BRAND };
