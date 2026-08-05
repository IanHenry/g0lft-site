/* Seeing signals: getting the audio back out.
 *
 * Every modulator in this project has an inverse, and having both is worth
 * more than having either. A listener can hear what the channel did rather
 * than being told: the hiss that arrives with the noise slider, an SSB voice
 * shifted in pitch by a tuning error, the buzz of an overmodulated AM carrier
 * passing through the origin. None of that is describable as well as it is
 * audible.
 *
 * It also closes the loop. A modulator checked only against a picture can be
 * wrong in ways a picture does not show; a modulator whose output demodulates
 * back to the tone that went in is right, and test/roundtrip.js says so to
 * five decimal places.
 *
 * These are readers, like the plots. They take the block the engine has
 * already generated and produce one real audio sample per IQ sample. Nothing
 * here generates, and nothing here reads the clock.
 */
(function (root) {
  'use strict';

  var Demod = {};

  /* ---- AM: the envelope, with the carrier removed -----------------------
   * A diode detector recovers |z| and then a capacitor blocks the DC that the
   * carrier contributes. Doing exactly that, with a one pole high pass in
   * place of the capacitor, keeps the failure modes honest: overmodulation
   * still produces the harsh distortion it produces in a real receiver,
   * because the envelope of a signal that has passed through the origin comes
   * back rectified rather than reconstructed.
   *
   * A synchronous detector would not distort like that, which is the argument
   * for using one, and is also why this is not one.
   */
  Demod.AM = function (opts) {
    opts = opts || {};
    return {
      label: 'AM envelope detector',
      dc: 0,
      alpha: opts.alpha === undefined ? 0.9995 : opts.alpha,
      reset: function () { this.dc = 0; },
      step: function (i, q) {
        var env = Math.sqrt(i * i + q * q);
        this.dc = this.alpha * this.dc + (1 - this.alpha) * env;
        return env - this.dc;
      }
    };
  };

  /* ---- FM: the rate of change of phase ----------------------------------
   * The discriminator. arg(z[n] . conj(z[n-1])) is the phase advanced in one
   * sample, which is the instantaneous frequency, which is the audio. Scaling
   * by fs/(2.pi.deviation) puts a full deviation swing at plus and minus one.
   *
   * Doing it as a complex product rather than as a difference of two atan2
   * calls is not an optimisation, it is correctness: the difference of two
   * angles has to be unwrapped and the product never needs it.
   */
  Demod.FM = function (opts) {
    opts = opts || {};
    return {
      label: 'FM discriminator',
      deviation: opts.deviation === undefined ? 5000 : opts.deviation,
      pi: 1, pq: 0,
      reset: function () { this.pi = 1; this.pq = 0; },
      step: function (i, q, fs) {
        var ci = i * this.pi + q * this.pq;      /* z . conj(prev) */
        var cq = q * this.pi - i * this.pq;
        this.pi = i; this.pq = q;
        if (ci === 0 && cq === 0) return 0;
        var d = Math.atan2(cq, ci);
        return d * fs / (2 * Math.PI * this.deviation);
      }
    };
  };

  /* ---- SSB: the real part, and nothing else -----------------------------
   * The baseband of an SSB signal is the analytic audio, so its real part is
   * the audio. There is no detector and nothing to recover, which is the whole
   * reason SSB needs the receiver to supply what the transmitter left out.
   *
   * Which is also why a tuning error is audible on SSB and not on FM: the
   * frequency offset the channel applies lands directly on the recovered
   * audio, moving every component by the same number of hertz rather than the
   * same ratio. Voices go metallic rather than merely high, because the
   * harmonic relationships are broken instead of scaled. Set a 200Hz error and
   * listen.
   */
  Demod.SSB = function () {
    return {
      label: 'SSB product detector',
      reset: function () {},
      step: function (i) { return i; }
    };
  };

  /* ---- CW: the envelope against a beat note -----------------------------
   * A CW receiver has nothing to detect either. What makes Morse audible is
   * the beat frequency oscillator: the signal is mixed against a tone a few
   * hundred hertz off, and what you hear is that tone switched on and off.
   *
   * So the audio is the envelope multiplied by a locally generated pitch,
   * which is exactly what the hardware does and is why the pitch is a receiver
   * setting rather than a property of the transmission.
   */
  Demod.CW = function (opts) {
    opts = opts || {};
    return {
      label: 'CW beat note',
      pitch: opts.pitch === undefined ? 600 : opts.pitch,
      phase: 0,
      reset: function () { this.phase = 0; },
      step: function (i, q, fs) {
        var env = Math.sqrt(i * i + q * q);
        var v = env * Math.sin(this.phase);
        this.phase += 2 * Math.PI * this.pitch / fs;
        if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
        return v;
      }
    };
  };

  /* Which detector belongs to which transmission. Chosen from the modulator so
   * the page never offers AM detection of an FM signal, which would produce
   * silence and look like a bug rather than a category error. */
  Demod.forModulator = function (mod) {
    if (!mod) return null;
    var m = mod.inner ? mod.inner : mod;
    if (m.deviation !== undefined) return Demod.FM({ deviation: m.deviation });
    if (m.depth !== undefined) return Demod.AM();
    if (m.label === 'CW' || m.order !== undefined) return Demod.CW();
    return Demod.SSB();
  };

  /* Run a detector across a whole block. The audio comes back at the block's
   * sample rate, which is far above anything audible, so the caller decimates
   * before it reaches a loudspeaker. */
  Demod.run = function (det, block, out) {
    var n = block.n, fs = block.fs, k;
    out = out || new Float32Array(n);
    for (k = 0; k < n; k++) out[k] = det.step(block.i[k], block.q[k], fs);
    return out;
  };

  root.SS = root.SS || {};
  root.SS.Demod = Demod;
  if (typeof module !== 'undefined' && module.exports) module.exports = Demod;

})(typeof globalThis !== 'undefined' ? globalThis : this);
