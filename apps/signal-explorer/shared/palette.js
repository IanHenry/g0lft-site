/* Seeing signals: the two colour maps the published figures use.
 *
 * The article states the rule and the printed figures confirm it: density
 * colouring for signals captured off the air, time colouring for synthesised
 * ones. In matplotlib those are magma and viridis, and reproducing them is
 * what makes the tool's output line up with the printed panels rather than
 * merely resemble them.
 *
 * These are ten point samplings of each map with linear interpolation between,
 * which is close but is not the real thing. Matplotlib's maps are defined on
 * 256 entries derived from a perceptual model. The difference is invisible on
 * a moving constellation and would matter if anything here were ever printed
 * beside a real matplotlib figure, so it is written down rather than assumed
 * away.
 *
 * Both maps are perceptually uniform and both survive being printed in
 * greyscale, which is the property that made them worth copying in the first
 * place. Neither relies on telling red from green.
 */
(function (root) {
  'use strict';

  var Palette = {};

  /* viridis: purple, blue, green, yellow. The article describes exactly this
   * progression for the loopback captures, and uses it to show which way a
   * phasor is turning. */
  var VIRIDIS = [
    [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
    [31, 158, 137], [53, 183, 121], [110, 206, 88], [181, 222, 43], [253, 231, 37]
  ];

  /* magma: black, purple, red, orange, yellow. Used for density, where a bin
   * holding one sample must come out nearly black. */
  var MAGMA = [
    [0, 0, 4], [24, 15, 61], [68, 15, 118], [114, 31, 129], [158, 47, 127],
    [205, 64, 113], [241, 96, 93], [253, 150, 104], [254, 202, 141], [252, 253, 191]
  ];

  function build(stops) {
    var lut = new Uint8Array(256 * 3), k, x, seg, f, a, b, c;
    for (k = 0; k < 256; k++) {
      x = k / 255 * (stops.length - 1);
      seg = Math.min(stops.length - 2, Math.floor(x));
      f = x - seg;
      a = stops[seg]; b = stops[seg + 1];
      for (c = 0; c < 3; c++) lut[k * 3 + c] = Math.round(a[c] + (b[c] - a[c]) * f);
    }
    return lut;
  }

  Palette.viridis = build(VIRIDIS);
  Palette.magma = build(MAGMA);

  /* t from 0 to 1. Returns a css colour. Cached, because a constellation trace
   * asks for a few thousand of these per frame and building strings is the
   * expensive part. */
  function cacheOf(lut) {
    var cache = new Array(256), k;
    for (k = 0; k < 256; k++) {
      cache[k] = 'rgb(' + lut[k * 3] + ',' + lut[k * 3 + 1] + ',' + lut[k * 3 + 2] + ')';
    }
    return cache;
  }
  Palette.viridisCss = cacheOf(Palette.viridis);
  Palette.magmaCss = cacheOf(Palette.magma);

  Palette.at = function (name, t) {
    var css = name === 'magma' ? Palette.magmaCss : Palette.viridisCss;
    var k = Math.round(t * 255);
    return css[k < 0 ? 0 : k > 255 ? 255 : k];
  };

  /* The tool's own furniture, kept away from the two data maps so nothing on a
   * plot can be mistaken for a value. */
  Palette.ui = {
    ink: '#1a1f24',
    inkSoft: '#5a6672',
    rule: '#ccd4da',
    grid: '#e8edf1',
    paper: '#ffffff',
    accent: '#1c5d7a',
    warn: '#a32b2b'
  };

  root.SS = root.SS || {};
  root.SS.Palette = Palette;
  if (typeof module !== 'undefined' && module.exports) module.exports = Palette;

})(typeof globalThis !== 'undefined' ? globalThis : this);
