/* Seeing signals: the loudspeaker as one more view.
 *
 * The same rule as the plots. Nothing here generates a sample; it is handed
 * what the engine already produced and plays it. The audio and the pictures
 * are the same moment for the same reason they always were.
 *
 * The speed problem, and why the answer is not to solve it
 * -------------------------------------------------------
 * Signal time is not wall clock time when the display is slowed. Something has
 * to give, and there are only two honest options: force real time whenever the
 * sound is on, or let the sound slow down with everything else and go down in
 * pitch. The second is better. A reader who hears a tone drop an octave while
 * watching its phasor visibly halve its rotation has been told the same fact
 * twice, and the distortion is the point rather than a failure.
 *
 * The loudspeaker has its own generator, and that is deliberate.
 *
 * The plots can be slowed to a fraction of a per cent of real time, which is
 * the only way to watch a constellation. At those speeds the display generator
 * produces six samples per animation frame where the sound card wants eight
 * hundred, and there is no honest way to make audio out of six samples:
 * stretching them gives frame-rate mush, and holding them gives clicks. Both
 * were tried.
 *
 * So the sound is generated separately, at real time, from the same
 * configuration. The loudspeaker and the plots show the same signal, at
 * different speeds, and saying that plainly is better than either artefact.
 *
 * An AudioWorklet built from a Blob, so there is no separate file to fetch and
 * no build step, which is the constraint the whole project runs under.
 */
