import { describe, expect, it } from 'vitest';
import { MemoryLayer, readGraphIri, readScope } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { READ_GRAPH_PLANNED_METHODS } from '../src/read-graph/adapter-contract.js';
import { wrapReadGraphLayer } from '../src/read-graph/read-graph-store.js';
import { startReadGraphs } from '../src/read-graph/startup.js';
import { CURRENT_READ_GRAPH_VERSIONS, readGraphStateCompareAndSet, type ReadGraphStateRow } from '../src/read-graph/state.js';

const KEPT = 'startup-settings-kept';
const OTHER = 'startup-settings-other';
const vm = (contextGraphId: string) => readGraphIri({ scope: readScope(contextGraphId), layer: MemoryLayer.VerifiableMemory });
const ready = (readGraph: string): ReadGraphStateRow => ({ readGraph, state: 'ready', generation: 3, ...CURRENT_READ_GRAPH_VERSIONS });
/** An in-memory engine that declares every planned method, as a maintaining adapter does. */
const maintaining = () => Object.assign(new OxigraphStore(), { readGraphCapabilities: { methods: READ_GRAPH_PLANNED_METHODS, serialUpdates: true } });

describe('read-graph start-up and the node\'s settings', () => {
  it('maintains what the runtime\'s settings keep when not told what to maintain, and nothing without such a setting', async () => {
    const adapter = maintaining();
    const store = wrapReadGraphLayer(adapter, {
      backend: 'oxigraph',
      readGraphs: { modes: { contextGraphs: { [KEPT]: { layers: { [MemoryLayer.VerifiableMemory]: 'build' } } } } },
    });
    await adapter.update([readGraphStateCompareAndSet(undefined, ready(vm(KEPT))), readGraphStateCompareAndSet(undefined, ready(vm(OTHER)))].join(';\n'));
    // The kept read graph is maintained: the mirror holds it. With no registry recorded for its ready row, it is marked dirty to be
    // rebuilt. The other takes the rule of a release that does not maintain it: marked dirty, and out of the mirror.
    expect(await startReadGraphs(store)).toEqual({ marked: 2, maintained: 1 });
    expect(store.runtime.mirror.get(vm(KEPT))?.state).toBe('dirty');
    expect(store.runtime.mirror.get(vm(OTHER))).toBeUndefined();

    // With every read graph off, start-up is that of a release that does not maintain read graphs.
    const plain = maintaining();
    const unset = wrapReadGraphLayer(plain, { backend: 'oxigraph' });
    await plain.update(readGraphStateCompareAndSet(undefined, ready(vm(KEPT))));
    expect(await startReadGraphs(unset)).toEqual({ marked: 1, maintained: 0 });
    expect(unset.runtime.mirror.size).toBe(0);
  });
});
