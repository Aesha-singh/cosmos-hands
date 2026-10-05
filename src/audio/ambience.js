/**
 * Procedural Web Audio ambience.
 *
 * No audio files: every sound is synthesised from oscillators and generated
 * noise buffers. That keeps the bundle small and, more usefully, makes the
 * ambience *continuous* — the drone's filter cutoff follows the camera's
 * altitude, so flying toward the Sun audibly brightens the sound. A looped MP3
 * could not do that.
 *
 * The graph:
 *
 * ```
 *   osc (root)  ──┐
 *   osc (root/2) ├── droneGain ──┐
 *   noise → LP ───┘               │
 *                                   ├── master ── compressor ── destination
 *   blips / whoosh ── fxGain ──────┤
 *                                   │
 *   reverbSend ── convolver ── wet ─┘
 * ```
 *
 * Autoplay policy: an AudioContext starts suspended until a user gesture, so
 * nothing is constructed until `resume()` is called from a real click. Calling
 * `new AudioContext()` before that logs a warning and wastes a context.
 *
 * @module audio/ambience
 */

import { AUDIO } from '../config.js';
import { clamp, clamp01 } from '../utils/math.js';
import { Emitter } from '../utils/dom.js';

export class Ambience extends Emitter {
  constructor() {
    super();
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    /** Set false by `pause()` when the tab is hidden. */
    this._wantRunning = true;

    /** Filter cutoff, Hz — driven by altitude. */
    this._cutoff = 320;
    this._targetCutoff = 320;
    /** Master level, driven by proximity to a star. */
    this._targetGain = AUDIO.masterGain;

    this._nodes = {};
  }

  /**
   * Build the graph. Must be called from a user gesture.
   * @returns {Promise<boolean>} true if audio started
   */
  async start() {
    if (this.ready) {
      await this.resume();
      return true;
    }

    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctor) {
      this.emit('unsupported');
      return false;
    }

    try {
      this.ctx = new Ctor({ latencyHint: 'playback' });
    } catch (err) {
      this.emit('error', err);
      return false;
    }

    const ctx = this.ctx;
    await this.resume();

    // --- master chain -----------------------------------------------------
    const master = ctx.createGain();
    master.gain.value = 0;

    // A gentle compressor keeps the drone from swamping the blips when both
    // play, without the pumping a limiter would introduce.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -22;
    comp.knee.value = 26;
    comp.ratio.value = 3.4;
    comp.attack.value = 0.02;
    comp.release.value = 0.4;

    master.connect(comp);
    comp.connect(ctx.destination);

    // --- reverb -----------------------------------------------------------
    const reverb = ctx.createConvolver();
    reverb.buffer = this._impulse(ctx, AUDIO.reverb.seconds, AUDIO.reverb.decay);
    const wet = ctx.createGain();
    wet.gain.value = AUDIO.reverb.wet;
    const send = ctx.createGain();
    send.gain.value = 1;
    send.connect(reverb);
    reverb.connect(wet);
    wet.connect(master);

    // --- drone ------------------------------------------------------------
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = this._cutoff;
    lp.Q.value = 0.9;

    const oscA = ctx.createOscillator();
    oscA.type = 'sawtooth';
    oscA.frequency.value = AUDIO.droneRoot;
    const gA = ctx.createGain();
    gA.gain.value = AUDIO.droneGains.osc;

    const oscB = ctx.createOscillator();
    oscB.type = 'sine';
    oscB.frequency.value = AUDIO.droneRoot * 0.5;
    const gB = ctx.createGain();
    gB.gain.value = AUDIO.droneGains.sub;

    // Filtered noise supplies the "air" that pure oscillators lack.
    const noise = ctx.createBufferSource();
    noise.buffer = this._noise(ctx, 4);
    noise.loop = true;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = this._cutoff * 2.4;
    noiseFilter.Q.value = 0.6;
    const gN = ctx.createGain();
    gN.gain.value = AUDIO.droneGains.noise;

