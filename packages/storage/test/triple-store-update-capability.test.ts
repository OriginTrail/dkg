import { describe, expect, it } from 'vitest';
import {
  BlazegraphStore,
  GraphSetIndexStore,
  OxigraphStore,
  SparqlHttpStore,
  deleteByPatternWithoutCount,
  supportsAtomicSparqlModify,
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

describe('supportsAtomicSparqlModify', () => {
  it('recognizes certified backends through decorators and refuses generic SPARQL updates', () => {
    const endpoint = 'http://store.test/query';
    const blazegraph = new BlazegraphStore(endpoint);
    expect(supportsAtomicSparqlModify(blazegraph)).toBe(true);
    expect(supportsAtomicSparqlModify(new GraphSetIndexStore(new OxigraphStore()))).toBe(true);
    expect(supportsAtomicSparqlModify(new GraphSetIndexStore(new SparqlHttpStore({ queryEndpoint: endpoint })))).toBe(false);
  });

  it.each(['update', 'flush'] as const)('refuses a decorator that hides the required %s operation', method => {
    const outer = new GraphSetIndexStore(new OxigraphStore());
    Object.defineProperty(outer, method, { value: undefined });
    expect(supportsAtomicSparqlModify(outer)).toBe(false);
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
