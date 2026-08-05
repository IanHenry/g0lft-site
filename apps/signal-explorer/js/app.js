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
    out.flush();
    syncControlsFromState();
    showRelevantControls();
  }

  /* ---- Controls --------------------------------------------------------- */
  function setRadio(name, value) {
    Array.prototype.forEach.call(
      document.querySelectorAll('input[name="' + name + '"]'),
      function (r) { r.checked = (r.value === value); });
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
      out.flush();
    }
  }

  function fmt(hz) {
    if (typeof hz !== 'number' || !isFinite(hz)) return '?';
    if (Math.abs(hz) >= 1000) return (hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1) + 'kHz';
    return hz.toFixed(Math.abs(hz) < 10 ? 1 : 0) + 'Hz';
  }

  function updateLabels() {
    var sps = engine.blockSize() * 60;
    $('v-speed').textContent = (engine.speed * 100).toFixed(engine.speed < 0.01 ? 2 : 1) + '% of real time';
    $('speed-note').textContent =
      'Generating ' + fmt(sps).replace('Hz', '') + ' samples a second of a signal recorded at ' +
      fmt(engine.fs) + '. At full speed this mode goes past far too quickly to follow, which is why the printed figures are densities.';
    $('v-scale').textContent = '±' + (iq.scale / 2).toFixed(2);
    $('v-persist').textContent = iq.persist;
    $('v-bins').textContent = iq.bins;
    $('v-vol').textContent = Math.round(parseFloat($('c-vol').value) * 100) + '%';
    $('speed-audio-note').textContent = engine.speed > 0.6
      ? 'At full speed the sound is correct.'
      : 'Slowed to ' + (engine.speed * 100).toFixed(1) + ' per cent, so the sound '
        + 'drops in pitch and coarsens. That is the same fact the constellation '
        + 'is showing, heard rather than seen.';
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
      $('v-depth').textContent = m.depth.toFixed(2) + (m.depth > 1 ? ', overmodulated' : '');
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
      var s = engine.source, v = parseFloat(this.value);
      if (s.freq !== undefined) s.freq = v;
      else if (s.f1 !== undefined) s.f1 = v;
      iq.clearDensity();
      updateLabels();
    });
    $('c-tone2').addEventListener('input', function () {
      if (engine.source.f2 !== undefined) engine.source.f2 = parseFloat(this.value);
      iq.clearDensity();
      updateLabels();
    });
    $('c-dev').addEventListener('input', function () {
      var m = innerMod();
      if (m && m.deviation !== undefined) m.deviation = parseFloat(this.value);
      iq.clearDensity();
      updateLabels();
    });
    $('c-depth').addEventListener('input', function () {
      var m = innerMod();
      if (m && m.depth !== undefined) m.depth = parseFloat(this.value);
      iq.clearDensity();
      updateLabels();
    });

    $('c-source').addEventListener('change', function () {
      sourceChoice = this.value;
      applySource();
      iq.clearDensity();
      out.flush();
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
          $('audio-note').textContent = 'Sound would not start: ' + e.message;
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

    document.querySelectorAll('input[name="listen"]').forEach(function (r) {
      r.addEventListener('change', function () { listenTo = this.value; out.flush(); });
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
    var s = null;
    if (sourceChoice === 'tone') s = new Sources.Tone(1000);
    else if (sourceChoice === 'twotone') s = new Sources.TwoTone(700, 1900);
    else if (sourceChoice === 'chirp') s = new Sources.Chirp(600, 2600, 2);
    else if (sourceChoice === 'speech') s = new Sources.Speech(20260907);
    else if (sourceChoice === 'music') s = new Sources.Music();
    if (s) engine.setSource(s);
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
    if (out.ready) {
      if (listenTo === 'after' && detector) {
        Demod.run(detector, block, demodBuf);
        out.push(demodBuf, block.n, engine.fs);
      } else {
        out.push(block.audio, block.n, engine.fs);
      }
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
