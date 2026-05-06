import { describe, expect, it } from 'vitest';
import { createSourceRegistry } from '../src/source-registry.js';

describe('source registry', () => {
  it('registers and resolves handlers by source kind', async () => {
    const registry = createSourceRegistry<{ kind: string }, string>();
    registry.register('demo', {
      async computeFingerprint() { return 'fp'; },
      async prepare() { return { fingerprint: 'fp', assets: ['a'] }; },
    });

    expect(registry.has('demo')).toBe(true);
    expect(registry.listKinds()).toEqual(['demo']);
    const handler = registry.resolve({ kind: 'demo' });
    await expect(handler.computeFingerprint({ kind: 'demo' })).resolves.toBe('fp');
  });

  it('throws for unsupported source kinds', () => {
    const registry = createSourceRegistry<{ kind: string }, string>();
    expect(() => registry.resolve({ kind: 'missing' })).toThrow(/Unsupported source kind/);
  });
});
