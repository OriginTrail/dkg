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
const integer = 'http://www.w3.org/2001/XMLSchema#integer';
const boolean = 'http://www.w3.org/2001/XMLSchema#boolean';
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
  // One mapping reached two ways in the first graph and one way in the next.
  quad('urn:s:hop', 'urn:p:link', 'urn:m:1', graphs[0]), quad('urn:m:1', 'urn:p:to', '"end"', graphs[0]),
  quad('urn:s:hop', 'urn:p:link', 'urn:m:2', graphs[0]), quad('urn:m:2', 'urn:p:to', '"end"', graphs[0]),
  quad('urn:s:hop', 'urn:p:link', 'urn:m:3', graphs[1]), quad('urn:m:3', 'urn:p:to', '"end"', graphs[1]),
  ...graphs.slice(0, 2).flatMap((graph) => [
    quad('urn:s:typed', 'urn:p:tagged', '"tagged"@en-GB', graph),
    quad('urn:s:typed', 'urn:p:count', `"7"^^<${integer}>`, graph),
    quad('urn:s:typed', 'urn:p:flag', `"true"^^<${boolean}>`, graph),
  ]),
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

/** Each graph on its own, keeping a mapping's rows from the lowest-IRI graph that holds it. */
async function lowestGraphRows(store: OxigraphStore, source: string) {
  const parsed = scope(source);
  const inner = parsed.source.slice(parsed.where!.openEnd, parsed.where!.close);
  const variables = parsed.whereVariables.map((variable) => variable.source).join(' ');
  const seen = new Set<string>();
  const rows: Record<string, string>[] = [];
  for (const graph of [...graphs].sort()) {
    const result = await store.query(materializePreparedSparql(
      scope(`SELECT ${variables} WHERE { GRAPH <${graph}> { ${inner} } }`).prepared,
    ));
    const matched = result.bindings.map((row) => ({ row, key: bag([row])[0] }));
    rows.push(...matched.filter(({ key }) => !seen.has(key)).map(({ row }) => row));
    for (const { key } of matched) seen.add(key);
  }
  return rows;
}

