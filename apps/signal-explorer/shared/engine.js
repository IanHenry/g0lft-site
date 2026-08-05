/* Seeing signals: one buffer, many views.
 *
 * The engine owns the only generator in the program. Once per animation frame
 * it advances the source and the modulator by a block of samples, applies the
 * channel, and pushes the result into a history ring. Every plot then reads
 * from that history. No plot is allowed to generate anything, which is the
 * single rule that keeps the waveform, the constellation, the spectrum and the
 * waterfall showing the same moment.
 *
 * There is a real tension in the design and it is worth naming rather than
 * hiding. The published figures were recorded at 250kHz with a 3kHz signal in
 * them, an oversampling ratio of about eighty, and they are densities
 * accumulated over 100000 samples. A real signal at its real speed is a blur:
 * a 1kHz tone at that sample rate goes round a thousand times a second. So the
 * tool offers both, and the speed control is the honest way between them.
 *
 *   speed = 1      real time. The constellation is a smear, which is the truth
 *                  about the signal and the reason the published figures are
 *                  density plots rather than photographs of a moving point.
 *   speed small    fewer samples of signal per frame, so the point crawls and
 *                  the article's prose becomes watchable.
 *
 * Slowing down does not change the signal. It changes how much of it passes
 * per frame. Every frequency, deviation and symbol rate stays exactly as
 * specified, which is why a measurement taken at any speed is still valid.
 */
(function (root) {
  'use strict';

  var DSP = root.SS && root.SS.DSP;
  if (!DSP && typeof require !== 'undefined') DSP = require('./dsp.js');

  var HISTORY = 16384;   /* enough for a 4096 point FFT with room to spare */

  function Engine(opts) {
    opts = opts || {};
    this.fs = opts.fs || 48000;
    this.speed = opts.speed === undefined ? 0.02 : opts.speed;
    this.fps = opts.fps || 60;

    this.source = null;
    this.modulator = null;
    this.channel = { gain: 1, noise: 0, freqOffset: 0, phase: 0 };

    this.rng = new DSP.Rng(opts.seed || 12345);
    this.block = new DSP.Block(1024);
    this.block.fs = this.fs;

    /* The history every plot reads. Ring buffer, so a frame costs a copy of
     * the new samples rather than a shuffle of everything. */
    this.hist = { i: new Float32Array(HISTORY), q: new Float32Array(HISTORY),
                  a: new Float32Array(HISTORY), n: HISTORY, w: 0, filled: 0 };

    this.samplesGenerated = 0;
    this.signalTime = 0;         /* seconds of signal that have passed */
  }

  Engine.HISTORY = HISTORY;

  Engine.prototype.setFs = function (fs) {
    this.fs = fs;
    this.block.fs = fs;
    return this;
  };

  Engine.prototype.setSource = function (src) {
    this.source = src;
    if (src && src.reset) src.reset();
    return this;
  };

  Engine.prototype.setModulator = function (mod) {
    this.modulator = mod;
    if (mod && mod.reset) mod.reset();
    return this;
  };

  /* Clear the history without disturbing the generator. Used when the mode
   * changes, so the old mode's trace does not hang around on the new one's
   * plot pretending to be part of it. */
  Engine.prototype.clearHistory = function () {
    this.hist.i.fill(0);
    this.hist.q.fill(0);
    this.hist.a.fill(0);
    this.hist.w = 0;
    this.hist.filled = 0;
    return this;
  };

  Engine.prototype.blockSize = function () {
    var n = Math.round(this.fs * this.speed / this.fps);
    if (n < 4) n = 4;
    if (n > 8192) n = 8192;
    return n;
  };

  /* Generate one frame. The only place in the program where the signal
   * advances, and it advances exactly once per call. */
  Engine.prototype.step = function (n) {
    if (n === undefined) n = this.blockSize();
    var b = this.block;
    if (b.n !== n) b.resize(n);
    b.fs = this.fs;
    b.t0 = this.signalTime;

    var src = this.source, mod = this.modulator, fs = this.fs, k;
    for (k = 0; k < n; k++) {
      src.step(fs);
      mod.step(src, fs);
      b.i[k] = mod.i;
      b.q[k] = mod.q;
      /* A modulator may override what counts as the audio going in: a keyed
       * transmission gates it, and a mode that generates its own symbols does
       * not use it at all. */
      b.audio[k] = (mod.a === undefined) ? src.a : mod.a;
    }

    DSP.applyChannel(b, this.channel, this.rng);

    var h = this.hist, w = h.w;
    for (k = 0; k < n; k++) {
      h.i[w] = b.i[k];
      h.q[w] = b.q[k];
      h.a[w] = b.audio[k];
      w = (w + 1) % h.n;
    }
    h.w = w;
    h.filled = Math.min(h.n, h.filled + n);

    this.samplesGenerated += n;
    this.signalTime += n / fs;
    return b;
  };

  /* Read the most recent `count` samples in time order into the arrays given.
   * Plots use this rather than indexing the ring themselves, because getting
   * the wrap wrong shows up as a signal that appears to jump backwards once
   * per revolution of the buffer, which is a genuinely confusing bug to look
   * at.
   */
  Engine.prototype.recent = function (count, outI, outQ) {
    var h = this.hist;
    if (count > h.filled) count = h.filled;
    var start = (h.w - count + h.n) % h.n, k, idx;
    for (k = 0; k < count; k++) {
      idx = start + k;
      if (idx >= h.n) idx -= h.n;
      outI[k] = h.i[idx];
      outQ[k] = h.q[idx];
    }
    return count;
  };

  Engine.prototype.recentAudio = function (count, out) {
    var h = this.hist;
    if (count > h.filled) count = h.filled;
    var start = (h.w - count + h.n) % h.n, k, idx;
    for (k = 0; k < count; k++) {
      idx = start + k;
      if (idx >= h.n) idx -= h.n;
      out[k] = h.a[idx];
    }
    return count;
  };

  root.SS = root.SS || {};
  root.SS.Engine = Engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;

})(typeof globalThis !== 'undefined' ? globalThis : this);
