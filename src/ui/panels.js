/**
 * Cheat sheet, diagnostics panel, and keyboard shortcuts.
 *
 * They share a module because they share the same keyboard plumbing, and
 * because all three are "show me the machinery" surfaces.
 *
 * The cheat sheet is not decoration: hand-gesture interfaces are undiscoverable
 * without a reference, and nobody discovers them by fumbling. It is built from
 * the same `GESTURE_LABELS` table the classifier uses, so it can never claim a
 * gesture the recogniser does not actually recognise.
 *
 * Class names come from `styles.css` (`.gcard`, `.drow`) rather than being
 * invented here, so the sheet inherits the design system instead of
 * duplicating it.
 *
 * @module ui/panels
 */

import { GESTURE_LABELS } from '../gestures/gesture-vocabulary.js';
import { UX } from '../config.js';
import { $, el, on, Emitter } from '../utils/dom.js';

/**
 * Two-hand and pointer-fallback entries, appended to the one-hand table.
 *
 * `keys` holds the keyboard equivalent, shown in the footer of each card so the
 * mouse path is never a second-class citizen — a wrist-sore user should be able
 * to do everything without holding their arms up.
 */
const EXTRA_ENTRIES = [
  {
    icon: '🔄', label: 'Two-hand twist', hint: 'Roll the camera. Hands apart or together zoom.',
    keys: 'Two hands · drag with right button',
  },
  {
    icon: '👐', label: 'Two-hand pan', hint: 'Move both hands together to fly across space.',
    keys: 'Two hands · right-drag or shift-drag',
  },
  {
    icon: '🖐', label: 'Both palms', hint: 'Hold both palms open to reset the view.',
    keys: 'Both hands · R',
  },
  {
    icon: '🖱', label: 'Mouse & touch', hint: 'Orbit, zoom and select. Always available, including when the camera is off.',
    keys: 'Drag · scroll · click',
  },
];

export class CheatSheet {
  constructor() {
    this.root = $('#cheatsheet');
    this.grid = $('#sheet-grid');

    this._build();
    on($('#sheet-close'), 'click', () => this.hide());
    // Dismiss on backdrop click — expected of a full-screen modal.
    this.root?.addEventListener('click', (e) => {
      if (e.target === this.root) this.hide();
    });
  }

  _build() {
    if (!this.grid) return;
    this.grid.innerHTML = '';
    const entries = [
      ...Object.values(GESTURE_LABELS).map((info) => ({
        icon: info.icon,
        label: info.label,
        hint: info.hint,
        keys: 'One hand',
      })),
      ...EXTRA_ENTRIES,
    ];

    for (const entry of entries) {
      this.grid.appendChild(el('div', { class: 'gcard' }, [
        el('div', { class: 'gcard__emoji', 'aria-hidden': 'true' }, [document.createTextNode(entry.icon)]),
        el('div', {}, [
          el('div', { class: 'gcard__label' }, [document.createTextNode(entry.label)]),
          el('p', { class: 'gcard__hint' }, [document.createTextNode(entry.hint)]),
          el('div', { class: 'gcard__keys' }, [document.createTextNode(entry.keys)]),
        ]),
      ]));
    }
  }

  /** @returns {boolean} */
  get isOpen() { return Boolean(this.root) && !this.root.hidden; }

  show() {
    if (this.root) this.root.hidden = false;
  }

  hide() {
    if (this.root) this.root.hidden = true;
  }

  toggle() {
    if (this.isOpen) this.hide(); else this.show();
  }
}

/**
 * Live diagnostics.
 *
 * Rows are declared once and only rewritten when the rendered text changes.
 * That matters more than it sounds: this panel updates every frame, and a naive
 * `innerHTML = ...` would reparse the DOM 60 times a second, janking the very
 * render loop it is trying to measure.
 *
 * @module ui/debug-panel
 */
export class DebugPanel {
  constructor() {
    this.root = $('#debug');
    this.body = $('#debug-body');
    /** @type {Map<string, HTMLElement>} */
    this.nodes = new Map();
    this._cache = new Map();

    on($('#debug-close'), 'click', () => this.hide());
  }

  /** @returns {boolean} */
  get isOpen() { return Boolean(this.root) && !this.root.hidden; }

  /**
   * Declare a row so values can arrive later.
   * @param {string} key
   * @param {string} label
   */
  addRow(key, label) {
    if (!this.body || this.nodes.has(key)) return;
    const value = el('span', {}, [document.createTextNode('—')]);
    this.body.appendChild(el('div', { class: 'drow' }, [
      el('span', {}, [document.createTextNode(label)]),
      value,
    ]));
    this.nodes.set(key, value);
    this._cache.set(key, null);
  }

  /**
   * Update a row. Skips the DOM write when the text is unchanged.
   * @param {string} key
   * @param {string|number} value
   */
  set(key, value) {
    const text = String(value);
    if (this._cache.get(key) === text) return;
    this._cache.set(key, text);
    const node = this.nodes.get(key);
    if (node) node.textContent = text;
  }

  /**
   * @param {Record<string, string|number>} values
   */
  setMany(values) {
    for (const [key, value] of Object.entries(values)) this.set(key, value);
  }

  show() {
    if (this.root) this.root.hidden = false;
  }

  hide() {
    if (this.root) this.root.hidden = true;
  }

  toggle() {
    if (this.isOpen) this.hide(); else this.show();
  }
}

/**
 * Global keyboard shortcuts.
 *
 * Bound on `window`, but it yields to text fields and to anything that has
 * already called `preventDefault`, so a future modal can suppress shortcuts
 * without this class knowing about it.
 *
 * @module ui/keys
 */
export class KeyboardShortcuts {
  /** @param {Emitter} emitter */
  constructor(emitter) {
    this.emitter = emitter;
    this._onKey = this._onKey.bind(this);
    window.addEventListener('keydown', this._onKey);
  }

  _onKey(event) {
    // Never steal a chord or a browser shortcut.
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;

    const target = event.target;
    if (target instanceof HTMLElement && (
      target.isContentEditable
      || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
    )) {
      return;
    }

    const keys = UX.keys;
    const key = event.key.toLowerCase();

    for (const [binding, action] of [
      [keys.debug, 'toggle-debug'],
      [keys.cheatsheet, 'toggle-cheatsheet'],
      [keys.help, 'toggle-cheatsheet'],
      [keys.labels, 'toggle-labels'],
      [keys.camera, 'toggle-camera'],
      [keys.reset, 'reset-view'],
      [keys.pause, 'toggle-pause'],
      [keys.mute, 'toggle-mute'],
    ]) {
      if (key === binding) {
        event.preventDefault();
        this.emitter.emit(action);
        return;
      }
    }

    for (let i = 1; i <= 4; i++) {
      if (key === keys[`scene${i}`]) {
        event.preventDefault();
        this.emitter.emit('scene', i - 1);
        return;
      }
    }

    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      this.emitter.emit('body-step', event.key === 'ArrowRight' ? 1 : -1);
      return;
    }

    if (event.key === 'Escape') this.emitter.emit('escape');
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
  }
}