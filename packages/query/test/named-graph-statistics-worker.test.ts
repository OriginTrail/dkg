import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { OxigraphWorkerStore } from '@origintrail-official/dkg-storage';
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
