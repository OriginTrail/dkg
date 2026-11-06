// One look per feedback state (see DESIGN.md): the rules that can be read from
// the code.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI = join(__dirname, '../src/ui');
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
));
const files = walk(UI);
const tsx = files.filter((f) => f.endsWith('.tsx'));
const matches = (list: string[], pattern: RegExp) => list.flatMap((file) => (
  [...readFileSync(file, 'utf8').matchAll(pattern)].map(([m]) => `${relative(UI, file)}: ${m.slice(0, 80)}`)
));

describe('feedback states', () => {
  it('ends loading copy with an ellipsis, not three dots', () => {
    expect(matches(tsx, /Loading [^'"`<\n]*\.\.\./g)).toEqual([]);
  });

  it('uses EmptyState, not the older markup', () => {
    expect(matches(tsx, /className="empty-state/g)).toEqual([]);
  });

  it('gives fields the same disabled look as buttons, and a red border when invalid', () => {
    const read = (name: string) => readFileSync(join(__dirname, '../src/ui/styles', name), 'utf8');
    expect(read('01-base.css')).toMatch(/button:disabled, input:disabled, textarea:disabled, select:disabled \{ opacity: var\(--opacity-disabled\)/);
    expect(read('27-ds-components.css')).toMatch(/\.ds-input\[aria-invalid="true"\]:not\(\[role="combobox"\]\) \{ border-color: var\(--accent-red\)/);
  });

  it('shows every disabled control the same way', () => {
    const css = files.filter((f) => f.endsWith('.css'));
    const found = css.flatMap((file) => [...readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*:disabled[^{}]*)\{([^{}]*)\}/g)]
      .filter(([, selector, body]) => !selector!.includes(':not(:disabled)') && /opacity:\s*[\d.]/.test(body!))
      .map(([, selector]) => `${relative(UI, file)}: ${selector!.trim()}`));
    expect(found).toEqual([]);
  });

  it('announces form errors', () => {
    expect(matches(tsx, /<div className="v10-modal-error[^>]*>/g).filter((m) => !m.includes('role='))).toEqual([]);
  });
});
