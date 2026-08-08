/* Seeing signals: FT8, properly.
 *
 * Lifted from the FT8 Message Explorer in G0LFT's error-correction project,
 * where the modulator is verified by round-tripping through WSJT-X's own
 * decoder: a WAV is written, `jt9 -8` decodes it, and if the message comes back
 * the modulator is right. The Costas array and the Gray map there were confirmed
 * against `ft8code`'s own printout. Same author, same project family, no
 * licence question, and already checked against the reference implementation.
 *
 * What the earlier version here got wrong
 * --------------------------------------
 * It was plain 8-FSK: eight tones, hard steps between them, random symbols. The
 * rate and spacing were right and everything else was not.
 *
 * A real FT8 frame is 79 symbols, not an endless stream. Twenty-one of them are
 * synchronisation, in three groups of seven spread through the frame, and the
 * pattern is a Costas array chosen so its autocorrelation has one sharp peak,
 * which is how a receiver finds a signal it was not told about.
 *
 * And the tone does not step, it slides. FT8 uses Gaussian frequency shaping
 * with BT = 2.0, so the instantaneous frequency is smoothed across three symbol
 * periods and the phase never jumps. That is what keeps the whole transmission
 * inside 50Hz. A modulator that switches abruptly splatters either side, which
 * would be a poor advertisement for a mode whose entire selling point is
 * bandwidth, and it also draws the wrong picture: hard steps give straight
 * radial jumps between eight radii, where the real thing sweeps smoothly.
 */
