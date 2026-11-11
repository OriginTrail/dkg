// Icons come from one set: Lucide for actions and things, LayerGlyph for
// memory layers, StatusGlyph for status (see DESIGN.md). Emoji and Unicode
// symbols render differently per platform and can't carry a size or colour.
import { describe, expect, it } from 'vitest';
import { codeFiles, cssFiles, findAll, tsxFiles } from './helpers/source.js';

// Arrows, technical symbols, shapes, dingbats and emoji.
const GLYPH = /[×←-⇿⌀-⏿■-➿⤀-⥿⬀-⯿\u{1f300}-\u{1faff}]/gu;
// Typography rather than icons: text arrows inside a sentence or link.
const ALLOWED = new Set(['→', '←']);

const stripComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s\/\/ .*$/gm, '');

describe('icons', () => {
  it('keeps icons to the size scale', () => {
    expect(findAll(tsxFiles, /\bsize=\{(10|11|13|15)\}/g, { show: (m) => m[1]! })).toEqual([]);
  });

  it('uses no emoji or symbol characters as icons in the UI code', () => {
    expect(findAll(codeFiles, GLYPH, { prepare: stripComments, keep: ([glyph]) => !ALLOWED.has(glyph) })).toEqual([]);
  });

  it('never prints an icon into a string, where it would read [object Object]', () => {
    expect(findAll(codeFiles, /\$\{[\w.]*[iI]con\}/g, { show: ([m]) => m })).toEqual([]);
  });

  it('puts the refresh icon on every text Refresh and Retry button', () => {
    expect(findAll(tsxFiles, /(?<!\/)>\s*(Retry|Refresh)[^<{\n]*<\/button>/g, { show: ([m]) => m })).toEqual([]);
  });

  it('draws no symbol characters from CSS', () => {
    const found = findAll(cssFiles, /content:\s*["']([^"']+)["']/g, {
      prepare: stripComments,
      keep: ([, value]) => !!value!.match(GLYPH),
      show: ([, value]) => value!,
    });
    expect(found).toEqual([]);
  });
});
