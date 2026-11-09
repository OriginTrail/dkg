import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { OxigraphWorkerStore, GraphSetIndexStore, ATOMIC_GRAPH_REPLACE_STAGING_PREFIX } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

it('counts a populated subgraph through the default worker when static roots are absent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'typed-stats-worker-'));
  const store = new OxigraphWorkerStore(join(directory, 'store'));
  const root = 'did:dkg:context-graph:worker-stats', code = `${root}/code`, graph = `${code}/_verifiable_memory/a/1`;
  try {
    await store.insert([
      { subject: code, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: `${root}/_meta` },
      { subject: code, predicate: 'http://schema.org/name', object: '"code"', graph: `${root}/_meta` },
      ...[1, 2].map(i => ({ graph, subject: 'urn:s', predicate: `urn:p:${i}`, object: '"v"' })),
    ]);
    const engine = new DKGQueryEngine(store);
    const inventory = await engine.listContextGraphQueryPartitionReads('worker-stats');
    expect(inventory.some(read => read.graph === root)).toBe(false);
    expect(inventory.some(read => read.graph === graph)).toBe(true);
    const stats = await engine.readContextGraphNamedGraphStats('worker-stats');
    expect(stats.find(row => row.graph === graph)).toEqual({ graph, entityCount: 1, tripleCount: 2 });
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

it.each([false, true])('keeps worker statistics inventory work independent of batch count (indexed=%s)', async indexed => {
  const directory = await mkdtemp(join(tmpdir(), 'typed-stats-bounded-worker-'));
  const worker = new OxigraphWorkerStore(join(directory, 'store'));
  const store = indexed ? new GraphSetIndexStore(worker) : worker;
  const root = 'did:dkg:context-graph:worker-batches';
  const graphs = Array.from({ length: 80 }, (_, i) => `${root}/_verifiable_memory/author/${i}`);
  try {
    await store.insert([...graphs, `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}private`].map(graph =>
      ({ graph, subject: 'urn:s', predicate: 'urn:p', object: '"v"' })));
    const engine = new DKGQueryEngine(store);
    const enumerate = vi.spyOn(worker, 'listGraphs');
    let batches = 0;
    const stats = await engine.readContextGraphNamedGraphStats('worker-batches', {}, async (_admission, read) => {
      batches++;
      enumerate.mockClear();
      const result = await read();
      expect(enumerate).not.toHaveBeenCalled();
      return result;
    });
    expect(batches).toBe(10);
    expect(stats.map(row => row.graph).sort()).toEqual(graphs.sort());
    expect(store.graphEnumerationVisibility?.(`${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}private`)).toBe(false);
    expect(await store.listGraphs()).not.toContain(`${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}private`);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
