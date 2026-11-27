/**
 * WCAG contrast maths over colours as a browser reports them. Shared by the
 * unit test (test/context-graph-contrast.test.ts) and the browser check
 * (browser-regressions/shell/badge-contrast.spec.ts), which reads every colour
 * with getComputedStyle so the real cascade decides what a badge looks like.
 */

/** sRGB channels 0–1 plus alpha 0–1. */
export type Rgba = [number, number, number, number];

/** Parse `#rgb`, `#rrggbb`, `rgb()`, `rgba()` or `color(srgb r g b / a)`. */
export function parseColour(value: string): Rgba {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (hex) {
    const raw = hex[1].length === 3 ? hex[1].split('').map((ch) => ch + ch).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16) / 255).concat(1) as Rgba;
  }
  if (v === 'transparent') return [0, 0, 0, 0];
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (rgb) {
    return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255, alpha(rgb[4])];
  }
  const srgb = /^color\(srgb\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (srgb) return [Number(srgb[1]), Number(srgb[2]), Number(srgb[3]), alpha(srgb[4])];
  throw new Error(`Cannot parse colour ${value}`);
}

function alpha(raw: string | undefined): number {
  if (raw === undefined) return 1;
  return raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw);
}

/** Paint `top` over an opaque `bottom`, as the screen shows it. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1) as Rgba;
}

export function luminance([r, g, b]: Rgba): number {
  const [lr, lg, lb] = [r, g, b].map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/** Contrast ratio of a foreground on a background; both are composited over `surface` first. */
export function contrastRatio(foreground: string, background: string, surface = '#ffffff'): number {
  const base = parseColour(surface);
  const bg = composite(parseColour(background), base);
  const fg = composite(parseColour(foreground), bg);
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
