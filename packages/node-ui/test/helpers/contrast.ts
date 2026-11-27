/**
 * WCAG contrast maths over colours as a browser reports them. Shared by the
 * unit test (test/context-graph-contrast.test.ts) and the browser check
 * (browser-regressions/shell/badge-contrast.spec.ts), which reads every colour
 * with getComputedStyle so the real cascade decides what a badge looks like.
 */

import { parseColour as parseCssColour } from '../../scripts/colour.mjs';

/** sRGB channels 0–1 plus alpha 0–1. */
export type Rgba = [number, number, number, number];

/** Parse a colour (scripts/colour.mjs lists the formats) as channels 0–1 plus alpha; throws on anything else. */
export function parseColour(value: string): Rgba {
  const c = parseCssColour(value);
  if (!c) throw new Error(`Cannot parse colour ${value}`);
  return [c.rgb[0] / 255, c.rgb[1] / 255, c.rgb[2] / 255, c.alpha];
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
