import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { opTone, opChartColor } from '../src/ui/op-type-colors.js';

const DS_CSS = readFileSync(join(__dirname, '../src/ui/styles/27-ds-components.css'), 'utf8');
const toneRule = (tone: string) => {
  const at = DS_CSS.indexOf(`.op-tone-${tone} {`);
  return at < 0 ? '' : DS_CSS.slice(at, DS_CSS.indexOf('}', at));
};

describe('operation type colours (C4 / C5)', () => {
  it('colours operations by the layer they write to', () => {
    for (const t of ['publish', 'publishFromSWM', 'update', 'ka-update']) expect(opTone(t)).toBe('vm');
    for (const t of ['workspace', 'share']) expect(opTone(t)).toBe('swm');
    for (const t of ['query', 'sync', 'gossip', 'verify', 'reconstruct', 'system', 'unknown', undefined]) {
      expect(opTone(t as string | undefined)).toBe('neutral');
    }
  });

  it('uses layer tokens for labels and badges, set once in the op-tone classes', () => {
    expect(toneRule('vm')).toContain('--op-text: var(--layer-verified-text)');
    expect(toneRule('swm')).toContain('--op-bg: var(--layer-shared-bg)');
    expect(toneRule('neutral')).toContain('--op-text: var(--text-secondary)');
  });

  it('gives chart series distinct data-palette colours in type order', () => {
    const types = ['publish', 'query', 'sync', 'share'];
    const cols = types.map((t) => opChartColor(t, types));
    expect(new Set(cols).size).toBe(types.length);
    // CSS variables: SVG attributes resolve them, so charts follow the theme.
    expect(cols).toEqual(['var(--data-1)', 'var(--data-2)', 'var(--data-3)', 'var(--data-4)']);
    expect(opChartColor('unknown', types)).toBe('var(--data-1)');
  });
});
