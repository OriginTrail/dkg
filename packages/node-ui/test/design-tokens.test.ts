/**
 * Design token check (DESIGN.md · Checks).
 *
 * Fails when the node UI has a hard-coded colour or corner size instead of a
 * token from styles/00-theme.css. There is no allowance list: if no token
 * fits, add one to 00-theme.css and describe it in DESIGN.md.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const UI = resolve(__dirname, '../src/ui');

type Kind = 'colour' | 'radius';

/** Where colour values legitimately live. */
const COLOUR_SOURCES = new Set([
  'styles/00-theme.css', // the tokens themselves
  'styles/30-marketplace-tokens.css', // the Marketplace's own palette, scoped to its views
]);
/** Canvas palettes: graph-viz draws with literal colours read from these. */
const isPaletteFile = (file: string) => /(^|\/)[\w-]*-colors\.ts$/.test(file);
/** Local test harness pages and mock data are not product UI. */
const isIgnored = (file: string) => /(^|\/)__/.test(file) || file.startsWith('mocks/');

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const COLOUR_FN = /\b(?:rgba?|hsla?)\(\s*[\d.]/g;
const CSS_RADIUS = /radius\s*:\s*([^;{}]+)/g;
const JS_RADIUS = /borderRadius\s*:\s*(['"`]?)([^,}\n]+?)\1\s*[,}\n]/g;
/** Hex colours anywhere in code: a quoted value, a var() fallback, a gradient
 *  stop. Not HTML entities (&#10530;) and not issue numbers in comments
 *  (comments are stripped first). */
const JS_HEX = /(?<![&\w#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;

/** A radius value is hard-coded if it has a non-zero length that isn't a token. */
function isRawRadius(value: string): boolean {
  const v = value.replace(/var\([^)]*\)/g, '').replace(/!important/, '').trim();
  if (!v) return false;
  return v.split(/[\s/]+/).some((part) => /^-?\d*\.?\d+(px|rem|em)?$/.test(part) && Number.parseFloat(part) !== 0);
}

function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}
function stripJsComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(css|tsx?)$/.test(name) ? [full] : [];
  });
}

interface Hit { kind: Kind; line: number; text: string }

