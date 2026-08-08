/* Signal Explorer: the wiring.
 *
 * This file owns the DOM and nothing else. It does not compute a sample. The
 * loop below is the only thing that calls engine.step, and every plot is then
 * handed the same history, which is what keeps the five views showing one
 * moment rather than five nearby ones.
 */
(function () {
  'use strict';

  var SS = window.SS;
  var Engine = SS.Engine, Presets = SS.Presets, Plots = SS.Plots, DSP = SS.DSP;
  var Demod = SS.Demod, Sources = SS.Sources;

  var $ = function (id) { return document.getElementById(id); };

  var engine = new Engine({ fs: 250000, seed: 20260904 });
  var preset = null;
  var userWav = null;          /* a loaded file overrides the preset's source */
  var detector = null;         /* the receiver, for listening after transmission */
  var sourceChoice = 'preset';

  /* The loudspeaker is one more reader of the same block. Not a second
   * generator: the same samples the plots are drawing, played.
   *
   * That rule was broken once, and putting it back is the reason this file is
   * shorter than it was. A separate generator running at real time while the
   * plots crawled meant two clocks, and two clocks mean the swept tone you can
   * see is not the swept tone you can hear. No amount of interface could make
   * that honest.
   *
   * What it costs is that you cannot have both at once, and that is not a
   * limitation of the program. A constellation has to be slowed a hundredfold
   * to be watched, and a signal slowed a hundredfold has no sound in it: a
   * 1kHz tone becomes 10Hz. Watch it or hear it, and the page says so where
   * the button is.
   */
  var out = new SS.AudioOut();
  var listenTo = 'before';
  var demodBuf = new Float32Array(Engine.HISTORY);
  var audioLead = true;
  var frameClock = 0;      /* the measured animation interval, for block sizing */

  /* The slowest the plots may run and still make a sound worth hearing.
   *
   * Playing a block generated at speed s stretches it by 1/s, so every
   * frequency in it is multiplied by s. At a quarter speed a 1kHz tone lands
   * on 250Hz, which is low but plainly a tone; at a tenth it is 100Hz and
   * turning to mush; below that there is nothing a loudspeaker can do with it.
   * A quarter is where the sound stops being informative, so that is where it
   * is switched off rather than left playing something misleading. */
  var AUDIO_MIN_SPEED = 0.25;

  /* Some captures have nothing audible in them at any speed. 6D to 6H were
   * recorded at 2MHz carrying two hundred thousand symbols a second: even
   * slowed to a quarter that is 50 kilobaud, an octave-and-a-half of nothing
   * above hearing. Seen and not heard, and the page says why. */
  var AUDIBLE_FS = 384000;

  var iq = new Plots.Constellation($('iq'));
  var audio = new Plots.Trace($('audio'), { colour: SS.Palette.ui.ink, range: 1.1 });
  var wave = new Plots.Waveform($('wave'));
  var phasor = new Plots.Phasor($('phasor'));
  var spectrum = new Plots.SpectrumView($('spectrum'), 2048);
  var waterfall = new Plots.Waterfall($('waterfall'), 1024);

  /* Scratch space the plots read. Allocated once: allocating inside the frame
   * loop is the fastest way to make an animation stutter. */
  var bufI = new Float32Array(Engine.HISTORY);
  var bufQ = new Float32Array(Engine.HISTORY);
  var bufA = new Float32Array(Engine.HISTORY);

  /* ---- Mode chooser ----------------------------------------------------- */
  /* Grouped by what things are, not by where they appeared in a magazine.
   * The panel number survives as a small chip, because a reader who has the
   * article open and wants 5D should find it in one glance, and because the
   * fragment in the address bar makes every mode separately linkable. That
   * matters more than the layout here: the article has gone to press, so a
   * link that keeps working is worth more than an arrangement that does. */
  function buildPresets() {
    var nav = $('presets'), seen = {}, order = [];
    Presets.forEach(function (p) {
      var g = p.group || 'Other';
      if (!seen[g]) { seen[g] = []; order.push(g); }
      seen[g].push(p);
    });
    order.forEach(function (g) {
      var row = document.createElement('div');
      row.className = 'grp';
      var h = document.createElement('h3');
      h.textContent = g;
      row.appendChild(h);
      seen[g].forEach(function (p) {
        var b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-pressed', 'false');
        b.innerHTML = (p.panel ? '<span class="p">' + p.panel + '</span>' : '') +
                      p.name.replace(/</g, '&lt;');
        b.addEventListener('click', function () { choose(p.id, true); });
        b.dataset.id = p.id;
        row.appendChild(b);
      });
      nav.appendChild(row);
    });
  }

  function choose(id, fromClick) {
    preset = Presets.byId(id) || Presets[0];
    id = preset.id;
    if (fromClick && window.history && window.history.replaceState) {
      window.history.replaceState(null, '', '#' + id);
    }
    Presets.apply(engine, preset);
    if (userWav) applyWav();

    Array.prototype.forEach.call($('presets').querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.id === id));
    });

    $('blurb-text').textContent = preset.blurb;
    $('blurb-origin').textContent = preset.origin;

    iq.scale = preset.scale;
    iq.mode = preset.view;
    iq.style = preset.style || 'line';
    iq.persist = preset.persist || 4096;
    iq.setBins(preset.bins || 150);
    phasor.scale = preset.scale;
    iq.clearDensity();
    setRadio('view', preset.view);

    /* Show the spectrum over the part of the band the signal actually
     * occupies. At 250kHz sampling with a 3kHz signal in it the full span is
     * 99 per cent empty, which is true and useless. */
    var span = Math.min(engine.fs / 2, 12000);
    if (preset.id === '5a') span = 200000 / 2;
    if (preset.id === '5b') span = 40000;
    spectrum.span = span;
    waterfall.span = span;

    applySource();
    detector = Demod.forModulator(engine.modulator);

    /* The same mode again for the loudspeaker, at real time. Its own source and
     * modulator instances, because both are stateful, but the same channel
     * object so noise, tuning and fading move together. */
    updateAudioAvailability();
    resetAudio();
    syncControlsFromState();
    showRelevantControls();
  }

  /* ---- Controls --------------------------------------------------------- */
  function setRadio(name, value) {
    Array.prototype.forEach.call(
      document.querySelectorAll('input[name="' + name + '"]'),
      function (r) { r.checked = (r.value === value); });
  }

  /* Apply a change to both generators. The sliders used to reach only the
   * display engine, so turning the tone knob moved the picture and not the
   * sound. Anything that alters the signal has to go through here. */
  function withSource(fn) { if (engine.source) fn(engine.source); }
  function withMod(fn) { var m = innerMod(); if (m) fn(m); }

  /* Empty the ring and arrange for the next frame to refill it with a lead-in
   * rather than a frame's worth. Anything that makes the old contents wrong,
   * a change of mode, of speed, or of what is being listened to, has to come
   * through here or the reader spends the next second catching up. */
  function resetAudio() {
    out.flush();
    audioLead = true;
  }

  /* Build the receiver and run a frame through it that nobody hears.
   *
   * A detector starts cold: filters are empty and any DC blocker has no
   * estimate yet, so the first block out of it is a settling transient rather
   * than the signal. On the 5B repeater capture it peaks near ten, which is a
   * bang out of the loudspeaker the instant you switch to listening after the
   * receiver. Discarding one frame removes it entirely. */
  function primeDetector() {
    detector = Demod.forModulator(engine.modulator);
    if (!detector) return;
    Demod.run(detector, engine.step(Math.round(engine.fs / 60)), demodBuf);
  }

  /* Feed the loudspeaker from the block the plots were just drawn from.
   *
   * `block.n` samples of signal generated at `engine.speed`, which audio.js
   * turns into the same stretch of sound at the card's rate. Nothing here
   * generates a sample. That is the whole design, and the reason the sound and
   * the picture can no longer disagree about anything. */
  /* Get a cushion of sound into the ring before the card starts reading it.
   *
   * Frames do not arrive evenly, and a ring holding only what the last frame
   * put in it runs dry inside almost every block the card renders, which is
   * heard as a rasp rather than as a gap. Eighty milliseconds rides out
   * several late frames.
   *
   * With one generator the only way to make that cushion is to run the signal
   * on a little further, which advances the plots by the same eighty
   * milliseconds of sound. At a quarter speed that is twenty milliseconds of
   * signal, once, at the moment the sound is switched on. Nobody will see it,
   * and the alternative is a second generator and two clocks again. */
  function leadIn() {
    var want = Math.round(engine.fs * engine.speed * SS.AudioOut.LEAD), chunk;
    while (want > 0) {
      chunk = Math.min(want, 8192);
      want -= chunk;
      if (chunk < 2) break;
      pumpAudio(engine.step(chunk));
    }
  }

  function pumpAudio(block) {
    if (listenTo === 'after' && detector) {
      Demod.run(detector, block, demodBuf);
      out.push(demodBuf, block.n, engine.fs, engine.speed);
    } else {
      out.push(block.audio, block.n, engine.fs, engine.speed);
    }
  }

  function modOf() { return engine.modulator; }
  function innerMod() {
    var m = engine.modulator;
    return m && m.inner ? m.inner : m;
  }

  /* Speed is on a log slider. Linear would put everything usable in the first
   * two per cent of the travel. */
  function speedFromSlider(v) { return Math.pow(10, parseFloat(v)); }
  function sliderFromSpeed(s) { return Math.log10(s); }

  function syncControlsFromState() {
    $('c-speed').value = sliderFromSpeed(engine.speed);
    $('c-scale').value = iq.scale;
    $('c-persist').value = iq.persist;
    $('c-bins').value = iq.bins;
    $('c-freq').value = engine.channel.freqOffset || 0;
    $('c-noise').value = engine.channel.noise || 0;
    $('c-gain').value = engine.channel.gain === undefined ? 1 : engine.channel.gain;
    $('c-fade').value = engine.channel.fadeDepth || 0;

    var src = engine.source, m = innerMod();
    if (src && src.freq !== undefined) $('c-tone').value = src.freq;
    if (src && src.f1 !== undefined) { $('c-tone').value = src.f1; $('c-tone2').value = src.f2; }
    if (m && m.deviation !== undefined) $('c-dev').value = m.deviation;
    if (m && m.depth !== undefined) $('c-depth').value = m.depth;
    updateLabels();
  }

  /* Only offer a control that does something to the mode on screen. A
   * deviation slider on an AM panel is worse than no slider: it invites the
   * reader to conclude the tool is broken. */
  function showRelevantControls() {
    var src = engine.source, m = innerMod();
    $('row-tone').hidden = !(src && (src.freq !== undefined || src.f1 !== undefined));
    $('row-tone2').hidden = !(src && src.f2 !== undefined);
    $('row-dev').hidden = !(m && m.deviation !== undefined);
    $('row-depth').hidden = !(m && m.depth !== undefined);
    $('depth-note').hidden = $('row-depth').hidden;

    var t = $('row-tone').querySelector('span');
    t.firstChild.textContent = src && src.f2 !== undefined ? 'First tone ' : 'Tone ';

    /* Some modes generate their own symbols and take no audio at all. Offering
     * a source chooser and an "audio going in" to listen to would be inviting
     * the reader to conclude the tool is broken when they hear a tone go in and
     * Morse come out. */
    var carries = !(m && m.carriesAudio === false);
    $('c-source').disabled = !carries;
    $('row-listen').querySelector('input[value="before"]').disabled = !carries;
    $('audio-caption').textContent = carries
      ? 'The audio going in'
      : 'No audio goes in';
    $('audio-hint').textContent = carries
      ? 'everything below is what the modulator does with this'
      : 'this mode builds its own symbols, so there is nothing to feed it and nothing to hear before transmission';
    if (!carries && listenTo === 'before') {
      listenTo = 'after';
      setRadio('listen', 'after');
      resetAudio();
    }
  }

  /* Whether there is anything to hear, and if not, why not in one sentence.
   *
   * Two separate reasons, and a reader deserves to be told which applies.
   * Either the mode carries nothing in the audio band at any speed, or the
   * plots have been slowed past the point where the sound means anything. The
   * second is fixable by moving one slider, so say so. */
  function audioState() {
    if (engine.fs > AUDIBLE_FS) return 'never';
    if (engine.speed < AUDIO_MIN_SPEED) return 'tooslow';
    return 'ok';
  }

  function updateAudioAvailability() {
    var st = audioState(), ok = st === 'ok';
    $('c-vol').disabled = !ok;
    var rs = document.getElementsByName('listen'), k;
    for (k = 0; k < rs.length; k++) {
      /* A mode that builds its own symbols has no audio going in, so there is
       * nothing to listen to before transmission whatever the speed. */
      rs[k].disabled = !ok || (rs[k].value === 'before' && !carriesAudio());
    }
    $('c-audio').disabled = st === 'never';

    if (st === 'never') {
      if (out.ready) { out.stop(); out.ready = false; }
      $('audio-note').textContent =
        'Nothing to hear. This capture was recorded at ' + fmt(engine.fs) +
        ' and carries two hundred thousand symbols a second, so all of it sits '
        + 'far above hearing however much it is slowed. The modes with sound in '
        + 'them are the analogue ones and the on air digital modes above.';
    } else if (st === 'tooslow') {
      $('audio-note').textContent = out.ready
        ? 'Sound paused. The plots are at ' + pct(engine.speed) + ' of real '
          + 'time, and at that speed a 1kHz tone would come out at '
          + fmt(1000 * engine.speed) + ', which is not something you can hear. '
          + 'Bring the speed back to a quarter or more and it resumes.'
        : 'Sound needs the plots at a quarter of real time or faster. Pressing '
          + 'the button will take them there.';
    } else if (out.ready) {
      $('audio-note').textContent = 'Playing at ' + out.sampleRate() + 'Hz.';
    } else {
      $('audio-note').textContent =
        'Your browser will not start audio without a click, which is why this '
        + 'is a button rather than a switch. The plots will speed up to a '
        + 'quarter of real time, because that is the slowest a signal can be '
        + 'played and still be heard.';
    }
  }

  function carriesAudio() {
    var m = engine.modulator;
    return !(m && m.carriesAudio === false);
  }

  function pct(x) {
    return (x * 100).toFixed(x < 0.01 ? 2 : x < 1 ? 1 : 0) + '%';
  }

  function fmt(hz) {
    if (typeof hz !== 'number' || !isFinite(hz)) return '?';
    var a = Math.abs(hz);
    if (a >= 1e6) return (hz / 1e6).toFixed(hz % 1e6 === 0 ? 0 : 2) + 'MHz';
    if (a >= 1000) return (hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1) + 'kHz';
    return hz.toFixed(a < 10 ? 1 : 0) + 'Hz';
  }

  function updateLabels() {
    var sps = engine.blockSize() * 60;
    $('v-speed').textContent = (engine.speed * 100).toFixed(engine.speed < 0.01 ? 2 : 1) + '% of real time';
    $('speed-note').textContent =
      'Generating ' + fmt(sps).replace('Hz', '') + ' samples a second of a signal recorded at ' +
      fmt(engine.fs) + '. At full speed this mode goes past far too quickly to follow, which is why the printed figures are densities.';
    /* The one thing about this tool a reader has to understand, said where
     * they will meet it. Slowing the plots is not a display option, it changes
     * how much signal passes in a frame, and the sound is that same signal
     * played. Slow it far enough and there is no sound left in it. */
    var hz = 1000 * engine.speed;
    $('speed-audio-note').textContent = engine.speed >= AUDIO_MIN_SPEED
      ? 'The sound is these same samples played, so it is slowed with them: a '
        + '1kHz tone comes out at ' + fmt(hz) + '. Nothing is generated twice, '
        + 'which is why what you hear and what you see cannot disagree.'
      : 'No sound at this speed. A 1kHz tone would come out at ' + fmt(hz) +
        ', which is not something a loudspeaker or an ear can do anything '
        + 'with. A constellation has to be slowed to be watched and a signal '
        + 'has to run to be heard, and that is a fact about signals rather '
        + 'than a shortcoming here. Bring the speed to a quarter or more.';
    $('v-scale').textContent = '±' + (iq.scale / 2).toFixed(2);
    $('v-persist').textContent = iq.persist;
    $('v-bins').textContent = iq.bins;
    $('v-vol').textContent = Math.round(parseFloat($('c-vol').value) * 100) + '%';

    $('v-freq').textContent = fmt(engine.channel.freqOffset || 0);
    $('v-noise').textContent = (engine.channel.noise || 0).toFixed(3);
    $('v-gain').textContent = (engine.channel.gain).toFixed(2);
    $('v-fade').textContent = (engine.channel.fadeDepth || 0) === 0
      ? 'none' : (engine.channel.fadeDepth * 100).toFixed(0) + '%';
    var src = engine.source, m = innerMod();
    if (src && src.freq !== undefined) $('v-tone').textContent = fmt(src.freq);
    if (src && src.f1 !== undefined) {
      $('v-tone').textContent = fmt(src.f1);
      $('v-tone2').textContent = fmt(src.f2) + ' (ratio ' + (src.f2 / src.f1).toFixed(1) + ')';
    }
    if (m && m.deviation !== undefined) $('v-dev').textContent = fmt(m.deviation);
    if (m && m.depth !== undefined) {
      /* The modulation index is the swing over the carrier, not the swing on
       * its own, so overmodulation begins wherever depth passes carrier rather
       * than at a fixed 1.0. Showing the raw depth said 0.60 next to a carrier
       * of 0.75 and left the reader to do the division. */
      var idx = m.depth / (m.carrier || 1);
      $('v-depth').textContent = Math.round(idx * 100) + '%' +
        (idx > 1 ? ', overmodulated' : '');
    }
  }

  function wire() {
    $('c-speed').addEventListener('input', function () {
      var was = audioState();
      engine.speed = speedFromSlider(this.value);
      /* Crossing into or out of the audible range empties the ring: what is
       * in it was generated at the old speed and would be played at the new
       * one, which is a step in pitch. */
      if (audioState() !== was) { resetAudio(); updateAudioAvailability(); }
      iq.clearDensity();
      updateLabels();
    });
    $('c-scale').addEventListener('input', function () {
      iq.scale = parseFloat(this.value);
      phasor.scale = iq.scale;
      updateLabels();
    });
    $('c-persist').addEventListener('input', function () {
      iq.persist = parseInt(this.value, 10);
      updateLabels();
    });
    $('c-bins').addEventListener('input', function () {
      iq.setBins(parseFloat(this.value));
      updateLabels();
    });
    $('c-clear').addEventListener('click', function () { iq.clearDensity(); });

    document.querySelectorAll('input[name="view"]').forEach(function (r) {
      r.addEventListener('change', function () {
        iq.mode = this.value;
        iq.clearDensity();
        $('view-hint').textContent = this.value === 'density'
          ? 'log scaled density, the way the printed figures were made'
          : 'coloured purple to yellow over time, so you can see which way it turns';
      });
    });

    $('c-freq').addEventListener('input', (function () {
      engine.channel.freqOffset = parseFloat(this.value);
      iq.clearDensity();
      updateLabels();
    }));
    $('c-noise').addEventListener('input', (function () {
      engine.channel.noise = parseFloat(this.value);
      iq.clearDensity();
      updateLabels();
    }));
    $('c-gain').addEventListener('input', (function () {
      engine.channel.gain = parseFloat(this.value);
      iq.clearDensity();
      updateLabels();
    }));
    $('c-fade').addEventListener('input', (function () {
      engine.channel.fadeDepth = parseFloat(this.value);
      iq.clearDensity();
      updateLabels();
    }));

    $('c-tone').addEventListener('input', function () {
      var v = parseFloat(this.value);
      withSource(function (s) {
        if (!s) return;
        if (s.freq !== undefined) s.freq = v;
        else if (s.f1 !== undefined) s.f1 = v;
      });
      iq.clearDensity();
      updateLabels();
    });
    $('c-tone2').addEventListener('input', function () {
      var v = parseFloat(this.value);
      withSource(function (s) { if (s && s.f2 !== undefined) s.f2 = v; });
      iq.clearDensity();
      updateLabels();
    });
    $('c-dev').addEventListener('input', function () {
      var v = parseFloat(this.value);
      withMod(function (m) { if (m && m.deviation !== undefined) m.deviation = v; });
      iq.clearDensity();
      updateLabels();
    });
    $('c-depth').addEventListener('input', function () {
      var v = parseFloat(this.value);
      withMod(function (m) { if (m && m.depth !== undefined) m.depth = v; });
      iq.clearDensity();
      updateLabels();
    });

    $('c-source').addEventListener('change', function () {
      sourceChoice = this.value;
      applySource();
      iq.clearDensity();
      resetAudio();
      showRelevantControls();
      syncControlsFromState();
    });

    $('c-audio').addEventListener('click', function () {
      var btn = this;
      /* The sound is the same samples the plots are made of, so it cannot
       * play while they are crawling. Rather than grey the button out and
       * leave the reader to work out which slider to move, take them there. */
      if (engine.speed < AUDIO_MIN_SPEED) {
        engine.speed = AUDIO_MIN_SPEED;
        $('c-speed').value = sliderFromSpeed(engine.speed);
        iq.clearDensity();
        updateLabels();
        resetAudio();
      }
      if (!out.ready) {
        out.start().then(function () {
          btn.setAttribute('aria-pressed', 'true');
          btn.textContent = 'Sound is on';
          updateAudioAvailability();
        }).catch(function (e) {
          btn.textContent = 'Sound is not available';
          $('audio-note').textContent = 'Sound would not start: ' + e.message +
            '. Everything else on the page works without it.';
        });
      } else if (btn.getAttribute('aria-pressed') === 'true') {
        out.stop();
        $('audio-note').textContent = 'Sound off.';
        btn.setAttribute('aria-pressed', 'false');
        btn.textContent = 'Turn the sound on';
      } else {
        resetAudio();
        out.resume();
        btn.setAttribute('aria-pressed', 'true');
        btn.textContent = 'Sound is on';
        updateAudioAvailability();
      }
    });

    /* A hidden tab gets no animation frames, so nothing refills the ring and
     * the worklet holds its last sample: a constant, which is silent, and a
     * step on the way back, which is not.
     *
     * The obvious answer is to suspend the audio context while hidden and
     * resume it on return, and that is a trap on iOS, where resuming outside
     * a user gesture frequently does not work. The page would then be silent
     * for the rest of the session with nothing to show for it, and the reader
     * would have no way to know that switching apps once was what did it. So
     * the context is left running and only the buffer is reset, which costs a
     * few milliseconds of a held sample and cannot strand anybody. */
    document.addEventListener('visibilitychange', function () {
      if (out.ready && !document.hidden) resetAudio();
    });

    var listenRadios = document.getElementsByName('listen');
    Array.prototype.forEach.call(listenRadios, function (r) {
      r.addEventListener('change', function () {
        listenTo = this.value;
        if (listenTo === 'after') primeDetector();
        resetAudio();
        updateAudioAvailability();
      });
    });

    $('c-vol').addEventListener('input', function () {
      out.setVolume(parseFloat(this.value));
      updateLabels();
    });

    $('c-wav').addEventListener('change', loadWav);
    $('c-wav-clear').addEventListener('click', function () {
      userWav = null;
      this.hidden = true;
      $('c-wav').value = '';
      choose(preset.id);
    });
  }

  /* Replace the mode's own audio without touching any capture parameter, so a
   * reader can hear the same channel carrying different material. */
  function applySource() {
    if (userWav) { applyWavSource(); return; }
    applySourceTo(engine);

  }

  function applySourceTo(target) {
    var s = null;
    if (sourceChoice === 'tone') s = new Sources.Tone(1000);
    else if (sourceChoice === 'twotone') s = new Sources.TwoTone(700, 1900);
    else if (sourceChoice === 'chirp') s = new Sources.Chirp(600, 2600, 2);
    else if (sourceChoice === 'speech') s = new Sources.Speech(20260907);
    else if (sourceChoice === 'music') s = new Sources.Music();
    if (s) target.setSource(s);
  }

  /* ---- Audio from a file ------------------------------------------------
   * Decoded through Web Audio, which handles WAV, MP3 and anything else the
   * browser knows, then handed to the buffer source. Nothing leaves the
   * machine: there is no upload here and no server to upload to.
   */
  function loadWav(ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    var ac = new (window.AudioContext || window.webkitAudioContext)();
    file.arrayBuffer()
      .then(function (b) { return ac.decodeAudioData(b); })
      .then(function (buf) {
        /* Mono. A stereo file's two channels are two different modulating
         * signals and there is only one transmitter here. */
        var ch = buf.getChannelData(0);
        var copy = new Float32Array(ch.length);
        copy.set(ch);
        userWav = { data: copy, rate: buf.sampleRate, name: file.name };
        $('c-wav-clear').hidden = false;
        applyWav();
        iq.clearDensity();
      })
      .catch(function (e) {
        $('blurb-origin').textContent = 'That file could not be decoded: ' + e.message;
      });
  }

  /* Both generators, always. A Buffer source holds a read position, so the two
   * need one each rather than a shared object, but a loaded file that reaches
   * only the display engine is heard as the preset's own audio while the plots
   * show the file. That is a worse failure than silence, because everything
   * looks right. */
  function applyWavSource() {
    engine.setSource(new SS.Sources.Buffer(userWav.data, userWav.rate));

  }

  function applyWav() {
    if (!userWav) return;
    applyWavSource();
    resetAudio();
    $('blurb-origin').textContent = 'Playing ' + userWav.name + ' through ' +
      (engine.modulator ? engine.modulator.label : 'the current mode') +
      '. Only the audio is replaced. The capture parameters are unchanged.';
    showRelevantControls();
  }

  /* ---- Readout ----------------------------------------------------------- */
  var statRows = [
    ['Mean amplitude', function (s) { return s.meanMag.toFixed(4); }],
    ['Amplitude variation', function (s) { return s.magSpread.toFixed(4); }],
    ['Peak', function (s) { return s.peak.toFixed(4); }],
    ['Centre of the cloud', function (s) { return s.meanI.toFixed(3) + ', ' + s.meanQ.toFixed(3); }],
    ['Rotation', function (s, r) { return fmt(r); }]
  ];
  function buildStats() {
    var tb = $('stats').querySelector('tbody');
    statRows.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + r[0] + '</td><td></td>';
      tb.appendChild(tr);
    });
  }
  var statTick = 0;
  function updateStats(block) {
    if (++statTick % 6) return;          /* six times a second is plenty */
    var s = DSP.stats(block);
    var rot = DSP.netRotation(block) / (block.n / engine.fs);
    var cells = $('stats').querySelectorAll('td:nth-child(2)');
    statRows.forEach(function (r, k) { cells[k].textContent = r[1](s, rot); });
  }

  /* ---- The loop ---------------------------------------------------------- */
  /* Say what the sound is actually doing, once a second.
   *
   * Everything upstream of the loudspeaker can be measured from here, and none
   * of it could be measured from a report that the sound did not work. If the
   * context is not running, or the ring is emptying faster than it is filled,
   * this says so in words rather than leaving a silent page and a guess. */
  var statusAt = 0, starvedAt = 0;
  function audioStatus(now) {
    if (!out.ready || now - statusAt < 1000) return;
    if (audioState() !== 'ok') return;   /* the note is explaining why, leave it */
    statusAt = now;
    var lost = out.starved - starvedAt;
    starvedAt = out.starved;
    var state = out.ctx ? out.ctx.state : 'none';
    if (state !== 'running') {
      $('audio-note').textContent = 'The browser has put audio into "' + state +
        '". Press the button again to wake it.';
    } else if (lost > out.sampleRate() * 0.02) {
      $('audio-note').textContent = 'Playing at ' + out.sampleRate() + 'Hz, but ' +
        'this machine is not keeping up: ' + (lost / out.sampleRate() * 1000).toFixed(0) +
        'ms of the last second had nothing ready to play. A mode with a lower ' +
        'sample rate will cost less, and so will slowing the plots, though ' +
        'not below a quarter speed or the sound stops altogether.';
    } else {
      $('audio-note').textContent = 'Playing at ' + out.sampleRate() + 'Hz, ' +
        Math.round(out.fill / out.sampleRate() * 1000) + 'ms buffered.';
    }
  }

  function frame() {
    /* Measured, not assumed. Engine.blockSize() divides by a nominal sixty
     * frames a second; on a 120Hz screen or in a throttled tab that hands the
     * plots half or twice the signal a real second contains. It was always
     * wrong, and it stopped being invisible when the same block started
     * feeding the loudspeaker, where it is a pitch error. */
    var now = performance.now();
    var dt = frameClock ? (now - frameClock) / 1000 : 1 / 60;
    frameClock = now;
    if (!(dt > 0) || dt > 0.05) dt = 1 / 60;

    var want = Math.round(engine.fs * engine.speed * dt);
    if (want < 4) want = 4;
    if (want > 8192) want = 8192;
    var block = engine.step(want);

    /* One read of the history, shared by everything that needs it. */
    var trail = Math.min(iq.persist, engine.hist.filled);
    var n = engine.recent(trail, bufI, bufQ);

    if (iq.mode === 'density') iq.accumulate(block.i, block.q, block.n);
    iq.draw(bufI, bufQ, n);

    /* The waveform wants a fixed window rather than the trail. Tying the two
     * together, which an earlier version did, means shortening the trail to
     * one revolution so the constellation colours correctly also cuts the
     * waveform down to a single cycle. Two views, two independent windows. */
    var wn = Math.min(1024, engine.hist.filled);
    engine.recent(wn, bufI, bufQ);
    engine.recentAudio(wn, bufA);
    audio.draw(bufA, wn);
    wave.draw(bufI, bufQ, wn, bufA);
    phasor.draw(block.i[block.n - 1], block.q[block.n - 1]);

    var sn = engine.recent(Math.min(4096, engine.hist.filled), bufI, bufQ);
    spectrum.draw(bufI, bufQ, sn, engine.fs);
    waterfall.draw(bufI, bufQ, sn, engine.fs);

    /* One more reader of the block that was already generated. */
    if (out.ready && audioState() === 'ok') {
      /* Real time, from the loudspeaker's own engine, so there is always
       * enough signal to make continuous audio however slowly the plots run.
       *
       * How much to generate is measured, not assumed. Engine.blockSize()
       * divides by a nominal sixty frames a second, and a 120Hz phone or a
       * throttled tab would then be handed half or twice the signal a real
       * second contains, which is a pitch error rather than a timing one. */
      var t = performance.now();
      /* Starting from nothing, the ring is empty by construction and the
       * reader catches the writer inside almost every block it renders. Get
       * ahead once, with real signal rather than silence, and stay ahead. */
      if (audioLead) { audioLead = false; leadIn(); }
      pumpAudio(block);
      audioStatus(t);
    }

    updateStats(block);
    requestAnimationFrame(frame);
  }

  buildPresets();
  buildStats();
  wire();
  /* A fragment selects a mode directly, so the article's figures stay linkable
   * from elsewhere even though the page is no longer organised around them. */
  var frag = (location.hash || '').replace(/^#/, '').toLowerCase();
  choose(Presets.byId(frag) ? frag : '5e');
  window.addEventListener('hashchange', function () {
    var f = (location.hash || '').replace(/^#/, '').toLowerCase();
    if (Presets.byId(f)) choose(f);
  });
  $('view-hint').textContent =
    'coloured purple to yellow over time, so you can see which way it turns';
  requestAnimationFrame(frame);

})();
