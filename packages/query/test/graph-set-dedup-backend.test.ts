import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlazegraphStore, OxigraphStore, sparqlEngineOf, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { materializePreparedSparql, prepareSparql } from '@origintrail-official/dkg-rdf-utils/sparql';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { planGraphDataset } from '../src/sparql-graph-dataset.js';
import { prepareGraphScope, rewriteGraphSet, wrapWithDeduplicatedGraphValues } from '../src/sparql-graph-scope.js';

// CI's tornado-blazegraph lane runs this file on a live server; elsewhere it runs on Oxigraph, so both stores answer to the same rows.
const endpoint = process.env.BLAZEGRAPH_TEST_URL;
if (process.env.DKG_REQUIRE_BLAZEGRAPH === '1' && !endpoint) throw new Error('Blazegraph CI endpoint is required');

const id = `graph-set-dedup-${randomUUID()}`;
const ROOT = `did:dkg:context-graph:${id}`;
const graphs = [ROOT, `${ROOT}/_verifiable_memory/a/1`, `${ROOT}/_verifiable_memory/a/2`];
const OUTSIDE = `urn:outside:${id}`;
const [A, B, LINK, TO, BLANK] = ['urn:p:a', 'urn:p:b', 'urn:p:link', 'urn:p:to', 'urn:p:blank'];
const quad = (subject: string, predicate: string, object: string, graph: string): Quad => (
  { subject, predicate, object, graph }
);
const data = [
  // A whole mapping mirrored in two graphs.
  ...graphs.slice(0, 2).flatMap((graph) => [quad('urn:s:1', A, '"x"', graph), quad('urn:s:1', B, '"y"', graph)]),
  // Two halves of a mapping in different graphs, which must not join.
  quad('urn:s:2', A, '"x"', graphs[0]), quad('urn:s:2', B, '"y"', graphs[1]),
  // (s3, x, y) in the last two graphs; (s3, x, z) in one.
  quad('urn:s:3', A, '"x"', graphs[1]), quad('urn:s:3', B, '"y"', graphs[1]), quad('urn:s:3', B, '"z"', graphs[1]),
  quad('urn:s:3', A, '"x"', graphs[2]), quad('urn:s:3', B, '"y"', graphs[2]),
  // A hidden hop repeats (s4, t) twice in the first graph and once in the next: the lowest graph's count stands.
  quad('urn:s:4', LINK, 'urn:m:1', graphs[0]), quad('urn:m:1', TO, '"t"', graphs[0]),
  quad('urn:s:4', LINK, 'urn:m:2', graphs[0]), quad('urn:m:2', TO, '"t"', graphs[0]),
  quad('urn:s:4', LINK, 'urn:m:3', graphs[1]), quad('urn:m:3', TO, '"t"', graphs[1]),
  // Likewise (s5, u): twice in the second graph, three times in the third.
  quad('urn:s:5', LINK, 'urn:m:4', graphs[1]), quad('urn:m:4', TO, '"u"', graphs[1]),
  quad('urn:s:5', LINK, 'urn:m:5', graphs[1]), quad('urn:m:5', TO, '"u"', graphs[1]),
  quad('urn:s:5', LINK, 'urn:m:6', graphs[2]), quad('urn:m:6', TO, '"u"', graphs[2]),
  quad('urn:s:5', LINK, 'urn:m:7', graphs[2]), quad('urn:m:7', TO, '"u"', graphs[2]),
  quad('urn:s:5', LINK, 'urn:m:8', graphs[2]), quad('urn:m:8', TO, '"u"', graphs[2]),
  // Blank nodes: one mirrored by the copy in beforeAll, and two that look alike but stay apart.
  quad('_:mirrored', BLANK, '"mirrored"', graphs[0]),
  quad('_:first', BLANK, '"alike"', graphs[0]), quad('_:second', BLANK, '"alike"', graphs[1]),
  // Never in scope.
  quad('urn:s:out', A, '"x"', OUTSIDE), quad('urn:s:out', B, '"y"', OUTSIDE),
  quad('urn:s:out', LINK, 'urn:m:1', OUTSIDE), quad('urn:s:out', LINK, 'urn:m:2', OUTSIDE),
];

