// @ts-check
// One colour parser for the package: the design check (scripts/design-check.mjs) and
// the contrast checks (test/helpers/contrast.ts, which the unit and browser contrast
// checks share). Each caller keeps its own maths on top and decides what to do with
// a value this can't read. The JSDoc types are checked: tsconfig.type-tests.json runs
// tsc with checkJs over this file.

/** A CSS colour: channels 0–255 (not rounded) and alpha 0–1. @typedef {{ rgb: [number, number, number], alpha: number }} Colour */

/** Degrees in one of each CSS angle unit. */
const DEGREES = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };

/**
 * A CSS hue in degrees, 0 up to 360: `-120`, `240deg`, `0.5turn`, `3.14rad` and `200grad` all work.
 * @param {string} text
 * @returns {number}
 */
export function parseHue(text) {
  const m = /^(-?[\d.]+(?:e-?\d+)?)(deg|grad|rad|turn)?$/.exec(text);
  if (!m) return Number.NaN;
  const unit = /** @type {keyof typeof DEGREES} */ (m[2] ?? 'deg');
  const deg = Number(m[1]) * DEGREES[unit];
  return ((deg % 360) + 360) % 360;
}

/** The CSS named colours (CSS Color 4), as #rrggbb. */
export const NAMED_COLOURS = new Map(Object.entries({
  aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4', azure: 'f0ffff', beige: 'f5f5dc',
  bisque: 'ffe4c4', black: '000000', blanchedalmond: 'ffebcd', blue: '0000ff', blueviolet: '8a2be2', brown: 'a52a2a',
  burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00', chocolate: 'd2691e', coral: 'ff7f50', cornflowerblue: '6495ed',
  cornsilk: 'fff8dc', crimson: 'dc143c', cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b',
  darkgray: 'a9a9a9', darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b', darkmagenta: '8b008b', darkolivegreen: '556b2f',
  darkorange: 'ff8c00', darkorchid: '9932cc', darkred: '8b0000', darksalmon: 'e9967a', darkseagreen: '8fbc8f', darkslateblue: '483d8b',
  darkslategray: '2f4f4f', darkslategrey: '2f4f4f', darkturquoise: '00ced1', darkviolet: '9400d3', deeppink: 'ff1493', deepskyblue: '00bfff',
  dimgray: '696969', dimgrey: '696969', dodgerblue: '1e90ff', firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22',
  fuchsia: 'ff00ff', gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff', gold: 'ffd700', goldenrod: 'daa520', gray: '808080',
  green: '008000', greenyellow: 'adff2f', grey: '808080', honeydew: 'f0fff0', hotpink: 'ff69b4', indianred: 'cd5c5c',
  indigo: '4b0082', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa', lavenderblush: 'fff0f5', lawngreen: '7cfc00',
  lemonchiffon: 'fffacd', lightblue: 'add8e6', lightcoral: 'f08080', lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3',
  lightgreen: '90ee90', lightgrey: 'd3d3d3', lightpink: 'ffb6c1', lightsalmon: 'ffa07a', lightseagreen: '20b2aa', lightskyblue: '87cefa',
  lightslategray: '778899', lightslategrey: '778899', lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', lime: '00ff00', limegreen: '32cd32',
  linen: 'faf0e6', magenta: 'ff00ff', maroon: '800000', mediumaquamarine: '66cdaa', mediumblue: '0000cd', mediumorchid: 'ba55d3',
  mediumpurple: '9370db', mediumseagreen: '3cb371', mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc', mediumvioletred: 'c71585',
  midnightblue: '191970', mintcream: 'f5fffa', mistyrose: 'ffe4e1', moccasin: 'ffe4b5', navajowhite: 'ffdead', navy: '000080',
  oldlace: 'fdf5e6', olive: '808000', olivedrab: '6b8e23', orange: 'ffa500', orangered: 'ff4500', orchid: 'da70d6',
  palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee', palevioletred: 'db7093', papayawhip: 'ffefd5', peachpuff: 'ffdab9',
  peru: 'cd853f', pink: 'ffc0cb', plum: 'dda0dd', powderblue: 'b0e0e6', purple: '800080', rebeccapurple: '663399',
  red: 'ff0000', rosybrown: 'bc8f8f', royalblue: '4169e1', saddlebrown: '8b4513', salmon: 'fa8072', sandybrown: 'f4a460',
  seagreen: '2e8b57', seashell: 'fff5ee', sienna: 'a0522d', silver: 'c0c0c0', skyblue: '87ceeb', slateblue: '6a5acd',
  slategray: '708090', slategrey: '708090', snow: 'fffafa', springgreen: '00ff7f', steelblue: '4682b4', tan: 'd2b48c',
  teal: '008080', thistle: 'd8bfd8', tomato: 'ff6347', turquoise: '40e0d0', violet: 'ee82ee', wheat: 'f5deb3',
  white: 'ffffff', whitesmoke: 'f5f5f5', yellow: 'ffff00', yellowgreen: '9acd32',
}));

/**
 * Reads a CSS colour, or returns null if it isn't one: `#rgb`, `#rgba`, `#rrggbb`,
 * `#rrggbbaa`, `rgb()`/`rgba()` and `hsl()`/`hsla()` with commas or spaces and an
 * optional `/ alpha` (a number or a percentage), `color(srgb r g b / a)` as
 * getComputedStyle reports it, a named colour, and `transparent`. `color(srgb …)`
 * keeps its precision.
 * @param {string} value
 * @returns {Colour | null}
 */
export function parseColour(value) {
  const v = value.trim().toLowerCase();
  if (v === 'transparent') return { rgb: [0, 0, 0], alpha: 0 };
  const named = NAMED_COLOURS.get(v);
  if (named) return parseColour(`#${named}`);
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return { rgb: [r, g, b], alpha: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
  }
  const fn = /^(rgba?|hsla?|color)\(([^)]*)\)$/.exec(v);
  if (!fn) return null;
  let parts = fn[2].split(/[\s,/]+/).filter(Boolean);
  if (fn[1] === 'color') {
    if (parts[0] !== 'srgb') return null;
    parts = parts.slice(1);
  }
  if (parts.length < 3 || parts.length > 4) return null;
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : Number(parts[3]);
  if (Number.isNaN(alpha)) return null;
  /** @type {[number, number, number]} */
  let rgb;
  if (fn[1] === 'color') {
    rgb = [Number(parts[0]) * 255, Number(parts[1]) * 255, Number(parts[2]) * 255];
  } else if (fn[1].startsWith('rgb')) {
    /** @param {string} p */
    const channel = (p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : Number(p));
    rgb = [channel(parts[0]), channel(parts[1]), channel(parts[2])];
  } else {
    const [s, l] = [parts[1], parts[2]].map((p) => (p.endsWith('%') ? parseFloat(p) : Number.NaN));
    rgb = hslToRgb(parseHue(parts[0]), s / 100, l / 100);
  }
  return rgb.some(Number.isNaN) ? null : { rgb, alpha };
}

/** @param {number} h degrees 0–360 @param {number} s 0–1 @param {number} l 0–1 @returns {[number, number, number]} */
function hslToRgb(h, s, l) {
  /** @param {number} n */
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  /** @param {number} n */
  const f = (n) => Math.round((l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))) * 255);
  return [f(0), f(8), f(4)];
}