function scan(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  const lineOf = (index: number) => text.slice(0, index).split('\n').length;
  const add = (kind: Kind, index: number) => {
    const line = lineOf(index);
    hits.push({ kind, line, text: text.split('\n')[line - 1].trim().slice(0, 120) });
  };
  if (file.endsWith('.css')) {
    const css = stripCssComments(text);
    if (!COLOUR_SOURCES.has(file)) {
      for (const m of css.matchAll(HEX)) add('colour', m.index!);
      for (const m of css.matchAll(COLOUR_FN)) add('colour', m.index!);
    }
    for (const m of css.matchAll(CSS_RADIUS)) if (isRawRadius(m[1])) add('radius', m.index!);
    return hits;
  }
  const js = stripJsComments(text);
  if (!isPaletteFile(file)) {
    for (const m of js.matchAll(JS_HEX)) add('colour', m.index!);
    for (const m of js.matchAll(COLOUR_FN)) add('colour', m.index!);
  }
  for (const m of js.matchAll(JS_RADIUS)) if (isRawRadius(m[2])) add('radius', m.index!);
  // CSS written inside template strings (e.g. a page's own <style>).
  for (const m of js.matchAll(/border-radius\s*:\s*([^;'"`}]+)/g)) if (isRawRadius(m[1])) add('radius', m.index!);
  return hits;
}

function collect(): Record<string, Hit[]> {
  const hits: Record<string, Hit[]> = {};
  for (const full of walk(UI)) {
    const file = relative(UI, full).split('\\').join('/');
    if (isIgnored(file)) continue;
    const found = scan(file, readFileSync(full, 'utf8'));
    if (found.length) hits[file] = found;
  }
  return hits;
}

/** Every match of a pattern in the UI source, as "file  match". */
function findInUi(pattern: RegExp): string[] {
  return walk(UI).flatMap((full) => {
    const file = relative(UI, full).split('\\').join('/');
    if (isIgnored(file)) return [];
    return [...readFileSync(full, 'utf8').matchAll(pattern)].map((m) => `  ${file}  ${m[0]}`);
  });
}

describe('design tokens', { timeout: 20_000 }, () => {
  it('has no hard-coded colours or corner sizes (use the tokens in styles/00-theme.css)', () => {
    const found = Object.entries(collect()).flatMap(([file, hs]) =>
      hs.sort((a, b) => a.line - b.line).map((h) => `  ${file}:${h.line}  ${h.kind === 'colour' ? 'colour' : 'corner'}  ${h.text}`));
    expect(found, `Use a token instead (DESIGN.md · Colour / Shape and size):\n${found.join('\n')}`).toEqual([]);
  });

  it('has no text below the 11px floor (DESIGN.md · Type)', () => {
    const small = findInUi(/font-size:\s*(?:[0-9]|10)(?:\.\d+)?px|fontSize:\s*(?:[0-9]|10)(?:\.\d+)?\b/g);
    expect(small, `Use --fs-micro or larger:\n${small.join('\n')}`).toEqual([]);
  });

  it('uses whole pixels for type sizes (DESIGN.md · Type)', () => {
    const fractional = findInUi(/(?:font-size|--fs-[a-z-]+):\s*\d+\.\d+px|fontSize:\s*\d+\.\d+/g);
    expect(fractional, `Use a whole size on the type scale:\n${fractional.join('\n')}`).toEqual([]);
  });

  it('recognises hard-coded values and allows tokens', () => {
    expect(isRawRadius('8px')).toBe(true);
    expect(isRawRadius('0 6px 6px 0')).toBe(true);
    expect(isRawRadius('var(--radius-card)')).toBe(false);
    expect(isRawRadius('50%')).toBe(false);
    expect(isRawRadius('0')).toBe(false);
    expect(scan('styles/x.css', '.a { color: #fff; border-radius: 6px; }').map((h) => h.kind)).toEqual(['colour', 'radius']);
    expect(scan('styles/x.css', '.a { color: var(--text-primary); border-radius: var(--radius-control); }')).toEqual([]);
    expect(scan('styles/00-theme.css', ':root { --x: #fff; }')).toEqual([]);
    expect(scan('x.tsx', "const s = { color: '#a0a0a0', borderRadius: 8 };").map((h) => h.kind)).toEqual(['colour', 'radius']);
    expect(scan('x.tsx', "const s = { borderRadius: 'var(--radius-pill)' };")).toEqual([]);
    expect(scan('layer-colors.ts', "export const C = '#94a3b8';")).toEqual([]);
    // Every hex length: #rgb, #rgba, #rrggbb, #rrggbbaa.
    for (const hex of ['#fff', '#ffff', '#ffffff', '#ffffff80']) {
      expect(scan('x.tsx', `const s = { color: '${hex}' };`), hex).toHaveLength(1);
      expect(scan('x.tsx', `const c = 'var(--x, ${hex})';`), `${hex} as fallback`).toHaveLength(1);
    }
    expect(scan('x.tsx', 'const a = <span>&#1234;</span>;')).toEqual([]);
    // Colours inside a longer string: var() fallbacks, gradients, shadows.
    expect(scan('x.tsx', "const c = 'var(--accent-orange, #f97316)';")).toHaveLength(1);
    expect(scan('x.tsx', "const g = 'linear-gradient(180deg, rgba(13,17,23,1) 0%, var(--x) 100%)';")).toHaveLength(1);
    expect(scan('x.tsx', "const s = { boxShadow: '-8px 0 30px rgba(0,0,0,.3)' };")).toHaveLength(1);
    // Not colours: HTML entities, issue numbers in comments, template-built hues.
    expect(scan('x.tsx', 'const a = <span>&#10530;</span>; // see #959')).toEqual([]);
    expect(scan('x.tsx', 'const h = `hsl(${hue}, 60%, 50%)`;')).toEqual([]);
  });
});
