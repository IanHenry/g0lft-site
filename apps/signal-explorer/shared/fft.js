/* Seeing signals: the FFT, and the analytic signal built on it.
 *
 * Plain JavaScript radix-2, iterative and in place. A 2048 point transform is
 * a few tens of microseconds, which is nothing against a 16ms frame, so
 * reaching for WebAssembly here would be a week spent on a problem that does
 * not exist. If the spectrum ever needs 16384 points at sixty frames a second,
 * measure first.
 *
 * The second half of this file is the more interesting part. Turning a
 * recording into a rotating phasor means computing its analytic signal, and
 * the textbook answer is an FIR Hilbert transformer. That is the wrong tool
 * here. A Hilbert transformer has no useful response near DC, and the width of
 * that dead zone goes as the reciprocal of the filter length: at a 48kHz
 * sample rate a 129 tap filter is deaf below about 600Hz, and the article's
 * speech starts at 300Hz. Reaching 300Hz needs about 600 taps, and 600
 * multiply-accumulates per sample at a quarter of a megasample per second is
 * not going to hold sixty frames a second.
 *
 * A file is loaded once. So do it once, offline, and exactly: transform the
 * whole recording, discard the negative frequencies, transform back. The
 * result is the analytic signal with no approximation anywhere and no cost per
 * sample at all. The playback path then just reads two arrays instead of one.
 */
(function (root) {
  'use strict';

  var FFT = {};

  function isPow2(n) { return n > 0 && (n & (n - 1)) === 0; }
  FFT.isPow2 = isPow2;

  FFT.nextPow2 = function (n) {
    var p = 1;
    while (p < n) p *= 2;
    return p;
  };

  /* In place. re and im are modified. inverse includes the 1/N. */
  FFT.transform = function (re, im, inverse) {
    var n = re.length, i, j, k, m, step, half;
    if (!isPow2(n)) throw new Error('FFT length must be a power of two, got ' + n);

    /* Bit reversal permutation */
    for (i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }

    var sign = inverse ? 1 : -1;
    for (step = 2; step <= n; step *= 2) {
      half = step / 2;
      var ang = sign * 2 * Math.PI / step;
      var wr = Math.cos(ang), wi = Math.sin(ang);
      for (i = 0; i < n; i += step) {
        var cr = 1, ci = 0;
        for (k = 0; k < half; k++) {
          m = i + k;
          var xr = re[m + half] * cr - im[m + half] * ci;
          var xi = re[m + half] * ci + im[m + half] * cr;
          re[m + half] = re[m] - xr;
          im[m + half] = im[m] - xi;
          re[m] += xr;
          im[m] += xi;
          var nr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = nr;
        }
      }
    }

    if (inverse) {
      for (i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
    return re;
  };

  /* ---- The analytic signal ----------------------------------------------
   * Zero the negative frequencies and double what is left, which is the
   * standard construction. The two bins with no partner, DC and Nyquist, are
   * left alone rather than doubled, and getting that wrong puts a constant
   * offset on the result that shows up as the whole constellation sitting off
   * centre.
   *
   * The input is padded to a power of two and the answer truncated back. The
   * transform therefore treats the recording as circular, so the first and
   * last few samples carry a little of each other. For a source that is going
   * to be played on a loop anyway, the join was already there.
   */
  FFT.analytic = function (x) {
    var n0 = x.length, n = FFT.nextPow2(n0), k;
    var re = new Float64Array(n), im = new Float64Array(n);
    for (k = 0; k < n0; k++) re[k] = x[k];

    FFT.transform(re, im, false);

    var half = n / 2;
    for (k = 1; k < half; k++) { re[k] *= 2; im[k] *= 2; }
    for (k = half + 1; k < n; k++) { re[k] = 0; im[k] = 0; }

    FFT.transform(re, im, true);

    var outR = new Float32Array(n0), outI = new Float32Array(n0);
    for (k = 0; k < n0; k++) { outR[k] = re[k]; outI[k] = im[k]; }
    return { re: outR, im: outI };
  };

  /* ---- Window functions -------------------------------------------------
   * Hann by default. A rectangular window on a tone that does not land exactly
   * in a bin smears it across the whole display, which reads as though the
   * signal were far wider than it is.
   */
  FFT.hann = function (n) {
    var w = new Float64Array(n), k;
    for (k = 0; k < n; k++) w[k] = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / (n - 1));
    return w;
  };

  /* ---- The spectrum a plot draws ----------------------------------------
   * Complex input, so the answer is two sided and the negative frequencies are
   * real information rather than a mirror. That is the whole point on this
   * plot: an upper sideband signal sits on one side of centre and a lower
   * sideband signal on the other, and a display that folded them together
   * would destroy the thing the article is about.
   *
   * Output is in dB, shifted so DC is in the middle, running from negative
   * half the sample rate on the left to positive half on the right.
   */
  function Spectrum(size) {
    this.size = size;
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.win = FFT.hann(size);
    this.db = new Float32Array(size);
    var s = 0, k;
    for (k = 0; k < size; k++) s += this.win[k];
    this.winGain = s / size;
  }
  Spectrum.prototype.compute = function (i, q, count, floorDb) {
    var n = this.size, k, src;
    floorDb = floorDb === undefined ? -120 : floorDb;
    /* Take the newest `n` of the samples handed in. */
    var off = Math.max(0, count - n);
    for (k = 0; k < n; k++) {
      src = off + k;
      if (src < count) { this.re[k] = i[src] * this.win[k]; this.im[k] = q[src] * this.win[k]; }
      else { this.re[k] = 0; this.im[k] = 0; }
    }
    FFT.transform(this.re, this.im, false);
    var scale = 1 / (n * this.winGain);
    var half = n / 2;
    for (k = 0; k < n; k++) {
      /* fftshift: bin 0 belongs in the middle. */
      var b = (k + half) % n;
      var mag = Math.sqrt(this.re[b] * this.re[b] + this.im[b] * this.im[b]) * scale;
      var db = 20 * Math.log10(mag + 1e-20);
      this.db[k] = db < floorDb ? floorDb : db;
    }
    return this.db;
  };
  /* Frequency in Hz of output bin k, given a sample rate. */
  Spectrum.prototype.binFreq = function (k, fs) {
    return (k - this.size / 2) * fs / this.size;
  };
  FFT.Spectrum = Spectrum;

  root.SS = root.SS || {};
  root.SS.FFT = FFT;
  if (typeof module !== 'undefined' && module.exports) module.exports = FFT;

})(typeof globalThis !== 'undefined' ? globalThis : this);
