import { describe, expect, it } from 'vitest';
import {
  deleteByPatternWithoutCount,
  UnsupportedTripleStoreCapabilityError,
  tryUpdateWithTouchedGraphs,
  type TripleStore,
} from '../src/index.js';

describe('deleteByPatternWithoutCount', () => {
  it('falls back to the counted operation for a third-party store without the capability', async () => {
    const calls: Array<{ pattern: { graph?: string }; source?: string }> = [];
    const store = {
      deleteByPattern: async (pattern: { graph?: string }, options?: { source?: string }) => {
        calls.push({ pattern, source: options?.source });
        return 7;
      },
    };

    await deleteByPatternWithoutCount(
      store,
      { graph: 'urn:test:graph' },
      { source: 'test.third-party-fallback' },
    );

    expect(calls).toEqual([{
      pattern: { graph: 'urn:test:graph' },
      source: 'test.third-party-fallback',
    }]);
  });

  it('prefers the no-count capability when the store provides it', async () => {
    let countedCalls = 0;
    let noCountCalls = 0;
    const store = {
      deleteByPattern: async () => {
        countedCalls += 1;
        return 1;
      },
      deleteByPatternWithoutCount: async () => {
        noCountCalls += 1;
      },
    };

    await deleteByPatternWithoutCount(store, { graph: 'urn:test:graph' });

    expect(noCountCalls).toBe(1);
    expect(countedCalls).toBe(0);
  });
});

describe('tryUpdateWithTouchedGraphs', () => {
  it('returns false for a typed unsupported-update signal from a decorator', async () => {
    const store = {
      update: async () => {
        throw new UnsupportedTripleStoreCapabilityError('update', 'TestDecorator');
      },
    } as unknown as TripleStore;

    await expect(
      tryUpdateWithTouchedGraphs(store, 'DELETE WHERE { ?s ?p ?o }', ['urn:test:graph']),
    ).resolves.toBe(false);
  });

  it('does not mask a genuine update execution failure', async () => {
    const failure = new Error('store is closed');
    const store = {
      update: async () => {
        throw failure;
      },
    } as unknown as TripleStore;

    await expect(
      tryUpdateWithTouchedGraphs(store, 'DELETE WHERE { ?s ?p ?o }', ['urn:test:graph']),
    ).rejects.toBe(failure);
  });
});
