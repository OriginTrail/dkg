import { describe, expect, it } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  materializePreparedSparql,
  prepareSparql,
} from '@origintrail-official/dkg-rdf-utils/sparql';
import {
  prepareGraphScope,
  wrapWithDeduplicatedGraphValues,
} from '../src/sparql-graph-scope.js';

const graphs = ['urn:graph:one', 'urn:graph:two', 'urn:graph:three'];
const type = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const quad = (subject: string, predicate: string, object: string, graph: string): Quad => (
  { subject, predicate, object, graph }
);
const data = [
  quad('urn:s:1', 'urn:p:value', '"one"', graphs[0]),
  quad('urn:s:1', 'urn:p:other', '"two"', graphs[0]),
  quad('urn:s:2', 'urn:p:value', '"one"', graphs[0]),
  quad('urn:s:1', 'urn:p:value', '"one"', graphs[1]),
  quad('urn:s:3', 'urn:p:value', '"three"', graphs[1]),
  quad('urn:s:3', 'urn:p:value', '"three"', graphs[2]),
  quad('urn:self', 'urn:self', 'urn:self', graphs[2]),
  quad('urn:s:1', type, 'urn:Thing', graphs[0]),
  quad('urn:s:1', type, 'urn:Thing', graphs[2]),
  quad('_:first', 'urn:p:value', '"blank"', graphs[0]),
  quad('_:second', 'urn:p:value', '"blank"', graphs[1]),
  quad('urn:forbidden', 'urn:p:value', '"hidden"', 'urn:outside'),
];

function scope(source: string) {
  const prepared = prepareSparql(source);
  if (prepared.status !== 'valid') throw new Error('Expected valid test input');
  return prepareGraphScope(prepared);
}

function rewrite(source: string, selected: readonly string[] = graphs) {
  const result = wrapWithDeduplicatedGraphValues(scope(source), selected);
  if (result.kind !== 'ready') throw new Error(`Unexpected fallback: ${result.reason}`);
  return result.value;
}

function bag(rows: Record<string, string>[]) {
  return rows.map((row) => JSON.stringify(
    Object.fromEntries(Object.entries(row).sort()),
  )).sort();
}