describe('graph-set deduplication routes', () => {
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
    '?s <urn:p:value> ?o ; <urn:p:other> ?other',
    '?s <urn:p:value> ?o . ?s <urn:p:other> ?other',
    '?s <urn:p:value> ?o FILTER(?o = "one") . ?s <urn:p:other> ?other',
    '?s ?p ?o . ?s ?p ?o FILTER(STRSTARTS(STR(?s), "urn:s:"))',
    '<urn:s:1> <urn:p:value> ?value',
    '?s <urn:p:value> "one"',
    '?s <urn:p:tagged> "tagged"@en-GB',
    `?s <urn:p:count> "7"^^<${integer}>`,
    '?s <urn:p:count> 7',
    '?s <urn:p:flag> true',
    '?s a <urn:Thing> ; <urn:p:value> ?value , "one"',
    '?s <urn:p:value> ?o FILTER(REGEX(STR(?o), "^o"))',
    '?s <urn:p:tagged> ?o FILTER(LANG(?o) = "en-gb" || LANGMATCHES(LANG(?o), "en"))',
    '?s <urn:p:tagged> ?o FILTER(?o = "tagged"@en-GB)',
    `?s <urn:p:count> ?o FILTER(?o = "7"^^<${integer}>)`,
    `?s <urn:p:count> ?o FILTER(DATATYPE(?o) = <${integer}>)`,
    '?s ?p ?o FILTER(ISLITERAL(?o) && !ISBLANK(?s) && !ISNUMERIC(?o))',
    '?s ?p ?o FILTER(SAMETERM(?s, ?o) || ISIRI(?o) || ISURI(?o))',
    '?s <urn:p:value> ?o FILTER STRSTARTS(STR(?s), "urn:s:")',
    '?s <urn:p:value> ?o FILTER(RAND() < 2)',
    '?s <urn:p:value> ?o FILTER(STR(UUID()) != "")',
    '?s <urn:p:value> ?o FILTER(STRUUID() != "")',
    '?s <urn:p:value> ?o FILTER(NOW() = NOW())',
    '?s <urn:p:value> ?o FILTER(COALESCE(?o = "one", false))',
    String.raw`?s <urn:p:value> ?\u006F . ?s <urn:p:other> $other`,
  ])('takes the DISTINCT route when a graph matches a mapping once: %s', async (pattern) => {
    const store = new OxigraphStore();
    try {
      await store.insert(data);
      const query = `SELECT * WHERE { ${pattern} }`;
      const rewritten = rewrite(query);
      expect(rewritten.source).toContain('{ SELECT DISTINCT');
      expect(rewritten.source).not.toContain('__dkgDedupMatchGraph');
      expect(rewritten.source).not.toContain('FILTER(true)');
      const actual = await store.query(materializePreparedSparql(rewritten.prepared));
      expect(bag(actual.bindings)).toEqual(bag(await lowestGraphRows(store, query)));
    } finally {
      await store.close();
    }
  });

  it.each([
    '?s <urn:p:link>/<urn:p:to> ?o',
    '?s <urn:p:link> [ <urn:p:to> ?o ]',
    '[] <urn:p:link> ?m . ?m <urn:p:to> ?o',
    '?s <urn:p:value>|<urn:p:other> ?o',
    '?o ^<urn:p:value> ?s',
    '?s !<urn:p:value> ?o',
    '?s <urn:p:link>* ?o',
    '?s <urn:p:link>+ ?o',
    '?s <urn:p:link>? ?o',
    '?s (<urn:p:link>) ?o',
    String.raw`?s <urn:p:link>/<urn:p:to> ?\u006F`,
    '$s <urn:p:link>/<urn:p:to> ?o FILTER(!BOUND(?missing))',
  ])('reads one graph on the aggregate route when a mapping can repeat: %s', async (pattern) => {
    const store = new OxigraphStore();
    try {
      await store.insert(data);
      const query = `SELECT * WHERE { ${pattern} }`;
      const rewritten = rewrite(query);
      expect(rewritten.source).toContain('MIN(?__dkgDedupMatchGraph)');
      expect(rewritten.source).toContain('OPTIONAL { GRAPH ?__dkgDedupGraph');
      expect(rewritten.source).not.toContain('FILTER NOT EXISTS');
      expect(rewritten.source).not.toContain('SELECT DISTINCT');
      const actual = await store.query(materializePreparedSparql(rewritten.prepared));
      expect(bag(actual.bindings)).toEqual(bag(await lowestGraphRows(store, query)));
      expect(actual.bindings.every((row) => !Object.keys(row).some((name) => name.startsWith('__dkg'))))
        .toBe(true);
    } finally {
      await store.close();
    }
  });

  it('reads the same graph whatever the order of the graph list', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert(data);
      const query = 'SELECT ?s ?o WHERE { ?s <urn:p:link>/<urn:p:to> ?o }';
      const row = { s: 'urn:s:hop', o: '"end"' };
      const read = async (selected: readonly string[]) => (
        await store.query(materializePreparedSparql(rewrite(query, selected).prepared))
      ).bindings;
      // The mapping matches twice in urn:graph:one, which sorts before urn:graph:two's single match.
      expect(await read(graphs)).toEqual([row, row]);
      expect(await read([graphs[1], graphs[2], graphs[0]])).toEqual([row, row]);
      expect(await read([graphs[1], graphs[2]])).toEqual([row]);
    } finally {
      await store.close();
    }
  });

  it.each([
    'SELECT ?s WHERE { _:x <urn:p:value> ?s }',
    'CONSTRUCT { ?s <urn:p:seen> ?o } WHERE { ?s <urn:p:link>/<urn:p:to> ?o }',
    'DESCRIBE ?s WHERE { ?s <urn:p:link>/<urn:p:to> ?o }',
  ])('takes the aggregate route for: %s', (query) => {
    const rewritten = rewrite(query);
    expect(rewritten.source).toContain('MIN(?__dkgDedupMatchGraph)');
    expect(rewritten.source).not.toContain('SELECT DISTINCT');
  });

  it.each([
    'ASK WHERE { ?s <urn:p:value> ?o }',
    'ASK WHERE { ?s <urn:p:link>/<urn:p:to> ?o }',
    'ASK WHERE { ?s <urn:p:value> ?o FILTER(RAND() < 2) }',
    'CONSTRUCT { ?s <urn:p:value> ?o } WHERE { ?s <urn:p:value> ?o }',
    'DESCRIBE ?s WHERE { ?s <urn:p:value> ?o . ?s <urn:p:other> ?other }',
    `PREFIX xsd: <http://www.w3.org/2001/XMLSchema#> SELECT ?s WHERE { ?s <urn:p:count> "7"^^xsd:integer }`,
  ])('takes the DISTINCT route for: %s', (query) => {
    const rewritten = rewrite(query);
    expect(rewritten.source).toContain('{ SELECT DISTINCT');
    expect(rewritten.source).not.toContain('__dkgDedupMatchGraph');
  });

  it.each([
    'FILTER(RAND() < 0.5)',
    'FILTER(STR(UUID()) != "")',
    'FILTER(STRUUID() != "")',
    'FILTER(BOUND(BNODE()))',
    'FILTER(NOW() = NOW())',
    'FILTER(<urn:custom:function>(?s))',
    'FILTER <urn:custom:function>(?s)',
    String.raw`FILTER(R\u0041ND() < 0.5)`,
  ])('runs an impure FILTER once per result row on the aggregate route: %s', (filter) => {
    const { source } = rewrite(`SELECT ?s WHERE { ?s <urn:p:link>/<urn:p:to> ?o ${filter} }`);
    expect(source).toContain('MIN(?__dkgDedupMatchGraph)');
    expect(source.split(filter)).toHaveLength(2);
    expect(source).toContain(`} } ${filter} }`);
    expect(source).toContain('FILTER(true)');
  });

  it('moves a prefixed extension function, and leaves pure FILTERs in both copies', () => {
    const prefixed = rewrite('PREFIX f: <urn:custom:> SELECT ?s WHERE { ?s <urn:p:link>/<urn:p:to> ?o FILTER(f:test(?s)) }').source;
    expect(prefixed).toContain('} } FILTER(f:test(?s)) }');
    const pattern = '?s <urn:p:link>/<urn:p:to> ?o FILTER(REGEX(STR(?o), "end"))';
    const pure = rewrite(`SELECT ?s WHERE { ${pattern} }`).source;
    expect(pure.split(pattern)).toHaveLength(3);
    expect(pure).not.toContain('FILTER(true)');
    const mixed = rewrite('SELECT ?s WHERE { ?s <urn:p:link>/<urn:p:to> ?o FILTER(?o = "end") FILTER(RAND() < 2) }').source;
    expect(mixed.split('FILTER(?o = "end") FILTER(true)')).toHaveLength(3);
    expect(mixed).toContain('} } FILTER(RAND() < 2) }');
  });

  it.each([
    '?s <urn:p:link>/<urn:p:to> ?o . FILTER(RAND() < 2) . ?s <urn:p:link> ?m',
    '?s <urn:p:link>/<urn:p:to> ?o FILTER(RAND() < 2) ?s <urn:p:link> ?m',
    'FILTER(RAND() < 2) ?s <urn:p:link>/<urn:p:to> ?o',
    '?s <urn:p:link>/<urn:p:to> ?o FILTER(RAND() < 2) FILTER(RAND() < 3) . ',
    '?s <urn:p:link>/<urn:p:to> ?o FILTER(COALESCE(?o = "end", false))',
  ])('keeps the rows and valid syntax when moving a FILTER out of: %s', async (pattern) => {
    const store = new OxigraphStore();
    try {
      await store.insert(data);
      const query = `SELECT * WHERE { ${pattern} }`;
      const rewritten = rewrite(query);
      expect(rewritten.source).toContain('FILTER(true)');
      const actual = await store.query(materializePreparedSparql(rewritten.prepared));
      expect(bag(actual.bindings)).toEqual(bag(await lowestGraphRows(store, query)));
    } finally {
      await store.close();
    }
  });

  it.each([
    ['RAND() < 2', [{ s: 'urn:s:hop', o: '"end"' }, { s: 'urn:s:hop', o: '"end"' }]],
    ['RAND() < 0', []],
  ])('never adds a row a FILTER did not accept on the aggregate route: %s', async (expression, expected) => {
    const store = new OxigraphStore();
    try {
      await store.insert(data);
      const rewritten = rewrite(`SELECT ?s ?o WHERE { ?s <urn:p:link>/<urn:p:to> ?o FILTER(${expression}) }`);
      expect(rewritten.source).toContain('MIN(?__dkgDedupMatchGraph)');
      const actual = await store.query(materializePreparedSparql(rewritten.prepared));
      expect(actual.bindings).toEqual(expected);
    } finally {
      await store.close();
    }
  });

  it.each([
    ['DISTINCT', '?s <urn:sample:value> ?o'],
    ['aggregate', '?s <urn:sample:link>/<urn:sample:to> ?o'],
  ])('tests each row of a volatile FILTER on the %s route', async (_route, pattern) => {
    const store = new OxigraphStore();
    try {
      // Oxigraph samples per row here. Evaluating the FILTER once for the query would give all rows or none.
      await store.insert(Array.from({ length: 2000 }, (_, n) => [
        quad(`urn:sample:${n}`, 'urn:sample:value', `"v${n}"`, graphs[0]),
        quad(`urn:sample:${n}`, 'urn:sample:link', `urn:sample:hop:${n}`, graphs[0]),
        quad(`urn:sample:hop:${n}`, 'urn:sample:to', `"t${n}"`, graphs[0]),
      ]).flat());
      const rewritten = rewrite(`SELECT ?s WHERE { ${pattern} FILTER(RAND() < 0.5) }`);
      const actual = await store.query(materializePreparedSparql(rewritten.prepared));
      expect(actual.bindings.length).toBeGreaterThan(700);
      expect(actual.bindings.length).toBeLessThan(1300);
    } finally {
      await store.close();
    }
  });

  it('applies LIMIT after a moved FILTER, not before it', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([
        ...data,
        quad('urn:s:target', 'urn:p:link', 'urn:m:target', graphs[0]),
        quad('urn:m:target', 'urn:p:to', '"target"', graphs[0]),
      ]);
      // COALESCE is deterministic but off the pure list, so this FILTER moves.
      const rewritten = rewrite('SELECT ?s WHERE { ?s <urn:p:link>/<urn:p:to> ?o FILTER(COALESCE(?o = "target", false)) } LIMIT 1');
      expect(rewritten.source.match(/LIMIT 1/g)).toHaveLength(1);
      const actual = await store.query(materializePreparedSparql(rewritten.prepared));
      expect(actual.bindings).toEqual([{ s: 'urn:s:target' }]);
    } finally {
      await store.close();
    }
  });

  it.each([
    ['ASK WHERE { ?s <urn:p:link>/<urn:p:to> ?o }', true],
    ['ASK WHERE { _:x <urn:p:link> ?o }', true],
    ['ASK WHERE { ?s <urn:p:to>/<urn:p:link> ?o }', false],
  ])('answers %s', async (query, expected) => {
    const store = new OxigraphStore();
    try {
      await store.insert(data);
      await expect(store.query(materializePreparedSparql(rewrite(query).prepared)))
        .resolves.toMatchObject({ type: 'boolean', value: expected });
    } finally {
      await store.close();
    }
  });

  it.each([
    'SELECT ?s WHERE { ?s <urn:p:value> ?o OPTIONAL { ?s ?p ?other } }',
    'SELECT ?s WHERE { { SELECT ?s WHERE { ?s <urn:p:value> ?o } } }',
  ])('retains the unsupported strategy result for nested patterns: %s', (query) => {
    expect(wrapWithDeduplicatedGraphValues(scope(query), graphs))
      .toMatchObject({ kind: 'unsupported', reason: 'strategy-rejected' });
  });

  it.each([
    '?__dkgDedupGraph', '$__dkgDedupGraph', '?__dkgDedupMatchGraph',
    String.raw`?\u005F_dkgDedupMatchGraph`,
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
