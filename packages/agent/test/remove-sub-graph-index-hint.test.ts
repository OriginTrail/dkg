import { describe, expect, it } from 'vitest';
import {
  OxigraphStore,
  type TripleStore,
  type UpdateOptions,
} from '@origintrail-official/dkg-storage';
import { ContextGraphRegistryMethods } from '../src/dkg-agent-cg-registry.js';

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
});
