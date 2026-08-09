import { describe, expect, it } from 'vitest';
import {
  OxigraphStore,
  type TripleStore,
  type QueryOptions,
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
  it('deletes the exact registration subject through the structured mutation', async () => {
    const inner = new OxigraphStore();
    const deleteCalls: Array<{
      pattern: { graph?: string; subject?: string };
      options?: QueryOptions;
    }> = [];
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'deleteByPattern') {
          return (
            pattern: { graph?: string; subject?: string },
            options?: QueryOptions,
          ) => {
            deleteCalls.push({ pattern, options });
            return target.deleteByPattern(pattern);
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

    expect(deleteCalls).toEqual([{
      pattern: {
        graph: 'did:dkg:context-graph:review-cg/_meta',
        subject: 'did:dkg:context-graph:review-cg/temp',
      },
      options: { source: 'agent.cg.removeSubGraph.registration' },
    }]);
  });

  it('never sends a mutation through query() or raw update()', async () => {
    const inner = new OxigraphStore();
    let rawMutationCalls = 0;
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'update' || prop === 'query') {
          return async () => {
            rawMutationCalls++;
            throw new Error('raw mutation channel reached');
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

    expect(rawMutationCalls).toBe(0);
  });

  it('propagates a structured deletion failure', async () => {
    const inner = new OxigraphStore();
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'deleteByPattern') {
          return async () => { throw new Error('store unavailable'); };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;

    try {
      await expect(removeTempSubGraph(store)).rejects.toThrow('store unavailable');
    } finally {
      await store.close();
    }
  });
});
