import { describe, expect, it } from 'vitest';
import { opTone, opTypeText, opTypeBg, opChartColor } from '../src/ui/op-type-colors.js';

describe('operation type colours (C4 / C5)', () => {
  it('colours operations by the layer they write to', () => {
    for (const t of ['publish', 'publishFromSWM', 'update', 'ka-update']) expect(opTone(t)).toBe('vm');
    for (const t of ['workspace', 'share']) expect(opTone(t)).toBe('swm');
    for (const t of ['query', 'sync', 'gossip', 'verify', 'reconstruct', 'system', 'unknown', undefined]) {
      expect(opTone(t as string | undefined)).toBe('neutral');
    }
  });

  it('uses layer tokens for labels and badges', () => {
    expect(opTypeText('publish')).toBe('var(--layer-verified-text)');
    expect(opTypeBg('share')).toBe('var(--layer-shared-bg)');
    expect(opTypeText('query')).toBe('var(--text-secondary)');
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
