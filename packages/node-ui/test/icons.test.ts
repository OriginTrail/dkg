// Icons come from one set: Lucide for actions and things, LayerGlyph for
// memory layers, StatusGlyph for status (see DESIGN.md). Emoji and Unicode
// symbols render differently per platform and can't carry a size or colour.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI = join(__dirname, '../src/ui');
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
));
const files = walk(UI);

// Arrows, technical symbols, shapes, dingbats and emoji.
const GLYPH = /[×←-⇿⌀-⏿■-➿⤀-⥿⬀-⯿\u{1f300}-\u{1faff}]/gu;
// Typography rather than icons: text arrows inside a sentence or link.
const ALLOWED = new Set(['→', '←', '↗']);

const stripComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s\/\/ .*$/gm, '');

describe('icons', () => {
  it('uses no emoji or symbol characters as icons in the UI code', () => {
    const found = files
      .filter((file) => /\.tsx?$/.test(file))
      .flatMap((file) => [...stripComments(readFileSync(file, 'utf8')).matchAll(GLYPH)]
        .filter(([glyph]) => !ALLOWED.has(glyph))
        .map(([glyph]) => `${relative(UI, file)}: ${glyph}`));
    expect(found).toEqual([]);
  });

  it('never prints an icon into a string, where it would read [object Object]', () => {
    const found = files
      .filter((file) => /\.tsx?$/.test(file))
      .flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/\$\{[\w.]*[iI]con\}/g)].map(([m]) => `${relative(UI, file)}: ${m}`));
    expect(found).toEqual([]);
  });

  it('puts the refresh icon on every text Refresh and Retry button', () => {
    const found = files
      .filter((file) => file.endsWith('.tsx'))
      .flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/(?<!\/)>\s*(Retry|Refresh)[^<{\n]*<\/button>/g)].map(([m]) => `${relative(UI, file)}: ${m}`));
    expect(found).toEqual([]);
  });

  it('draws no symbol characters from CSS', () => {
    const found = files
      .filter((file) => file.endsWith('.css'))
      .flatMap((file) => [...stripComments(readFileSync(file, 'utf8')).matchAll(/content:\s*["']([^"']+)["']/g)]
        .filter(([, value]) => value.match(GLYPH))
        .map(([, value]) => `${relative(UI, file)}: ${value}`));
    expect(found).toEqual([]);
  });
});
