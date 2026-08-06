/* Seeing signals: PSK31.
 *
 * Two ideas, and both of them are elegant enough to be worth the file.
 *
 * The varicode. Characters get codes of different lengths, shortest to the
 * commonest, so a space is "1" and an e is "11" while a Z is ten bits. No code
 * contains "00", which means "00" can separate them, which means the mode needs
 * no start bits, no stop bits and no frame at all: a receiver joining part way
 * through finds the next "00" and is aligned. Average about six bits a
 * character instead of eight.
 *
 * Differential encoding. The data is not in the phase but in whether the phase
 * changed: no change is a 1, a reversal is a 0. A receiver therefore never has
 * to know the absolute phase, only whether this symbol matches the last, which
 * removes carrier recovery from the problem entirely. The idle state is
 * continuous zeros, so an idle transmitter reverses every symbol and gives the
 * receiver something to lock its timing to.
 *
 * The shaping matters too. Amplitude follows a raised cosine spanning two
 * symbol periods, overlapping by half, so a run of equal symbols sums to a
 * constant while a reversal passes through zero. That is what keeps a 31.25
 * baud signal inside about 31Hz, and it is why the constellation is not two
 * points but a figure that goes through the origin.
 *
 * The varicode table came from G0LFT's own ts_ham_modes.py, which states it was
 * written to the published G3PLX specification rather than taken from any
 * implementation, and is decode-validated there against fldigi. It has been
 * checked here against the generating rule as well: 95 entries, every code
 * begins and ends with 1, none contains "00", and the set is uniquely
 * decodable when separated by "00".
 */
