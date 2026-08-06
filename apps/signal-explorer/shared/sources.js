/* Seeing signals: the modulating signal.
 *
 * Every source produces two numbers per step: .a, the real audio a listener
 * would hear, and .aq, its quadrature partner. Carrying both is what makes SSB
 * exact rather than approximate. A tone's quadrature partner is sin to its
 * cos, known in closed form, so nothing is lost. Only a recording has to have
 * one computed, and it is done once when the file loads rather than per
 * sample, so only that source pays for it.
 *
 * Sources are stateful and continuous. They are stepped once per sample by the
 * engine and never restarted between frames, so a tone that ends a frame part
 * way through a cycle starts the next frame in the same place. Restarting
 * would put a discontinuity at every frame boundary, sixty times a second,
 * which shows on the constellation as a spurious radial streak.
 */
(function (root) {
  'use strict';

  var DSP = root.SS && root.SS.DSP;
  if (!DSP && typeof require !== 'undefined') DSP = require('./dsp.js');
  var FFT = root.SS && root.SS.FFT;
  if (!FFT && typeof require !== 'undefined') FFT = require('./fft.js');

  var Sources = {};

  /* ---- Silence, for the noise-only panel (article 4A) -------------------- */
  function Silence() { this.a = 0; this.aq = 0; }
  Silence.prototype.step = function () { this.a = 0; this.aq = 0; };
  Silence.prototype.reset = function () {};
  Sources.Silence = Silence;

  /* ---- A single tone ----------------------------------------------------- */
  function Tone(freq) {
    this.freq = freq === undefined ? 1000 : freq;
    this.phase = 0;
  }
  Tone.prototype.reset = function () { this.phase = 0; };
  Tone.prototype.step = function (fs) {
    this.a = Math.cos(this.phase);
    this.aq = Math.sin(this.phase);
    this.phase += 2 * Math.PI * this.freq / fs;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
  };
  Sources.Tone = Tone;

  /* ---- Two tones ---------------------------------------------------------
   * Two equal tones, which on SSB is the standard test signal for transmitter
   * linearity. 700Hz and 1900Hz are the usual pair: both well inside the
   * passband, and their difference and sum fall clear of each other so
   * intermodulation products are easy to identify.
   *
   * On the constellation the sum of two phasors is
   *
   *     e^{jw1 t} + e^{jw2 t} = 2 cos((w2-w1)t/2) . e^{j(w1+w2)t/2}
   *
   * which is a phasor turning at the mean frequency whose radius beats at half
   * the difference. Equal amplitudes make the radius reach zero, which is why
   * the trace passes through the origin. The shape of the closed figure comes
   * out of both rates together and is not worth reducing to a one line rule
   * here; the two frequencies are controls, so it can be looked at directly.
   *
   * An earlier version defaulted these to 300 and 2700 because that ratio
   * reproduces the rosette in the printed figure. That was backwards. The job
   * is to model two tones correctly and let the picture follow, not to pick
   * numbers that make a particular picture.
   */
  function TwoTone(f1, f2, ratio) {
    this.f1 = f1 === undefined ? 700 : f1;
    this.f2 = f2 === undefined ? 1900 : f2;
    this.ratio = ratio === undefined ? 1 : ratio;   /* amplitude of the second */
    this.p1 = 0; this.p2 = 0;
  }
  TwoTone.prototype.reset = function () { this.p1 = 0; this.p2 = 0; };
  TwoTone.prototype.step = function (fs) {
    var g = 1 / (1 + this.ratio);
    this.a = g * (Math.cos(this.p1) + this.ratio * Math.cos(this.p2));
    this.aq = g * (Math.sin(this.p1) + this.ratio * Math.sin(this.p2));
    this.p1 += 2 * Math.PI * this.f1 / fs;
    this.p2 += 2 * Math.PI * this.f2 / fs;
    if (this.p1 > 2 * Math.PI) this.p1 -= 2 * Math.PI;
    if (this.p2 > 2 * Math.PI) this.p2 -= 2 * Math.PI;
  };
  Sources.TwoTone = TwoTone;

  /* ---- A swept tone ------------------------------------------------------
   * The clearest possible demonstration that rotation speed is frequency: the
   * point visibly winds up and unwinds while its radius stays put.
   *
   * The amplitude is deliberately constant. An earlier version shaped it like
   * birdsong, which made the circle breathe at the same time as it changed
   * speed, and the two effects fought each other. One thing at a time: this
   * source changes frequency and nothing else. `env` is available for anyone
   * who does want the bird.
   */
  function Chirp(lo, hi, rate, env) {
    this.lo = lo === undefined ? 2000 : lo;
    this.hi = hi === undefined ? 4500 : hi;
    this.rate = rate === undefined ? 3 : rate;   /* sweeps per second */
    this.env = env === undefined ? 0 : env;      /* 0 keeps the radius fixed */
    this.phase = 0;
    this.sweep = 0;
  }
  Chirp.prototype.reset = function () { this.phase = 0; this.sweep = 0; };
  Chirp.prototype.step = function (fs) {
    /* Triangular sweep, so the bird goes up and comes back rather than
     * jumping from the top to the bottom, which would click. */
    var x = this.sweep < 0.5 ? this.sweep * 2 : 2 - this.sweep * 2;
    var f = this.lo + (this.hi - this.lo) * x;
    var env = 1 - this.env + this.env * Math.sin(Math.PI * this.sweep);
    this.a = env * Math.cos(this.phase);
    this.aq = env * Math.sin(this.phase);
    this.phase += 2 * Math.PI * f / fs;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    this.sweep += this.rate / fs;
    if (this.sweep >= 1) this.sweep -= 1;
  };
  Sources.Chirp = Chirp;

  /* ---- Synthetic speech --------------------------------------------------
   * The article is specific about what real voice does on the plot, and every
   * clause of it is a requirement here: content from about 300Hz to 3000Hz,
   * "all present simultaneously", each component "rotating at different
   * speeds", the cloud expanding on vowels and contracting on consonants, and
   * collapsing into the noise during pauses.
   *
   * So this is a bank of partials with a syllabic envelope rather than a tone
   * with tremolo. It is not speech and does not claim to be; it is the
   * spectral and rhythmic behaviour the constellation actually responds to.
   * Seeded, because a test that measures the breathing has to see the same
   * breathing twice.
   */
  /* Note the field name. The bank of partial frequencies is `partialFreq`, not
   * `freq`, because `freq` is the name every single tone source uses and the
   * page treats any source carrying one as a tone with a frequency slider.
   * Calling it `freq` here handed the UI a Float64Array where it expected a
   * number, and every mode built on this source threw part way through
   * switching to it. The symptom was not an error the reader could see: the
   * plots updated and the labels silently stopped. */
  function Speech(seed) {
    this.rng = new DSP.Rng(seed || 20260904);
    this.n = 48;
    this.partialFreq = new Float64Array(this.n);
    this.amp = new Float64Array(this.n);
    this.phase = new Float64Array(this.n);
    var k, f;
    for (k = 0; k < this.n; k++) {
      /* Logarithmic spacing across 300Hz to 3000Hz, jittered so the partials
       * are not harmonically related and the sum never repeats. */
      f = 300 * Math.pow(10, (k / (this.n - 1)) * Math.log10(3000 / 300));
      this.partialFreq[k] = f * (0.94 + 0.12 * this.rng.next());
      this.amp[k] = 1 / Math.sqrt(this.partialFreq[k] / 300);   /* speech tilts down with frequency */
      this.phase[k] = 2 * Math.PI * this.rng.next();
    }
    var norm = 0;
    for (k = 0; k < this.n; k++) norm += this.amp[k];
    for (k = 0; k < this.n; k++) this.amp[k] /= norm;
    this.syll = 0;
    this.rate = 3.6;          /* syllables per second */
    this.state = 0;
    this.brightness = 0;
    this.level = 0;
  }
  Speech.prototype.reset = function () { this.syll = 0; };
  Speech.prototype.step = function (fs) {
    /* Syllable clock. Three kinds of interval in rotation: a loud broad vowel,
     * a quiet narrow consonant, and a pause. */
    var s = this.syll, phaseOfSyll = s - Math.floor(s), idx = Math.floor(s) % 8;
    var vowel = (idx === 0 || idx === 2 || idx === 4);
    var pause = (idx === 7);
    var env, bright;
    /* Every syllable begins and ends at silence, so the envelope is continuous
     * across the boundary. It used to step between 0.25, 0.10 and 0.02 as the
     * syllable type changed, and a step in amplitude is a click: audible on
     * every mode built on this source, several times a second. Real speech
     * closes to nothing between syllables anyway, so the fix is also the more
     * faithful shape. */
    var shape = Math.sin(Math.PI * phaseOfSyll);
    if (pause) {
      env = 0.02 * shape;
      bright = 0.5;
    } else if (vowel) {
      env = 1.0 * shape;
      bright = 0.25;                       /* energy low in the band */
    } else {
      env = 0.28 * shape;
      bright = 0.85;                       /* consonants sit high and quiet */
    }
    this.level = env;
    this.brightness = bright;

    var re = 0, im = 0, k, w, x;
    for (k = 0; k < this.n; k++) {
      /* Weight the bank towards the low or the high end depending on whether
       * this is a vowel or a consonant. Same partials, different balance,
       * which is what makes the cloud change size rather than change shape. */
      x = k / (this.n - 1);
      w = Math.exp(-Math.pow((x - bright) / 0.42, 2));
      re += this.amp[k] * w * Math.cos(this.phase[k]);
      im += this.amp[k] * w * Math.sin(this.phase[k]);
      this.phase[k] += 2 * Math.PI * this.partialFreq[k] / fs;
      if (this.phase[k] > 2 * Math.PI) this.phase[k] -= 2 * Math.PI;
    }
    /* The bank sums to well under one because forty-eight partials at
     * unrelated phases mostly cancel: its rms including the envelope measures
     * 0.075, so unity rms would want a scale of about 13. That is the wrong
     * target. Speech has a high peak to mean ratio and the plot wants the loud
     * passages to fill the frame while the quiet ones stay small, so the scale
     * is set from the peaks instead, and the constraint is that a modulating
     * signal must stay inside plus and minus one. At 6 it peaked at 1.66, which
     * silently overmodulated every AM preset built on it: the envelope went
     * negative and the point crossed the origin. 3.5 keeps the peak at unity.
     * test/modes.js pins the loud and quiet ends. */
    this.a = env * re * 3.5;
    this.aq = env * im * 3.5;
    this.syll += this.rate / fs;
  };
  Speech.prototype.label = 'Voice-like, not speech';
  Sources.Speech = Speech;


  /* ---- Music -------------------------------------------------------------
   * A plucked note, repeated up a scale. Music is worth having beside speech
   * because it behaves differently on the plot: speech is noisy and broadband
   * and its cloud breathes irregularly, while a note is a fundamental with
   * harmonics at exact integer multiples, so its SSB trace closes into a
   * repeating figure the way the two tone rosette does. The difference between
   * the two is audible and visible at the same time, which is the whole point
   * of the tool.
   *
   * Harmonic amplitudes fall as 1/n and the envelope decays, which is roughly
   * how a plucked string behaves. It is not a synthesiser and does not claim
   * to be.
   */
  function Music(opts) {
    opts = opts || {};
    /* A pentatonic run, so any two notes sounding together are consonant and
     * the result is listenable rather than a test signal. */
    this.notes = opts.notes || [220, 247.5, 293.3, 330, 391.1, 440];
    this.harmonics = opts.harmonics || 6;
    this.rate = opts.rate === undefined ? 2.2 : opts.rate;   /* notes per second */
    this.phase = new Float64Array(this.harmonics);
    this.n = 0;
    this.t = 0;
  }
  Music.prototype.reset = function () { this.n = 0; this.t = 0; this.phase.fill(0); };
  Music.prototype.step = function (fs) {
    var period = 1 / this.rate;
    if (this.t >= period) {
      this.t -= period;
      this.n = (this.n + 1) % this.notes.length;
      this.phase.fill(0);
    }
    var f0 = this.notes[this.n];
    /* Decay, attack, and a short taper into the note boundary. Without the
     * taper the note is still at four per cent when the next one resets the
     * phases, and that step clicks once per note. */
    var tail = Math.min(1, (period - this.t) / 0.015);
    var env = Math.exp(-3.2 * this.t / period) *
              (1 - Math.exp(-400 * this.t)) * Math.max(0, tail);
    var re = 0, im = 0, k, a, norm = 0;
    for (k = 1; k <= this.harmonics; k++) {
      a = 1 / k;
      norm += a;
      re += a * Math.cos(this.phase[k - 1]);
      im += a * Math.sin(this.phase[k - 1]);
      this.phase[k - 1] += 2 * Math.PI * f0 * k / fs;
      if (this.phase[k - 1] > 2 * Math.PI) this.phase[k - 1] -= 2 * Math.PI;
    }
    this.a = env * re / norm;
    this.aq = env * im / norm;
    this.t += 1 / fs;
  };
  Sources.Music = Music;

  /* ---- A recorded waveform ----------------------------------------------
   * The only source that has to be given its quadrature partner rather than
   * knowing it, because a recording carries no such thing. It is computed once
   * at load time by discarding the negative frequencies, which is exact. See
   * the note in js/fft.js for why the usual per-sample Hilbert filter is the
   * wrong answer here: its dead zone near DC would swallow the bottom of the
   * article's 300Hz to 3000Hz speech band.
   *
   * Resampling is linear. The audio is a modulating signal at a few kHz being
   * carried on a baseband running at tens or hundreds of kHz, so it is grossly
   * oversampled by the time it reaches the plot and the interpolation error
   * lands far below anything visible.
   */
  function Buffer(samples, sampleRate) {
    samples = samples || new Float32Array(1);
    this.sampleRate = sampleRate || 48000;
    var n = samples.length;

    /* Fade both ends to zero before transforming, over about 21ms.
     *
     * The transform treats the recording as circular, so if the last sample
     * does not join up with the first it sees a step, and the leakage from
     * that step lands as an error in the analytic signal near both ends. It is
     * not small and it is not local: measured on a steady tone, it reaches
     * about 2500 samples at 1kHz and 16000 at 120Hz, scaling with the
     * wavelength rather than with the length of the file. A fixed guard band
     * would therefore be a guess.
     *
     * Fading to zero removes the step instead of tolerating it, and takes the
     * worst error across the whole buffer to 6e-5 at 1kHz and 8e-3 at 80Hz,
     * confined to the fade itself where the signal is nearly silent anyway. A
     * fade is also what a looping player wants regardless: without one the
     * join clicks, and a click draws a streak across the constellation once
     * per loop.
     *
     * 1024 samples at 48kHz was measured rather than chosen; 256 leaves 1.5e-2
     * at 300Hz, which is visible as a wobble on what should be a clean circle.
     */
    var fade = Math.min(Math.round(this.sampleRate * 0.021), Math.floor(n / 4));
    var faded = Float32Array.from(samples), k, w;
    for (k = 0; k < fade; k++) {
      w = 0.5 - 0.5 * Math.cos(Math.PI * k / fade);
      faded[k] *= w;
      faded[n - 1 - k] *= w;
    }

    var pair = FFT.analytic(faded);
    this.re = pair.re;
    this.im = pair.im;
    this.length = n;
    this.fade = fade;
    this.pos = 0;
    this.loop = true;
  }
  Buffer.prototype.reset = function () { this.pos = 0; };
  Buffer.prototype.step = function (fs) {
    var p = this.pos, n = this.length;
    var i0 = Math.floor(p), frac = p - i0, i1 = i0 + 1;
    if (i1 >= n) i1 = this.loop ? 0 : n - 1;
    this.a = this.re[i0] * (1 - frac) + this.re[i1] * frac;
    this.aq = this.im[i0] * (1 - frac) + this.im[i1] * frac;
    this.pos += this.sampleRate / fs;
    if (this.pos >= n) this.pos = this.loop ? this.pos - n : n - 1;
  };
  Sources.Buffer = Buffer;

  root.SS = root.SS || {};
  root.SS.Sources = Sources;
  if (typeof module !== 'undefined' && module.exports) module.exports = Sources;

})(typeof globalThis !== 'undefined' ? globalThis : this);
