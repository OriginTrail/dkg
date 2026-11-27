import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// DESIGN.md · Colour: `--text-ghost` is decoration only. Contrast itself is checked in a
// real browser (browser-regressions/shell/badge-contrast.spec.ts); this pins where the
// stylesheets may use ghost as a text colour.

const styles = resolve(dirname(fileURLToPath(import.meta.url)), '../src/ui/styles');

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