const rows = (...items: Record<string, string>[]) => items;
const JOINED = rows(
  { s: 'urn:s:1', x: '"x"', y: '"y"' },
  { s: 'urn:s:3', x: '"x"', y: '"y"' },
  { s: 'urn:s:3', x: '"x"', y: '"z"' },
);
const HOPS = rows(
  { s: 'urn:s:4', o: '"t"' }, { s: 'urn:s:4', o: '"t"' },
  { s: 'urn:s:5', o: '"u"' }, { s: 'urn:s:5', o: '"u"' },
);
const JOIN = `?s <${A}> ?x . ?s <${B}> ?y`;
// The distinct triples whose subject starts urn:s:, in any in-scope graph.
const SUBJECT_TRIPLES = 15;

function scope(source: string) {
  const prepared = prepareSparql(source);
  if (prepared.status !== 'valid') throw new Error('Expected valid test input');
  return prepareGraphScope(prepared);
}

function rewrite(source: string): string {
  const result = wrapWithDeduplicatedGraphValues(scope(source), graphs);
  if (result.kind !== 'ready') throw new Error(`Unexpected fallback: ${result.reason}`);
  return materializePreparedSparql(result.value.prepared);
}

function bag(items: readonly Record<string, string>[]) {
  return items.map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).sort()))).sort();
}

const integer = (value: string | undefined) => Number(/^"(\d+)"/.exec(value ?? '')?.[1]);

