// Layers, breakpoints, motion and line height come from fixed scales (see
// DESIGN.md · Layout and overlays).
import { describe, expect, it } from 'vitest';
import { classify, declarations, type Kind } from '../scripts/design-rules.mjs';
import { cssFiles as css, findAll, read, tsxFiles as tsx, where, withoutCssComments as strip } from './helpers/source.js';

const matches = (list: string[], pattern: RegExp, keep: (m: RegExpMatchArray) => boolean = () => true) => findAll(list, pattern, { prepare: strip, keep });

// Stylesheet rules come from scripts/design-rules.mjs, which design:check uses too, so the
// rule and its exceptions are written once. Here any literal a rule finds fails; the
// design check turns the same finding into a suggestion.
const literal = (kinds: Kind[], files = css) => files.flatMap((f) => declarations(read(f), '.css')
  .flatMap((d) => classify(d.prop, d.value)
    .filter((h) => kinds.includes(h.kind))
    .map((h) => `${where(f)}:${d.line} ${d.prop}: ${h.value}`)));
const sheets = css.filter((f) => !f.endsWith('00-theme.css'));

const OFF_SCALE_SPACING = 0;
// Values from data only: colours, sizes and positions the code works out at runtime.
const INLINE_STYLES = 40; // 37, plus the Marketplace meter bars' worked-out widths and heights (marketplace/purchase/Meters.tsx).
const INLINE_FONT_SIZES = 0; // Canvas options take numbers and sit outside style attributes.

describe('layout tokens', () => {
  it('uses a layer token for anything above 10', () => {
    expect(literal(['layer'])).toEqual([]);
    expect(matches(tsx, /zIndex:\s*(\d+)/g, (m) => Number(m[1]) > 10)).toEqual([]);
  });

  it('keeps to the breakpoint scale', () => {
    const allowed = new Set(['600', '720', '860', '920', '1180', '1320', '1500']);
    expect(matches(css, /@media \(max-width:\s*(\d+)px\)/g, (m) => !allowed.has(m[1]!))).toEqual([]);
  });

  it('times transitions with the motion tokens', () => {
    expect(literal(['motion'])).toEqual([]);
  });

  it('sets type from the tokens', () => {
    expect(literal(['type size', 'weight'], sheets)).toEqual([]);
    expect(matches(sheets, /letter-spacing:\s*([^;}\s]+)/g, (m) => m[1] !== '0' && m[1] !== 'var(--ls-caps)')).toEqual([]);
  });

  // Inline sizes in style attributes. Only ever lower this.
  it('does not add inline font sizes', () => {
    expect(matches(tsx, /style=\{\{[^}]*\bfontSize:\s*\d/g).length).toBeLessThanOrEqual(INLINE_FONT_SIZES);
  });

  // 10 and 14 stay inside the nested padding tokens in 00-theme.css, and nowhere else.
  it('does not add spacing outside the scale', () => {
    expect(literal(['spacing'], sheets).length).toBeLessThanOrEqual(OFF_SCALE_SPACING);
  });

  it('does not add inline styles', () => {
    const count = tsx.filter((f) => !f.includes('design-system'))
      .reduce((n, f) => n + (read(f).match(/style=\{\{/g) ?? []).length, 0);
    expect(count).toBeLessThanOrEqual(INLINE_STYLES);
  });

  it('sets line height from the scale', () => {
    expect(literal(['line height'])).toEqual([]);
    expect(matches(tsx, /lineHeight:\s*(\d*\.\d+)/g)).toEqual([]);
  });
});