    for (const [src, gain] of [[oscA, gA], [oscB, gB], [noise, gN]]) {
      src.connect(gain);
      gain.connect(lp);
    }
    lp.connect(droneGain);
    droneGain.connect(master);
    droneGain.connect(send);

    // --- slow modulation ---------------------------------------------------
    // Three LFOs at mutually irrational rates. If any two had a whole-number
    // ratio, the composite would repeat audibly every few seconds and sound
    // like a loop; at these rates the pattern never repeats perceptibly.
    const lfoFilter = ctx.createOscillator();
    lfoFilter.frequency.value = AUDIO.lfo.filter;
    const lfoFilterAmt = ctx.createGain();
    lfoFilterAmt.gain.value = this._cutoff * 0.22;
    lfoFilter.connect(lfoFilterAmt);
    lfoFilterAmt.connect(lp.frequency);

    const lfoGain = ctx.createOscillator();
    lfoGain.frequency.value = AUDIO.lfo.gain;
    const lfoGainAmt = ctx.createGain();
    lfoGainAmt.gain.value = 0.012;
    lfoGain.connect(lfoGainAmt);
    lfoGainAmt.connect(droneGain.gain);

    const lfoDetune = ctx.createOscillator();
    lfoDetune.frequency.value = AUDIO.lfo.detune;
    const lfoDetuneAmt = ctx.createGain();
    lfoDetuneAmt.gain.value = 7;
    lfoDetune.connect(lfoDetuneAmt);
    lfoDetuneAmt.connect(oscA.detune);

    const t0 = ctx.currentTime;
    for (const node of [oscA, oscB, noise, lfoFilter, lfoGain, lfoDetune]) node.start(t0);

    // --- fx bus for discrete sounds ---------------------------------------
    const fxGain = ctx.createGain();
    fxGain.gain.value = 1;
    fxGain.connect(master);
    fxGain.connect(send);

    this._nodes = {
      master, comp, reverb, wet, send, lp, droneGain, fxGain,
      oscA, oscB, noise, noiseFilter, lfoFilter,
    };