describe(`graph-set deduplication on ${endpoint ? 'Blazegraph' : 'Oxigraph'}`, { timeout: 30_000 }, () => {
  let store: TripleStore;
  const select = async (source: string) => {
    const result = await store.query(rewrite(source));
    if (result.type !== 'bindings') throw new Error(`Expected bindings, got ${result.type}`);
    return result.bindings;
  };

  beforeAll(async () => {
    store = endpoint ? new BlazegraphStore(endpoint, { timeout: 20_000 }) : new OxigraphStore();
    // Last graph first, so a store that ordered graphs by term creation would pick the wrong one.
    for (const graph of [...graphs].reverse()) await store.insert(data.filter((item) => item.graph === graph));
    await store.insert(data.filter((item) => item.graph === OUTSIDE));
    await store.update(`INSERT { GRAPH <${graphs[1]}> { ?s <${BLANK}> "mirrored" } } WHERE { GRAPH <${graphs[0]}> { ?s <${BLANK}> "mirrored" } }`);
  }, 30_000);

  afterAll(async () => {
    if (!store) return;
    for (const graph of [...graphs, OUTSIDE]) await store.dropGraph(graph).catch(() => {});
    await store.close().catch(() => {});
  }, 30_000);

  it.each<[string, string, Record<string, string>[]]>([
    ['a join mirrored across graphs', `SELECT ?s ?x ?y WHERE { ${JOIN} }`, JOINED],
    ['a caller projection, which keeps its repeats', `SELECT ?s WHERE { ${JOIN} }`, rows({ s: 'urn:s:1' }, { s: 'urn:s:3' }, { s: 'urn:s:3' })],
    ['a constant subject', `SELECT ?x ?y WHERE { <urn:s:1> <${A}> ?x . <urn:s:1> <${B}> ?y }`, rows({ x: '"x"', y: '"y"' })],
    ['a constant object', `SELECT ?s ?y WHERE { ?s <${A}> "x" ; <${B}> ?y }`, rows({ s: 'urn:s:1', y: '"y"' }, { s: 'urn:s:3', y: '"y"' }, { s: 'urn:s:3', y: '"z"' })],
    ['a variable used only in a FILTER', `SELECT ?s ?x ?y WHERE { ${JOIN} FILTER(!BOUND(?missing)) }`, JOINED],
    ['a sequence path, with the lowest graph\'s count', `SELECT ?s ?o WHERE { ?s <${LINK}>/<${TO}> ?o }`, HOPS],
    ['a blank node, with the lowest graph\'s count', `SELECT ?s ?o WHERE { ?s <${LINK}> [ <${TO}> ?o ] }`, HOPS],
    ['a path with a variable used only in a FILTER', `SELECT ?s ?o WHERE { ?s <${LINK}>/<${TO}> ?o FILTER(!BOUND(?missing)) }`, HOPS],
    ['SELECT * on a path, which hides the helper variables', `SELECT * WHERE { ?s <${LINK}>/<${TO}> ?o }`, HOPS],
    ['a join with no match', `SELECT ?s WHERE { ?s <${A}> ?x . ?s <${TO}> ?y }`, rows()],
    ['a path with no match', `SELECT ?s WHERE { ?s <${TO}>/<${LINK}> ?o }`, rows()],
    ['an alternative path', `SELECT ?s ?o WHERE { ?s <${A}>|<${B}> ?o }`, rows(
      { s: 'urn:s:1', o: '"x"' }, { s: 'urn:s:1', o: '"y"' }, { s: 'urn:s:2', o: '"x"' }, { s: 'urn:s:2', o: '"y"' },
      { s: 'urn:s:3', o: '"x"' }, { s: 'urn:s:3', o: '"y"' }, { s: 'urn:s:3', o: '"z"' },
    )],
    ['a volatile FILTER that always passes', `SELECT ?s WHERE { ?s <${A}> ?x FILTER(RAND() < 2) }`, rows({ s: 'urn:s:1' }, { s: 'urn:s:2' }, { s: 'urn:s:3' })],
    ['a volatile FILTER that never passes', `SELECT ?s WHERE { ?s <${A}> ?x FILTER(RAND() < 0) }`, rows()],
    ['a path with a volatile FILTER that always passes', `SELECT ?s ?o WHERE { ?s <${LINK}>/<${TO}> ?o FILTER(RAND() < 2) }`, HOPS],
    ['a path with a volatile FILTER that never passes', `SELECT ?s ?o WHERE { ?s <${LINK}>/<${TO}> ?o FILTER(RAND() < 0) }`, rows()],
    // Two paths for each of two ?hop values in the lowest graph, and one more ?hop only in the next.
    ['a path with FILTERs moved from between its triples', `SELECT ?s ?o WHERE { ?s <${LINK}>/<${TO}> ?o . FILTER(RAND() < 2) . ?s <${LINK}> ?hop FILTER(COALESCE(?s != <urn:s:5>, false)) }`, Array.from({ length: 5 }, () => ({ s: 'urn:s:4', o: '"t"' }))],
  ])('returns the exact rows for %s', async (_name, source, expected) => {
    expect(bag(await select(source))).toEqual(bag(expected));
  });

  it.each([
    ['DISTINCT', `SELECT ?s ?v WHERE { ?s <${BLANK}> ?v }`],
    ['aggregate', `SELECT ?s ?v WHERE { ?s <${BLANK}>|<urn:p:none> ?v }`],
  ])('keeps blank-node identity on the %s route', async (_route, source) => {
    const found = await select(source);
    expect(found.map((row) => row.v).sort()).toEqual(['"alike"', '"alike"', '"mirrored"']);
    expect(new Set(found.map((row) => row.s)).size).toBe(3);
  });

  it('counts each triple once however many graphs hold it', async () => {
    const [row] = await select(`SELECT (COUNT(*) AS ?c) WHERE { ?s ?p ?o . ?s ?p ?o FILTER(STRSTARTS(STR(?s), "urn:s:")) }`);
    expect(integer(row.c)).toBe(SUBJECT_TRIPLES);
    const triples = await select(`SELECT ?s ?p ?o WHERE { ?s ?p ?o . ?s ?p ?o FILTER(STRSTARTS(STR(?s), "urn:s:")) }`);
    expect(triples).toHaveLength(SUBJECT_TRIPLES);
    expect(new Set(bag(triples)).size).toBe(SUBJECT_TRIPLES);
  });

  it.each([
    [`?s <${A}> ?x . ?s <${TO}> ?y`],
    [`?s <${TO}>/<${LINK}> ?o`],
  ])('counts zero rows for %s', async (pattern) => {
    const [row] = await select(`SELECT (COUNT(*) AS ?c) WHERE { ${pattern} }`);
    expect(integer(row.c)).toBe(0);
  });

  describe.each(['values', 'dataset'])('a pattern without caller variables through %s graph access', (mode) => {
    // Without a store engine the planner reads a repeated path through dataset access, and the others through values.
    const p = mode === 'dataset' ? '+' : '';
    const planned = (source: string) => {
      if (mode === 'dataset') expect(planGraphDataset(scope(source), null).graphAccess, source).toBe('dataset');
      const result = mode === 'values' ? wrapWithDeduplicatedGraphValues(scope(source), graphs)
        : rewriteGraphSet(scope(source), graphs, 'deduplicated-values-union', null);
      if (result.kind !== 'ready') throw new Error(`Unexpected fallback: ${result.reason}`);
      return materializePreparedSparql(result.value.prepared);
    };
    it.each<[string, string, number]>([
      ['a constant triple both graphs hold', `<urn:s:1> <${A}>${p} "x"`, 1],
      ['distinct blank subjects', `[] <${BLANK}>${p} "alike"`, 2],
      ['a blank subject both graphs hold', `[] <${BLANK}>${p} "mirrored"`, 1],
      ['a property list', `[ <${BLANK}>${p} "alike" ]`, 2],
      ['a labelled blank node and a FILTER', `_:b <${BLANK}>${p} "alike" FILTER(STRLEN("x") = 1)`, 2],
      ['a hidden hop', `<urn:s:4> <${LINK}>${p}/<${TO}> "t"`, 2],
      ['a triple only outside the graph set', `<urn:s:out> <${A}>${p} "x"`, 0],
    ])('counts %s', async (_name, pattern, expected) => {
      const result = await store.query(planned(`SELECT (COUNT(*) AS ?c) WHERE { ${pattern} }`));
      expect(result.type === 'bindings' ? integer(result.bindings[0]?.c) : Number.NaN).toBe(expected);
    });

    it('returns empty rows under SELECT * and answers ASK', async () => {
      const rows = await store.query(planned(`SELECT * WHERE { [] <${BLANK}>${p} "alike" }`));
      expect(rows.type === 'bindings' ? rows.bindings : null).toEqual([{}, {}]);
      await expect(store.query(planned(`ASK { [] <${BLANK}>${p} "mirrored" }`))).resolves.toMatchObject({ type: 'boolean', value: true });
      await expect(store.query(planned(`ASK { <urn:s:out> <${A}>${p} "x" }`))).resolves.toMatchObject({ type: 'boolean', value: false });
    });
  });

  it('aggregates over the deduplicated rows', async () => {
    const counts = await select(`SELECT ?s (COUNT(*) AS ?c) WHERE { ${JOIN} } GROUP BY ?s`);
    expect(Object.fromEntries(counts.map((row) => [row.s, integer(row.c)])))
      .toEqual({ 'urn:s:1': 1, 'urn:s:3': 2 });
    const hops = await select(`SELECT ?s (COUNT(*) AS ?c) WHERE { ?s <${LINK}>/<${TO}> ?o } GROUP BY ?s`);
    expect(Object.fromEntries(hops.map((row) => [row.s, integer(row.c)])))
      .toEqual({ 'urn:s:4': 2, 'urn:s:5': 2 });
  });

  it('retains mirror suppression on repeated paths through the engine dataset route', async () => {
    const engine = new DKGQueryEngine(store);
    const read = async (source: string) => (await engine.query(source, { contextGraphId: id })).bindings;
    expect(bag(await read(`SELECT ?s WHERE { ?s <${A}>+ ?o }`)))
      .toEqual(bag(rows({ s: 'urn:s:1' }, { s: 'urn:s:2' }, { s: 'urn:s:3' })));
    expect(integer((await read(`SELECT (COUNT(*) AS ?c) WHERE { ?s <${A}>+ ?o }`))[0]?.c)).toBe(3);
    // Projecting away ?y must retain the two distinct mappings for s3.
    expect(bag(await read(`SELECT ?s WHERE { ?s <${A}>+ ?x . ?s <${B}> ?y }`)))
      .toEqual(bag(rows({ s: 'urn:s:1' }, { s: 'urn:s:3' }, { s: 'urn:s:3' })));
    // Hidden path multiplicity comes from one graph, not every mirror.
    expect(bag(await read(`SELECT ?s ?o WHERE { ?s <${LINK}>+/<${TO}> ?o }`))).toEqual(bag(HOPS));
  });

  it('applies LIMIT to the deduplicated rows', async () => {
    const expected = bag(HOPS);
    const limited = bag(await select(`SELECT ?s ?o WHERE { ?s <${LINK}>/<${TO}> ?o } LIMIT 3`));
    expect(limited).toHaveLength(3);
    for (const row of new Set(limited)) {
      expect(limited.filter((item) => item === row).length)
        .toBeLessThanOrEqual(expected.filter((item) => item === row).length);
    }
    expect(await select(`SELECT ?s ?x ?y WHERE { ${JOIN} } LIMIT 2`)).toHaveLength(2);
    // A FILTER has to see every row before the LIMIT applies, on both routes.
    expect(await select(`SELECT ?s WHERE { ?s <${A}> ?x FILTER(COALESCE(?s = <urn:s:3>, false)) } LIMIT 1`))
      .toEqual([{ s: 'urn:s:3' }]);
    expect(await select(`SELECT ?s WHERE { ?s <${LINK}>/<${TO}> ?o FILTER(COALESCE(?s = <urn:s:5>, false)) } LIMIT 1`))
      .toEqual([{ s: 'urn:s:5' }]);
  });

  describe.each(['values', 'dataset'])('modifiers and FILTERs through %s graph access', (mode) => {
    const pattern = `?s <${LINK}>${mode === 'dataset' ? '+' : ''}/<${TO}> ?o`;
    const planned = (source: string) => {
      const result = mode === 'values' ? wrapWithDeduplicatedGraphValues(scope(source), graphs)
        : rewriteGraphSet(scope(source), graphs, 'deduplicated-values-union', null);
      if (result.kind !== 'ready') throw new Error(`Unexpected fallback: ${result.reason}`);
      return materializePreparedSparql(result.value.prepared);
    };
    const read = async (source: string) => (await store.query(planned(source))).bindings;
    it.each(['__dkgDedupGraph', '__dkgDedupMatchGraph', '__dkgDedupMatched', '__dkgViewGraph', '__dkgDedupFilter0', '__dkgBlankNode0'])('preserves caller bindings named %s, including escaped spellings', async (name) => {
      for (const variable of [`?${name}`, `?\\u005F${name.slice(1)}`]) {
        const mirrored = await read(`SELECT * WHERE { ?s <${A}>${mode === 'dataset' ? '+' : ''} ${variable} FILTER(${variable} = "x") }`);
        expect(bag(mirrored)).toEqual(bag(['urn:s:1', 'urn:s:2', 'urn:s:3'].map(s => ({ s, [name]: '"x"' }))));
        const found = await read(`SELECT * WHERE {
          _:subject <${LINK}> ?hop . _:subject <${LINK}>${mode === 'dataset' ? '+' : ''}/<${TO}> ${variable}
          FILTER(${variable} = "t")
        }`);
        expect(bag(found)).toEqual(bag([
          ...Array.from({ length: 2 }, () => ({ hop: 'urn:m:1', [name]: '"t"' })),
          ...Array.from({ length: 2 }, () => ({ hop: 'urn:m:2', [name]: '"t"' })),
          { hop: 'urn:m:3', [name]: '"t"' },
        ]));
      }
    });
    it('preserves repeated named blank-node matches without exposing helper bindings', async () => {
      for (const binding of ['hop', '__dkgBlankNode0']) {
        const found = await read(`SELECT * WHERE {
          _:subject <${LINK}> ?${binding} . _:subject <${LINK}>${mode === 'dataset' ? '+' : ''}/<${TO}> ?o
          FILTER(?o = "t")
        }`);
        expect(bag(found)).toEqual(bag([
          ...Array.from({ length: 2 }, () => ({ [binding]: 'urn:m:1', o: '"t"' })),
          ...Array.from({ length: 2 }, () => ({ [binding]: 'urn:m:2', o: '"t"' })),
          { [binding]: 'urn:m:3', o: '"t"' },
        ]));
      }
      const rewritten = planned(`ASK WHERE { _:subject <${LINK}>${mode === 'dataset' ? '+' : ''}/<${TO}> ?o FILTER(?o = "t") } OFFSET 1`);
      const result = await store.query(endpoint ? rewritten.replace(/^ASK/, 'SELECT *') : rewritten);
      if (endpoint) expect(result.bindings).toEqual([{ o: '"t"' }]);
      else expect(result).toMatchObject({ type: 'boolean', value: true });
    });

    it.each([1, 2])('preserves ASK-planned row counts before HAVING COUNT > %s', async (threshold) => {
      const rewritten = planned(`ASK WHERE { ${pattern} FILTER(?s = <urn:s:4>) }
        GROUP BY ?s HAVING(COUNT(*) > ${threshold})`);
      // These backends reject native ASK GROUP BY. SELECT executes the same
      // ASK-planned bag and exposes whether the cardinality-sensitive group survives.
      const result = await store.query(rewritten.replace(/^ASK/, 'SELECT ?s'));
      expect(result.bindings).toEqual(threshold === 1 ? [{ s: 'urn:s:4' }] : []);
    });

    it.each([0, 1, 2])('preserves hidden-path multiplicity for ASK OFFSET %s', async (offset) => {
      const rewritten = planned(`ASK WHERE {
        ${pattern} FILTER(?s = <urn:s:4>)
      } OFFSET ${offset}`);
      // Blazegraph rejects native ASK OFFSET syntax. Execute the ASK planner's
      // exact pattern as SELECT there, checking the bag consumed by OFFSET.
      const result = await store.query(endpoint ? rewritten.replace(/^ASK/, 'SELECT *') : rewritten);
      // The first graph contributes two rows; its one-row mirror adds none.
      if (endpoint) expect(result.bindings).toHaveLength(Math.max(0, 2 - offset));
      else expect(result).toMatchObject({ type: 'boolean', value: offset < 2 });
    });

    it.each<[string, Record<string, string>[]]>([
      ['REGEX(STR(?o), "t")', HOPS.filter(row => row.o === '"t"')],
      ['COALESCE(?o = "t", false)', HOPS.filter(row => row.o === '"t"')],
      ['!BOUND(?missing)', HOPS],
      ['IF(?o = "t", true, 1/0)', HOPS.filter(row => row.o === '"t"')],
      ['?o = 1/0', rows()],
      ['?missing = "absent"', rows()],
      ['RAND() < 2', HOPS],
      ['RAND() < 0', rows()],
    ])('preserves the exact repeated-row bag for FILTER(%s)', async (filter, expected) => {
      expect(bag(await read(`SELECT ?s ?o WHERE { ${pattern} FILTER(${filter}) }`)))
        .toEqual(bag(expected));
    });

  });

  it.each(['caller GRAPH', 'union-only'])('keeps repeated blank-node labels private in %s branches on unknown engines', async (route) => {
    for (const label of ['subject', '__dkgBranch0', String.raw`\u0073ubject`]) {
      const pattern = `_:${label} <${LINK}>+ ?hop . _:${label} <${LINK}>/<${TO}> ?o FILTER(?o = "t")`;
      const query = `SELECT * WHERE { ${route === 'caller GRAPH' ? `GRAPH ?g { ${pattern} }` : pattern} }`;
      const result = rewriteGraphSet(scope(query), graphs, route === 'caller GRAPH' ? 'values-union' : 'union-only', null);
      if (result.kind !== 'ready') throw new Error(`Unexpected fallback: ${result.reason}`);
      const found = (await store.query(materializePreparedSparql(result.value.prepared))).bindings;
      const expected = [
        ...Array.from({ length: 2 }, () => ({ g: graphs[0], hop: 'urn:m:1', o: '"t"' })),
        ...Array.from({ length: 2 }, () => ({ g: graphs[0], hop: 'urn:m:2', o: '"t"' })),
        { g: graphs[1], hop: 'urn:m:3', o: '"t"' },
      ];
      expect(bag(found)).toEqual(bag(route === 'caller GRAPH' ? expected : expected.map(({ hop, o }) => ({ hop, o }))));
    }
  });

  it('preserves caller BIND assignments to its GRAPH variable on unknown engines', async () => {
    for (const variable of ['?g', String.raw`?\u0067`]) {
      const result = rewriteGraphSet(scope(`SELECT * WHERE { GRAPH ${variable} {
        BIND(<${graphs[0]}> AS ${variable}) ?s <${A}>+ ?o FILTER(${variable} = <${graphs[0]}>)
      } }`), graphs, 'values-union', null);
      if (result.kind !== 'ready') throw new Error(`Unexpected fallback: ${result.reason}`);
      const found = (await store.query(materializePreparedSparql(result.value.prepared))).bindings;
      expect(bag(found)).toEqual(bag([
        { g: graphs[0], s: 'urn:s:1', o: '"x"' }, { g: graphs[0], s: 'urn:s:2', o: '"x"' },
      ]));
    }
  });

  it('preserves caller BIND expressions with an explicitly bound GRAPH variable', async () => {
    const pattern = (path: string) => `GRAPH ?g { BIND(STR(?g) AS ?graphLabel) ?s <${A}>${path} ?o FILTER(?o = "x") }`;
    const values = `VALUES ?g { ${graphs.map(g => `<${g}>`).join(' ')} }`;
    // This fixture has only single-hop A paths. A native triple read supplies
    // the backend's graph-variable expression semantics without DKG rewriting.
    const native = (await store.query(`SELECT * ${graphs.map(g => `FROM NAMED <${g}>`).join(' ')} WHERE { ${values} ${pattern('')} }`)).bindings;
    expect(native).toHaveLength(5);
    const result = rewriteGraphSet(scope(`SELECT * WHERE { ${values} ${pattern('+')} }`), graphs, 'values-union', null);
    if (result.kind !== 'ready') throw new Error(`Unexpected fallback: ${result.reason}`);
    const found = (await store.query(materializePreparedSparql(result.value.prepared))).bindings;
    expect(bag(found)).toEqual(bag(native));
  });

  it.each(['SELECT', String.raw`S\u0045LECT`])('preserves a direct %s subquery inside caller GRAPH on unknown engines', async (keyword) => {
    const result = rewriteGraphSet(scope(`SELECT ?g ?s WHERE { GRAPH ?g {
      # The direct subquery must remain a group beside the generated VALUES.
      ${keyword} ?s WHERE { ?s <${A}>+ ?o FILTER(?o = "x") }
    } }`), graphs, 'values-union', null);
    if (result.kind !== 'ready') throw new Error(`Unexpected fallback: ${result.reason}`);
    const found = (await store.query(materializePreparedSparql(result.value.prepared))).bindings;
    expect(bag(found)).toEqual(bag([
      { g: graphs[0], s: 'urn:s:1' }, { g: graphs[0], s: 'urn:s:2' },
      { g: graphs[1], s: 'urn:s:1' }, { g: graphs[1], s: 'urn:s:3' },
      { g: graphs[2], s: 'urn:s:3' },
    ]));
  });

  it.each([
    [`ASK WHERE { ${JOIN} }`, true],
    [`ASK WHERE { ?s <${LINK}>/<${TO}> ?o }`, true],
    [`ASK WHERE { ?s <${A}> ?x . ?s <${TO}> ?y }`, false],
  ])('answers %s', async (source, expected) => {
    const result = await store.query(rewrite(source));
    expect(result).toMatchObject({ type: 'boolean', value: expected });
  });

  it.each([
    [JOIN, ['urn:s:1', 'urn:s:3']],
    [`?s <${LINK}>/<${TO}> ?o`, ['urn:s:4', 'urn:s:5']],
  ])('builds CONSTRUCT from the in-scope mappings of %s', async (where, subjects) => {
    const result = await store.query(rewrite(`CONSTRUCT { ?s <urn:p:seen> "yes" } WHERE { ${where} }`));
    if (result.type !== 'quads') throw new Error(`Expected quads, got ${result.type}`);
    expect([...new Set(result.quads.map((item) => item.subject))].sort()).toEqual(subjects);
  });

  it('samples mirrored DISTINCT mappings only once per logical row', async () => {
    const predicate = 'urn:mirror-sample:value';
    await store.insert(graphs.slice(0, 2).flatMap(graph => Array.from({ length: 2000 }, (_, n) =>
      quad(`urn:mirror-sample:${n}`, predicate, `"value-${n}"`, graph))));
    expect(await select(`SELECT ?s ?o WHERE { ?s <${predicate}> ?o }`)).toHaveLength(2000);
    const retained = await select(`SELECT ?s ?o WHERE {
      ?s <${predicate}> ?o FILTER(REGEX(STRUUID(), "^[0-7]"))
    }`);
    // Two independent chances per row retain about 1500; one retains about 1000.
    expect(retained.length).toBeGreaterThan(700);
    expect(retained.length).toBeLessThan(1300);
    expect(new Set(bag(retained)).size).toBe(retained.length);
  });

  it('reads through the engine with one row per triple', async () => {
    const engine = new DKGQueryEngine(store);
    const options = { contextGraphId: id, view: 'verifiable-memory' as const };
    const counted = await engine.query(
      'SELECT (COUNT(*) AS ?c) WHERE { ?s ?p ?o . ?s ?p ?o FILTER(STRSTARTS(STR(?s), "urn:s:")) }',
      options,
    );
    expect(integer(counted.bindings[0].c)).toBe(SUBJECT_TRIPLES);
    const joined = await engine.query(`SELECT ?s ?x ?y WHERE { ${JOIN} }`, options);
    expect(bag(joined.bindings)).toEqual(bag(JOINED));
    const hops = await engine.query(`SELECT ?s ?o WHERE { ?s <${LINK}>/<${TO}> ?o }`, options);
    expect(bag(hops.bindings)).toEqual(bag(HOPS));
  });

  it.each(['values', 'dataset'])('samples each retained row when hidden paths repeat the same mapping (%s)', async (route) => {
    const count = 2000;
    const link = `urn:sample:${route}:link`;
    const to = `urn:sample:${route}:to`;
    await store.insert(Array.from({ length: count }, (_, n) => [
      quad('urn:sample:shared', link, `urn:sample:${route}:hop:${n}`, graphs[0]),
      quad(`urn:sample:${route}:hop:${n}`, to, 'urn:sample:end', graphs[0]),
    ]).flat());
    const pattern = `?s <${link}>${route === 'dataset' ? '+' : ''}/<${to}> ?o`;
    const engine = new DKGQueryEngine(store);
    const read = route === 'dataset'
      ? async (query: string) => (await engine.query(query, { contextGraphId: id })).bindings : select;
    expect(await read(`SELECT ?s WHERE { ${pattern} }`)).toHaveLength(count);
    // Blazegraph folds RAND() to one value even in an unrewritten query.
    // STRUUID is evaluated per row on both engines; its first hex digit gives
    // the same 50% sampling probability without relying on that backend quirk.
    const retained = await read(`SELECT ?s ?o WHERE { ${pattern} FILTER(REGEX(STRUUID(), "^[0-7]")) }`);
    // Filtering once per group produces 0 or count. Independent row sampling
    // stays well inside this deliberately wide interval.
    expect(retained.length).toBeGreaterThan(count * 0.25);
    expect(retained.length).toBeLessThan(count * 0.75);
    expect(new Set(bag(retained))).toEqual(new Set([JSON.stringify({ o: 'urn:sample:end', s: 'urn:sample:shared' })]));
  });

  it('keeps repeated-path reads practical across 1,000 graphs', async () => {
    const selected = Array.from({ length: 1000 }, (_, n) => `urn:dataset-scale:${id}:${n}`);
    try {
      await store.insert([
        ...selected.map(graph => quad('urn:scale:dummy', 'urn:scale:dummy', 'urn:scale:dummy', graph)),
        ...Array.from({ length: 3 }, (_, n) => [
          quad('urn:scale:s', 'urn:scale:link', `urn:scale:hop:${n}`, selected[0]),
          quad(`urn:scale:hop:${n}`, 'urn:scale:to', 'urn:scale:end', selected[0]),
        ]).flat(),
      ]);
      const rewritten = rewriteGraphSet(scope('SELECT ?s ?o WHERE { ?s <urn:scale:link>+/<urn:scale:to> ?o }'), selected, 'deduplicated-values-union', null);
      if (rewritten.kind !== 'ready') throw new Error(`Unexpected fallback: ${rewritten.reason}`);
      const found = await store.query(rewritten.value.source);
      expect(found.bindings).toEqual(Array.from({ length: 3 }, () => ({ s: 'urn:scale:s', o: 'urn:scale:end' })));
    } finally {
      await store.update(selected.map(graph => `DROP SILENT GRAPH <${graph}>`).join('; '));
    }
  });

  it.each([
    ['<urn:scale:link>+', 1400],
    ['(<urn:scale:link>|<urn:scale:other>)+', 64],
  ] as const)('keeps caller GRAPH reads executable for %s across %i graphs', async (path, callerGraphScale) => {
    const contextGraphId = `${id}-caller-scale-${path.includes('|') ? 'alt' : 'plus'}`;
    const root = `did:dkg:context-graph:${contextGraphId}`;
    const selected = [root, ...Array.from({ length: callerGraphScale - 1 }, (_, n) => `${root}/_verifiable_memory/a/${n}`)];
    const forbidden = `${root}-unlisted`;
    const facade = new Proxy(store, { get(target, key) {
      if (key === 'sparqlEngine') return undefined;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect(sparqlEngineOf(facade)).toBeNull();
    try {
      await store.insert([
        ...selected.map(graph => quad('urn:scale:s', 'urn:scale:link', 'urn:scale:o', graph)),
        quad('urn:scale:forbidden', 'urn:scale:link', 'urn:scale:o', forbidden),
      ]);
      const engine = new DKGQueryEngine(facade);
      const pattern = `GRAPH ?g { ?s ${path} ?o }`;
      const page = await engine.query(`SELECT ?g ?s ?o WHERE { ${pattern} } ORDER BY ?g LIMIT 10 OFFSET 3`, { contextGraphId });
      expect(page.bindings).toEqual([...selected].sort().slice(3, 13).map(g => ({ g, s: 'urn:scale:s', o: 'urn:scale:o' })));
      const count = await engine.query(`SELECT (COUNT(*) AS ?n) WHERE { ${pattern} }`, { contextGraphId });
      expect(integer(count.bindings?.[0]?.n)).toBe(selected.length);
    } finally {
      await store.update([...selected, forbidden].map(graph => `DROP SILENT GRAPH <${graph}>`).join('; '));
    }
  });
});
