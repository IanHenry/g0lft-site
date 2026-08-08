/* Seeing signals: one preset per panel of the article's Figure 4 and Figure 5.
 *
 * These are the tool's link back to the printed page. Selecting a preset
 * should give the reader the panel they are looking at, moving. Every number
 * here is traceable to one of three places: the GNU Radio flowgraphs that made
 * the original captures, the text of the article, or a published standard that
 * neither of those records. Every preset says which in its `origin` line, so
 * the page shows its working rather than asking to be trusted.
 *
 * Sample rates are the rate the IQ was recorded at, which is after the
 * translating filter and before any demodulation, because that is what the
 * published constellations plot.
 */
(function (root) {
  'use strict';

  var SS = root.SS || {};
  var DSP = SS.DSP, Sources = SS.Sources, Mod = SS.Mod, Dig = SS.Dig, FT8 = SS.FT8, PSK = SS.PSK;
  if (typeof require !== 'undefined') {
    if (!DSP) DSP = require('./dsp.js');
    if (!Sources) Sources = require('./sources.js');
    if (!Mod) Mod = require('./modulators.js');
    if (!Dig) Dig = require('./digital.js');
    if (!FT8) FT8 = require('./ft8.js');
    if (!PSK) PSK = require('./psk31.js');
  }

  function P(o) { return o; }

  var Presets = [
    P({
      id: '4a', panel: '4A', name: 'No signal', group: 'Fundamentals',
      blurb: 'Thermal noise alone. A cloud centred on the origin, and the baseline every other panel is read against.',
      fs: 250000, speed: 0.02, scale: 0.6, view: 'trace', persist: 4096, style: 'dots', bins: 100,
      origin: 'From the article: the receiver noise floor. No capture parameters apply.',
      source: function () { return new Sources.Silence(); },
      mod: function () { return Mod.NoSignal(); },
      channel: { noise: 0.06, gain: 1 }
    }),
    P({
      id: '4b', panel: '4B', name: 'Unmodulated carrier', group: 'Fundamentals',
      blurb: 'A single point on the I axis. Tune off, even by a fraction of a hertz, and it starts to go round. The slower it turns, the closer you are.',
      fs: 250000, speed: 0.004, scale: 1.6, view: 'trace', persist: 8192, style: 'line', bins: 150,
      origin: 'From the article. Try the tuning slider: the rotation rate is the tuning error, exactly.',
      source: function () { return new Sources.Silence(); },
      mod: function () { return Mod.Carrier(); },
      channel: { noise: 0.01, gain: 0.7, freqOffset: 0 }
    }),
    P({
      id: '5a', panel: '5A', name: 'FM broadcast', group: 'Analogue',
      blurb: 'Constant amplitude, changing frequency, so the radius never moves and everything is in how fast the point travels. A clean tight ring.',
      fs: 200000, speed: 0.02, scale: 2.3, view: 'density', persist: 4096, style: 'line', bins: 120,
      origin: 'From the capture flowgraph broadcast_fm.py: 1MHz sampling, tuned 100.700MHz, decimated by 5 to a 200kHz recording, 192kHz filter. Deviation 75kHz is the standard for band II, not in the flowgraph.',
      source: function () { return new Sources.Speech(20260901); },
      mod: function () { return Mod.FM({ deviation: 75000 }); },
      /* 219Hz is measured from fm_broadcast.iq, whose angle histogram is
       * uniform to within six per cent. Without an offset the phase is the
       * integral of zero-mean audio, which wanders about its starting angle
       * rather than sweeping, and the ring develops bright patches. */
      channel: { noise: 0.04, gain: 0.8, freqOffset: 219 }
    }),
    P({
      id: '5b', panel: '5B', name: 'FM repeater', group: 'Analogue',
      blurb: 'Noise at the origin, snapping into a rotating circle when somebody keys up, wobbling while they talk, collapsing back to a dot. You can watch the repeater breathe.',
      fs: 100000, speed: 0.02, scale: 2.3, view: 'density', persist: 4096, style: 'line', bins: 120,
      origin: 'From the capture flowgraph repeater_fm.py: 1MHz sampling, tuned 145.750MHz, decimated by 10 to a 100kHz recording, 40kHz filter, max_dev=5e3.',
      source: function () { return new Sources.Speech(20260902); },
      mod: function () { return Mod.Keyed(Mod.FM({ deviation: 5000 }), { onTime: 4, offTime: 2, edge: 0.03 }); },
      /* 118Hz, measured from fm_repeatertime.iq over 15.9 seconds. Its angle
       * histogram is uniform to within four per cent: a real repeater capture
       * fills the ring evenly, and it does so because the receiver is never
       * exactly on frequency. */
      channel: { noise: 0.05, gain: 0.8, freqOffset: 118 }
    }),
    P({
      id: '5c', panel: '5C', name: 'AM broadcast', group: 'Analogue',
      blurb: 'Frequency constant, amplitude varying. The point sits on the I axis and breathes in and out with the programme, never altering phase.',
      fs: 250000, speed: 0.02, scale: 2.2, view: 'density', persist: 4096, style: 'line', bins: 150,
      origin: 'From the capture flowgraph broadcast_am.py: 250kHz sampling, tuned 909kHz, no decimation, 15kHz filter. 909kHz is BBC Radio 5 Live, as named in the article.',
      source: function () { return new Sources.Speech(20260903); },
      /* The index is depth over carrier, so these are 80 per cent. An earlier
       * version paired depth 0.7 with carrier 0.55, which is 127 per cent:
       * overmodulated before the audio was even considered, and the point
       * crossed the origin on peaks. A broadcast station does not do that. */
      mod: function () { return Mod.AM({ depth: 0.6, carrier: 0.75 }); },
      channel: { noise: 0.015, gain: 1 }
    }),
    P({
      id: '5d', panel: '5D', name: 'AM airband', group: 'Analogue',
      blurb: 'The same modulation through a real path. The amplitude still varies, but the phase wanders because the path keeps changing, so it smears into a breathing cloud.',
      fs: 250000, speed: 0.02, scale: 1.6, view: 'density', persist: 4096, style: 'dots', bins: 45,
      origin: 'From the capture flowgraph airband_am.py: 250kHz sampling, tuned 120.625MHz, no decimation, 10kHz filter. The 1800Hz offset is measured from the capture itself, not assumed.',
      source: function () { return new Sources.Speech(20260905); },
      mod: function () { return Mod.AM({ depth: 0.6, carrier: 0.75 }); },
      /* The offset is measured rather than modelled. The recording rotates
       * 2322 turns in 1.29 seconds, which is 1800Hz, and its angle histogram is
       * uniform to within one per cent across twelve sectors: the phasor sweeps
       * every angle evenly. Its centre of mass is the origin to four decimal
       * places, so the carrier is not sitting still anywhere.
       *
       * 1800Hz is receiver tuning error, not aircraft Doppler. Doppler that
       * large at 120.625MHz would need a closing speed of 4470m/s. It is about
       * 15ppm, which is an ordinary crystal.
       *
       * A short-lived earlier version of this comment derived 100Hz of Doppler
       * from an aircraft closing at 250m/s and claimed it explained the panel.
       * The arithmetic was right and the explanation was invented. The capture
       * was sitting on disk the whole time. */
      channel: { noise: 0.05, gain: 1, freqOffset: 1800, fadeDepth: 0.35, fadeRate: 1.6 }
    }),
    P({
      id: '5e', panel: '5E', name: 'USB, single tone', group: 'Analogue',
      blurb: 'No carrier, just the audio moved up to a radio frequency. One tone is one point going round a circle: the radius is its amplitude and the rotation rate is its frequency.',
      fs: 250000, speed: 0.0015, scale: 2.4, view: 'trace', persist: 265, style: 'line', bins: 150,
      origin: 'From the capture flowgraph ssb.py: 250kHz sampling, tuned 14.074MHz, 3kHz filter. The sideband itself is a standard choice; ssb.py has no sideband selection.',
      source: function () { return new Sources.Tone(1000); },
      mod: function () { return Mod.SSB({ sideband: 'usb' }); },
      channel: { noise: 0.008, gain: 1 }
    }),
    P({
      id: '5f', panel: '5F', name: 'LSB, single tone', group: 'Analogue',
      blurb: 'The same circle turning the other way. This is one of the very few places where the direction of rotation is directly visible, and it is the whole difference between the two sidebands.',
      fs: 250000, speed: 0.0015, scale: 2.4, view: 'trace', persist: 265, style: 'line', bins: 150,
      origin: 'As USB single tone, with the sideband inverted. Watch the colour: it runs purple to yellow the opposite way round.',
      source: function () { return new Sources.Tone(1000); },
      mod: function () { return Mod.SSB({ sideband: 'lsb' }); },
      channel: { noise: 0.008, gain: 1 }
    }),
    P({
      id: '5g', panel: '5G', name: 'Double sideband, suppressed carrier', group: 'Analogue',
      blurb: 'A USB tone and an LSB tone together. The two rotations cancel in Q and leave movement in I alone, so it looks like AM but centred on the origin instead of offset by a carrier.',
      fs: 250000, speed: 0.0015, scale: 2.4, view: 'trace', persist: 265, style: 'line', bins: 150,
      origin: 'The article builds this by adding the two sidebands rather than by multiplying a carrier, and so does the code.',
      source: function () { return new Sources.Tone(1000); },
      mod: function () { return Mod.DSB(); },
      channel: { noise: 0.008, gain: 1 }
    }),
    P({
      id: '5h', panel: '5H', name: 'USB, two tones', group: 'Analogue',
      blurb: 'Two rotations combined. Each frequency adds another layer, and the point traces loops and spirals instead of a circle.',
      fs: 250000, speed: 0.002, scale: 2.6, view: 'trace', persist: 850, style: 'line', bins: 150,
      origin: 'Standard value: 700Hz and 1900Hz, the usual two tone test pair for SSB linearity. The number of loops follows from the ratio of the mean frequency to the difference, so move either slider and the figure changes accordingly.',
      source: function () { return new Sources.TwoTone(700, 1900); },
      mod: function () { return Mod.SSB({ sideband: 'usb' }); },
      channel: { noise: 0.004, gain: 0.85 }
    }),
    P({
      id: '5i', panel: '5I', name: 'USB voice', group: 'Analogue',
      blurb: 'Real speech is hundreds of components at once, each rotating at its own speed. The cloud expands on vowels, contracts on consonants, and collapses into the noise in the pauses.',
      fs: 250000, speed: 0.02, scale: 2.2, view: 'density', persist: 4096, style: 'line', bins: 100,
      origin: 'From the article: content from about 300Hz to 3000Hz, all present simultaneously. The voice here is synthetic; load a WAV file for a real one.',
      source: function () { return new Sources.Speech(20260906); },
      mod: function () { return Mod.SSB({ sideband: 'usb' }); },
      channel: { noise: 0.01, gain: 1 }
    }),
    P({
      id: 'birdsong', panel: '', name: 'Swept tone', group: 'Fundamentals',
      blurb: 'Not in the article. A tone sweeping up and down, which is the plainest possible demonstration that rotation speed is frequency: the point visibly winds up and unwinds.',
      fs: 250000, speed: 0.0015, scale: 2.4, view: 'trace', persist: 2000, style: 'line', bins: 150,
      origin: 'Standard value. Included because it makes the frequency to rotation link obvious in a way a fixed tone cannot.',
      source: function () { return new Sources.Chirp(600, 2600, 2); },
      mod: function () { return Mod.SSB({ sideband: 'usb' }); },
      channel: { noise: 0.006, gain: 1 }
    }),
    /* ---- Figure 6, the digital modes ------------------------------------
     * Parameters from the loopback generators rather than from the receive
     * flowgraphs, so these are transmitted values rather than inferred ones.
     * The PSK and QAM panels all share one setup: 2MS/s with ten samples per
     * symbol, which is 200kBd, and rectangular shaping.
     */
    P({
      id: '6a', panel: '6A', name: 'CW', group: 'Digital',
      blurb: 'On-off keying, the oldest digital mode and the simplest. Key down puts the point at a fixed amplitude, key up drops it into the noise at the origin. Tuned slightly off, the key-down point traces a short arc during each dit and dah instead of sitting still.',
      /* A quarter speed rather than a sixteenth. The constellation is a point
       * switching on and off, which needs no slowing to follow, and a quarter
       * is where the sound starts working, so the mode opens ready to hear. */
      fs: 62500, speed: 0.25, scale: 2.4, view: 'density', persist: 3000, style: 'line', bins: 187,
      origin: 'From the capture flowgraph cw.py: 250kHz sampling, tuned 14.090MHz, decimated by 4 to 62.5kHz, 500Hz filter. Speed and text are standard choices; the receive flowgraph never knew them. Edges are shaped over 5ms, which is why the loop is rounded rather than a jump.',
      source: function () { return new Sources.Silence(); },
      mod: function () { return Dig.CW({ wpm: 20, text: 'CQ CQ DE G0LFT K' }); },
      channel: { noise: 0.02, gain: 1, freqOffset: 6 }
    }),
    P({
      id: '6b', panel: '6B', name: 'RTTY', group: 'Digital',
      blurb: 'Two tone frequency shift keying. Each tone is a different rotation rate, so the point turns at one speed for mark and another for space. The amplitude never changes, so both are the same circle: what carries the data is how fast it goes round.',
      fs: 62500, speed: 0.02, scale: 2.4, view: 'density', persist: 4000, style: 'line', bins: 187,
      origin: 'From the capture flowgraph rtty.py: 250kHz sampling, tuned 14.090MHz, decimated by 4 to 62.5kHz, 300Hz filter. Baud and shift are from the loopback generator: 45.45 baud, 1000Hz mark, 500Hz shift. Note that shift is not the 170Hz of normal amateur practice.',
      source: function () { return new Sources.Silence(); },
      mod: function () { return Dig.RTTY({ mark: 1000, shift: 500, baud: 45.45, seed: 11 }); },
      channel: { noise: 0.02, gain: 1 }
    }),
    P({
      id: '6c', panel: '6C', name: 'FT8, a whole passband', group: 'Digital',
      blurb: 'Not one signal but everything inside a 3kHz filter at once. A dozen stations, different frequencies, different strengths, all transmitting together. Their sum is the dense swirl of overlapping loops, and no single signal can make it.',
      fs: 12000, speed: 0.25, scale: 2.6, view: 'density', persist: 8192, style: 'dots', bins: 150,
      origin: 'Standard FT8: 79 symbols of 8-FSK at 6.25 baud with 6.25Hz spacing, Costas synchronisation at the start, middle and end, and Gaussian frequency shaping at BT 2.0. The modulator is the one from the FT8 Message Explorer, checked by round-tripping through the WSJT-X jt9 decoder.',
      source: function () { return new Sources.Silence(); },
      mod: function () { return FT8.Band({ count: 14, lo: 300, hi: 2700, seed: 91 }); },
      channel: { noise: 0.02, gain: 1 }
    }),
    P({
      id: '6c1', panel: '', name: 'FT8, one signal', group: 'Digital',
      blurb: 'The same mode with a single station in the passband, so the structure is visible: eight tones, sliding rather than stepping between them, in a frame that starts and stops.',
      fs: 12000, speed: 0.25, scale: 2.6, view: 'trace', persist: 3000, style: 'line', bins: 150,
      origin: 'Standard FT8, one signal at 1000Hz. The tone slides because FT8 shapes its frequency with a Gaussian pulse; a mode that stepped between tones would splatter either side and lose the narrow bandwidth that is its whole point.',
      source: function () { return new Sources.Silence(); },
      mod: function () { return FT8.Modulator({ offset: 1000, seed: 5 }); },
      channel: { noise: 0.01, gain: 1 }
    }),
    P({
      id: '6psk31', panel: '', name: 'PSK31, carrying text', group: 'Digital',
      blurb: 'Differential BPSK at 31.25 baud, sending real characters. The data is not in the phase but in whether the phase changed, so a receiver never needs to know the absolute phase. Shaping takes the trace through the origin on every reversal, which is why it is a line rather than two dots.',
      /* Real time. At 31 baud the line through the origin is perfectly
       * watchable, so this is one of the few modes where the picture and the
       * sound are both right at once and nothing has to be moved to hear it. */
      fs: 8000, speed: 1, scale: 2.6, view: 'trace', persist: 1200, style: 'line', bins: 150,
      origin: 'Standard PSK31: G3PLX varicode, differential BPSK, 31.25 baud, raised cosine shaping over two symbol periods. The varicode was written to the published specification rather than taken from any implementation, and 95 per cent of the power sits inside 31Hz.',
      source: function () { return new Sources.Silence(); },
      mod: function () { return PSK.Modulator({ text: 'CQ CQ de G0LFT G0LFT k  ' }); },
      channel: { noise: 0.03, gain: 1 }
    }),
    P({
      id: '6d', panel: '6D', name: 'BPSK', group: 'Digital',
      blurb: 'Two phase states 180 degrees apart, both on the I axis. One bit per symbol. The straight spokes between the points are the transitions: the generator steps instantly from one symbol to the next, with no shaping at all.',
      fs: 2000000, speed: 0.02, scale: 2.6, view: 'density', persist: 600, style: 'line', bins: 225,
      origin: 'Loopback generator: a B210 into an attenuator, 2MS/s, 10 samples per symbol so 200kBd, rectangular shaping, random symbols.',
      source: function () { return new Sources.Silence(); },
      mod: function () { return Dig.PSK({ order: 2, sps: 10, seed: 21 }); },
      channel: { noise: 0.03, gain: 1 }
    }),
    P({
      id: '6e', panel: '6E', name: 'QPSK', group: 'Digital',
      blurb: 'Four phase states 90 degrees apart, one in each quadrant. Two bits per symbol instead of one, for the same power and the same bandwidth. The points are closer together, which is the price.',
      fs: 2000000, speed: 0.02, scale: 2.6, view: 'density', persist: 600, style: 'line', bins: 225,
      origin: 'Same loopback setup as BPSK. The generator writes this as exp(1j * arange(4) * pi/2), so the points sit on the axes rather than at 45 degrees.',
      source: function () { return new Sources.Silence(); },
      mod: function () { return Dig.PSK({ order: 4, sps: 10, seed: 22 }); },
      channel: { noise: 0.03, gain: 1 }
    }),
    P({
      id: '6f', panel: '6F', name: '8PSK', group: 'Digital',
      blurb: 'Eight points equally spaced around a circle, three bits per symbol. Turn the noise up and watch which of these three panels fails first.',
      fs: 2000000, speed: 0.02, scale: 2.6, view: 'density', persist: 600, style: 'line', bins: 225,
      origin: 'Same loopback setup as BPSK.',
      source: function () { return new Sources.Silence(); },
      mod: function () { return Dig.PSK({ order: 8, sps: 10, seed: 23 }); },
      channel: { noise: 0.03, gain: 1 }
    }),
    P({
      id: '6g', panel: '6G', name: '16-QAM', group: 'Digital',
      blurb: 'Amplitude and phase together, so the points form a grid rather than a ring. Four bits per symbol. This is where the trade-off becomes visible rather than asserted: more data, and the points crowded closer.',
      fs: 2000000, speed: 0.02, scale: 3.3, view: 'density', persist: 800, style: 'line', bins: 225,
      origin: 'Loopback generator: (I + jQ)/3 with I and Q each drawn from [-3,-1,1,3], so the outer points sit at unit distance along each axis.',
      source: function () { return new Sources.Silence(); },
      mod: function () { return Dig.QAM({ order: 16, sps: 10, seed: 24 }); },
      channel: { noise: 0.02, gain: 1 }
    }),
    P({
      id: '6h', panel: '6H', name: '64-QAM', group: 'Digital',
      blurb: 'An eight by eight grid, six bits per symbol. The clusters are visibly crowded now, and it takes a much better signal to tell them apart. This is the mode your router drops out of first as you walk down the garden.',
      fs: 2000000, speed: 0.02, scale: 3.3, view: 'density', persist: 1200, style: 'line', bins: 225,
      origin: 'As 16-QAM, over [-7..7] divided by 7.',
      source: function () { return new Sources.Silence(); },
      mod: function () { return Dig.QAM({ order: 64, sps: 10, seed: 25 }); },
      channel: { noise: 0.012, gain: 1 }
    })
  ];

  /* Build the engine state a preset describes. Kept here rather than in the UI
   * so the presets can be exercised headlessly. */
  Presets.apply = function (engine, preset) {
    engine.setFs(preset.fs);
    engine.speed = preset.speed;
    engine.setSource(preset.source());
    engine.setModulator(preset.mod());
    engine.channel = {
      gain: 1, noise: 0, freqOffset: 0, phase: 0, fadeDepth: 0
    };
    for (var k in preset.channel) engine.channel[k] = preset.channel[k];
    engine.channel.fading = new DSP.Fading(preset.channel.fadeRate || 1.2, 6, new DSP.Rng(99));
    engine.clearHistory();
    return engine;
  };

  Presets.byId = function (id) {
    for (var k = 0; k < Presets.length; k++) if (Presets[k].id === id) return Presets[k];
    return null;
  };

  root.SS.Presets = Presets;
  if (typeof module !== 'undefined' && module.exports) module.exports = Presets;

})(typeof globalThis !== 'undefined' ? globalThis : this);
