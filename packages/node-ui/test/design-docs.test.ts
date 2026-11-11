/**
 * DESIGN.md stays in step with the code (DESIGN.md · Other tokens): every token
 * and ds component is described, and every token it names still exists.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const design = readFileSync(resolve(root, 'DESIGN.md'), 'utf8');
const theme = readFileSync(resolve(root, 'src/ui/styles/00-theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = [...new Set([...theme.matchAll(/(?:^|[;{\s])(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]))];

describe('DESIGN.md', () => {
  it('describes every token in 00-theme.css', () => {
    expect(tokens.filter((token) => !design.includes(token))).toEqual([]);
  });

  it('describes every ds component', () => {
    const components = readdirSync(resolve(root, 'src/ui/components/ds'))
      .filter((file) => file.endsWith('.tsx'))
      .map((file) => file.replace('.tsx', ''));
    expect(components.filter((name) => !design.includes(name))).toEqual([]);
  });

  it('names no token that has been removed', () => {
    const named = [...design.matchAll(/`(--[a-z0-9]+(?:-[a-z0-9]+)*)`/g)].map((m) => m[1]);
    expect([...new Set(named)].filter((token) => !tokens.includes(token))).toEqual([]);
  });
});