(function (root) {
  'use strict';

  var DSP = root.SS && root.SS.DSP;
  if (!DSP && typeof require !== 'undefined') DSP = require('./dsp.js');

  var FT8 = {};

  /* The parameters, all of which follow from one another. A symbol lasts
   * 1920 samples at 12000Hz, which is 0.16 seconds, so the rate is 6.25 baud
   * and the tone spacing is the same 6.25Hz. Spacing equal to the symbol rate
   * is what makes the eight tones orthogonal, and eight of them spans 50Hz. */
  FT8.SYMBOL_SECONDS = 0.16;
  FT8.BAUD = 1 / FT8.SYMBOL_SECONDS;          /* 6.25 */
  FT8.TONE_SPACING = 6.25;
  FT8.TONES = 8;
  FT8.TOTAL_SYMBOLS = 79;
  FT8.DATA_SYMBOLS = 58;
  FT8.BT = 2.0;

  /* Confirmed from ft8code's own printout. */
  FT8.COSTAS = [3, 1, 4, 0, 6, 5, 2];
  FT8.GRAY = [0, 1, 3, 2, 5, 6, 4, 7];

  /* Abramowitz and Stegun 7.1.26, plenty for shaping a waveform. */
  function erf(x) {
    var sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    var t = 1 / (1 + 0.3275911 * x);
    var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
      - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return sign * y;
  }

  /* The Gaussian smoothing pulse, as a continuous function of time in symbol
   * units. The frame version tabulates this; here it is evaluated directly,
   * because the engine streams a few samples at a time and tabulating 79
   * symbols at a quarter of a megasample per second would be six megabytes to
   * play twelve seconds of audio. */
  FT8.pulse = function (t) {
    if (t <= -1.5 || t >= 1.5) return 0;
    var c = Math.PI * Math.sqrt(2 / Math.log(2)) * FT8.BT;
    return 0.5 * (erf(c * (t + 0.5)) - erf(c * (t - 0.5)));
  };

  /* A full 79 symbol frame: Costas at the start, middle and end, with the data
   * symbols between. Real data would come from the message, its CRC and the
   * LDPC parity; random data symbols produce an identical looking signal and
   * are honest about carrying no message. */
  FT8.frame = function (dataSymbols, seed) {
    var out = new Int32Array(FT8.TOTAL_SYMBOLS), k, d = 0;
    var rng = new DSP.Rng(seed || 1234);
    function nextData() {
      if (dataSymbols && d < dataSymbols.length) return dataSymbols[d++];
      return Math.floor(rng.next() * FT8.TONES) % FT8.TONES;
    }
    for (k = 0; k < 7; k++) out[k] = FT8.COSTAS[k];
    for (k = 7; k < 36; k++) out[k] = nextData();
    for (k = 36; k < 43; k++) out[k] = FT8.COSTAS[k - 36];
    for (k = 43; k < 72; k++) out[k] = nextData();
    for (k = 72; k < 79; k++) out[k] = FT8.COSTAS[k - 72];
    return out;
  };

  /* ---- One signal, as a streaming modulator ------------------------------
   * `offset` is where tone zero sits relative to the tuned frequency. Real FT8
   * signals land wherever their operator put them in the passband, which is
   * the whole reason the band looks the way it does.
   */
  FT8.Signal = function (opts) {
    opts = opts || {};
    var tones = FT8.frame(opts.data, opts.seed);
    return {
      label: 'FT8',
      tones: tones,
      offset: opts.offset === undefined ? 1000 : opts.offset,
      amplitude: opts.amplitude === undefined ? 1 : opts.amplitude,
      /* Gap between transmissions, so the frame starts and stops as a real one
       * does rather than running forever. FT8 transmits for 12.64 seconds in a
       * 15 second slot. */
      slot: opts.slot === undefined ? 15 : opts.slot,
      phase: 0,
      t: 0,
      env: 0,
      reset: function () { this.phase = 0; this.t = 0; },
      step: function (fs) {
        var sym = this.t / FT8.SYMBOL_SECONDS;
        var f, s, from, to, ramp, duration = FT8.TOTAL_SYMBOLS * FT8.SYMBOL_SECONDS;

        if (this.t >= this.slot) { this.t -= this.slot; sym = 0; }

        if (sym >= FT8.TOTAL_SYMBOLS) {
          /* Between transmissions. */
          this.env = 0;
          this.i = 0; this.q = 0;
          this.t += 1 / fs;
          return;
        }

        /* Only symbols within a symbol and a half contribute to the smoothed
         * frequency, so this is a handful of terms rather than a sum over the
         * whole frame. */
        f = 0;
        from = Math.max(0, Math.floor(sym - 1.5));
        to = Math.min(FT8.TOTAL_SYMBOLS - 1, Math.ceil(sym + 1.5));
        for (s = from; s <= to; s++) f += this.tones[s] * FT8.pulse(sym - s);

        /* Quarter symbol raised cosine ramps at each end of the transmission,
         * so it does not begin or end with a click that spreads across the
         * band. */
        ramp = FT8.SYMBOL_SECONDS / 8;
        if (this.t < ramp) this.env = 0.5 * (1 - Math.cos(Math.PI * this.t / ramp));
        else if (this.t > duration - ramp) {
          this.env = 0.5 * (1 - Math.cos(Math.PI * (duration - this.t) / ramp));
        } else this.env = 1;
        if (this.env < 0) this.env = 0;

        var a = this.amplitude * this.env;
        this.i = a * Math.cos(this.phase);
        this.q = a * Math.sin(this.phase);
        this.phase += 2 * Math.PI * (this.offset + FT8.TONE_SPACING * f) / fs;
        if (this.phase > Math.PI) this.phase -= 2 * Math.PI;
        else if (this.phase < -Math.PI) this.phase += 2 * Math.PI;
        this.t += 1 / fs;
      }
    };
  };

  /* ---- A passband full of them -------------------------------------------
   * The printed panel is not one signal. It is everything inside a 3kHz filter
   * at once, which on a busy band is a dozen or more transmissions at different
   * frequencies and different strengths, all starting together. Their sum is
   * the dense swirl of overlapping loops in the figure, and no single signal
   * can produce it: one signal is a slowly turning circle whose rate steps
   * eight ways.
   *
   * Each signal gets its own start offset within the slot as well, because
   * real stations are not synchronised to better than a fraction of a second.
   */
  FT8.Band = function (opts) {
    opts = opts || {};
    var count = opts.count === undefined ? 12 : opts.count;
    var lo = opts.lo === undefined ? 300 : opts.lo;
    var hi = opts.hi === undefined ? 2700 : opts.hi;
    var rng = new DSP.Rng(opts.seed || 77);
    var sigs = [], k, s;
    for (k = 0; k < count; k++) {
      s = FT8.Signal({
        offset: lo + rng.next() * (hi - lo),
        /* Strengths spread over about 20dB, which is an ordinary evening on
         * 40m: a few locals dominating and a lot of weak ones underneath. */
        amplitude: 0.15 + 0.85 * Math.pow(rng.next(), 2),
        seed: 1000 + k * 7
      });
      s.t = rng.next() * 0.6;          /* not perfectly synchronised */
      sigs.push(s);
    }
    /* Normalise so a dozen signals do not simply sum to something enormous. */
    var norm = 1 / Math.sqrt(count);
    return {
      label: 'FT8, a 3kHz passband',
      signals: sigs,
      carriesAudio: false,
      /* Already where a receiver would put it: the signals sit at their real
       * audio offsets in the passband, so the real part of this is what a
       * loudspeaker plays. No beat note wanted. */
      audioBand: true,
      a: 0,
      reset: function () { for (var j = 0; j < sigs.length; j++) sigs[j].reset(); },
      step: function (src, fs) {
        var i = 0, q = 0, j;
        for (j = 0; j < sigs.length; j++) {
          sigs[j].step(fs);
          i += sigs[j].i;
          q += sigs[j].q;
        }
        this.i = i * norm;
        this.q = q * norm;
      }
    };
  };

  /* The single signal, wrapped so the engine can drive it like any modulator. */
  FT8.Modulator = function (opts) {
    var s = FT8.Signal(opts);
    return {
      label: 'FT8',
      signal: s,
      carriesAudio: false,
      /* Already where a receiver would put it: the signals sit at their real
       * audio offsets in the passband, so the real part of this is what a
       * loudspeaker plays. No beat note wanted. */
      audioBand: true,
      a: 0,
      reset: function () { s.reset(); },
      step: function (src, fs) { s.step(fs); this.i = s.i; this.q = s.q; }
    };
  };

  root.SS = root.SS || {};
  root.SS.FT8 = FT8;
  if (typeof module !== 'undefined' && module.exports) module.exports = FT8;

})(typeof globalThis !== 'undefined' ? globalThis : this);
