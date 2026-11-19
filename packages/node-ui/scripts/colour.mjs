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

/**
 * Reads a CSS colour, or returns null if it isn't one: `#rgb`, `#rgba`, `#rrggbb`,
 * `#rrggbbaa`, `rgb()`/`rgba()` and `hsl()`/`hsla()` with commas or spaces and an
 * optional `/ alpha` (a number or a percentage), `color(srgb r g b / a)` as
 * getComputedStyle reports it, and `transparent`. `color(srgb …)` keeps its precision.
 * @param {string} value
 * @returns {Colour | null}
 */
export function parseColour(value) {
  const v = value.trim().toLowerCase();
  if (v === 'transparent') return { rgb: [0, 0, 0], alpha: 0 };
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
