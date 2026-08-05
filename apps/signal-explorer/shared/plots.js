/* Seeing signals: the views.
 *
 * Every plot in here is a reader. None of them generates a sample, advances a
 * phase, or reads the clock. They are handed the engine's history and draw it.
 * That is the rule that keeps five plots showing the same moment, and it is
 * worth restating in each file it applies to because it is easy to break by
 * accident and the symptom, plots that disagree slightly, looks like a
 * rendering bug rather than an architectural one.
 *
 * Canvas rather than SVG, because these animate. The error correction tools
 * are SVG throughout because every panel is a candidate figure for print; here
 * the figures already exist in the magazine and the job is movement. Where a
 * frame does need to be exported for print, it is rasterised and offered as a
 * PNG rather than pretending to be a vector.
 */
(function (root) {
  'use strict';

  var Palette = root.SS && root.SS.Palette;
  var FFT = root.SS && root.SS.FFT;

  var Plots = {};
  var UI = Palette.ui;

  /* ---- Sizing ------------------------------------------------------------
   * A canvas has two sizes and confusing them is the commonest way to get a
   * blurry plot on a high resolution screen. The backing store is sized in
   * device pixels and the drawing is scaled to CSS pixels once, so every
   * coordinate below is in CSS pixels.
   */
  function fit(canvas) {
    var dpr = root.devicePixelRatio || 1;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return null;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }
  Plots.fit = fit;

  function label(ctx, str, x, y, align, colour) {
    ctx.fillStyle = colour || UI.inkSoft;
    ctx.font = '11px "Segoe UI", Helvetica, Arial, sans-serif';
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(str, x, y);
  }

  /* ===================================================================== */
  /* The constellation, which is what the article is about.                 */
  /* ===================================================================== */
  function Constellation(canvas) {
    this.canvas = canvas;
    this.mode = 'trace';          /* 'trace' or 'density' */
    this.style = 'line';          /* 'line' or 'dots', for the trace mode */
    this.scale = 1.6;             /* full width of the view in IQ units */
    this.persist = 4096;          /* samples of trail in trace mode */
    this.bins = 200;
    this.grid = new Float32Array(this.bins * this.bins);
    this.gridMax = 0;
    this.gridExtent = null;       /* the scale the grid was accumulated at */
    this.showAxes = true;
  }

  Constellation.prototype.clearDensity = function () {
    this.grid.fill(0);
    this.gridMax = 0;
    return this;
  };

  /* How coarse the density is, in cells across the visible window.
   *
   * This is a real per-panel setting rather than a rendering detail, and the
   * published figures differ enormously in it. Every plotting script uses
   * hexbin at gridsize=150 with the view locked to plus or minus 0.1, and
   * varies only the `extent` the bins are computed over. Since the cell size
   * is 2*extent/150, the number of cells actually visible works out at
   * 15/extent, which runs from 25 across for the FM panels to 187 for CW and
   * RTTY. A single fixed value cannot reproduce both, and the coarse ones are
   * where the banding in the printed panels comes from.
   */
  Constellation.prototype.setBins = function (n) {
    n = Math.max(8, Math.min(400, Math.round(n)));
    if (n === this.bins) return this;
    this.bins = n;
    this.grid = new Float32Array(n * n);
    this.gridMax = 0;
    this.gridExtent = null;
    return this;
  };

  /* Density accumulates across frames, which is the whole point: the published
   * panels are 100000 samples, about four tenths of a second of signal, piled
   * up. Feed it every frame and it fills in the same way.
   *
   * Changing the zoom has to reset it. The bins are in IQ units, so keeping
   * counts gathered at one scale and drawing them at another puts bright
   * pixels in the wrong places, which reads as a real feature of the signal.
   */
  Constellation.prototype.accumulate = function (i, q, n) {
    if (this.gridExtent !== this.scale) { this.clearDensity(); this.gridExtent = this.scale; }
    var b = this.bins, half = this.scale / 2, k, bi, bq, idx, v;
    for (k = 0; k < n; k++) {
      bi = Math.floor((i[k] + half) / this.scale * b);
      bq = Math.floor((q[k] + half) / this.scale * b);
      if (bi < 0 || bi >= b || bq < 0 || bq >= b) continue;
      idx = bq * b + bi;
      v = ++this.grid[idx];
      if (v > this.gridMax) this.gridMax = v;
    }
    return this;
  };

  Constellation.prototype.draw = function (i, q, n) {
    var f = fit(this.canvas);
    if (!f) return;
    var ctx = f.ctx, w = f.w, h = f.h;
    var size = Math.min(w, h), cx = w / 2, cy = h / 2;
    var px = size / this.scale;      /* pixels per IQ unit */

    ctx.fillStyle = UI.paper;
    ctx.fillRect(0, 0, w, h);

    if (this.showAxes) {
      ctx.strokeStyle = UI.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      var r;
      for (r = 0.25; r <= this.scale / 2 + 1e-9; r += 0.25) {
        ctx.moveTo(cx + r * px, cy);
        ctx.arc(cx, cy, r * px, 0, 2 * Math.PI);
      }
      ctx.stroke();
      ctx.strokeStyle = UI.rule;
      ctx.beginPath();
      ctx.moveTo(cx - size / 2, cy); ctx.lineTo(cx + size / 2, cy);
      ctx.moveTo(cx, cy - size / 2); ctx.lineTo(cx, cy + size / 2);
      ctx.stroke();
    }

    if (this.mode === 'density') this.drawDensity(ctx, cx, cy, px, size);
    else this.drawTrace(ctx, i, q, n, cx, cy, px);

    label(ctx, 'I', cx + size / 2 - 10, cy + 4, 'right');
    label(ctx, 'Q', cx + 4, cy - size / 2 + 2, 'left');
  };

  /* Time colouring: oldest sample purple, newest yellow. The article uses this
   * to make the direction of rotation visible, which is the one thing a still
   * picture of a circle cannot otherwise tell you.
   *
   * Two things here were learned by looking at the result rather than by
   * reasoning about it.
   *
   * The trail has to be about one revolution long. Run it over sixteen and
   * every colour is painted over by the newest one, the circle comes out a
   * uniform green, and the direction of rotation, the entire point of the
   * panel, is destroyed. The trail length is therefore a property of each
   * preset rather than one number for the whole tool.
   *
   * And the trace is drawn as joined segments rather than as dots. At a
   * quarter of a megasample per second a 1kHz tone gives 250 samples per
   * revolution, which is a dotted circle rather than a line. The published
   * figure looks solid because it piles up four hundred revolutions; a live
   * trail of one revolution has to join its samples up instead. Segments are
   * drawn in colour buckets, one path per bucket, because a stroke call per
   * sample is far slower for no visible gain.
   *
   * Scattered signals are the exception: joining consecutive samples of noise
   * draws a ball of string rather than a cloud, so those set style 'dots'.
   */
  Constellation.prototype.drawTrace = function (ctx, i, q, n, cx, cy, px) {
    var css = Palette.viridisCss, k, t;
    if (n < 2) return;

    if (this.style === 'dots') {
      var dot = 1.4;
      for (k = 0; k < n; k++) {
        ctx.fillStyle = css[((k / (n - 1)) * 255) | 0];
        ctx.fillRect(cx + i[k] * px - dot / 2, cy - q[k] * px - dot / 2, dot, dot);
      }
      return;
    }

    var buckets = 64, per = Math.max(1, Math.floor(n / buckets)), b, from, to;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (b = 0; b < buckets; b++) {
      from = b * per;
      to = (b === buckets - 1) ? n : Math.min(n, from + per + 1);
      if (to - from < 2) continue;
      /* Colour by the middle of the bucket, not its first sample. Using the
       * first loses the top of the scale entirely: the last bucket covers the
       * newest samples but gets painted in the colour of where it started, so
       * the trail never reaches yellow and the reader loses the end of the
       * progression. */
      t = Math.round((((from + to - 1) / 2) / (n - 1)) * 255);
      ctx.strokeStyle = css[t < 0 ? 0 : t > 255 ? 255 : t];
      ctx.beginPath();
      for (k = from; k < to; k++) {
        var x = cx + i[k] * px, y = cy - q[k] * px;
        if (k === from) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  };

  /* Log scaled density, on white. The log is not decoration: on a linear scale
   * the origin of a voice plot is so much denser than the loops that the loops
   * disappear entirely. On a log scale a bin holding one sample comes out
   * nearly black and stays visible, which is the speckle around the rings in
   * the published panels. */
  Constellation.prototype.drawDensity = function (ctx, cx, cy, px, size) {
    if (this.gridMax < 1) return;
    var b = this.bins, cell = this.scale / b * px;
    var lut = Palette.magmaCss, denom = Math.log(this.gridMax + 1);
    var bi, bq, v, t, x0 = cx - this.scale / 2 * px, y0 = cy + this.scale / 2 * px;
    var draw = Math.ceil(cell) + 0.5;
    for (bq = 0; bq < b; bq++) {
      for (bi = 0; bi < b; bi++) {
        v = this.grid[bq * b + bi];
        if (v === 0) continue;
        t = Math.log(v + 1) / denom;
        ctx.fillStyle = lut[Math.round(t * 255)];
        ctx.fillRect(x0 + bi * cell, y0 - (bq + 1) * cell, draw, draw);
      }
    }
  };

  Plots.Constellation = Constellation;

  /* ===================================================================== */
  /* I and Q against time. The pair of waves the phasor is a side effect of. */
  /* ===================================================================== */
  function Waveform(canvas) {
    this.canvas = canvas;
    this.showAudio = false;
  }
  Waveform.prototype.draw = function (i, q, n, audio) {
    var f = fit(this.canvas);
    if (!f) return;
    var ctx = f.ctx, w = f.w, h = f.h;
    ctx.fillStyle = UI.paper;
    ctx.fillRect(0, 0, w, h);

    var mid = h / 2, amp = h / 2 - 12;
    ctx.strokeStyle = UI.grid;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

    /* Scale to the larger of the two so I and Q keep their relative sizes.
     * Normalising them separately would hide the fact that AM has no Q at all,
     * which is the single most important thing this view shows. */
    var peak = 1e-6, k;
    for (k = 0; k < n; k++) {
      if (Math.abs(i[k]) > peak) peak = Math.abs(i[k]);
      if (Math.abs(q[k]) > peak) peak = Math.abs(q[k]);
    }
    var sy = amp / peak;

    function trace(arr, colour) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (var k2 = 0; k2 < n; k2++) {
        var x = k2 / (n - 1) * w, y = mid - arr[k2] * sy;
        if (k2) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    /* Two ends of viridis, so I and Q read as the same family as the
     * constellation rather than as unrelated decoration, and so the pair still
     * separates for a reader who cannot tell red from green. */
    trace(i, Palette.at('viridis', 0.30));
    trace(q, Palette.at('viridis', 0.85));

    if (this.showAudio && audio) {
      var apeak = 1e-6;
      for (k = 0; k < n; k++) if (Math.abs(audio[k]) > apeak) apeak = Math.abs(audio[k]);
      ctx.strokeStyle = UI.rule;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (k = 0; k < n; k++) {
        var x = k / (n - 1) * w, y = mid - audio[k] / apeak * amp;
        if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke();
    }

    label(ctx, 'I', 6, 4, 'left', Palette.at('viridis', 0.30));
    label(ctx, 'Q', 18, 4, 'left', Palette.at('viridis', 0.85));
    label(ctx, 'peak ' + peak.toFixed(2), w - 6, 4, 'right');
  };
  Plots.Waveform = Waveform;

  /* ===================================================================== */
  /* The modulating signal on its own.                                      */
  /* ===================================================================== */
  /* This is the input, and without it the reader is being shown three views
   * of an effect and none of its cause. Every modulator in this tool is a
   * sentence about what the audio does to the point, and that sentence cannot
   * be checked against anything unless the audio is on screen.
   *
   * Drawn on a fixed vertical scale rather than normalised. The AM panel's
   * whole claim is that the envelope follows the audio, and a trace that
   * rescales itself every frame breaks that correspondence: the audio would
   * look the same during a shout and a whisper while the constellation
   * visibly changed size.
   */
  function Trace(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.colour = opts.colour || UI.ink;
    this.range = opts.range === undefined ? 1.1 : opts.range;
  }
  Trace.prototype.draw = function (a, n) {
    var f = fit(this.canvas);
    if (!f) return;
    var ctx = f.ctx, w = f.w, h = f.h;
    ctx.fillStyle = UI.paper;
    ctx.fillRect(0, 0, w, h);

    var mid = h / 2, amp = h / 2 - 8, k, peak = 0;
    ctx.strokeStyle = UI.grid;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

    ctx.strokeStyle = this.colour;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (k = 0; k < n; k++) {
      if (Math.abs(a[k]) > peak) peak = Math.abs(a[k]);
      var y = mid - Math.max(-1, Math.min(1, a[k] / this.range)) * amp;
      var x = k / (n - 1) * w;
      if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();

    /* Say when the trace is against the stops, so a flat top reads as
     * clipping rather than as a property of the signal. */
    if (peak > this.range) {
      label(ctx, 'clipped at ' + this.range.toFixed(1), w - 6, 4, 'right', UI.warn);
    } else {
      label(ctx, 'peak ' + peak.toFixed(2), w - 6, 4, 'right');
    }
  };
  Plots.Trace = Trace;

  /* ===================================================================== */
  /* Spectrum. Two sided, because that is the point.                        */
  /* ===================================================================== */
  function SpectrumView(canvas, size) {
    this.canvas = canvas;
    this.spec = new FFT.Spectrum(size || 2048);
    this.floorDb = -90;
    this.topDb = 6;
    this.span = 0;          /* Hz shown either side of centre; 0 means all */
  }
  SpectrumView.prototype.draw = function (i, q, n, fs) {
    var f = fit(this.canvas);
    if (!f) return;
    var ctx = f.ctx, w = f.w, h = f.h;
    ctx.fillStyle = UI.paper;
    ctx.fillRect(0, 0, w, h);

    var db = this.spec.compute(i, q, n, this.floorDb);
    var size = this.spec.size;
    var span = this.span > 0 ? this.span : fs / 2;
    var lo = Math.max(0, Math.floor(size / 2 - span / (fs / size)));
    var hi = Math.min(size, Math.ceil(size / 2 + span / (fs / size)));
    if (hi - lo < 8) { lo = 0; hi = size; }

    ctx.strokeStyle = UI.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    var d;
    for (d = this.floorDb; d <= this.topDb; d += 20) {
      var gy = h - (d - this.floorDb) / (this.topDb - this.floorDb) * h;
      ctx.moveTo(0, gy); ctx.lineTo(w, gy);
    }
    ctx.stroke();

    /* Centre line: zero baseband frequency, which is where the receiver is
     * tuned. An upper sideband signal sits to its right and a lower sideband
     * signal to its left, and that asymmetry is only visible because the
     * input is complex. */
    ctx.strokeStyle = UI.rule;
    ctx.beginPath();
    var zx = (size / 2 - lo) / (hi - lo) * w;
    ctx.moveTo(zx, 0); ctx.lineTo(zx, h);
    ctx.stroke();

    ctx.strokeStyle = UI.accent;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (var k = lo; k < hi; k++) {
      var x = (k - lo) / (hi - lo) * w;
      var v = (db[k] - this.floorDb) / (this.topDb - this.floorDb);
      var y = h - Math.max(0, Math.min(1, v)) * h;
      if (k === lo) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    var edge = span >= 1000 ? (span / 1000).toFixed(0) + 'kHz' : span.toFixed(0) + 'Hz';
    label(ctx, '-' + edge, 4, h - 15);
    label(ctx, '0', zx + 4, h - 15);
    label(ctx, '+' + edge, w - 4, h - 15, 'right');
  };
  Plots.SpectrumView = SpectrumView;

  /* ===================================================================== */
  /* Waterfall. The same spectrum, remembered.                              */
  /* ===================================================================== */
  function Waterfall(canvas, size) {
    this.canvas = canvas;
    this.spec = new FFT.Spectrum(size || 1024);
    this.floorDb = -90;
    this.topDb = 6;
    this.span = 0;
    this.buf = null;        /* an offscreen canvas we scroll */
    this.bufCtx = null;
  }
  Waterfall.prototype.draw = function (i, q, n, fs) {
    var f = fit(this.canvas);
    if (!f) return;
    var ctx = f.ctx, w = f.w, h = f.h;

    if (!this.buf || this.buf.width !== Math.round(w) || this.buf.height !== Math.round(h)) {
      this.buf = document.createElement('canvas');
      this.buf.width = Math.max(1, Math.round(w));
      this.buf.height = Math.max(1, Math.round(h));
      this.bufCtx = this.buf.getContext('2d');
      this.bufCtx.fillStyle = '#000004';
      this.bufCtx.fillRect(0, 0, this.buf.width, this.buf.height);
    }

    /* Scroll down by one row, then draw the new spectrum on the top row.
     * drawImage onto itself is the cheap way; a second buffer and a swap would
     * be cleaner and is not worth it at these sizes. */
    var bc = this.bufCtx, bw = this.buf.width, bh = this.buf.height;
    bc.drawImage(this.buf, 0, 1);

    var db = this.spec.compute(i, q, n, this.floorDb);
    var size = this.spec.size;
    var span = this.span > 0 ? this.span : fs / 2;
    var lo = Math.max(0, Math.floor(size / 2 - span / (fs / size)));
    var hi = Math.min(size, Math.ceil(size / 2 + span / (fs / size)));
    if (hi - lo < 8) { lo = 0; hi = size; }

    var img = bc.createImageData(bw, 1), lut = Palette.magma, x, k, t, c;
    for (x = 0; x < bw; x++) {
      k = lo + Math.floor(x / bw * (hi - lo));
      t = (db[k] - this.floorDb) / (this.topDb - this.floorDb);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      c = Math.round(t * 255) * 3;
      img.data[x * 4] = lut[c];
      img.data[x * 4 + 1] = lut[c + 1];
      img.data[x * 4 + 2] = lut[c + 2];
      img.data[x * 4 + 3] = 255;
    }
    bc.putImageData(img, 0, 0);

    ctx.drawImage(this.buf, 0, 0, w, h);
  };
  Plots.Waterfall = Waterfall;

  /* ===================================================================== */
  /* The phasor, which is where the article starts.                         */
  /* ===================================================================== */
  function Phasor(canvas) {
    this.canvas = canvas;
    this.scale = 1.6;
    this.showProjections = true;
  }
  Phasor.prototype.draw = function (i, q) {
    var f = fit(this.canvas);
    if (!f) return;
    var ctx = f.ctx, w = f.w, h = f.h;
    var size = Math.min(w, h), cx = w / 2, cy = h / 2, px = size / this.scale;

    ctx.fillStyle = UI.paper;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = UI.rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - size / 2, cy); ctx.lineTo(cx + size / 2, cy);
    ctx.moveTo(cx, cy - size / 2); ctx.lineTo(cx, cy + size / 2);
    ctx.stroke();

    var x = cx + i * px, y = cy - q * px;
    if (this.showProjections) {
      ctx.strokeStyle = UI.grid;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(x, cy);
      ctx.moveTo(x, y); ctx.lineTo(cx, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = Palette.at('viridis', 0.30);
      ctx.fillRect(x - 2.5, cy - 2.5, 5, 5);
      ctx.fillStyle = Palette.at('viridis', 0.85);
      ctx.fillRect(cx - 2.5, y - 2.5, 5, 5);
    }
    ctx.strokeStyle = UI.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy); ctx.lineTo(x, y);
    ctx.stroke();
    ctx.fillStyle = UI.accent;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, 2 * Math.PI);
    ctx.fill();

    label(ctx, 'I', cx + size / 2 - 10, cy + 4, 'right');
    label(ctx, 'Q', cx + 4, cy - size / 2 + 2, 'left');
  };
  Plots.Phasor = Phasor;

  root.SS = root.SS || {};
  root.SS.Plots = Plots;

})(typeof globalThis !== 'undefined' ? globalThis : this);