(function (root) {
  'use strict';

  var PSK = {};

  PSK.BAUD = 31.25;

  PSK.VARICODE = {
    ' ': '1',
    '!': '111111111',
    '"': '101011111',
    '#': '111110101',
    '$': '111011011',
    '%': '1011010101',
    '&': '1010111011',
    "'": '101111111',
    '(': '11111011',
    ')': '11110111',
    '*': '101101111',
    '+': '111011111',
    ',': '1110101',
    '-': '110101',
    '.': '1010111',
    '/': '110101111',
    '0': '10110111',
    '1': '10111101',
    '2': '11101101',
    '3': '11111111',
    '4': '101110111',
    '5': '101011011',
    '6': '101101011',
    '7': '110101101',
    '8': '110101011',
    '9': '110110111',
    ':': '11110101',
    ';': '110111101',
    '<': '111101101',
    '=': '1010101',
    '>': '111010111',
    '?': '1010101111',
    '@': '1010111101',
    'A': '1111101',
    'B': '11101011',
    'C': '10101101',
    'D': '10110101',
    'E': '1110111',
    'F': '11011011',
    'G': '11111101',
    'H': '101010101',
    'I': '1111111',
    'J': '111111101',
    'K': '101111101',
    'L': '11010111',
    'M': '10111011',
    'N': '11011101',
    'O': '10101011',
    'P': '11010101',
    'Q': '111011101',
    'R': '10101111',
    'S': '1101111',
    'T': '1101101',
    'U': '101010111',
    'V': '110110101',
    'W': '101011101',
    'X': '101110101',
    'Y': '101111011',
    'Z': '1010101101',
    '[': '111110111',
    '\\': '111101111',
    ']': '111111011',
    '^': '1010111111',
    '_': '101101101',
    '`': '1011011111',
    'a': '1011',
    'b': '1011111',
    'c': '101111',
    'd': '101101',
    'e': '11',
    'f': '111101',
    'g': '1011011',
    'h': '101011',
    'i': '1101',
    'j': '111101011',
    'k': '10111111',
    'l': '11011',
    'm': '111011',
    'n': '1111',
    'o': '111',
    'p': '111111',
    'q': '110111111',
    'r': '10101',
    's': '10111',
    't': '101',
    'u': '110111',
    'v': '1111011',
    'w': '1101011',
    'x': '11011111',
    'y': '1011101',
    'z': '111010101',
    '{': '1010110111',
    '|': '110111011',
    '}': '1010110101',
    '~': '1011010111'
  };

  PSK.DECODE = (function () {
    var d = {}, k;
    for (k in PSK.VARICODE) d[PSK.VARICODE[k]] = k;
    return d;
  })();

  /* Text to a bit stream. Each character is its code followed by "00", and a
   * transmission begins and ends with idle zeros so a receiver has something to
   * synchronise on before the first character arrives. */
  PSK.toBits = function (text, idle) {
    idle = idle === undefined ? 32 : idle;
    var bits = [], k, code, j;
    for (j = 0; j < idle; j++) bits.push(0);
    text = String(text);
    for (k = 0; k < text.length; k++) {
      code = PSK.VARICODE[text.charAt(k)];
      if (!code) continue;
      for (j = 0; j < code.length; j++) bits.push(code.charAt(j) === '1' ? 1 : 0);
      bits.push(0); bits.push(0);
    }
    for (j = 0; j < idle; j++) bits.push(0);
    return bits;
  };

  /* And back. Split on "00" and look each run up. A run that is not in the
   * table is noise, and is dropped rather than printed as a wrong character. */
  PSK.fromBits = function (bits) {
    /* No codeword contains "00", so splitting the stream on it recovers the
     * characters directly. That is the entire decoder, and it is the whole
     * point of the code's design: no framing to find, no length to agree, and a
     * receiver joining mid-transmission is aligned at the next separator.
     *
     * Runs that are not in the table are dropped rather than printed. Idle
     * produces empty runs, which fall out for free. */
    var s = (bits.join ? bits.join('') : String(bits)).split('00');
    var out = '', k;
    for (k = 0; k < s.length; k++) {
      if (s[k] && PSK.DECODE[s[k]]) out += PSK.DECODE[s[k]];
    }
    return out;
  };

  /* ---- The modulator ------------------------------------------------------
   * Differential BPSK with the overlapping raised cosine envelope. Only two
   * symbol pulses overlap at any moment, so this is two terms rather than a
   * filter.
   */
  PSK.Modulator = function (opts) {
    opts = opts || {};
    var bits = opts.bits || PSK.toBits(opts.text === undefined ? 'CQ CQ de G0LFT' : opts.text);
    var baud = opts.baud || PSK.BAUD;
    var loop = opts.loop !== false;

    return {
      label: 'PSK31',
      baud: baud,
      bits: bits,
      carriesAudio: false,
      a: 0,
      /* Symbol values are the accumulated phase: start at +1, and a data bit of
       * 0 flips it. Nothing here needs to know the absolute phase. */
      sym: 1,
      prev: 1,
      idx: 0,
      t: 0,
      reset: function () { this.sym = 1; this.prev = 1; this.idx = 0; this.t = 0; },
      step: function (src, fs) {
        var spb = fs / this.baud;
        if (this.t >= spb) {
          this.t -= spb;
          this.prev = this.sym;
          var bit = this.idx < this.bits.length ? this.bits[this.idx] : 0;
          this.idx++;
          if (loop && this.idx >= this.bits.length) this.idx = 0;
          if (bit === 0) this.sym = -this.sym;   /* 0 reverses, 1 holds */
        }
        /* Hann pulses two symbols long, half overlapped: equal neighbours sum
         * to one, opposite neighbours pass through zero. */
        var f = this.t / spb;
        var hNow = 0.5 * (1 - Math.cos(Math.PI * f));
        var hPrev = 0.5 * (1 + Math.cos(Math.PI * f));
        this.i = this.sym * hNow + this.prev * hPrev;
        this.q = 0;
        this.t++;
      }
    };
  };

  /* ---- The receiver -------------------------------------------------------
   * Integrate each symbol, then compare its sign with the previous one. No
   * carrier recovery, because differential encoding removed the need for it.
   */
  PSK.demodulate = function (block, baud, offset) {
    var spb = block.fs / baud;
    /* Sample half a symbol late.
     *
     * With half-overlapped pulses the waveform is purely the previous symbol at
     * the start of a symbol period and purely the current one at its end, so a
     * window aligned to the period averages the two and cancels them exactly
     * whenever they differ, which is every reversal, which is the data. The
     * peak of each symbol sits on the boundary, so the window has to straddle
     * it. This is the timing recovery a real receiver has to search for; here
     * the clock is shared, so it can simply be stated. */
    if (offset === undefined) offset = spb / 2;
    var count = Math.floor((block.n - offset) / spb), out = [], s, k, from, to, acc, prev = null, cur;
    for (s = 0; s < count; s++) {
      from = Math.round(offset + s * spb);
      to = Math.round(offset + (s + 1) * spb);
      acc = 0;
      for (k = from; k < to && k < block.n; k++) acc += block.i[k];
      cur = acc >= 0 ? 1 : -1;
      if (prev !== null) out.push(cur === prev ? 1 : 0);
      prev = cur;
    }
    return out;
  };

  root.SS = root.SS || {};
  root.SS.PSK = PSK;
  if (typeof module !== 'undefined' && module.exports) module.exports = PSK;

})(typeof globalThis !== 'undefined' ? globalThis : this);
