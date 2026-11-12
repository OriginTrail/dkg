import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryLayer, readGraphIri, type ReadGraphKey } from '@origintrail-official/dkg-core';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { BlazegraphNamespaceManager, blazegraphNamespaceApiUrlFromSparqlEndpoint } from '../src/blazegraph-namespace-manager.js';
import { guardReadGraphPartition } from '../src/read-graph-partition-store.js';
import { ReadGraphBuilder } from '../src/read-graph/builder.js';
import { applyReadGraphModes } from '../src/read-graph/live-modes.js';
import { wrapReadGraphLayer, type ReadGraphStore } from '../src/read-graph/read-graph-store.js';
import { readGraphModeOf } from '../src/read-graph/settings.js';
import { buildReadGraph, markReadGraphDirty, removeReadGraph } from '../src/read-graph/rebuild.js';
import { readStoredReadGraphRow } from '../src/read-graph/stored-states.js';
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

  const triplesOf = async (graph: string, on: TripleStore = adapter) => {
    const result = await on.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
    return (result.type === 'bindings' ? result.bindings : []).map((b) => `${b.s} ${b.p} ${b.o}`).sort();
  };
  const expectUnion = async (layer: ReadGraphStore, fixture: LayerFixture, key: ReadGraphKey, on: TripleStore = adapter) => {
    const result = await on.query(`SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "${fixture.root}")) }`);
    const quads = result.type === 'bindings' ? result.bindings : [];
    const expected = [...new Set(quads.filter((b) => isLayerMember(layer, fixture, key, b.g!)).map((b) => `${b.s} ${b.p} ${b.o}`))].sort();
    expect(await triplesOf(readGraphIri(key), on), readGraphIri(key)).toEqual(expected);
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
    // With a data directory, where refused dirty marks would have been kept.
    const dataDir = mkdtempSync(join(tmpdir(), 'read-graph-builder-live-'));
    try {
      expect(await startReadGraphs(store, { dataDir, maintains: (key) => key.scope.contextGraphId === fixture.contextGraphId })).toMatchObject({ marked: 1 });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
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

  it('switches a layer on under write load, backfills it, and drops it once switched off', async () => {
    // A namespace of its own: its runtime is new, as a node's is at start.
    const [handle] = await manager!.acquireMany([`read-graph-live-modes-${randomUUID()}`]);
    const live = new BlazegraphStore(handle!.sparqlUrl, { timeout: 60_000 });
    const dataDir = mkdtempSync(join(tmpdir(), 'read-graph-live-modes-'));
    // Ended in `finally` whatever the assertions do, before the store closes and the namespace goes.
    let builder: ReadGraphBuilder | undefined;
    let stopped = false;
    let load: Promise<void> | undefined;
    try {
      const fixture = layerFixture(`modes-live-${randomUUID().slice(0, 8)}`);
      const layer = wrapReadGraphLayer(live, { backend: 'blazegraph', options: { url: handle!.sparqlUrl } });
      const store = guardReadGraphPartition(layer);
      await live.insert([
        ...fixture.facts,
        ...fixture.graphs.flatMap((graph, i) => [q('urn:s:shared', '"both"', graph), q(`urn:s:${i}`, `"v${i}"`, graph)]),
      ]);
      await startReadGraphs(store, { dataDir });
      const [wholeVm, , codeVm] = fixture.keys as [ReadGraphKey, ReadGraphKey, ReadGraphKey];
      const vmKeys = () => fixture.keys.filter((key) => readGraphModeOf(layer.runtime.modes, key) !== 'off');
      builder = new ReadGraphBuilder({
        store, dataDir, intervalMs: 3_600_000, batching: { pauseRatio: 0, graphsPerBatch: 1, triplesPerDrop: 3 },
        wanted: vmKeys, off: (key) => readGraphModeOf(layer.runtime.modes, key) === 'off',
      });
      let writes = 0;
      load = (async () => {
        const graphs = [fixture.graphs[1]!, fixture.graphs[4]!, fixture.graphs[6]!];
        while (!stopped) {
          await store.insert([q(`urn:load:${writes}`, `"w${writes}"`, graphs[writes % graphs.length]!)]);
          if (writes % 3 === 2) await store.delete([q(`urn:load:${writes - 1}`, `"w${writes - 1}"`, graphs[(writes - 1) % graphs.length]!)]);
          writes += 1;
        }
      })();
      const on = await applyReadGraphModes(store, { contextGraphs: { [fixture.contextGraphId]: { layers: { [MemoryLayer.VerifiableMemory]: 'serve' } } } }, {
        dataDir, wanted: vmKeys,
      });
      expect(on.find((change) => change.layer === 'verifiable-memory')?.outcome).toBe('applied');
      expect((await readStoredReadGraphRow(live, readGraphIri(wholeVm))).row?.state).toBe('dirty');
      builder.request();
      await builder.whenIdle();
      stopped = true;
      await load;
      expect(writes).toBeGreaterThan(0);
      builder.request();
      await builder.whenIdle();
      for (const key of [wholeVm, codeVm]) {
        expect(layer.runtime.mirror.get(readGraphIri(key))?.state, readGraphIri(key)).toBe('ready');
        await expectUnion(layer, fixture, key, live);
      }

      const off = await applyReadGraphModes(store, { contextGraphs: { [fixture.contextGraphId]: { layers: { [MemoryLayer.VerifiableMemory]: 'off' } } } });
      expect(off.find((change) => change.layer === 'verifiable-memory')).toMatchObject({ from: 'serve', to: 'off', outcome: 'applied' });
      expect(layer.runtime.mirror.size).toBe(0);
      builder.request();
      await builder.whenIdle();
      await builder.close();
      for (const key of [wholeVm, codeVm]) {
        expect(await triplesOf(readGraphIri(key), live)).toEqual([]);
        expect(await readStoredReadGraphRow(live, readGraphIri(key))).toEqual({ row: undefined, damaged: false });
      }
    } finally {
      stopped = true;
      await load?.catch(() => undefined);
      await builder?.close();
      await live.close();
      await manager!.disposeAll([handle!]);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 180_000);
});
