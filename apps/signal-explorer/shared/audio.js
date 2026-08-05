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
 * So each frame of generated audio is resampled to fill one frame of the card,
 * however few samples it contained. At full speed that is nearly one to one and
 * the audio is correct; slowed, the same waveform is stretched, so the pitch
 * falls with the rotation and stays continuous.
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
    '    this.port.onmessage = e => {',
    '      const d = e.data;',
    '      if (d.reset) { this.w = 0; this.r = 0; this.last = 0; return; }',
    '      const s = d.samples;',
    '      for (let k = 0; k < s.length; k++) {',
    '        this.buf[this.w] = s[k];',
    '        this.w = (this.w + 1) & this.mask;',
    '      }',
    '      /* If the writer has lapped the reader the reader is too far behind',
    '         to be worth catching up, so jump it forward rather than playing',
    '         half a second of stale audio. */',
    '      const avail = (this.w - this.r) & this.mask;',
    '      if (avail > (this.buf.length >> 1)) this.r = (this.w - 2048) & this.mask;',
    '    };',
    '  }',
    '  process(inputs, outputs) {',
    '    const out = outputs[0][0];',
    '    if (!out) return true;',
    '    for (let k = 0; k < out.length; k++) {',
    '      if (this.r !== this.w) { this.last = this.buf[this.r]; this.r = (this.r + 1) & this.mask; }',
    '      else this.starved++;',
    '      out[k] = this.last;',
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
  }

  /* Must be called from a click. Browsers will not start audio otherwise, and
   * that is a deliberate protection rather than an obstacle to route around. */
  AudioOut.prototype.start = function () {
    var self = this;
    if (this.ready) return Promise.resolve(true);
    var Ctx = root.AudioContext || root.webkitAudioContext;
    if (!Ctx) return Promise.reject(new Error('no Web Audio in this browser'));
    this.ctx = new Ctx();
    var url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    return this.ctx.audioWorklet.addModule(url).then(function () {
      URL.revokeObjectURL(url);
      self.node = new AudioWorkletNode(self.ctx, 'ring-player', { outputChannelCount: [1] });
      self.gain = self.ctx.createGain();
      self.gain.gain.value = self.volume;
      self.node.connect(self.gain).connect(self.ctx.destination);
      self.ready = true;
      return self.ctx.resume().then(function () { return true; });
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

  /* Take one frame of audio at the engine's rate and hand over one frame's
   * worth at the card's rate, by resampling rather than decimating.
   *
   * This is the fix for the clicking. Decimating only works while the engine is
   * producing at least as many samples as the card consumes. Slowed to a
   * fraction of a per cent it produces six samples a frame against the eight
   * hundred the card wants, the ring empties instantly, and the zero order hold
   * that was supposed to give a graceful pitch drop instead gives a burst of
   * audio sixty times a second, which is a click train at the frame rate. That
   * is not slowed audio, it is the animation being made audible.
   *
   * Resampling to fill the frame gives what was actually wanted: the same
   * waveform stretched, so a tone slowed to a hundredth comes out a hundredth
   * of the pitch, continuously. Linear interpolation, so it is gritty when
   * stretched a long way, and the grit is the honest artefact of listening to
   * something played far too slowly.
   */
  AudioOut.prototype.push = function (audio, n, fs) {
    if (!this.ready || n < 2) return;
    var want = Math.round(this.sampleRate() / 60);
    if (want > this.out.length) want = this.out.length;
    var out = this.out, k, pos, i0, frac;
    var stepIn = (n - 1) / want;
    for (k = 0; k < want; k++) {
      pos = k * stepIn;
      i0 = pos | 0;
      frac = pos - i0;
      out[k] = i0 + 1 < n
        ? audio[i0] * (1 - frac) + audio[i0 + 1] * frac
        : audio[n - 1];
    }
    this.node.port.postMessage({ samples: out.slice(0, want) });
  };

  AudioOut.prototype.flush = function () {
    if (this.ready) this.node.port.postMessage({ reset: true });
  };

  root.SS = root.SS || {};
  root.SS.AudioOut = AudioOut;

})(typeof globalThis !== 'undefined' ? globalThis : this);
