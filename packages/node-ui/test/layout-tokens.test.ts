// Layers, breakpoints, motion and line height come from fixed scales (see
// DESIGN.md · Layout and overlays).
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI = join(__dirname, '../src/ui');
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
));
const files = walk(UI);
const css = files.filter((f) => f.endsWith('.css'));
const tsx = files.filter((f) => f.endsWith('.tsx'));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const matches = (list: string[], pattern: RegExp, keep: (m: RegExpMatchArray) => boolean = () => true) => list.flatMap((file) => (
  [...strip(readFileSync(file, 'utf8')).matchAll(pattern)].filter(keep).map((m) => `${relative(UI, file)}: ${m[0].slice(0, 70)}`)
));

const OFF_SCALE_SPACING = 0;
// Values from data only: colours, sizes and positions the code works out at runtime.
const INLINE_STYLES = 40; // 37, plus the Marketplace meter bars' worked-out widths and heights (marketplace/purchase/Meters.tsx).
const INLINE_FONT_SIZES = 0; // Canvas options take numbers and sit outside style attributes.

describe('layout tokens', () => {
  it('uses a layer token for anything above 10', () => {
    expect(matches(css, /z-index:\s*(\d+)/g, (m) => Number(m[1]) > 10)).toEqual([]);
    expect(matches(tsx, /zIndex:\s*(\d+)/g, (m) => Number(m[1]) > 10)).toEqual([]);
  });

  it('keeps to the breakpoint scale', () => {
    const allowed = new Set(['600', '720', '860', '920', '1180', '1320', '1500']);
    expect(matches(css, /@media \(max-width:\s*(\d+)px\)/g, (m) => !allowed.has(m[1]!))).toEqual([]);
  });

  it('times transitions with the motion tokens', () => {
    expect(matches(css, /transition(?:-duration)?:[^;}]*?(?<![\w.-])\d*\.?\d+m?s\b[^;}]*/g, (m) => !/\.01ms/.test(m[0]))).toEqual([]);
  });

  it('sets type from the tokens', () => {
    const sheets = css.filter((f) => !f.endsWith('00-theme.css'));
    expect(matches(sheets, /font-size:\s*\d+px/g)).toEqual([]);
    expect(matches(sheets, /font-weight:\s*(\d+)/g, (m) => !['400', '500', '600', '700'].includes(m[1]!))).toEqual([]);
    expect(matches(sheets, /letter-spacing:\s*([^;}\s]+)/g, (m) => m[1] !== '0' && m[1] !== 'var(--ls-caps)')).toEqual([]);
  });

  // Inline sizes in style attributes. Only ever lower this.
  it('does not add inline font sizes', () => {
    expect(matches(tsx, /style=\{\{[^}]*\bfontSize:\s*\d/g).length).toBeLessThanOrEqual(INLINE_FONT_SIZES);
  });

  // 10 and 14 stay inside the nested padding tokens in 00-theme.css, and nowhere else.
  it('does not add spacing outside the scale', () => {
    const sheets = css.filter((f) => !f.endsWith('00-theme.css'));
    const spacing = /(?:padding|margin|gap)[a-z-]*\s*:[^;}]*/g;
    const offScale = sheets.flatMap((f) => [...strip(readFileSync(f, 'utf8')).matchAll(spacing)]
      .flatMap((m) => [...m[0].matchAll(/(?<![\w.#-])(\d+)px\b/g)].filter((v) => v[1] !== '1' && v[1] !== '0')));
    expect(offScale.length).toBeLessThanOrEqual(OFF_SCALE_SPACING);
  });

  it('does not add inline styles', () => {
    const count = tsx.filter((f) => !f.includes('design-system'))
      .reduce((n, f) => n + (readFileSync(f, 'utf8').match(/style=\{\{/g) ?? []).length, 0);
    expect(count).toBeLessThanOrEqual(INLINE_STYLES);
  });

  it('sets line height from the scale', () => {
    expect(matches(css, /line-height:\s*(\d*\.\d+)/g)).toEqual([]);
    expect(matches(tsx, /lineHeight:\s*(\d*\.\d+)/g)).toEqual([]);
  });
});