describe('single-triple graph deduplication', () => {
  it.each([
    'SELECT (COUNT(?s) AS ?count) WHERE { ?s <urn:p:value> ?value }',
    'SELECT (COUNT(*) AS ?count) WHERE { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), "urn:s:")) }',
    'SELECT ?s WHERE { ?s <urn:p:value> ?o FILTER(?o = "one") }',
    'SELECT ?o WHERE { FILTER(STRSTARTS(STR(?s), "urn:s:")) ?s <urn:p:value> ?o }',
    'SELECT ?o WHERE { ?s <urn:p:value> ?o . FILTER(STRSTARTS(STR(?s), "urn:s:")) FILTER(?o != "three") }',
    'SELECT ?p (COUNT(*) AS ?count) WHERE { ?s ?p ?o FILTER(STRSTARTS(STR(?s), "urn:s:")) } GROUP BY ?p HAVING(COUNT(*) > 1)',
    'SELECT ?o WHERE { ?s <urn:p:value> ?o FILTER(BOUND(?s) && (!BOUND(?missing) || ?missing = "x")) }',
    'SELECT ?o WHERE { ?s <urn:p:value> ?o FILTER(?o IN ("one", "three")) }',
    'SELECT ?o WHERE { ?s <urn:p:value> ?o FILTER(STRSTARTS(LCASE(STR(?o)), "o") && STRLEN(STR(?o)) > 1) }',
    'SELECT ?o WHERE { ?s <urn:p:value> ?o FILTER(CONTAINS(STR(?s), "s:") && STRENDS(UCASE(STR(?o)), "E")) } ORDER BY ?o LIMIT 2 OFFSET 1',
    'SELECT ?s WHERE { ?s ?p ?o FILTER(?s = <urn:s:1>) }',
    'SELECT ?o WHERE { ?s <urn:p:value> ?o FILTER(?o = "FILTER RAND() { }" || ?o = "one") }',
    'SELECT ?o WHERE { ?s <urn:p:value> ?o FILTER(?o = 1/0) }',
    String.raw`SELECT $s WHERE { ?s ?p ?o . F\u0049LTER(STRSTARTS(STR($s), "urn:s:")) }`,
    'SELECT ?o WHERE { ?s <urn:p:value> ?o FILTER # opaque comment with RAND()\n (STRSTARTS(STR(?s), "urn:s:")) }',
    'SELECT (COUNT(*) AS ?count) WHERE { ?s ?p ?o }',
    'SELECT ?s WHERE { ?s ?p ?o . }',
    'SELECT ?o WHERE { ?s <urn:p:value> ?o }',
    'SELECT DISTINCT ?o WHERE { ?s <urn:p:value> ?o }',
    'SELECT (COUNT(DISTINCT ?o) AS ?count) WHERE { ?s <urn:p:value> ?o }',
    'SELECT ?p (COUNT(?s) AS ?count) WHERE { ?s ?p ?o } GROUP BY ?p',
    'SELECT ?p (COUNT(?s) AS ?count) WHERE { ?s ?p ?o } GROUP BY ?p HAVING(COUNT(?s)>1)',
    'SELECT ?s ?o WHERE { ?s ?s ?o }',
    'SELECT ?s WHERE { ?s <urn:self> ?s }',
    'SELECT * WHERE { ?s a ?o }',
    'PREFIX v: <urn:p:> SELECT ?s ?o WHERE { ?s v:value ?o . }',
    'SELECT ?s ?o WHERE { # opaque triple comment\n ?s <urn:p:value> ?o . } ORDER BY ?s ?o LIMIT 3 OFFSET 1',
    'SELECT ?s WHERE { $s <urn:p:value> ?o }',
    String.raw`SELECT ?s WHERE \u007B ?s <urn:p:value> ?\u006F . \u007D`,
  ])('matches the independently materialized authorized RDF union: %s', async (query) => {
    const store = new OxigraphStore();
    try {
      await store.insert(data);
      // RDF union removes mirrored triples, but different hidden triple
      // variables must still produce duplicate caller projections. Copy inside
      // one store so blank-node identity is preserved rather than reallocated.
      await store.update(`INSERT { ?s ?p ?o } WHERE {
        VALUES ?g { ${graphs.map((g) => `<${g}>`).join(' ')} }
        GRAPH ?g { ?s ?p ?o }
      }`);
      const rewritten = rewrite(query, [...graphs, graphs[0]]);
      expect(rewritten.source).toContain('SELECT DISTINCT');
      expect(rewritten.source).not.toContain('FILTER NOT EXISTS');
      const [actual, expected] = await Promise.all([
        store.query(materializePreparedSparql(rewritten.prepared)),
        store.query(materializePreparedSparql(scope(query).prepared)),
      ]);
      expect(bag(actual.bindings)).toEqual(bag(expected.bindings));
      expect(actual.bindings.some((row) => Object.values(row).includes('urn:forbidden')))
        .toBe(false);
    } finally {
      await store.close();
    }
  });

  it('retains projected-away multiplicity and hides every helper variable', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert(data);
      const rewritten = rewrite('SELECT ?o WHERE { ?s <urn:p:value> ?o }');
      const result = await store.query(rewritten.source);
      expect(result.bindings.filter((row) => row.o === '"one"')).toHaveLength(2);
      expect(result.bindings.filter((row) => row.o === '"blank"')).toHaveLength(2);
      expect(result.bindings).toHaveLength(5);
      expect(result.bindings.every((row) => Object.keys(row).join() === 'o')).toBe(true);
    } finally {
      await store.close();
    }
  });

  it.each([
    'SELECT ?s WHERE { ?s <urn:p:value> ?o ; <urn:p:other> ?other }',
    'SELECT ?s WHERE { ?s <urn:p:value> ?o . ?s <urn:p:other> ?other }',
    'SELECT ?s WHERE { ?s <urn:p:value>/<urn:p:other> ?o }',
    'SELECT ?s WHERE { ?s <urn:p:value>* ?o }',
    'SELECT ?s WHERE { ?s ^<urn:p:value> ?o }',
    'SELECT ?s WHERE { _:x <urn:p:value> ?s }',
    'SELECT ?s WHERE { <urn:s:1> <urn:p:value> ?s }',
    'SELECT ?s WHERE { ?s <urn:p:value> "one" }',
    'SELECT ?s WHERE { ?s <urn:p:value> ?o FILTER(RAND() < 0.5) }',
    'SELECT ?s WHERE { ?s <urn:p:value> ?o FILTER(STR(UUID()) != "") }',
    'SELECT ?s WHERE { ?s <urn:p:value> ?o FILTER(STRUUID() != "") }',
    'SELECT ?s WHERE { ?s <urn:p:value> ?o FILTER(BOUND(BNODE())) }',
    'SELECT ?s WHERE { ?s <urn:p:value> ?o FILTER(NOW() = NOW()) }',
    'SELECT ?s WHERE { ?s <urn:p:value> ?o FILTER(<urn:custom:function>(?s)) }',
    'PREFIX f: <urn:custom:> SELECT ?s WHERE { ?s <urn:p:value> ?o FILTER(f:test(?s)) }',
    String.raw`SELECT ?s WHERE { ?s <urn:p:value> ?o FILTER(R\u0041ND() < 0.5) }`,
    'SELECT ?s WHERE { ?s <urn:p:value> ?o FILTER STRSTARTS(STR(?s), "urn:s:") }',
    'SELECT ?s WHERE { ?s <urn:p:value> ?o FILTER(?o = "one") . ?s <urn:p:other> ?other }',
    'ASK WHERE { ?s <urn:p:value> ?o }',
    'CONSTRUCT { ?s <urn:p:value> ?o } WHERE { ?s <urn:p:value> ?o }',
    'DESCRIBE ?s WHERE { ?s <urn:p:value> ?o }',
  ])('retains the graph-rank strategy for unproven shapes: %s', (query) => {
    const rewritten = rewrite(query);
    expect(rewritten.source).toContain('FILTER NOT EXISTS');
    expect(rewritten.source).not.toContain('{ SELECT DISTINCT');
  });

  it.each([
    'SELECT ?s WHERE { ?s <urn:p:value> ?o OPTIONAL { ?s ?p ?other } }',
    'SELECT ?s WHERE { { SELECT ?s WHERE { ?s <urn:p:value> ?o } } }',
  ])('retains the unsupported strategy result for nested patterns: %s', (query) => {
    expect(wrapWithDeduplicatedGraphValues(scope(query), graphs))
      .toMatchObject({ kind: 'unsupported', reason: 'strategy-rejected' });
  });

  it.each([
    '?__dkgDedupGraph', '$__dkgDedupRank', '?__dkgDedupPriorGraph',
    String.raw`?\u005F_dkgDedupPriorRank`,
  ])('preserves logical helper-variable collision checks: %s', (variable) => {
    expect(wrapWithDeduplicatedGraphValues(
      scope(`SELECT ${variable} WHERE { ?s <urn:p:value> ?o }`), graphs,
    )).toMatchObject({ kind: 'unsupported', reason: 'helper-variable-collision' });
  });

  it('preserves explicit GRAPH, empty sets, single graphs and safe IRI checks', () => {
    const explicit = scope('SELECT ?s WHERE { GRAPH <urn:graph:one> { ?s ?p ?o } }');
    expect(wrapWithDeduplicatedGraphValues(explicit, graphs))
      .toEqual({ kind: 'ready', value: explicit });
    const original = scope('SELECT * WHERE { ?s ?p ?o }');
    expect(wrapWithDeduplicatedGraphValues(original, []))
      .toEqual({ kind: 'ready', value: original });
    const single = rewrite(original.source, [graphs[0], graphs[0]]);
    expect(single.source).toContain('GRAPH <urn:graph:one>');
    expect(single.source).not.toContain('SELECT DISTINCT');
    expect(() => rewrite(original.source, [graphs[0], 'urn:bad> } UNION {']))
      .toThrow();
  });
});
