/* Seeing signals: the loudspeaker as one more view.
 *
 * The same rule as the plots. Nothing here generates a sample; it is handed
 * what the engine already produced and plays it. The audio and the pictures
 * are the same moment for the same reason they always were.
 *
 * Speed, and what the loudspeaker does about it
 * ---------------------------------------------
 * Signal time is not wall clock time when the display is slowed, and the sound
 * follows the speed control rather than ignoring it. Slowed to a fiftieth, a
 * 1kHz tone comes out at 20Hz, because that is what a 1kHz tone slowed fifty
 * times is. A reader who hears the pitch fall as the phasor visibly slows has
 * been told the same fact twice, and the distortion is the point rather than a
 * failure. Far enough down there is nothing a loudspeaker can reproduce, and
 * that is worth hearing too.
 *
 * The generator is still its own, separate from the one driving the plots, and
 * that is deliberate. It runs the same preset over the same channel, but its
 * block size is chosen from the measured frame interval rather than from a
 * nominal sixty frames a second, because a block sized for the wrong frame
 * rate is a pitch error. The plots all agree with each other, which is what
 * the one buffer rule was protecting; the loudspeaker keeps its own count.
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
    '    this.tick = 0;',
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
    '    /* Tell the writer how much is actually in the ring. It cannot work',
    '       this out for itself: estimating from a wall clock assumes the card',
    '       consumes at exactly its nominal rate, and a ring that is nearly',
    '       empty on average starves inside almost every render quantum, which',
    '       is heard as a rasp rather than as a gap. Every sixty fourth block,',
    '       about twelve times a second, which is far more often than a control',
    '       loop that nudges by a few per cent needs and rare enough that the',
    '       audio thread is not spending its budget posting messages. */',
    '    if ((this.tick++ & 63) === 0) {',
    '      this.port.postMessage({ fill: (this.w - this.r) & this.mask,',
    '                              starved: this.starved });',
    '    }',
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
    this.fill = 0;         /* samples in the ring, reported by the worklet */
    this.starved = 0;
    /* Resampler state, so one block joins the next instead of restarting. */
    this.prev = 0;
    this.phase = 0;
  }

  /* How much sound should be sitting ahead of the reader.
   *
   * An animation frame is about 16ms and they do not arrive evenly: a frame
   * that takes 40ms is unremarkable on a phone. Without a cushion the ring is
   * empty by construction, the reader catches the writer inside almost every
   * 128 sample block, and what comes out is a rasp. Eighty milliseconds is
   * enough to ride out several late frames and short enough that nothing feels
   * out of step with the picture. */
  AudioOut.LEAD = 0.08;
  AudioOut.TARGET = 0.05;

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
      self.node.port.onmessage = function (e) {
        self.fill = e.data.fill;
        self.starved = e.data.starved;
      };
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

  /* Take a block of audio and hand over the same stretch of time at the card's
   * rate, slowed by `speed`.
   *
   * The output length comes from the input length and the speed, never from a
   * wall clock: `n` samples at `fs` played at speed s last n/(fs*s) seconds.
   * Timing the frames instead and asking for that many samples shifts the
   * pitch by whatever ratio the real frame rate differs from the assumed one,
   * which on a 120Hz phone is an octave. That was the first bug here.
   *
   * Slowing is a real slowing, not a trick: at a hundredth of speed a 1kHz
   * tone comes out at 10Hz, because that is what a 1kHz tone slowed a hundred
   * times is. The plots are showing the same thing. Below a few per cent there
   * is nothing left a loudspeaker can reproduce, and hearing it fall away is
   * the point rather than a fault.
   *
   * Two directions, and they need different arithmetic:
   *
   *   stretching (the usual case once slowed) interpolates between input
   *   samples, carrying the fractional position and the last sample across the
   *   block boundary so the waveform is continuous. Holding each input sample
   *   instead gives a staircase, and a staircase regenerated every animation
   *   frame is the frame-rate rasp this started with.
   *
   *   squeezing (at or near full speed, where a 250kHz generator feeds a 48kHz
   *   card) averages the interval each output sample covers. Picking a point
   *   would fold content near the card rate straight into the middle of
   *   hearing, and averaging has its null exactly there.
   */
  AudioOut.prototype.push = function (audio, n, fs, speed) {
    if (!this.ready || n < 1) return;
    if (!(speed > 0)) speed = 1;

    var rate = this.sampleRate();
    var want = Math.round(n * rate / (fs * speed));

    /* Nudge towards the target cushion. The generator's clock and the card's
     * clock are different crystals and will drift apart; this is the only
     * feedback in the path and it moves the rate by two per cent at a time,
     * which is inaudible and takes about a second to correct a wander. The
     * fill figure comes from the worklet, so it is measured rather than
     * inferred from how often frames happen to arrive. */
    var target = rate * AudioOut.TARGET;
    /* Proportional, and capped at five per cent either way. A fixed two per
     * cent nudge cannot win against a four per cent error, and the backlog
     * then grows without bound until the ring laps and the reader is jumped
     * forward with a fade. Measured here at 350ms and climbing. */
    var err = (this.fill - target) / target;
    if (err > 0.5 || err < -0.4) {
      var adj = 1 - err * 0.02;
      if (adj > 1.05) adj = 1.05;
      if (adj < 0.95) adj = 0.95;
      want = Math.round(want * adj);
    }

    if (want < 1) return;
    if (want > this.out.length) want = this.out.length;

    var out = this.out, k, j, acc, cnt, from, to, p, i, f, a, b;
    var step = n / want;

    if (step < 1) {
      /* Interpolate over [prev, audio[0] ... audio[n-1]], so position 0 is the
       * last sample of the PREVIOUS block. Starting at audio[0] instead skips
       * the interval between the blocks, and the waveform steps by a whole
       * input sample once per animation frame. Slowed a hundredfold that is a
       * step the signal itself would take a hundred output samples to make:
       * sixty clicks a second, which is what this sounded like. */
      for (k = 0; k < want; k++) {
        p = this.phase + k * step;
        i = Math.floor(p);
        f = p - i;
        a = i <= 0 ? this.prev : (i <= n ? audio[i - 1] : audio[n - 1]);
        b = (i + 1) <= 0 ? this.prev
                         : ((i + 1) <= n ? audio[i] : audio[n - 1]);
        out[k] = a + (b - a) * f;
      }
      /* Whatever is left of the last input sample starts the next block. */
      this.phase = this.phase + want * step - n;
      if (this.phase < 0) this.phase = 0;
      this.prev = audio[n - 1];
    } else {
      for (k = 0; k < want; k++) {
        from = Math.floor(k * step);
        to = Math.floor((k + 1) * step);
        if (to <= from) to = from + 1;
        if (to > n) to = n;
        acc = 0; cnt = 0;
        for (j = from; j < to; j++) { acc += audio[j]; cnt++; }
        out[k] = cnt ? acc / cnt : 0;
      }
      this.phase = 0;
      this.prev = audio[n - 1];
    }
    this.node.port.postMessage({ samples: out.slice(0, want) });
  };

  AudioOut.prototype.flush = function () {
    if (this.ready) this.node.port.postMessage({ reset: true });
    this.fill = 0;
    this.prev = 0;
    this.phase = 0;
  };

  root.SS = root.SS || {};
  root.SS.AudioOut = AudioOut;

})(typeof globalThis !== 'undefined' ? globalThis : this);
