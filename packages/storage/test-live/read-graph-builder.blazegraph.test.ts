import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryLayer, readGraphIri, type ReadGraphKey } from '@origintrail-official/dkg-core';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { BlazegraphNamespaceManager, blazegraphNamespaceApiUrlFromSparqlEndpoint } from '../src/blazegraph-namespace-manager.js';
import { guardReadGraphPartition } from '../src/read-graph-partition-store.js';
import { wrapReadGraphLayer, type ReadGraphStore } from '../src/read-graph/read-graph-store.js';
import { buildReadGraph, markReadGraphDirty, readStoredReadGraphRow, removeReadGraph } from '../src/read-graph/rebuild.js';
import { startReadGraphs } from '../src/read-graph/startup.js';
import { readGraphBackfillBatch } from '../src/read-graph/statements.js';
import type { TripleStoreConfig } from '../src/triple-store-composition.js';
import type { TripleStore } from '../src/triple-store.js';
import { isLayerMember, layerFixture, q, type LayerFixture } from '../test/helpers/read-graph-layer-conformance.js';

describe('read-graph builds on a live Blazegraph', () => {
  let manager: BlazegraphNamespaceManager | undefined;
  let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>> | undefined;
  let adapter: TripleStore;
  let config: TripleStoreConfig;

  beforeAll(async () => {
    if (!process.env.BLAZEGRAPH_TEST_URL) throw new Error('The live Blazegraph lane requires BLAZEGRAPH_TEST_URL');
    manager = new BlazegraphNamespaceManager({ namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(process.env.BLAZEGRAPH_TEST_URL) });
    handles = await manager.acquireMany([`read-graph-builder-${randomUUID()}`]);
    const url = handles[0]!.sparqlUrl;
    adapter = new BlazegraphStore(url, { timeout: 60_000 });
    config = { backend: 'blazegraph', options: { url } };
  }, 60_000);
  afterAll(async () => {
    await adapter?.close();
    if (manager && handles) await manager.disposeAll(handles);
  }, 60_000);

  const triplesOf = async (graph: string) => {
    const result = await adapter.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
    return (result.type === 'bindings' ? result.bindings : []).map((b) => `${b.s} ${b.p} ${b.o}`).sort();
  };
  const expectUnion = async (layer: ReadGraphStore, fixture: LayerFixture, key: ReadGraphKey) => {
    const result = await adapter.query(`SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "${fixture.root}")) }`);
    const quads = result.type === 'bindings' ? result.bindings : [];
    const expected = [...new Set(quads.filter((b) => isLayerMember(layer, fixture, key, b.g!)).map((b) => `${b.s} ${b.p} ${b.o}`))].sort();
    expect(await triplesOf(readGraphIri(key)), readGraphIri(key)).toEqual(expected);
  };

  it('builds read graphs to their members, keeps them across a start, rebuilds after a dirty mark and removes one', async () => {
    const fixture = layerFixture(`builder-live-${randomUUID().slice(0, 8)}`);
    const layer = wrapReadGraphLayer(adapter, config);
    const store = guardReadGraphPartition(layer);
    await adapter.insert([
      ...fixture.facts,
      ...fixture.graphs.flatMap((graph, i) => [q('urn:s:shared', '"both"', graph), q(`urn:s:${i}`, `"v${i}"`, graph)]),
    ]);
    const context = { store, batching: { pauseRatio: 0, graphsPerBatch: 2, triplesPerDrop: 3 } };
    for (const key of fixture.keys) {
      expect(await buildReadGraph(context, key), readGraphIri(key)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
      await expectUnion(layer, fixture, key);
    }
    // A write through the layer is maintained in every read graph it touches.
    await store.insert([q('urn:s:new', '"n"', fixture.graphs[1]!)]);
    const [vm, , code] = fixture.keys as [ReadGraphKey, ReadGraphKey, ReadGraphKey];
    await expectUnion(layer, fixture, vm);

    // A start keeps the ready rows it maintains, outside working memory.
    const { wholeVm, codeVm, agentWm } = fixture.readGraphs;
    const ready = layer.runtime.mirror.get(wholeVm)!;
    expect(await startReadGraphs(store, { maintains: (key) => key.scope.contextGraphId === fixture.contextGraphId })).toMatchObject({ marked: 1 });
    expect(layer.runtime.mirror.get(wholeVm)).toEqual(ready);
    expect(layer.runtime.mirror.get(agentWm)).toMatchObject({ state: 'dirty' });

    // A dirty mark, an operation of the earlier generation landing late, and the rebuild.
    expect(await markReadGraphDirty(context, wholeVm)).toMatchObject({ state: 'dirty', generation: ready.generation + 1 });
    await adapter.update!(readGraphBackfillBatch(wholeVm, { state: 'ready', generation: ready.generation }, [fixture.graphs[9]!]));
    expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done', row: { state: 'ready', generation: ready.generation + 2 } });
    await expectUnion(layer, fixture, vm);

    expect(await removeReadGraph(context, codeVm)).toMatchObject({ outcome: 'done', row: undefined });
    expect(await triplesOf(codeVm)).toEqual([]);
    expect(await readStoredReadGraphRow(adapter, codeVm)).toEqual({ row: undefined, damaged: false });
    expect(layer.runtime.mirror.get(readGraphIri(code))).toBeUndefined();
    expect(layer.runtime.mirror.get(readGraphIri({ ...vm, layer: MemoryLayer.VerifiableMemory }))?.state).toBe('ready');
  }, 120_000);
});
