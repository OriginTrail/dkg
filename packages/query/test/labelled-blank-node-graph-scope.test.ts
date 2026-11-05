import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BlazegraphStore, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { materializePreparedSparql, prepareSparql } from '@origintrail-official/dkg-rdf-utils/sparql';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { prepareGraphScope, wrapWithDeduplicatedGraphValues, wrapWithGraphUnion } from '../src/sparql-graph-scope.js';

const endpoint = process.env.BLAZEGRAPH_TEST_URL;
if (process.env.DKG_REQUIRE_BLAZEGRAPH === '1' && !endpoint) throw new Error('Blazegraph CI endpoint is required');
const routes = { deduplicated: wrapWithDeduplicatedGraphValues, union: wrapWithGraphUnion };
function rewrite(query: string, graphs: string[], route: keyof typeof routes) {
  const prepared = prepareSparql(query);
  if (prepared.status !== 'valid') throw new Error('Invalid fixture');
  const rewritten = routes[route](prepareGraphScope(prepared), graphs);
  if (rewritten.kind !== 'ready') throw new Error(`Unexpected refusal: ${rewritten.reason}`);
  return materializePreparedSparql(rewritten.value.prepared);
}

describe(`labelled blank-node patterns on ${endpoint ? 'Blazegraph' : 'Oxigraph'}`, () => {
  it.each(['deduplicated', 'union'] as const)('preserves joins within each %s copy and excludes other graphs', async (route) => {
    const store = endpoint ? new BlazegraphStore(endpoint) : new OxigraphStore();
    const prefix = `urn:blank-scope:${randomUUID()}`;
    const graphs = [prefix + ':one', prefix + ':two', prefix + ':three'];
    const outside = prefix + ':outside';
    const data: Quad[] = [
      ...[...graphs, outside].flatMap((graph, index) => [
        { graph, subject: `${prefix}:s${index}`, predicate: 'urn:p', object: `_:b${index}` },
        { graph, subject: `_:b${index}`, predicate: 'urn:q', object: `"value${index}"` },
      ]),
      // Two distinct witnesses must retain two projected rows, not DISTINCT them.
      { graph: graphs[0], subject: `${prefix}:s0`, predicate: 'urn:p', object: '_:other' },
      { graph: graphs[0], subject: '_:other', predicate: 'urn:q', object: '"value0"' },
      // This graph uses a renamed pattern: repeated labels must still join one
      // witness, preserve legitimate duplicates, and exclude a disconnected q.
      { graph: graphs[1], subject: `${prefix}:s1`, predicate: 'urn:p', object: '_:second' },
      { graph: graphs[1], subject: '_:second', predicate: 'urn:q', object: '"value1"' },
      { graph: graphs[1], subject: '_:disconnected', predicate: 'urn:q', object: '"decoy"' },
      // The deduplicated route renames its earlier-graph anti-join. Disconnected
      // witnesses there must not suppress a valid mapping from the next graph.
      { graph: graphs[0], subject: `${prefix}:shared`, predicate: 'urn:p', object: '_:left' },
      { graph: graphs[0], subject: '_:right', predicate: 'urn:q', object: '"shared"' },
      { graph: graphs[1], subject: `${prefix}:shared`, predicate: 'urn:p', object: '_:joined' },
      { graph: graphs[1], subject: '_:joined', predicate: 'urn:q', object: '"shared"' },
    ];
    try {
      await store.insert(data);
      for (const label of ['h', '__dkgCopy0', 'é', String.raw`\u0068`]) {
        const query = `SELECT ?s ?o WHERE { ?s <urn:p> _:${label} . _:${label} <urn:q> ?o }`;
        const rows = await store.query(rewrite(query, graphs, route));
        expect(rows.bindings.map(row => `${row.s} ${row.o}`).sort()).toEqual([
          `${prefix}:s0 "value0"`, `${prefix}:s0 "value0"`, `${prefix}:s1 "value1"`, `${prefix}:s1 "value1"`, `${prefix}:s2 "value2"`, `${prefix}:shared "shared"`,
        ]);
      }
      const count = await store.query(rewrite('SELECT (COUNT(*) AS ?n) WHERE { ?s <urn:p> _:h . _:h <urn:q> ?o }', graphs, route));
      expect(count.bindings[0]?.n).toMatch(/^"6"/);
    } finally {
      for (const graph of [...graphs, outside]) await store.dropGraph(graph);
      await store.close();
    }
  });

  it('executes a labelled pattern through the real multi-graph VM query engine', async () => {
    const store = endpoint ? new BlazegraphStore(endpoint) : new OxigraphStore();
    const id = `blank-vm-${randomUUID()}`;
    const root = `did:dkg:context-graph:${id}`;
    const graphs = [`${root}/_verifiable_memory/a/1`, `${root}/_verifiable_memory/a/2`];
    try {
      await store.insert(graphs.flatMap((graph, index) => [
        { graph, subject: `urn:item:${index}`, predicate: 'urn:p', object: `_:vm${index}` },
        { graph, subject: `_:vm${index}`, predicate: 'urn:q', object: `"value${index}"` },
      ]));
      const result = await new DKGQueryEngine(store).query('SELECT ?s ?o WHERE { ?s <urn:p> _:h . _:h <urn:q> ?o }',
        { contextGraphId: id, view: 'verifiable-memory' });
      expect(result.bindings.sort((a, b) => a.s!.localeCompare(b.s!))).toEqual([
        { s: 'urn:item:0', o: '"value0"' }, { s: 'urn:item:1', o: '"value1"' },
      ]);
    } finally {
      for (const graph of graphs) await store.dropGraph(graph);
      await store.close();
    }
  });

  it('does not rewrite label-like text inside strings, comments or IRIs', () => {
    const query = `SELECT ?s WHERE { ?s <urn:p:_:\u0068> _:h . _:h <urn:q> "_:h" . # _:h
 }`;
    const rewritten = rewrite(query, ['urn:g1', 'urn:g2'], 'deduplicated');
    expect(rewritten.match(/"_:h"/g)).toHaveLength(2);
    expect(rewritten.match(/# _:h/g)).toHaveLength(2);
    expect(rewritten.match(/<urn:p:_:h>/g)).toHaveLength(2);
  });
});
