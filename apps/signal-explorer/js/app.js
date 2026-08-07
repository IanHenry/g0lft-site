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

  /* The loudspeaker is one more reader of the same block. It is fed from the
   * frame loop like every plot, never from a second generator. */
  var out = new SS.AudioOut();
  var listenTo = 'before';
  var demodBuf = new Float32Array(Engine.HISTORY);

  /* A second generator, for the loudspeaker only, running at real time.
   *
   * The plots are usually slowed to a fraction of a per cent, which is the only
   * way to watch a constellation, and at those speeds the display generator
   * makes about six samples per frame where the card wants eight hundred. There
   * is no honest audio to be made from six samples. So the sound comes from its
   * own engine at speed 1, configured identically and sharing the channel
   * object so every slider affects both.
   *
   * The plots still all agree with each other, which is what the one-buffer
   * rule was protecting. The loudspeaker is a different clock, and the page
   * says so. */
  var audioEngine = new Engine({ fs: 250000, seed: 4242 });
  audioEngine.speed = 1;
  var audioDetector = null;
  var audioBuf = new Float32Array(Engine.HISTORY);
  var audioClock = 0;
  var audioLead = true;
  var audible = true;

  /* Is there anything to listen to?
   *
   * The rule is the capture's own sample rate. Panels 6D to 6H were recorded
   * at 2MHz with ten samples to a symbol, which is two hundred thousand
   * symbols a second: the signal occupies a couple of hundred kilohertz and
   * every part of it is above hearing. Slowing it to fit the audio band would
   * not be that signal any more, and a made up sound presented next to a real
   * constellation is worse than no sound. So those modes are seen and not
   * heard, and the page says so. */
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
    Presets.apply(audioEngine, preset);
    audioEngine.speed = 1;
    if (userWav) audioEngine.setSource(new SS.Sources.Buffer(userWav.data, userWav.rate));
    else applySourceTo(audioEngine);
    audioEngine.channel = engine.channel;
    primeDetector();
    setAudible(audioEngine.fs <= AUDIBLE_FS);
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
  function bothSources(fn) { fn(engine.source); if (audioEngine.source) fn(audioEngine.source); }
  function bothMods(fn) {
    fn(innerMod());
    var m = audioEngine.modulator;
    if (m) fn(m.inner ? m.inner : m);
  }

  /* Build the receiver for the loudspeaker's engine and run a frame through it
   * that nobody hears.
   *
   * A detector starts cold: filters are empty and any DC blocker has no
   * estimate yet, so the first block out of it is a settling transient rather
   * than the signal. On the 5B repeater capture it peaks near ten, which is a
   * bang out of the speaker at the instant you switch to listening after the
   * receiver. Discarding one frame costs a sixtieth of a second of audio and
   * removes it entirely. */
  /* Generate `secs` of real time and hand it to the loudspeaker. Split into
   * blocks the engine and the scratch buffer can hold, because the lead-in
   * asks for eighty milliseconds at once and at 250kHz that is twenty thousand
   * samples. */
  /* Empty the ring and arrange for the next frame to refill it with a lead-in
   * rather than a frame's worth. Anything that makes the old contents wrong,
   * a change of mode or of what is being listened to, has to come through
   * here or the reader spends the next second catching up. */
  function resetAudio() {
    out.flush();
    audioClock = 0;
    audioLead = true;
  }

  function pumpAudio(secs) {
    var want = Math.round(audioEngine.fs * secs), chunk, ab;
    while (want > 0) {
      chunk = Math.min(want, 8192);
      if (chunk < 8) break;
      want -= chunk;
      ab = audioEngine.step(chunk);
      if (listenTo === 'after' && audioDetector) {
        Demod.run(audioDetector, ab, audioBuf);
        out.push(audioBuf, ab.n, audioEngine.fs);
      } else {
        out.push(ab.audio, ab.n, audioEngine.fs);
      }
    }
  }

  function primeDetector() {
    audioDetector = Demod.forModulator(audioEngine.modulator);
    if (!audioDetector) return;
    Demod.run(audioDetector, audioEngine.step(Math.round(audioEngine.fs / 60)), audioBuf);
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

  function setAudible(yes) {
    audible = yes;
    $('c-audio').disabled = !yes;
    $('c-vol').disabled = !yes;
    var rs = document.getElementsByName('listen'), k;
    for (k = 0; k < rs.length; k++) rs[k].disabled = !yes;
    if (!yes) {
      resetAudio();
      $('audio-note').textContent =
        'Nothing to hear. This capture was recorded at ' + fmt(audioEngine.fs) +
        ' and carries two hundred thousand symbols a second, so the whole '
        + 'signal sits far above hearing. The modes with audio in them are the '
        + 'analogue ones and the on air digital modes further up.';
    } else if (!out.ready) {
      $('audio-note').textContent =
        'Your browser will not start audio without a click, which is why this '
        + 'is a button rather than a switch.';
    } else {
      $('audio-note').textContent = 'Playing at ' + out.sampleRate() + 'Hz.';
    }
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
    $('speed-audio-note').textContent = engine.speed > 0.6
      ? 'The sound plays at real time, which is what the plots are showing too.'
      : 'The sound always plays at real time, whatever the plots are doing. There is no useful audio to be made from a signal slowed a hundredfold, so the loudspeaker keeps its own clock.';
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
      engine.speed = speedFromSlider(this.value);
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

    $('c-freq').addEventListener('input', function () {
      engine.channel.freqOffset = parseFloat(this.value);
      iq.clearDensity();
      updateLabels();
    });
    $('c-noise').addEventListener('input', function () {
      engine.channel.noise = parseFloat(this.value);
      iq.clearDensity();
      updateLabels();
    });
    $('c-gain').addEventListener('input', function () {
      engine.channel.gain = parseFloat(this.value);
      iq.clearDensity();
      updateLabels();
    });
    $('c-fade').addEventListener('input', function () {
      engine.channel.fadeDepth = parseFloat(this.value);
      iq.clearDensity();
      updateLabels();
    });

    $('c-tone').addEventListener('input', function () {
      var v = parseFloat(this.value);
      bothSources(function (s) {
        if (!s) return;
        if (s.freq !== undefined) s.freq = v;
        else if (s.f1 !== undefined) s.f1 = v;
      });
      iq.clearDensity();
      updateLabels();
    });
    $('c-tone2').addEventListener('input', function () {
      var v = parseFloat(this.value);
      bothSources(function (s) { if (s && s.f2 !== undefined) s.f2 = v; });
      iq.clearDensity();
      updateLabels();
    });
    $('c-dev').addEventListener('input', function () {
      var v = parseFloat(this.value);
      bothMods(function (m) { if (m && m.deviation !== undefined) m.deviation = v; });
      iq.clearDensity();
      updateLabels();
    });
    $('c-depth').addEventListener('input', function () {
      var v = parseFloat(this.value);
      bothMods(function (m) { if (m && m.depth !== undefined) m.depth = v; });
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
      if (!out.ready) {
        out.start().then(function () {
          btn.setAttribute('aria-pressed', 'true');
          btn.textContent = 'Sound is on';
          $('audio-note').textContent = 'Playing at ' + out.sampleRate() + 'Hz.';
        }).catch(function (e) {
          btn.textContent = 'Sound is not available';
          $('audio-note').textContent = 'Sound would not start: ' + e.message +
            '. Everything else on the page works without it.';
        });
      } else if (btn.getAttribute('aria-pressed') === 'true') {
        out.stop();
        btn.setAttribute('aria-pressed', 'false');
        btn.textContent = 'Turn the sound on';
      } else {
        out.resume();
        btn.setAttribute('aria-pressed', 'true');
        btn.textContent = 'Sound is on';
      }
    });

    /* A hidden tab gets no animation frames, so nothing refills the ring and
     * the worklet holds its last sample forever: a DC offset that costs
     * nothing to hear but bangs on the way back. Stop the clock instead. */
    document.addEventListener('visibilitychange', function () {
      if (!out.ready) return;
      if (document.hidden) { out.stop(); }
      else { resetAudio(); out.resume(); }
    });

    var listenRadios = document.getElementsByName('listen');
    Array.prototype.forEach.call(listenRadios, function (r) {
      r.addEventListener('change', function () {
        listenTo = this.value;
        if (listenTo === 'after') primeDetector();
        resetAudio();
        audioClock = 0;
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
    if (audioEngine.modulator) applySourceTo(audioEngine);
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

  function applyWavSource() {
    engine.setSource(new SS.Sources.Buffer(userWav.data, userWav.rate));
  }

  function applyWav() {
    if (!userWav) return;
    engine.setSource(new SS.Sources.Buffer(userWav.data, userWav.rate));
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
  function frame() {
    var block = engine.step();

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
    if (out.ready && audible) {
      /* Real time, from the loudspeaker's own engine, so there is always
       * enough signal to make continuous audio however slowly the plots run.
       *
       * How much to generate is measured, not assumed. Engine.blockSize()
       * divides by a nominal sixty frames a second, and a 120Hz phone or a
       * throttled tab would then be handed half or twice the signal a real
       * second contains, which is a pitch error rather than a timing one. */
      var t = performance.now();
      var adt = audioClock ? (t - audioClock) / 1000 : 1 / 60;
      audioClock = t;
      if (!(adt > 0) || adt > 0.05) adt = 1 / 60;
      /* Starting from nothing, the ring is empty by construction and the
       * reader catches the writer inside almost every block it renders. Get
       * ahead once, with real signal rather than silence, and stay ahead. */
      if (audioLead) { adt += SS.AudioOut.LEAD; audioLead = false; }
      pumpAudio(adt);
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
