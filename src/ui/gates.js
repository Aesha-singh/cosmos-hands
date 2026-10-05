/**
 * Boot gates: intro, permission, and the fatal error card.
 *
 * The whole point of the intro is to make one promise before anything happens —
 * *nothing about your camera leaves this device* — because a browser that
 * immediately asks for a webcam is the single biggest reason people close a tab.
 * So the button the user is invited to press is the one that explains itself,
 * and the camera is not requested until after that button is clicked.
 *
 * Every failure mode gets a real message with a next action. "Something went
 * wrong" is never acceptable: if the camera was denied we say so and offer the
 * pointer fallback; if WebGL 2 is missing we say that specifically, because
 * that is the one problem no fallback can rescue.
 *
 * @module ui/gates
 */

import { BRAND } from '../config.js';
import { $, on } from '../utils/dom.js';
import { Emitter } from '../utils/dom.js';

/** Reasons the camera may be unavailable, with what we can do about each. */
const CAMERA_FAILURES = {
  NotAllowedError: {
    title: 'Camera access was denied',
    body: 'COSMOS HANDS needs your webcam to read hand landmarks. Nothing is recorded or '
      + 'uploaded — the frames go straight to the model running in this tab. You can grant '
      + 'access again from the icon in your address bar, or explore with the mouse instead.',
    fatal: false,
  },
  NotFoundError: {
    title: 'No camera found',
    body: 'No video input device is available. Connect a webcam and reload, or explore with '
      + 'the mouse and touch controls, which support everything except the gestures.',
    fatal: false,
  },
  NotReadableError: {
    title: 'The camera is already in use',
    body: 'Another application or tab has exclusive access to your camera. Close it and '
      + 'reload — or explore with the mouse and touch controls.',
    fatal: false,
  },
  OverconstrainedError: {
    title: 'The camera cannot provide the requested format',
    body: 'Your webcam cannot supply the resolution COSMOS HANDS asks for. It will try again '
      + 'with relaxed constraints, or you can explore with the mouse and touch controls.',
    fatal: false,
  },
  SecurityError: {
    title: 'The browser blocked the camera',
    body: 'Camera access requires a secure context. Open this page over HTTPS or on '
      + 'localhost, or explore with the mouse and touch controls.',
    fatal: false,
  },
};

export class Gates extends Emitter {
  constructor() {
    super();
    this.intro = $('#intro');
    this.permission = $('#permission');
    this.permissionReason = $('#permission-reason');
    this.fatal = $('#fatal');
    this.fatalTitle = $('#fatal-title');
    this.fatalBody = $('#fatal-body');
    this.fatalTrace = $('#fatal-trace');
    this.loader = $('#loader');
    this.loaderLabel = $('#loader-label');

    on($('#btn-begin-camera'), 'click', () => {
      this.hideIntro();
      this.emit('begin-camera');
    });
    on($('#btn-begin-mouse'), 'click', () => {
      this.hideIntro();
      this.emit('begin-mouse');
    });
    on($('#btn-grant'), 'click', () => this.emit('grant-camera'));
    on($('#btn-skip-camera'), 'click', () => {
      this.hidePermission();
      this.emit('skip-camera');
    });
    on($('#btn-fatal-reload'), 'click', () => window.location.reload());
    on($('#btn-fatal-report'), 'click', () => this._copyDetails());
  }

  /* ---------------------------------------------------------------- loader -- */

  /** @param {string} label */
  setLoader(label) {
    if (this.loaderLabel) this.loaderLabel.textContent = label;
  }

  hideLoader() {
    if (this.loader) {
      this.loader.classList.add('is-done');
      // Wait for the fade before removing it from the layout.
      setTimeout(() => { if (this.loader) this.loader.hidden = true; }, 520);
    }
  }

  /* ----------------------------------------------------------------- intro -- */

  /** Hide the intro and reveal the app chrome. */
  hideIntro() {
    if (!this.intro) return;
    this.intro.classList.add('is-out');
    setTimeout(() => {
      if (this.intro) this.intro.hidden = true;
    }, 900);
    this.emit('intro-dismissed');
  }

  /* ------------------------------------------------------------ permission -- */

  /**
   * Show the pre-prompt card.
   * @param {string} [reason]
   */
  showPermission(reason) {
    if (this.permissionReason && reason) this.permissionReason.textContent = reason;
    if (this.permission) this.permission.hidden = false;
  }

  hidePermission() {
    if (this.permission) this.permission.hidden = true;
  }

  /* ----------------------------------------------------------------- fatal -- */

  /**
   * Show the unrecoverable error card.
   *
   * @param {Object} err
   * @param {string} [err.title]
   * @param {boolean} [err.showTrace]
   */
  showFatal(err, { title, showTrace = false } = {}) {
    const known = CAMERA_FAILURES[err?.name];
    const heading = title ?? known?.title ?? err?.title ?? 'Something went wrong';
    const body = known?.body ?? err?.message ?? String(err ?? 'Unknown error');

    if (this.fatalTitle) this.fatalTitle.textContent = heading;
    if (this.fatalBody) this.fatalBody.textContent = body;

    if (this.fatalTrace) {
      // The trace can contain the page URL and browser details; keep it collapsed
      // behind an explicit action rather than dumping it on screen.
      if (showTrace && err?.stack) {
        this.fatalTrace.textContent = err.stack;
        this.fatalTrace.hidden = false;
      } else {
        this.fatalTrace.hidden = true;
      }
    }

    if (this.fatal) this.fatal.hidden = false;
    this.hideLoader();
    this.emit('fatal', err, heading);
  }

  /**
   * Copy diagnostic details to the clipboard, so a bug report is one click.
   * @private
   */
  async _copyDetails() {
    const report = [
      `${BRAND.name} — error report`,
      `when: ${new Date().toISOString()}`,
      `ua: ${navigator.userAgent}`,
      `screen: ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}dpr`,
      `webgl: ${(() => {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2');
        if (!gl) return 'WebGL2 unavailable';
        const d = gl.getExtension('WEBGL_debug_renderer_info');
        return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      })()}`,
      '',
      this.fatalTitle?.textContent ?? '',
      this.fatalBody?.textContent ?? '',
      '',
      this.fatalTrace?.textContent ?? '',
    ].join('\n');

    const btn = $('#btn-fatal-report');
    try {
      await navigator.clipboard.writeText(report);
      if (btn) btn.textContent = 'Copied ✓';
    } catch {
      // Clipboard access can be denied; fall back to a selectable prompt.
      if (btn) btn.textContent = 'Copy failed — select manually';
      console.info(report);
    }
    setTimeout(() => { if (btn) btn.textContent = 'Copy details'; }, 2600);
  }
}