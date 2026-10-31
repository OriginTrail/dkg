import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlazegraphStore, OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { materializePreparedSparql, prepareSparql } from '@origintrail-official/dkg-rdf-utils/sparql';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { prepareGraphScope, wrapWithDeduplicatedGraphValues } from '../src/sparql-graph-scope.js';

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

  it('aggregates over the deduplicated rows', async () => {
    const counts = await select(`SELECT ?s (COUNT(*) AS ?c) WHERE { ${JOIN} } GROUP BY ?s`);
    expect(Object.fromEntries(counts.map((row) => [row.s, integer(row.c)])))
      .toEqual({ 'urn:s:1': 1, 'urn:s:3': 2 });
    const hops = await select(`SELECT ?s (COUNT(*) AS ?c) WHERE { ?s <${LINK}>/<${TO}> ?o } GROUP BY ?s`);
    expect(Object.fromEntries(hops.map((row) => [row.s, integer(row.c)])))
      .toEqual({ 'urn:s:4': 2, 'urn:s:5': 2 });
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
});