    this.ready = true;
    master.gain.linearRampToValueAtTime(
      this.muted ? 0 : AUDIO.masterGain,
      t0 + AUDIO.fadeIn,
    );
    this.emit('ready');
    return true;
  }

  /**
   * Synthesise a decaying-noise impulse response for the convolver.
   * @param {AudioContext} ctx
   * @param {number} seconds
   * @param {number} decay
   * @returns {AudioBuffer}
   */
  _impulse(ctx, seconds, decay) {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * seconds));
    const buffer = ctx.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        // Exponential decay with a short pre-delay of silence, which reads as
        // "large hall" rather than "small room".
        const t = i / length;
        const env = Math.pow(1 - t, decay);
        data[i] = (Math.random() * 2 - 1) * env * (i < rate * 0.01 ? i / (rate * 0.01) : 1);
      }
    }
    return buffer;
  }

  /**
   * @param {AudioContext} ctx
   * @param {number} seconds
   * @returns {AudioBuffer}
   */
  _noise(ctx, seconds) {
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * seconds);
    const buffer = ctx.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  /* ------------------------------------------------------------ continuous -- */

  /**
   * Per-frame update. `altitude` is 0 at a star and 1 when far from everything.
   * @param {Object} [state]
   * @param {number} [state.altitude]
   * @param {number} [state.speed] Camera speed, for a subtle Doppler-ish lift.
   * @param {number} [state.warp] 0..1 warp-drive intensity.
   */
  update({ altitude = 0.5, speed = 0, warp = 0 } = {}) {
    if (!this.ready || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Closer to a star: brighter and louder. Far out: dark and quiet.
    const proximity = 1 - clamp01(altitude);
    const target = 220 + proximity * 2100 + warp * 2600 + Math.min(speed, 4) * 130;
    // Ramp rather than set: jumping the cutoff audibly clicks.
    this._cutoff += (target - this._cutoff) * 0.04;
    this._nodes.lp.frequency.setTargetAtTime(this._cutoff, now, 0.08);
    this._nodes.noiseFilter.frequency.setTargetAtTime(this._cutoff * 2.4, now, 0.12);
    this._nodes.oscA.frequency.setTargetAtTime(
      AUDIO.droneRoot * (1 + warp * 0.5),
      now,
      0.2,
    );
  }

  /* --------------------------------------------------------------- one-shots -- */

  /**
   * Short UI blip.
   * @param {Object} [opts]
   * @param {number} [opts.freq] Hz.
   * @param {number} [opts.peak] Gain.
   * @param {number} [opts.decay] Seconds.
   * @param {OscillatorType} [opts.type]
   */
  blip({ freq = 660, peak = AUDIO.blip.peak, decay = AUDIO.blip.decay, type = 'triangle' } = {}) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + AUDIO.blip.attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    osc.connect(gain);
    gain.connect(this._nodes.fxGain);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  }

  /**
   * Filtered-noise whoosh for scene transitions.
   * @param {Object} [opts]
   * @param {number} [opts.peak]
   * @param {number} [opts.duration]
   */
  whoosh({ peak = AUDIO.whoosh.peak, duration = AUDIO.whoosh.duration } = {}) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this._noise(ctx, duration + 0.2);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    // Sweep the band upward: reads as acceleration.
    bp.frequency.setValueAtTime(220, t);
    bp.frequency.exponentialRampToValueAtTime(2600, t + duration * 0.8);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + duration * 0.35);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    src.connect(bp);
    bp.connect(gain);
    gain.connect(this._nodes.fxGain);
    src.start(t);
    src.stop(t + duration + 0.2);
  }

  /**
   * Sonify a body: pitch from its orbital period, level from distance.
   *
   * The mapping is musical rather than literal — pitch tracks log orbital
   * period, so the inner planets are high and the outer ones low, which is
   * both accurate in ordering and pleasant to hear.
   *
   * @param {Object} opts
   * @param {number} opts.periodDays
   * @param {number} [opts.proximity] 0 far, 1 near.
   */
  sonify({ periodDays, proximity = 1 }) {
    if (!this.ready || this.muted || !Number.isFinite(periodDays)) return;
    const semitones = clamp(
      Math.log10(Math.max(periodDays, 0.5) / 88) / Math.log10(60000 / 88) * AUDIO.sonify.rangeSemitones,
      0,
      AUDIO.sonify.rangeSemitones,
    );
    const freq = AUDIO.sonify.baseFreq * (2 ** (semitones / 12));
    this.blip({
      freq,
      peak: AUDIO.sonify.gain * clamp01(proximity) * 2,
      decay: 0.55,
      type: 'sine',
    });
  }

  /* ------------------------------------------------------------------ state -- */

  async resume() {
    if (this.ctx?.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch { /* the next gesture will try again */ }
    }
    this._wantRunning = true;
  }

  async pause() {
    this._wantRunning = false;
    if (this.ctx?.state === 'running') {
      try {
        await this.ctx.suspend();
      } catch { /* ignore */ }
    }
  }

  /** @param {boolean} [value] Toggle if omitted. */
  setMuted(value) {
    this.muted = value ?? !this.muted;
    if (!this.ready) return this.muted;
    const now = this.ctx.currentTime;
    this._nodes.master.gain.cancelScheduledValues(now);
    this._nodes.master.gain.setTargetAtTime(
      this.muted ? 0 : AUDIO.masterGain,
      now,
      0.15,
    );
    this.emit('mute', this.muted);
    return this.muted;
  }

  toggleMute() { return this.setMuted(); }

  /** @returns {boolean} */
  get isPlaying() { return Boolean(this.ctx && this.ctx.state === 'running' && !this.muted); }

  /** Tear down the whole graph. */
  dispose() {
    if (!this.ctx) return;
    const nodes = this._nodes;
    for (const node of Object.values(nodes)) {
      if (node?.stop) { try { node.stop(); } catch { /* already stopped */ } }
      if (node?.disconnect) { try { node.disconnect(); } catch { /* ignore */ } }
    }
    this.ctx.close().catch(() => {});
    this.ctx = null;
    this.ready = false;
  }
}

const attack = (decay) => decay + 0.05;