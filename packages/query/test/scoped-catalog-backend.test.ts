import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BlazegraphStore, OxigraphStore, ChangelogStore } from '@origintrail-official/dkg-storage';
import { readScopedContentGraphCatalog } from '../src/scoped-content-graph-catalog.js';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

const endpoint = process.env.BLAZEGRAPH_TEST_URL;
if (process.env.DKG_REQUIRE_BLAZEGRAPH === '1' && !endpoint) throw new Error('Blazegraph CI endpoint is required');
describe(`scoped catalog on ${endpoint ? 'Blazegraph' : 'Oxigraph'}`, () => {
  it('inventories every nonempty same-context graph in one admission and scopes variable reads', async () => {
    const store = endpoint ? new BlazegraphStore(endpoint, { timeout: 2000 }) : new OxigraphStore();
    const id = `catalog-${randomUUID()}`, root = `did:dkg:context-graph:${id}`;
    const graphs = [root, `${root}/_verifiable_memory/a/1`, `${root}/_verifiable_memory/a/2`];
    const empty = `${root}/_verifiable_memory/empty/1`, unrelated = `urn:unrelated:${id}`;
    try {
      await store.insert([...graphs, unrelated].map((graph, n) => ({ graph, subject: `urn:s:${n}`, predicate: 'urn:name', object: `"value-${n}"` })));
      await store.update(`CREATE SILENT GRAPH <${empty}>`);
      let admissions = 0;
      const catalog = await readScopedContentGraphCatalog(id, query => { admissions++; return store.query(query); });
      expect(admissions).toBe(1);
      expect([...catalog.graphs].sort()).toEqual([...graphs].sort());
      const result = await new DKGQueryEngine(store).query('SELECT ?g ?name WHERE { GRAPH ?g { ?s <urn:name> ?name } }',
        { contextGraphId: id, includeContextGraphPartitions: true });
      expect(result.bindings.sort((a, b) => a.g!.localeCompare(b.g!))).toEqual(graphs.map((g, n) => ({ g, name: `"value-${n}"` })).sort((a, b) => a.g.localeCompare(b.g)));
      const decorated = new ChangelogStore(store, { reservedGraphs: [graphs[1]!] });
      const scoped = await new DKGQueryEngine(decorated).query('SELECT ?g ?name WHERE { GRAPH ?g { ?s <urn:name> ?name } }',
        { contextGraphId: id, includeContextGraphPartitions: true });
      expect(scoped.bindings.map(row => row.g).sort()).toEqual([graphs[0], graphs[2]].sort());
    } finally {
      for (const graph of [...graphs, empty, unrelated]) await store.dropGraph(graph);
      await store.close();
    }
  });
});
