/* Seeing signals: the signal processing core.
 *
 * Pure. No DOM, no canvas, no timers. Everything here runs unchanged under
 * Node, which is what lets test/ assert the article's claims about each mode
 * rather than trusting a picture. That constraint is the whole reason this
 * file exists separately from the plotting.
 *
 * One buffer, many views. A single generator fills one block of IQ samples per
 * animation frame and every plot renders from that same block. The obvious
 * mistake, and one an earlier prototype made, is letting each plot call the
 * generator itself: the plots then disagree about what the signal is doing,
 * and with a stateful modulator they also advance its phase several times per
 * frame. Nothing in here reads the clock, so the caller decides how far time
 * moves and everything stays in step.
 */
(function (root) {
  'use strict';

  var DSP = {};

  /* ---- Reproducible noise ------------------------------------------------
   * Math.random cannot be seeded, and a test that says "the noise cloud is
   * centred on the origin" needs to be able to run the same noise twice.
   */
  function Rng(seed) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }
  Rng.prototype.next = function () {
    /* xorshift32 */
    var x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;  x >>>= 0;
    this.s = x;
    return x / 4294967296;
  };
  /* Box-Muller, both outputs kept. Throwing one away doubles the cost for no
   * reason, and the pair is exactly what a complex noise sample wants. */
  Rng.prototype.gaussianPair = function (sigma) {
    var u1 = this.next(), u2 = this.next();
    if (u1 < 1e-12) u1 = 1e-12;
    var r = sigma * Math.sqrt(-2 * Math.log(u1));
    var th = 2 * Math.PI * u2;
    return [r * Math.cos(th), r * Math.sin(th)];
  };
  DSP.Rng = Rng;

  /* ---- The block every plot reads --------------------------------------- */
  function Block(n) {
    this.n = n;
    this.i = new Float32Array(n);
    this.q = new Float32Array(n);
    this.audio = new Float32Array(n);   /* the modulating signal, for the waveform view */
    this.fs = 48000;
    this.t0 = 0;                        /* seconds of signal before this block */
  }
  Block.prototype.resize = function (n) {
    if (n === this.n) return this;
    this.n = n;
    this.i = new Float32Array(n);
    this.q = new Float32Array(n);
    this.audio = new Float32Array(n);
    return this;
  };
  DSP.Block = Block;

  /* ---- Raised cosine edge ------------------------------------------------
   * A keyed carrier with square edges splashes across the band and draws a
   * straight radial line on the constellation. Real CW is shaped, which is why
   * the published CW panel is a rounded loop pinched at the origin rather than
   * a dot that teleports. Same shape used for FT8's tone transitions.
   */
  DSP.raisedCosine = function (x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return 0.5 - 0.5 * Math.cos(Math.PI * x);
  };

  /* ---- Root raised cosine pulse ------------------------------------------
   * For the PSK and QAM modes. beta is the roll-off, sps is samples per
   * symbol, span is the length in symbols each side.
   */
  DSP.rrcTaps = function (sps, span, beta) {
    var n = 2 * span * sps + 1, taps = new Float32Array(n), k, t, v, d;
    for (k = 0; k < n; k++) {
      t = (k - (n - 1) / 2) / sps;
      if (Math.abs(t) < 1e-8) {
        v = 1 - beta + 4 * beta / Math.PI;
      } else if (beta > 0 && Math.abs(Math.abs(4 * beta * t) - 1) < 1e-8) {
        v = (beta / Math.SQRT2) * (
          (1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * beta)) +
          (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * beta))
        );
      } else {
        d = Math.PI * t * (1 - 16 * beta * beta * t * t);
        v = (Math.sin(Math.PI * t * (1 - beta)) +
             4 * beta * t * Math.cos(Math.PI * t * (1 + beta))) / d;
      }
      taps[k] = v;
    }
    /* Unit peak rather than unit energy, so the constellation lands on the
     * symbol values the reader is being shown and not on a scaled copy. */
    var peak = 0;
    for (k = 0; k < n; k++) if (Math.abs(taps[k]) > peak) peak = Math.abs(taps[k]);
    if (peak > 0) for (k = 0; k < n; k++) taps[k] /= peak;
    return taps;
  };

  /* ---- The channel -------------------------------------------------------
   * Applied to a filled block, in the order a real receiver would see it:
   * gain, then the tuning error, then the noise the receiver itself adds.
   * Noise last matters. Put it before the gain and turning the gain up cleans
   * the signal, which is the opposite of what a radio does.
   *
   * freqOffset is in Hz and is the article's "tune off, even by a fraction of
   * a Hz, and the point begins to rotate slowly". phase is in radians and is
   * why an AM carrier sits on the I axis rather than anywhere else.
   */
  /* ---- Fading -------------------------------------------------------------
   * The article's airband panel is AM that has been through a real path: "the
   * amplitude still varies, but the phase wanders because the propagation path
   * is constantly changing. It is still recognisably AM but messier."
   *
   * Reproducing that needs a channel that moves. This is the sum of sinusoids
   * construction usually credited to Jakes: several complex components at
   * closely spaced low frequencies with unrelated phases, added together. Their
   * sum drifts in amplitude and phase in a way that looks and behaves like a
   * multipath channel, and it is cheap and repeatable.
   *
   * It is an approximation and is labelled as one on the page. A serious HF
   * channel simulator is the Watterson model, which this is not. What it is
   * good for is showing why the airband panel is a smeared cloud where the
   * broadcast panel is a clean line, which is the article's actual claim.
   */
  function Fading(rate, paths, rng) {
    this.rate = rate === undefined ? 1.2 : rate;    /* Hz, how fast it moves */
    var n = paths || 6, k;
    this.n = n;
    this.f = new Float64Array(n);
    this.p = new Float64Array(n);
    rng = rng || new Rng(4242);
    for (k = 0; k < n; k++) {
      /* Spread the component rates rather than making them equal, so the sum
       * never repeats on a short cycle and the fading does not look periodic. */
      this.f[k] = this.rate * (0.35 + 1.3 * rng.next()) * (rng.next() < 0.5 ? -1 : 1);
      this.p[k] = 2 * Math.PI * rng.next();
    }
  }
  Fading.prototype.step = function (fs) {
    var re = 0, im = 0, k;
    for (k = 0; k < this.n; k++) {
      re += Math.cos(this.p[k]);
      im += Math.sin(this.p[k]);
      this.p[k] += 2 * Math.PI * this.f[k] / fs;
      if (this.p[k] > 2 * Math.PI) this.p[k] -= 2 * Math.PI;
      else if (this.p[k] < 0) this.p[k] += 2 * Math.PI;
    }
    /* Normalise so the mean power is one, which keeps "depth 0" and "depth 1"
     * comparable at the same gain rather than one of them being quieter. */
    var s = 1 / Math.sqrt(this.n);
    this.re = re * s;
    this.im = im * s;
  };
  DSP.Fading = Fading;

  DSP.applyChannel = function (block, ch, rng) {
    var n = block.n, fs = block.fs, k;
    var gain = ch.gain === undefined ? 1 : ch.gain;
    var df = ch.freqOffset || 0;
    var ph0 = ch.phase || 0;
    var sigma = ch.noise || 0;
    var fade = ch.fadeDepth > 0 ? ch.fading : null;
    var i, q, c, s, ang, g, fr, fi;

    for (k = 0; k < n; k++) {
      i = block.i[k] * gain;
      q = block.q[k] * gain;
      if (fade) {
        /* Mix between the direct signal and the faded one, so the control runs
         * from a clean path to a fully fading one rather than switching. */
        fade.step(fs);
        fr = 1 + ch.fadeDepth * (fade.re - 1);
        fi = ch.fadeDepth * fade.im;
        var ni = i * fr - q * fi;
        q = i * fi + q * fr;
        i = ni;
      }
      if (df !== 0 || ph0 !== 0) {
        ang = 2 * Math.PI * df * (block.t0 + k / fs) + ph0;
        c = Math.cos(ang); s = Math.sin(ang);
        block.i[k] = i * c - q * s;
        block.q[k] = i * s + q * c;
      } else {
        block.i[k] = i;
        block.q[k] = q;
      }
      if (sigma > 0) {
        g = rng.gaussianPair(sigma);
        block.i[k] += g[0];
        block.q[k] += g[1];
      }
    }
    return block;
  };

  /* ---- Measurements the tests and the readouts share --------------------- */
  DSP.stats = function (block) {
    var n = block.n, k, i, q, m;
    var sumI = 0, sumQ = 0, sumM = 0, sumM2 = 0, peak = 0;
    for (k = 0; k < n; k++) {
      i = block.i[k]; q = block.q[k];
      m = Math.sqrt(i * i + q * q);
      sumI += i; sumQ += q; sumM += m; sumM2 += m * m;
      if (m > peak) peak = m;
    }
    var meanM = sumM / n;
    return {
      meanI: sumI / n,
      meanQ: sumQ / n,
      meanMag: meanM,
      rms: Math.sqrt(sumM2 / n),
      peak: peak,
      /* How much the radius wanders. The article's test for FM is that this is
       * near zero ("a clean tight ring, very little variation in radius") and
       * for AM that it is not. */
      magSpread: Math.sqrt(Math.max(0, sumM2 / n - meanM * meanM))
    };
  };

  /* Net rotation over the block, in cycles. Positive is anticlockwise, which
   * is the direction a USB tone turns and the sign that separates 5E from 5F.
   * Summed as phase differences rather than measured end to end, so a signal
   * that goes round more than once still reports the truth. */
  DSP.netRotation = function (block) {
    var n = block.n, k, d, prev = null, total = 0, a;
    for (k = 0; k < n; k++) {
      if (block.i[k] === 0 && block.q[k] === 0) { prev = null; continue; }
      a = Math.atan2(block.q[k], block.i[k]);
      if (prev !== null) {
        d = a - prev;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        total += d;
      }
      prev = a;
    }
    return total / (2 * Math.PI);
  };

  root.SS = root.SS || {};
  root.SS.DSP = DSP;
  if (typeof module !== 'undefined' && module.exports) module.exports = DSP;

})(typeof globalThis !== 'undefined' ? globalThis : this);
