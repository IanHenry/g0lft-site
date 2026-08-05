/* Seeing signals: the digital modulators, Figure 6.
 *
 * Where the analogue modes move the point continuously, these place it. A
 * symbol is chosen, the point goes there, and the interesting question becomes
 * what it does on the way, which is the pulse shaping.
 *
 * Every parameter here comes from the loopback generators that produced the
 * printed panels, which were transmit scripts rather than captures, so the
 * transmitted values are known exactly rather than inferred. Two of them are
 * worth knowing before reading the code:
 *
 * **Pulse shaping in the published captures is rectangular.** The generator
 * holds each symbol for ten samples and steps instantly, with no filter of any
 * kind. That is why the printed constellations show tight dots joined by
 * straight radial spokes. A real transmitter does not do this, because an
 * instant step occupies infinite bandwidth, so a root raised cosine is offered
 * alongside and the difference between them is worth looking at: the same
 * symbols, the same points, and a completely different picture between them.
 *
 * **The published captures were phase corrected afterwards in software**, by
 * the Mth-power estimator. Generating at baseband there is no such rotation to
 * remove, so this code produces the constellation already square with the
 * axes. A reader comparing the two is comparing a corrected picture with one
 * that never needed correcting.
 */
(function (root) {
  'use strict';

  var DSP = root.SS && root.SS.DSP;
  if (!DSP && typeof require !== 'undefined') DSP = require('./dsp.js');

  var Dig = {};

  /* ---- Symbol timing, shared by everything below --------------------------
   * Holds the sample clock, pulls a new symbol when one is due, and applies
   * the shaping. Separated out because the difference between BPSK and 64-QAM
   * is only which points exist, and that difference should be the only thing
   * the individual modulators contain.
   */
  function Symbols(opts) {
    this.sps = opts.sps;                    /* samples per symbol */
    this.next = opts.next;                  /* function returning [i, q] */
    this.shaping = opts.shaping || 'rect';
    this.beta = opts.beta === undefined ? 0.35 : opts.beta;
    this.span = opts.span || 6;             /* RRC length, in symbols each side */
    this.reset();
  }
  Symbols.prototype.reset = function () {
    this.k = 0;                             /* samples since the current symbol */
    this.cur = this.next();
    /* History for the shaping filter, newest last. */
    var n = 2 * this.span + 2, j;
    this.hist = [];
    for (j = 0; j < n; j++) this.hist.push([0, 0]);
    this.taps = DSP.rrcTaps(this.sps, this.span, this.beta);
    this.phase = 0;
  };
  Symbols.prototype.step = function () {
    if (this.k >= this.sps) {
      this.k = 0;
      this.hist.shift();
      this.hist.push(this.cur);
      this.cur = this.next();
    }
    var i, q;
    if (this.shaping === 'rrc') {
      /* Sum of shifted pulses. The symbol at history position m sits
       * (m - span) symbols back from the one being emitted, so its pulse is
       * sampled at that offset plus the fraction of a symbol elapsed. */
      i = 0; q = 0;
      var mid = (this.taps.length - 1) / 2, m, off, t;
      for (m = 0; m < this.hist.length; m++) {
        off = (this.hist.length - 1 - m) * this.sps + this.k;
        t = Math.round(mid - off + this.span * this.sps);
        if (t < 0 || t >= this.taps.length) continue;
        i += this.hist[m][0] * this.taps[t];
        q += this.hist[m][1] * this.taps[t];
      }
      /* Include the symbol currently being emitted. */
      t = Math.round(mid + this.k);
      if (t >= 0 && t < this.taps.length) {
        i += this.cur[0] * this.taps[t];
        q += this.cur[1] * this.taps[t];
      }
    } else {
      i = this.cur[0];
      q = this.cur[1];
    }
    this.k++;
    this.i = i;
    this.q = q;
  };

  /* Deterministic symbol picker, so a measurement can be repeated. */
  function picker(seed, n) {
    var rng = new DSP.Rng(seed || 7);
    return function () { return Math.floor(rng.next() * n) % n; };
  }

  /* ---- Phase shift keying (article 6D, 6E, 6F) ---------------------------
   * M points equally spaced round a circle, constant amplitude. The generator
   * that made the printed panels writes QPSK as exp(1j * arange(4) * pi/2), so
   * the points sit on the axes rather than at 45 degrees, and this follows it.
   * Each symbol carries log2(M) bits: one for BPSK, two for QPSK, three for
   * 8PSK, and that is the whole trade the article is about.
   */
  Dig.PSK = function (opts) {
    opts = opts || {};
    var order = opts.order || 4;
    var pick = picker(opts.seed, order);
    var syms = [], k;
    for (k = 0; k < order; k++) {
      syms.push([Math.cos(2 * Math.PI * k / order), Math.sin(2 * Math.PI * k / order)]);
    }
    var s = new Symbols({
      sps: opts.sps || 10,
      shaping: opts.shaping,
      beta: opts.beta,
      next: function () { return syms[pick()]; }
    });
    return {
      label: order + '-PSK',
      order: order,
      bitsPerSymbol: Math.log2(order),
      symbols: s,
      reset: function () { s.reset(); },
      /* Nothing is fed in: the symbols are generated here. Saying so lets
       * the page stop pretending there is an audio input to listen to. */
      carriesAudio: false,
      a: 0,
      step: function () { s.step(); this.i = s.i; this.q = s.q; }
    };
  };

  /* ---- Quadrature amplitude modulation (article 6G, 6H) ------------------
   * Amplitude and phase together, so the points form a grid rather than a
   * ring. The generator builds 16-QAM as (I + jQ)/3 with I and Q each drawn
   * from [-3,-1,1,3], which puts the outermost points at unit distance along
   * each axis, and 64-QAM follows the same pattern over [-7..7] divided by 7.
   *
   * The grid is why the article's trade-off is visible rather than asserted:
   * four bits per symbol instead of two, and the points four times closer
   * together for the same peak power.
   */
  Dig.QAM = function (opts) {
    opts = opts || {};
    var order = opts.order || 16;
    var side = Math.round(Math.sqrt(order));
    if (side * side !== order) throw new Error('QAM order must be a square, got ' + order);
    var levels = [], k;
    for (k = 0; k < side; k++) levels.push(2 * k - (side - 1));
    var norm = side - 1;
    var pick = picker(opts.seed, order);
    var s = new Symbols({
      sps: opts.sps || 10,
      shaping: opts.shaping,
      beta: opts.beta,
      next: function () {
        var v = pick();
        return [levels[v % side] / norm, levels[Math.floor(v / side)] / norm];
      }
    });
    return {
      label: order + '-QAM',
      order: order,
      bitsPerSymbol: Math.log2(order),
      symbols: s,
      reset: function () { s.reset(); },
      /* Nothing is fed in: the symbols are generated here. Saying so lets
       * the page stop pretending there is an audio input to listen to. */
      carriesAudio: false,
      a: 0,
      step: function () { s.step(); this.i = s.i; this.q = s.q; }
    };
  };

  /* ---- Frequency shift keying (article 6B, 6C) ---------------------------
   * Each symbol is a different rotation rate, which is exactly how the article
   * describes it: "the point rotates at one rate for mark and another for
   * space". Amplitude is constant, so it is a circle either way, and what
   * distinguishes the symbols is speed rather than position.
   *
   * Continuous phase. The accumulator carries across symbol boundaries rather
   * than restarting, because a phase discontinuity at every symbol would
   * splash energy across the band and draw a radial jump the real signal does
   * not make. This is what the CP in CPFSK stands for and it is not optional.
   */
  Dig.FSK = function (opts) {
    opts = opts || {};
    var tones = opts.tones || [1000, 1500];
    var baud = opts.baud || 45.45;
    var pick = picker(opts.seed, tones.length);
    var order = tones.length;
    return {
      label: order + '-FSK',
      tones: tones,
      baud: baud,
      order: order,
      bitsPerSymbol: Math.log2(order),
      carriesAudio: false,
      a: 0,
      phase: 0,
      t: 0,
      sym: 0,
      reset: function () { this.phase = 0; this.t = 0; this.sym = pick(); },
      step: function (src, fs) {
        var spb = fs / this.baud;
        if (this.t >= spb) { this.t -= spb; this.sym = pick(); }
        this.i = Math.cos(this.phase);
        this.q = Math.sin(this.phase);
        this.phase += 2 * Math.PI * this.tones[this.sym] / fs;
        if (this.phase > Math.PI) this.phase -= 2 * Math.PI;
        else if (this.phase < -Math.PI) this.phase += 2 * Math.PI;
        this.t++;
      }
    };
  };

  /* RTTY is two tone FSK. 45.45 baud is the classic rate; the shift here is
   * 500Hz because that is what the loopback generator transmitted, not the
   * 170Hz of normal amateur practice. Using the measured value rather than the
   * expected one, and saying so, is the whole discipline of this project. */
  Dig.RTTY = function (opts) {
    opts = opts || {};
    var mark = opts.mark === undefined ? 1000 : opts.mark;
    var shift = opts.shift === undefined ? 500 : opts.shift;
    var m = Dig.FSK({
      tones: [mark, mark + shift],
      baud: opts.baud === undefined ? 45.45 : opts.baud,
      seed: opts.seed
    });
    m.label = 'RTTY';
    m.mark = mark;
    m.shift = shift;
    return m;
  };

  /* ---- On-off keying, which is CW (article 4C, 6A) -----------------------
   * The simplest digital mode there is, and the oldest. Key down puts the
   * point at a fixed amplitude; key up drops it into the noise at the origin.
   * If you are tuned slightly off, the key-down point traces a short arc
   * rather than sitting still, which is the article's description and which
   * the channel's frequency offset produces on its own.
   *
   * The edges are shaped. A hard-keyed carrier splashes clicks either side and
   * would draw a straight radial line across the plot; a real transmitter
   * ramps over a few milliseconds, and that ramp is why the published CW panel
   * is a rounded loop pinched at the origin rather than a dot that teleports.
   * 5ms is a conventional rise time.
   */
  var MORSE = {
    A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.',
    H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.',
    O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-',
    V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
    0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-',
    5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
    '/': '-..-.', '?': '..--..', '.': '.-.-.-', ',': '--..--'
  };
  Dig.morseKey = function (text) {
    /* Returns [on, units] pairs. Standard timing: a dash is three units, the
     * gap inside a character is one, between characters three, between words
     * seven. */
    var out = [], k, ch, code, j;
    text = String(text).toUpperCase();
    for (k = 0; k < text.length; k++) {
      ch = text.charAt(k);
      if (ch === ' ') { out.push([0, 7]); continue; }
      code = MORSE[ch];
      if (!code) continue;
      for (j = 0; j < code.length; j++) {
        out.push([1, code.charAt(j) === '-' ? 3 : 1]);
        out.push([0, 1]);
      }
      out.push([0, 2]);          /* 1 already emitted, so 3 in total */
    }
    return out;
  };

  Dig.CW = function (opts) {
    opts = opts || {};
    var text = opts.text || 'CQ CQ DE G0LFT G0LFT K';
    var wpm = opts.wpm || 20;
    var rise = opts.rise === undefined ? 0.005 : opts.rise;
    var seq = Dig.morseKey(text);
    return {
      label: 'CW',
      text: text,
      wpm: wpm,
      rise: rise,
      carriesAudio: false,
      a: 0,
      idx: 0,
      t: 0,
      env: 0,
      reset: function () { this.idx = 0; this.t = 0; },
      step: function (src, fs) {
        /* PARIS timing: one unit is 1.2 seconds divided by words per minute. */
        var unit = 1.2 / this.wpm;
        var e = seq[this.idx];
        var len = e[1] * unit;
        if (this.t >= len) {
          this.t -= len;
          this.idx = (this.idx + 1) % seq.length;
          e = seq[this.idx];
          len = e[1] * unit;
        }
        var r = Math.min(this.rise, len / 2), env;
        if (!e[0]) env = 0;
        else if (this.t < r) env = DSP.raisedCosine(this.t / r);
        else if (this.t > len - r) env = DSP.raisedCosine((len - this.t) / r);
        else env = 1;
        this.env = env;
        this.i = env;
        this.q = 0;
        this.t += 1 / fs;
      }
    };
  };

  root.SS = root.SS || {};
  root.SS.Dig = Dig;
  if (typeof module !== 'undefined' && module.exports) module.exports = Dig;

})(typeof globalThis !== 'undefined' ? globalThis : this);
