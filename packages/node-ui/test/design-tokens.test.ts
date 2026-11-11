/**
 * Design token check (DESIGN.md · Checks).
 *
 * Fails when a change adds a hard-coded colour or corner size to the node UI
 * instead of using a token from styles/00-theme.css. Existing values are
 * counted per file in fixtures/design-token-baseline.json; a file may never
 * go above its baseline. After removing hard-coded values, lower the
 * baseline with:
 *
 *   UPDATE_DESIGN_BASELINE=1 pnpm vitest run test/design-tokens.test.ts
 *
 * The update only ever lowers counts, so it can't be used to let new
 * hard-coded values in.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const UI = resolve(__dirname, '../src/ui');
const BASELINE_PATH = resolve(__dirname, 'fixtures/design-token-baseline.json');

type Kind = 'colour' | 'radius';
type Counts = Record<string, Partial<Record<Kind, number>>>;

/** Where colour values legitimately live. */
const COLOUR_SOURCES = new Set([
  'styles/00-theme.css', // the tokens themselves
]);
/** Canvas palettes: graph-viz draws with literal colours read from these. */
const isPaletteFile = (file: string) => /(^|\/)[\w-]*-colors\.ts$/.test(file);
/** Local test harness pages and mock data are not product UI. */
const isIgnored = (file: string) => /(^|\/)__/.test(file) || file.startsWith('mocks/');

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const COLOUR_FN = /\b(?:rgba?|hsla?)\(\s*[\d.]/g;
const CSS_RADIUS = /radius\s*:\s*([^;{}]+)/g;
const JS_RADIUS = /borderRadius\s*:\s*(['"`]?)([^,}\n]+?)\1\s*[,}\n]/g;
const QUOTED_HEX = /(['"`])#[0-9a-fA-F]{3,8}\1/g;
const QUOTED_COLOUR_FN = /(['"`])(?:rgba?|hsla?)\(\s*[\d.]/g;

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
    for (const m of js.matchAll(QUOTED_HEX)) add('colour', m.index!);
    for (const m of js.matchAll(QUOTED_COLOUR_FN)) add('colour', m.index!);
  }
  for (const m of js.matchAll(JS_RADIUS)) if (isRawRadius(m[2])) add('radius', m.index!);
  // CSS written inside template strings (e.g. a page's own <style>).
  for (const m of js.matchAll(/border-radius\s*:\s*([^;'"`}]+)/g)) if (isRawRadius(m[1])) add('radius', m.index!);
  return hits;
}

function collect(): { counts: Counts; hits: Record<string, Hit[]> } {
  const counts: Counts = {};
  const hits: Record<string, Hit[]> = {};
  for (const full of walk(UI)) {
    const file = relative(UI, full).split('\\').join('/');
    if (isIgnored(file)) continue;
    const found = scan(file, readFileSync(full, 'utf8'));
    if (!found.length) continue;
    hits[file] = found;
    for (const h of found) {
      counts[file] ??= {};
      counts[file][h.kind] = (counts[file][h.kind] ?? 0) + 1;
    }
  }
  return { counts, hits };
}

function sorted(counts: Counts): Counts {
  return Object.fromEntries(Object.keys(counts).sort().map((f) => [f, counts[f]]));
}

describe('design tokens', () => {
  const { counts, hits } = collect();
  const baseline: Counts = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : {};

  if (process.env.UPDATE_DESIGN_BASELINE) {
    // Only ever lower: a file's new allowance is the smaller of old and current.
    const lowered: Counts = {};
    for (const [file, kinds] of Object.entries(baseline)) {
      for (const kind of Object.keys(kinds) as Kind[]) {
        const next = Math.min(kinds[kind] ?? 0, counts[file]?.[kind] ?? 0);
        if (next > 0) (lowered[file] ??= {})[kind] = next;
      }
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted(lowered), null, 2)}\n`);
  }

  it('adds no hard-coded colours or corner sizes (use the tokens in styles/00-theme.css)', () => {
    const over: string[] = [];
    for (const [file, kinds] of Object.entries(counts)) {
      for (const kind of Object.keys(kinds) as Kind[]) {
        const now = kinds[kind] ?? 0;
        const allowed = baseline[file]?.[kind] ?? 0;
        if (now <= allowed) continue;
        const lines = hits[file].filter((h) => h.kind === kind).sort((a, b) => a.line - b.line).slice(0, 12).map((h) => `      ${file}:${h.line}  ${h.text}`);
        over.push(`  ${file}: ${now} hard-coded ${kind === 'colour' ? 'colours' : 'corner sizes'} (allowed ${allowed})\n${lines.join('\n')}`);
      }
    }
    expect(over, `Use a token instead (DESIGN.md · Colour / Shape and size):\n${over.join('\n')}`).toEqual([]);
  });

  it('keeps the baseline current (lower it after removing hard-coded values)', () => {
    const stale: string[] = [];
    for (const [file, kinds] of Object.entries(baseline)) {
      for (const kind of Object.keys(kinds) as Kind[]) {
        const now = counts[file]?.[kind] ?? 0;
        if (now < (kinds[kind] ?? 0)) stale.push(`  ${file} ${kind}: baseline ${kinds[kind]}, now ${now}`);
      }
    }
    expect(stale, `Run UPDATE_DESIGN_BASELINE=1 pnpm vitest run test/design-tokens.test.ts:\n${stale.join('\n')}`).toEqual([]);
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
  });
});
