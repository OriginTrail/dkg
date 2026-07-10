import { describe, expect, it } from 'vitest';
import {
  OxigraphStore,
  type TripleStore,
  type UpdateOptions,
} from '@origintrail-official/dkg-storage';
import { ContextGraphRegistryMethods } from '../src/dkg-agent-cg-registry.js';

async function removeTempSubGraph(store: TripleStore): Promise<void> {
  await ContextGraphRegistryMethods.prototype.removeSubGraph.call(
    {
      store,
      publisher: { clearSubGraphOwnership: () => undefined },
      contextGraphMetaProjection: { markDirty: () => undefined },
      log: { info: () => undefined },
    } as never,
    'review-cg',
    'temp',
  );
}

describe('removeSubGraph graph-set maintenance', () => {
  it('declares the context-graph meta graph on the server-side deregistration update', async () => {
    const inner = new OxigraphStore();
    const updateCalls: Array<{ sparql: string; options?: UpdateOptions }> = [];
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'update') {
          return (sparql: string, options?: UpdateOptions) => {
            updateCalls.push({ sparql, options });
            return target.update(sparql, options);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;

    try {
      await removeTempSubGraph(store);
    } finally {
      await store.close();
    }

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].sparql).toContain('DELETE WHERE');
    expect(updateCalls[0].options).toEqual({
      source: 'agent.cg.removeSubGraph.registration',
      touchedGraphs: ['did:dkg:context-graph:review-cg/_meta'],
    });
  });

  it('falls back to query() when server-side update() is unavailable', async () => {
    const inner = new OxigraphStore();
    const queryCalls: string[] = [];
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'update') return undefined;
        if (prop === 'query') {
          return async (sparql: string) => {
            queryCalls.push(sparql);
            return { type: 'bindings' as const, bindings: [] };
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;

    try {
      await removeTempSubGraph(store);
    } finally {
      await store.close();
    }

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]).toContain('DELETE WHERE');
  });

  it('falls back to deleteByPattern() when the SPARQL update fails', async () => {
    const inner = new OxigraphStore();
    const deletePatterns: Array<{ graph?: string; subject?: string }> = [];
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'update') {
          return async () => { throw new Error('update unsupported'); };
        }
        if (prop === 'deleteByPattern') {
          return async (pattern: { graph?: string; subject?: string }) => {
            deletePatterns.push(pattern);
            return 0;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;

    try {
      await removeTempSubGraph(store);
    } finally {
      await store.close();
    }

    expect(deletePatterns).toEqual([{
      graph: 'did:dkg:context-graph:review-cg/_meta',
      subject: 'did:dkg:context-graph:review-cg/temp',
    }]);
  });
});
