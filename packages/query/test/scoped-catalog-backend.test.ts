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
    const assertion = `${root}/_working_memory/a/registered`, child = `${root}/child`;
    graphs.push(`${root}/code`, `${root}/code/_verifiable_memory/a/1`, assertion);
    const excluded = [child, `${child}/_verifiable_memory/a/1`, `${root}/_working_memory/a/unregistered`];
    const meta = `${root}/_meta`, childMeta = `${child}/_meta`;
    const empty = `${root}/_verifiable_memory/empty/1`, unrelated = `urn:unrelated:${id}`;
    try {
      await store.insert([...graphs, ...excluded, unrelated].map((graph, n) => ({ graph, subject: `urn:s:${n}`, predicate: 'urn:name', object: `"value-${n}"` })));
      await store.insert([
        ...['code', 'child'].flatMap(name => [
          { graph: meta, subject: `${root}/${name}`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph' },
          { graph: meta, subject: `${root}/${name}`, predicate: 'http://schema.org/name', object: `"${name}"` },
        ]),
        { graph: meta, subject: 'urn:assertion', predicate: 'http://dkg.io/ontology/assertionGraph', object: assertion },
        { graph: childMeta, subject: child, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://dkg.network/ontology#ContextGraph' },
      ]);
      await store.update(`CREATE SILENT GRAPH <${empty}>`);
      let admissions = 0;
      const catalog = await readScopedContentGraphCatalog(id, query => { admissions++; return store.query(query); });
      expect(admissions).toBe(1);
      expect([...catalog.graphs].sort()).toEqual([...graphs, ...excluded, meta, childMeta].sort());
      expect(catalog.subGraphs).toEqual(new Set(['code', 'child']));
      expect(catalog.assertionGraphs).toEqual(new Set([assertion]));
      expect(catalog.childContextGraphs).toEqual(new Set([child]));
      const result = await new DKGQueryEngine(store).query('SELECT ?g ?name WHERE { GRAPH ?g { ?s <urn:name> ?name } }',
        { contextGraphId: id, includeContextGraphPartitions: true });
      expect(result.bindings.sort((a, b) => a.g!.localeCompare(b.g!))).toEqual(graphs.map((g, n) => ({ g, name: `"value-${n}"` })).sort((a, b) => a.g.localeCompare(b.g)));
      const decorated = new ChangelogStore(store, { reservedGraphs: [graphs[1]!] });
      const scoped = await new DKGQueryEngine(decorated).query('SELECT ?g ?name WHERE { GRAPH ?g { ?s <urn:name> ?name } }',
        { contextGraphId: id, includeContextGraphPartitions: true });
      expect(scoped.bindings.map(row => row.g).sort()).toEqual(graphs.filter(g => g !== graphs[1]).sort());
    } finally {
      for (const graph of [...graphs, ...excluded, meta, childMeta, empty, unrelated]) await store.dropGraph(graph);
      await store.close();
    }
  });
});
