// One colour parser for the package: the design check (scripts/design-check.mjs) and
// the contrast checks (test/helpers/contrast.ts, which the unit and browser contrast
// checks share). Each caller keeps its own maths on top and decides what to do with
// a value this can't read.

/**
 * A CSS colour as `{ rgb: [r, g, b], alpha }`: channels 0–255 (not rounded, so
 * `color(srgb …)` keeps its precision) and alpha 0–1. Null if it isn't one.
 *
 * Reads `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` and `hsl()`/`hsla()`
 * with commas or spaces and an optional `/ alpha` (a number or a percentage),
 * `color(srgb r g b / a)` as getComputedStyle reports it, and `transparent`.
 */
export function parseColour(value) {
  const v = value.trim().toLowerCase();
  if (v === 'transparent') return { rgb: [0, 0, 0], alpha: 0 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), alpha: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
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
  const n = parts.slice(0, 3).map((p) => parseFloat(p));
  if (n.some(Number.isNaN)) return null;
  if (fn[1] === 'color') return { rgb: n.map((c) => c * 255), alpha };
  if (fn[1].startsWith('rgb')) return { rgb: parts.slice(0, 3).map((p, i) => (p.endsWith('%') ? (n[i] / 100) * 255 : n[i])), alpha };
  return { rgb: hslToRgb(n[0], n[1] / 100, n[2] / 100), alpha };
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((c) => Math.round(c * 255));
}
