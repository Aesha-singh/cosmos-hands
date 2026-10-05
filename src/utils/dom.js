/**
 * DOM helpers.
 *
 * Deliberately tiny — COSMOS HANDS has no framework. Just enough sugar to keep
 * the UI modules readable without a virtual DOM in the hot path.
 *
 * @module utils/dom
 */

/**
 * Query a single element.
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {HTMLElement}
 */
export const $ = (selector, root = document) => {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`[dom] missing element: ${selector}`);
  return /** @type {HTMLElement} */ (el);
};

/**
 * Query all matching elements as a typed array.
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {HTMLElement[]}
 */
export const $$ = (selector, root = document) =>
  Array.from(root.querySelectorAll(selector));

/**
 * Create an element with attributes and children in one call.
 *
 * @param {string} tag
 * @param {Object} [attrs] `class`, `text`, `html`, `data-*`, `style` object,
 *   or any HTML attribute. `on*` keys become listeners.
 * @param {(Node|string)[]} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Add an event listener and return a disposer. */
export function on(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/** Show/hide with a class instead of the `hidden` attribute, for CSS transitions. */
export function toggle(el, show, className = 'is-live') {
  el.classList.toggle(className, show);
}

/** Write text only when it changed — avoids needless layout work every frame. */
export function setText(el, value) {
  const s = String(value);
  if (el.textContent !== s) el.textContent = s;
}

/** Toggle a class based on a boolean condition. */
export function setClass(el, className, on) {
  el.classList.toggle(className, !!on);
}

/** requestAnimationFrame-based debounce for resize observers. */
export function onResize(handler, target = window) {
  let raf = 0;
  const run = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(handler);
  };
  target.addEventListener('resize', run, { passive: true });
  return () => target.removeEventListener('resize', run);
}

/** Await the next frame — useful when writing to the DOM mid-transition. */
export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

/** Simple typed event emitter. */
export class Emitter {
  constructor() { /** @type {Map<string, Set<Function>>} */ this._h = new Map(); }
  /** @param {string} type @param {Function} fn @returns {() => void} disposer */
  on(type, fn) {
    if (!this._h.has(type)) this._h.set(type, new Set());
    this._h.get(type).add(fn);
    return () => this.off(type, fn);
  }
  /** @param {string} type @param {Function} fn */
  off(type, fn) { this._h.get(type)?.delete(fn); }
  /** @param {string} type @param {...any} args */
  emit(type, ...args) {
    this._h.get(type)?.forEach((fn) => { try { fn(...args); } catch (e) { console.error(e); } });
  }
  clear() { this._h.clear(); }
}
