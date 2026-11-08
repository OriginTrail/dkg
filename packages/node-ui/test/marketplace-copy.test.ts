import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COPY, copy } from '../src/ui/marketplace/copy.generated.js';

const ROOT = fileURLToPath(new URL('../src/ui/marketplace', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(f) && f !== 'copy.generated.ts' ? [p] : [];
  });
}

describe('marketplace string table', () => {
  const code = sources(ROOT).map((p) => readFileSync(p, 'utf8')).join('\n');
  const literals = new Set([...code.matchAll(/['"]([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)['"]/g)].map((m) => m[1]));
  // Keys built from a template, as `activity.state.${c.state}`: any segment may stand in for a placeholder.
  const templates = [...code.matchAll(/`([a-z][a-z0-9-]*\.(?:[a-z0-9.-]|\$\{[^}]*\})+)`/g)]
    .map((m) => new RegExp(`^${m[1].replace(/\./g, '\\.').replace(/\$\{[^}]*\}/g, '[a-z0-9-]+')}$`));
  templates.push(/^off\.(buyer|seller)\.(title|body)$/);

  it('holds no key the section does not use', () => {
    const unused = Object.keys(COPY).filter((k) => !literals.has(k) && !templates.some((t) => t.test(k)));
    expect(unused).toEqual([]);
  });

  it('says what a missing key is, so a test can catch it', () => {
    expect(copy('no.such.key')).toBe('⟦missing copy: no.such.key⟧');
    expect(copy('catalog.covered', { trac: '2.5' })).toBe('2.5 TRAC left this epoch');
  });
});