(function (root) {
  'use strict';

  var WORKLET = [
    'class RingPlayer extends AudioWorkletProcessor {',
    '  constructor() {',
    '    super();',
    '    this.buf = new Float32Array(1 << 16);',
    '    this.mask = this.buf.length - 1;',
    '    this.w = 0; this.r = 0;',
    '    this.last = 0;',
    '    this.starved = 0;',
    '    this.fade = 0;',
    '    this.port.onmessage = e => {',
    '      const d = e.data;',
    '      if (d.reset) { this.w = 0; this.r = 0; this.last = 0; this.fade = 0; return; }',
    '      const s = d.samples;',
    '      for (let k = 0; k < s.length; k++) {',
    '        this.buf[this.w] = s[k];',
    '        this.w = (this.w + 1) & this.mask;',
    '      }',
    '      /* If the writer has lapped the reader the reader is too far behind',
    '         to be worth catching up, so jump it forward rather than playing',
    '         half a second of stale audio. */',
    '      const avail = (this.w - this.r) & this.mask;',
    '      /* If the reader has fallen a long way behind, skipping it forward',
    '         is a discontinuity and clicks. Ask the output stage to fade',
    '         across the jump instead. */',
    '      if (avail > (this.buf.length >> 1)) {',
    '        this.r = (this.w - 4096) & this.mask;',
    '        this.fade = 128;',
    '      }',
    '    };',
    '  }',
    '  process(inputs, outputs) {',
    '    const out = outputs[0][0];',
    '    if (!out) return true;',
    '    for (let k = 0; k < out.length; k++) {',
    '      if (this.r !== this.w) { this.last = this.buf[this.r]; this.r = (this.r + 1) & this.mask; }',
    '      else this.starved++;',
    '      if (this.fade > 0) { out[k] = this.last * (1 - this.fade / 128); this.fade--; }',
    '      else out[k] = this.last;',
    '    }',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("ring-player", RingPlayer);'
  ].join('\n');

  function AudioOut() {
    this.ctx = null;
    this.node = null;
    this.gain = null;
    this.ready = false;
    this.volume = 0.4;
    /* Scratch for the resampler, allocated once. */
    this.out = new Float32Array(8192);
    this.lastPush = 0;
    this.backlog = 0;
  }

  /* Must be called from a click. Browsers will not start audio otherwise, and
   * that is a deliberate protection rather than an obstacle to route around. */
  AudioOut.prototype.start = function () {
    var self = this;
    if (this.ready) return Promise.resolve(true);
    var Ctx = root.AudioContext || root.webkitAudioContext;
    if (!Ctx) return Promise.reject(new Error('no Web Audio in this browser'));
    this.ctx = new Ctx();
    if (!this.ctx.audioWorklet) {
      /* Some mobile browsers, and any browser over plain http rather than
       * https, have no AudioWorklet. Say so plainly instead of failing
       * silently, because a silent failure on a phone is indistinguishable
       * from a volume problem and the reader will blame their handset. */
      return Promise.reject(new Error(
        root.isSecureContext === false
          ? 'audio needs a secure connection, and this page was loaded over http'
          : 'this browser has no AudioWorklet'));
    }

    /* iOS in particular starts the context suspended and will only resume it
     * inside the gesture that asked for sound, so resume first and load the
     * worklet after. Doing it the other way round works everywhere else and
     * leaves an iPhone silent with no error at all. */
    var resumed = this.ctx.state === 'suspended'
      ? this.ctx.resume() : Promise.resolve();
    var url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    return resumed.then(function () {
      return self.ctx.audioWorklet.addModule(url);
    }).then(function () {
      URL.revokeObjectURL(url);
      self.node = new AudioWorkletNode(self.ctx, 'ring-player', { outputChannelCount: [1] });
      self.gain = self.ctx.createGain();
      self.gain.gain.value = self.volume;
      self.node.connect(self.gain).connect(self.ctx.destination);
      self.ready = true;
      return self.ctx.resume().then(function () {
        if (self.ctx.state !== 'running') {
          throw new Error('the browser kept audio suspended, state is ' + self.ctx.state);
        }
        return true;
      });
    });
  };

  AudioOut.prototype.stop = function () {
    if (this.ctx) this.ctx.suspend();
  };
  AudioOut.prototype.resume = function () {
    if (this.ctx) this.ctx.resume();
  };
  AudioOut.prototype.setVolume = function (v) {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v;
  };
  AudioOut.prototype.sampleRate = function () {
    return this.ctx ? this.ctx.sampleRate : 48000;
  };

  /* Take a block of audio at the generator's rate and hand over the same
   * stretch of time at the card's rate.
   *
   * The output length comes from the input length, not from a wall clock:
   * `n` samples at `fs` are n/fs seconds of signal, and they must come out as
   * n/fs seconds of sound or the pitch is wrong. Timing the frames instead
   * and asking for that many samples was the earlier mistake, and it shifts
   * the pitch by whatever ratio the real frame rate differs from the assumed
   * one. Keeping the caller responsible for generating a real time's worth is
   * the only part that needs a clock, and it is done there.
   *
   * Each output sample is the MEAN of the input interval it covers, not a
   * point taken from it. The generator runs far faster than the card, up to
   * 250kHz against 48kHz, and picking points would fold everything above
   * 24kHz straight down into the audible band. Averaging is a crude
   * anti-alias filter and an honest one.
   */
  AudioOut.prototype.push = function (audio, n, fs) {
    if (!this.ready || n < 2) return;

    var rate = this.sampleRate();
    var want = Math.round(n * rate / fs);

    /* Aim at a small steady backlog so ordinary jitter never empties the ring
     * and a slow generator never fills it. This is the only feedback in the
     * path, and it moves the rate by a fraction of a per cent at a time, which
     * is inaudible. */
    var target = rate * 0.04;
    if (this.backlog > target * 2) want = Math.round(want * 0.98);
    else if (this.backlog < target * 0.5) want = Math.round(want * 1.02);

    var now = (root.performance && root.performance.now)
      ? root.performance.now() : Date.now();
    if (this.lastPush) {
      var dt = (now - this.lastPush) / 1000;
      if (dt > 0 && dt < 0.5) this.backlog += want - rate * dt;
      if (this.backlog < 0) this.backlog = 0;
    }
    this.lastPush = now;

    if (want < 1) return;
    if (want > this.out.length) want = this.out.length;

    var out = this.out, k, from, to, j, acc, cnt;
    var step = n / want;
    for (k = 0; k < want; k++) {
      from = Math.floor(k * step);
      to = Math.floor((k + 1) * step);
      if (to <= from) to = from + 1;
      if (to > n) to = n;
      acc = 0; cnt = 0;
      for (j = from; j < to; j++) { acc += audio[j]; cnt++; }
      out[k] = cnt ? acc / cnt : 0;
    }
    this.node.port.postMessage({ samples: out.slice(0, want) });
  };

  AudioOut.prototype.flush = function () {
    if (this.ready) this.node.port.postMessage({ reset: true });
    this.lastPush = 0;
    this.backlog = 0;
  };

  root.SS = root.SS || {};
  root.SS.AudioOut = AudioOut;

})(typeof globalThis !== 'undefined' ? globalThis : this);
