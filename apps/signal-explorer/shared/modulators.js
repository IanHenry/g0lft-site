/* Seeing signals: the analogue modulators.
 *
 * Each one takes the modulating signal and says where the point goes. That
 * sentence is the article's whole thesis, so these are deliberately short:
 * every mode here is a couple of lines, and the differences between them are
 * meant to be readable side by side rather than buried in a framework.
 *
 * Sign convention: positive baseband frequency turns anticlockwise, so a USB
 * tone rotates one way and an LSB tone the other. That is the article's 5E and
 * 5F, and it is the one place in the whole subject where the direction of
 * rotation is visible and means something, so it is worth being exact about.
 */
(function (root) {
  'use strict';

  var Mod = {};

  /* ---- Unmodulated carrier (article 4B) ---------------------------------
   * A single point on the I axis, standing still. Tune off and the channel's
   * frequency offset makes it rotate, which is where the article's rule comes
   * from: the slower the rotation, the closer you are to being tuned.
   */
  Mod.Carrier = function () {
    return {
      label: 'Unmodulated carrier',
      reset: function () {},
      step: function () { this.i = 1; this.q = 0; }
    };
  };

  /* ---- No signal at all (article 4A) ------------------------------------
   * Nothing but what the channel adds. Kept as a mode rather than as an empty
   * state, because the noise cloud is the baseline every other panel is read
   * against and it deserves to be selectable.
   */
  Mod.NoSignal = function () {
    return {
      label: 'No signal',
      reset: function () {},
      step: function () { this.i = 0; this.q = 0; }
    };
  };

  /* ---- Amplitude modulation (article 5C, 5D) -----------------------------
   * "The point expands and contracts along the I axis but never alters
   * phase." So Q is zero by construction, and any phase wander the reader sees
   * is the channel rather than the modulation. That is exactly the difference
   * between the broadcast panel and the airband one: same modulator, different
   * channel.
   *
   * depth is the modulation index. Above 1 the envelope goes negative, the
   * point passes through the origin and out the other side, and the carrier is
   * overmodulated. Worth being able to do rather than clamped away, because
   * seeing it is the point.
   */
  Mod.AM = function (opts) {
    opts = opts || {};
    var depth = opts.depth === undefined ? 0.7 : opts.depth;
    var carrier = opts.carrier === undefined ? 1 : opts.carrier;
    return {
      label: 'AM',
      depth: depth,
      carrier: carrier,
      reset: function () {},
      step: function (src) {
        this.i = this.carrier + this.depth * src.a;
        this.q = 0;
      }
    };
  };

  /* ---- Double sideband, suppressed carrier (article 5G) ------------------
   * Built the way the article builds it, by adding a USB tone to an LSB tone
   * rather than by multiplying a carrier. The two rotations cancel in Q and
   * leave movement in I only, which is why the result "resembles broadcast AM
   * but centred on the origin rather than offset by a carrier wave".
   *
   * Writing it as (usb + lsb) / 2 rather than as the single term it collapses
   * to keeps the article's derivation visible in the code. test/modes.js
   * checks the two agree.
   */
  Mod.DSB = function () {
    return {
      label: 'DSB suppressed carrier',
      reset: function () {},
      step: function (src) {
        var usbI = src.a, usbQ = src.aq;
        var lsbI = src.a, lsbQ = -src.aq;
        this.i = (usbI + lsbI) / 2;
        this.q = (usbQ + lsbQ) / 2;
      }
    };
  };

  /* ---- Single sideband (article 5E, 5F, 5H, 5I) --------------------------
   * The audio itself, shifted up to a radio frequency, with no carrier. On the
   * plot that means the baseband is the analytic audio: a single tone becomes
   * a point going round a circle at the tone's frequency, and speech becomes
   * the sum of a few dozen of those, which is the cloud.
   *
   * LSB is the same signal with Q negated, which mirrors every rotation. It is
   * not a different modulator and is not written as one.
   */
  Mod.SSB = function (opts) {
    opts = opts || {};
    var sign = (opts.sideband === 'lsb') ? -1 : 1;
    return {
      label: sign > 0 ? 'USB' : 'LSB',
      sideband: sign > 0 ? 'usb' : 'lsb',
      reset: function () {},
      step: function (src) {
        this.i = src.a;
        this.q = sign * src.aq;
      }
    };
  };

  /* ---- Frequency modulation (article 5A, 5B) -----------------------------
   * Constant amplitude, so the radius never changes and the ring is as tight
   * as the deviation is steady. All the information is in how fast the point
   * moves round, which is the sentence the constellation makes obvious and a
   * waveform diagram never does.
   *
   * deviation is peak deviation in Hz. The two presets that matter are 75kHz
   * for broadcast, which is the ITU figure for band II rather than anything
   * measured, and 5kHz for the repeater, which is measured: it is
   * max_dev=5e3 in the repeater flowgraph, so it is the one deviation
   * figure in this file that was measured rather than assumed.
   *
   * The phase accumulator is the state that makes FM continuous across frames.
   * Reset it per frame and the ring breaks up into arcs.
   */
  Mod.FM = function (opts) {
    opts = opts || {};
    return {
      label: 'FM',
      deviation: opts.deviation === undefined ? 5000 : opts.deviation,
      phase: 0,
      reset: function () { this.phase = 0; },
      step: function (src, fs) {
        this.i = Math.cos(this.phase);
        this.q = Math.sin(this.phase);
        this.phase += 2 * Math.PI * this.deviation * src.a / fs;
        if (this.phase > Math.PI) this.phase -= 2 * Math.PI;
        else if (this.phase < -Math.PI) this.phase += 2 * Math.PI;
      }
    };
  };

  /* ---- A transmission that starts and stops (article 5B) -----------------
   * The repeater panel is the one that tells a story: noise at the origin, a
   * ring snapping into existence when somebody keys up, a wobble while they
   * talk, and a collapse back to a dot. That behaviour belongs to the
   * transmission rather than to FM, so it wraps any modulator rather than
   * being built into one.
   *
   * Edges are shaped over a few milliseconds. A repeater's carrier does not
   * appear instantaneously, and an instant edge would draw a radial line
   * across the plot that no real signal makes.
   */
  Mod.Keyed = function (inner, opts) {
    opts = opts || {};
    return {
      label: inner.label + ', keyed',
      inner: inner,
      onTime: opts.onTime === undefined ? 3.0 : opts.onTime,
      offTime: opts.offTime === undefined ? 1.5 : opts.offTime,
      edge: opts.edge === undefined ? 0.02 : opts.edge,
      t: 0,
      env: 0,
      reset: function () { this.t = 0; this.inner.reset(); },
      step: function (src, fs) {
        var period = this.onTime + this.offTime;
        var x = this.t % period;
        var e;
        if (x < this.edge) e = x / this.edge;
        else if (x < this.onTime - this.edge) e = 1;
        else if (x < this.onTime) e = (this.onTime - x) / this.edge;
        else e = 0;
        this.env = 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, e)));
        this.inner.step(src, fs);
        this.i = this.inner.i * this.env;
        this.q = this.inner.q * this.env;
        /* Nobody is talking into a microphone that is not keyed. Without this
         * the "audio going in" view and the loudspeaker both carried straight
         * on through the gaps, which is not what a repeater sounds like. */
        this.a = src.a * this.env;
        this.t += 1 / fs;
      }
    };
  };

  root.SS = root.SS || {};
  root.SS.Mod = Mod;
  if (typeof module !== 'undefined' && module.exports) module.exports = Mod;

})(typeof globalThis !== 'undefined' ? globalThis : this);
