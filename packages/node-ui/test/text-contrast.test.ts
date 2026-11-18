import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { composite, contrastRatio, parseColour } from './helpers/contrast.js';

// DESIGN.md · Colour: readable text clears 4.5:1 on the surface it sits on, in both
// themes, and `--text-ghost` is decoration only. This pins the text and surface pairs
// the UI uses, from the token values in 00-theme.css. (Badges and counts are checked in
// a real browser: browser-regressions/shell/badge-contrast.spec.ts.)

const styles = resolve(dirname(fileURLToPath(import.meta.url)), '../src/ui/styles');
const theme = readFileSync(resolve(styles, '00-theme.css'), 'utf8');

function block(selector: string): Map<string, string> {
  const start = theme.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No ${selector} block in 00-theme.css`);
  const body = theme.slice(theme.indexOf('{', start) + 1, theme.indexOf('\n}', start));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

const dark = block(':root');
const light = new Map([...dark, ...block(':root.light, body.light')]);

function resolveColour(tokens: Map<string, string>, name: string, depth = 0): string {
  const raw = tokens.get(name);
  if (!raw) throw new Error(`${name} is not defined`);
  const ref = /^var\((--[\w-]+)\)$/.exec(raw);
  if (ref && depth < 8) return resolveColour(tokens, ref[1], depth + 1);
  return raw;
}

/** The ratio of a text token on a surface token, compositing translucent text over the surface. */
function ratio(tokens: Map<string, string>, text: string, surface: string): number {
  const bg = parseColour(resolveColour(tokens, surface));
  const fg = composite(parseColour(resolveColour(tokens, text)), bg);
  const hex = (c: number[]) => '#' + c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  return contrastRatio(hex(fg), hex(bg));
}

const TEXT = ['--text-primary', '--text-secondary', '--text-tertiary', '--text-success', '--text-warning', '--text-danger'];
const SURFACES = ['--bg-root', '--bg-panel', '--bg-surface', '--bg-elevated'];
const LAYERS: Array<[string, string]> = [
  ['--layer-working-text', '--layer-working-bg'],
  ['--layer-shared-text', '--layer-shared-bg'],
  ['--layer-verified-text', '--layer-verified-bg'],
];

describe('text contrast (DESIGN.md · Colour)', () => {
  for (const [name, tokens] of [['dark', dark], ['light', light]] as const) {
    for (const text of TEXT) {
      for (const surface of SURFACES) {
        it(`${name}: ${text} on ${surface} clears 4.5:1`, () => {
          expect(ratio(tokens, text, surface)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
    for (const [text, surface] of LAYERS) {
      it(`${name}: ${text} on ${surface} clears 4.5:1`, () => {
        expect(ratio(tokens, text, surface)).toBeGreaterThanOrEqual(4.5);
      });
    }
    it(`${name}: primary button text clears 4.5:1`, () => {
      expect(ratio(tokens, '--text-on-primary', '--accent-primary')).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('--text-ghost is decoration only', () => {
  // Separators and marks with no words in them. Anything a person reads uses tertiary or stronger.
  const DECORATION = new Set([
    '.v10-header-meta-sep',
    '.v10-po-participant-tag::before',
    '.v10-ka-conn-arrow',
    '.v10-memstack-cell-sep',
    '.v10-project-strip-sep',
  ]);

  it('only colours the listed separators and marks', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(styles).filter((f) => f.endsWith('.css'))) {
      const css = readFileSync(resolve(styles, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        if (!/(^|[;\s])color\s*:\s*var\(--text-ghost\)/.test(m[2])) continue;
        for (const selector of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
          if (!DECORATION.has(selector)) offenders.push(`${file}: ${selector}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
