import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryLayer, readGraphIri, readGraphStateGraphIri, readScope } from '@origintrail-official/dkg-core';
import {
  BlazegraphNamespaceManager, BlazegraphStore, blazegraphNamespaceApiUrlFromSparqlEndpoint,
  noteStoreMayHoldReadGraphPartitions, OxigraphStore, READ_GRAPH_STATE_PREDICATES,
  type Quad, type TripleStore,
} from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { ScopedQueryViolationError } from '../src/scoped-query-error.js';
import { UnscopedReadGraphQueryError } from '../src/unscoped-read-graph-scope.js';

// CI's tornado-blazegraph lane runs this file on a live server; elsewhere it runs on Oxigraph.
const endpoint = process.env.BLAZEGRAPH_TEST_URL;
if (process.env.DKG_REQUIRE_BLAZEGRAPH === '1' && !endpoint) throw new Error('Blazegraph CI endpoint is required');
const ENGINE = endpoint ? 'blazegraph' : 'oxigraph';

const CG = 'unscoped-oracle';
const CG2 = 'unscoped-oracle-other';
const ROOT = `did:dkg:context-graph:${CG}`;
const G1 = `${ROOT}/_verifiable_memory/0xaa/1`;
const G2 = `${ROOT}/_verifiable_memory/0xaa/2`;
const GS = `${ROOT}/code/_verifiable_memory/0xaa/9`;
const META = `${ROOT}/_meta`;
const H1 = `did:dkg:context-graph:${CG2}/_verifiable_memory/0xbb/1`;
const RCG = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory });
const RSUB = readGraphIri({ scope: readScope(CG, 'code'), layer: MemoryLayer.VerifiableMemory });
const R2 = readGraphIri({ scope: readScope(CG2), layer: MemoryLayer.VerifiableMemory });
const ST = readGraphStateGraphIri(CG);
const ST2 = readGraphStateGraphIri(CG2);
const INT = (n: number) => `"${n}"^^<http://www.w3.org/2001/XMLSchema#integer>`;
const HINTS = 'PREFIX hint: <http://www.bigdata.com/queryHints#>';

const q = (graph: string, subject: string, predicate: string, object: string): Quad => ({ graph, subject, predicate, object });
const BASE: Quad[] = [
  q(G1, 'urn:s', 'urn:p', 'urn:x'), q(G1, 'urn:a', 'urn:b', 'urn:c'), q(G1, 'urn:x', 'urn:r', 'urn:z'), q(G1, 'urn:s', 'urn:val', INT(5)),
  // A subject whose only urn:q match is left in a read graph (STALE): it keeps the negative shapes honest.
  q(G1, 'urn:v', 'urn:p', 'urn:x'),
  q(G2, 'urn:s', 'urn:q', 'urn:y'), q(G2, 'urn:a', 'urn:b', 'urn:c'), q(G2, 'urn:s', 'urn:val', INT(5)),
  q(GS, 'urn:s', 'urn:t', 'urn:w'), q(GS, 'urn:a', 'urn:b', 'urn:c'),
  q(META, 'urn:ka1', 'urn:status', '"confirmed"'), q(META, 'urn:ka1', 'urn:points', RCG),
  q(H1, 'urn:s', 'urn:p', 'urn:x'), q(H1, 'urn:m', 'urn:n', 'urn:o'),
  // The store's default graph.
  q('', 'urn:dg', 'urn:dp', 'urn:do'),
];
const copiesOf = (readGraph: string, ...members: string[]) => {
  const seen = new Set<string>();
  return BASE.filter(row => members.includes(row.graph)).filter(row => {
    const key = `${row.subject} ${row.predicate} ${row.object}`;
    return !seen.has(key) && seen.add(key);
  }).map(row => ({ ...row, graph: readGraph }));
};
const COPIES = [...copiesOf(RCG, G1, G2, GS), ...copiesOf(RSUB, GS), ...copiesOf(R2, H1)];
const stateRow = (stateGraph: string, readGraph: string, state: string, generation: number) => [
  q(stateGraph, readGraph, READ_GRAPH_STATE_PREDICATES.state, `"${state}"`),
  q(stateGraph, readGraph, READ_GRAPH_STATE_PREDICATES.generation, INT(generation)),
  q(stateGraph, readGraph, READ_GRAPH_STATE_PREDICATES.ruleVersion, INT(1)),
  q(stateGraph, readGraph, READ_GRAPH_STATE_PREDICATES.builderVersion, INT(1)),
];
const STATE = [...stateRow(ST, RCG, 'ready', 3), ...stateRow(ST, RSUB, 'ready', 1), ...stateRow(ST2, R2, 'dirty', 7)];
// Triples an unmaintained writer deleted from H1 while R2 was dirty: they are left only in R2.
const STALE = [q(R2, 'urn:gone', 'urn:p', 'urn:x'), q(R2, 'urn:gone', 'urn:val', INT(5)), q(R2, 'urn:v', 'urn:q', 'urn:hidden')];
const VARIANTS = {
  copies: [...BASE, ...COPIES],
  'copies and state': [...BASE, ...COPIES, ...STATE],
  'copies, state and a stale triple': [...BASE, ...COPIES, ...STATE, ...STALE],
} as const;
type Variant = keyof typeof VARIANTS;

/**
 * What each shape reads:
 * - graph: only inside GRAPH, by variable or by an IRI outside read-graph partitions;
 * - graph-path: inside GRAPH ?g with a *, + or ? path; graph-group: a GRAPH ?g group without a leading triple pattern;
 * - default: outside GRAPH; hint: carries a query hint; dataset: names its own dataset;
 * - describe: DESCRIBE; names: names a read graph, which every store refuses.
 */
type Kind = 'graph' | 'graph-path' | 'graph-group' | 'default' | 'hint' | 'dataset' | 'describe' | 'names';
const SHAPES: ReadonlyArray<readonly [string, Kind, string]> = [
  ['D1 all triples', 'default', 'SELECT ?s ?p ?o WHERE { ?s ?p ?o }'],
  ['D1a all triples, analytic hint', 'hint', `${HINTS} SELECT ?s ?p ?o WHERE { hint:Query hint:analytic "true" . ?s ?p ?o }`],
  ['D2 all triples, DISTINCT', 'default', 'SELECT DISTINCT ?s ?p ?o WHERE { ?s ?p ?o }'],
  ['D3 COUNT(*)', 'default', 'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }'],
  ['D3a COUNT(*), analytic hint', 'hint', `${HINTS} SELECT (COUNT(*) AS ?n) WHERE { hint:Query hint:analytic "true" . ?s ?p ?o }`],
  ['D4 COUNT(*), constant predicate', 'default', 'SELECT (COUNT(*) AS ?n) WHERE { ?s <urn:b> ?o }'],
  ['D5 COUNT(DISTINCT ?s)', 'default', 'SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s ?p ?o }'],
  ['D6 DISTINCT ?p', 'default', 'SELECT DISTINCT ?p WHERE { ?s ?p ?o }'],
  ['D7 a triple in several graphs', 'default', 'SELECT ?o WHERE { <urn:a> <urn:b> ?o }'],
  ['D8 join across assets', 'default', 'SELECT ?s ?z WHERE { ?s <urn:p> ?x . ?x <urn:r> ?z }'],
  ['D9 join of two copied triples', 'default', 'SELECT ?s ?o WHERE { ?s <urn:val> ?v . <urn:a> <urn:b> ?o }'],
  ['D9a the same, analytic hint', 'hint', `${HINTS} SELECT ?s ?o WHERE { hint:Query hint:analytic "true" . ?s <urn:val> ?v . <urn:a> <urn:b> ?o }`],
  ['D9b the same, optimizer None', 'hint', `${HINTS} SELECT ?s ?o WHERE { hint:Query hint:optimizer "None" . <urn:a> <urn:b> ?o . ?s <urn:val> ?v }`],
  ['D10 SUM', 'default', 'SELECT (SUM(?v) AS ?t) WHERE { ?s <urn:val> ?v }'],
  ['D11 GROUP BY with COUNT', 'default', 'SELECT ?s (COUNT(?o) AS ?c) WHERE { ?s ?p ?o } GROUP BY ?s'],
  ['D12 OPTIONAL', 'default', 'SELECT ?s ?y WHERE { ?s <urn:p> <urn:x> OPTIONAL { ?s <urn:q> ?y } }'],
  ['D13 FILTER NOT EXISTS', 'default', 'SELECT ?s WHERE { ?s <urn:p> <urn:x> FILTER NOT EXISTS { ?s <urn:q> ?y } }'],
  ['D14 MINUS', 'default', 'SELECT ?s WHERE { ?s <urn:p> ?x MINUS { ?s <urn:q> ?y } }'],
  ['D15 sequence path', 'default', 'SELECT ?s ?z WHERE { ?s <urn:p>/<urn:r> ?z }'],
  ['D16 one-or-more path', 'default', 'SELECT ?s ?o WHERE { ?s <urn:p>+ ?o }'],
  ['D17 negated property set', 'default', 'SELECT (COUNT(*) AS ?n) WHERE { ?s !<urn:none> ?o }'],
  ['D18 COUNT in a sub-select', 'default', 'SELECT ?n WHERE { { SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o } } }'],
  ['D19 ASK a stale triple', 'default', 'ASK { <urn:gone> <urn:p> <urn:x> }'],
  ['D20 a state predicate', 'default', `SELECT ?r ?st WHERE { ?r <${READ_GRAPH_STATE_PREDICATES.state}> ?st }`],
  ['D21 predicate bound by VALUES', 'default', `SELECT ?s ?o WHERE { VALUES ?p { <${READ_GRAPH_STATE_PREDICATES.state}> <urn:p> } ?s ?p ?o }`],
  ['D22 FILTER EXISTS', 'default', 'SELECT ?s WHERE { ?s <urn:p> ?x FILTER EXISTS { ?x <urn:r> ?z } }'],
  ['D23 NOT EXISTS inside EXISTS', 'default', 'SELECT ?s WHERE { ?s <urn:p> ?x FILTER EXISTS { ?x <urn:r> ?z FILTER NOT EXISTS { ?s <urn:q> ?y } } }'],
  ['D24 UNION', 'default', 'SELECT ?s ?v WHERE { { ?s <urn:p> <urn:x> } UNION { ?s <urn:val> ?v } }'],
  ['D25 subject bound by VALUES', 'default', 'SELECT ?s ?o WHERE { VALUES ?s { <urn:gone> <urn:s> } ?s <urn:p> ?o }'],
  ['D26 the default graph', 'default', 'SELECT ?o WHERE { <urn:dg> <urn:dp> ?o }'],
  ['G1 GRAPH ?g, all quads', 'graph', 'SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } }'],
  ['G2 COUNT per graph', 'graph', 'SELECT ?g (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g'],
  ['G3 graph enumeration', 'graph', 'SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }'],
  ['G4 COUNT(*) of quads', 'graph', 'SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } }'],
  ['G5 ?g bound to a read graph', 'names', `SELECT ?s WHERE { VALUES ?g { <${RCG}> } GRAPH ?g { ?s ?p ?o } }`],
  ['G6 a read graph by name', 'names', `SELECT ?s WHERE { GRAPH <${RCG}> { ?s ?p ?o } }`],
  ['G7 FROM a read graph', 'names', `SELECT ?s FROM <${RCG}> WHERE { ?s ?p ?o }`],
  ['G8 default pattern and GRAPH ?g', 'default', 'SELECT ?g ?y WHERE { <urn:s> <urn:p> <urn:x> . GRAPH ?g { <urn:s> <urn:q> ?y } }'],
  ['G9 ?g pinned to a read graph', 'names', `SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } FILTER(?g = <${RCG}>) }`],
  ['C1 CONSTRUCT', 'default', 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }'],
  ['C2 short CONSTRUCT', 'default', 'CONSTRUCT WHERE { ?s <urn:b> ?o }'],
  ['C3 CONSTRUCT from GRAPH ?g', 'graph', 'CONSTRUCT { ?s <urn:in> ?g } WHERE { GRAPH ?g { ?s ?p ?o } }'],
  ['X1 DESCRIBE', 'describe', 'DESCRIBE <urn:a>'],
  ['X2 DESCRIBE a stale subject', 'describe', 'DESCRIBE <urn:gone>'],
  ['X3 DESCRIBE a stale object', 'describe', 'DESCRIBE <urn:x>'],
  ['X4 DESCRIBE a read graph', 'names', `DESCRIBE <${RCG}>`],
  ['X5 DESCRIBE what a state row names', 'describe', 'DESCRIBE ?r WHERE { ?r ?p "ready" }'],
  ['P1 one-or-more path in GRAPH', 'graph-path', 'SELECT ?g ?s ?o WHERE { GRAPH ?g { ?s <urn:p>+ ?o } }'],
  ['P2 zero-or-more path in GRAPH', 'graph-path', 'SELECT ?g ?x ?y WHERE { GRAPH ?g { ?x <urn:p>* ?y } }'],
  ['P3 zero-or-one path in GRAPH', 'graph-path', 'SELECT ?g ?x ?y WHERE { GRAPH ?g { ?x <urn:p>? ?y } }'],
  ['P4 sequence path in GRAPH', 'graph', 'SELECT ?g ?s ?z WHERE { GRAPH ?g { ?s <urn:p>/<urn:r> ?z } }'],
  ['S1 COUNT in a sub-select over GRAPH', 'graph', 'SELECT ?n WHERE { { SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } } } }'],
  ['O1 OPTIONAL GRAPH', 'graph', 'SELECT ?s ?h WHERE { GRAPH ?g { ?s <urn:p> <urn:x> } OPTIONAL { GRAPH ?h { ?s <urn:q> ?y } } }'],
  ['N1 NOT EXISTS over GRAPH', 'graph', 'SELECT ?g ?s WHERE { GRAPH ?g { ?s <urn:p> ?x } FILTER(NOT EXISTS { GRAPH ?h { ?s <urn:q> ?y } }) }'],
  ['M1 MINUS over GRAPH', 'graph', 'SELECT ?g ?s WHERE { GRAPH ?g { ?s ?p ?o } MINUS { GRAPH ?h { ?s <urn:q> ?y } } }'],
  ['Y1 EXISTS in the projection, outside GRAPH', 'default', 'SELECT ?s (EXISTS { <urn:gone> <urn:p> <urn:x> } AS ?stale) WHERE { GRAPH ?g { ?s <urn:p> <urn:x> } }'],
  ['U1 UNION of GRAPH', 'graph', 'SELECT ?g ?s WHERE { { GRAPH ?g { ?s <urn:p> ?o } } UNION { GRAPH ?g { ?s <urn:t> ?o } } }'],
  ['B1 a computed graph IRI', 'graph', `SELECT ?s WHERE { BIND(IRI(CONCAT("${ROOT}/_", "read/cg/_verifiable_memory")) AS ?g) GRAPH ?g { ?s ?p ?o } }`],
  ['B2 a graph IRI read from data', 'graph', `SELECT ?o WHERE { GRAPH <${META}> { ?k <urn:points> ?g } GRAPH ?g { ?s ?p ?o } }`],
  ['Q1 ASK over GRAPH', 'graph', 'ASK { GRAPH ?g { <urn:gone> <urn:p> <urn:x> } }'],
  ['E1 graphs by an empty group', 'graph-group', 'SELECT ?g WHERE { GRAPH ?g { } }'],
  ['H1 a hint inside GRAPH', 'hint', `${HINTS} SELECT ?g WHERE { GRAPH ?g { ?s ?p ?o . hint:Prior hint:runFirst "true" } }`],
  ['F1 FROM NAMED with GRAPH ?g', 'dataset', `SELECT ?g ?s FROM NAMED <${G1}> WHERE { GRAPH ?g { ?s ?p ?o } }`],
  ['C4 CONSTRUCT of every quad', 'graph', 'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }'],
  ['X6 DESCRIBE over GRAPH', 'describe', 'DESCRIBE ?s WHERE { GRAPH ?g { ?s <urn:p> <urn:x> } }'],
];

/**
 * Every store refuses a read-graph name and a dataset the query names. A store
 * that restricts its dataset answers the rest; any other answers GRAPH only.
 */
function expected(kind: Kind): 'exact' | 'refused' {
  if (kind === 'names' || kind === 'dataset') return 'refused';
  if (ENGINE === 'oxigraph') return 'exact';
  return kind === 'graph' ? 'exact' : 'refused';
}

function normalize(result: { bindings: Array<Record<string, string>>; quads?: Quad[] }): string {
  return JSON.stringify({
    bindings: result.bindings.map(binding => JSON.stringify(Object.entries(binding).sort())).sort(),
    quads: (result.quads ?? []).map(quad => JSON.stringify([quad.subject, quad.predicate, quad.object])).sort(),
  });
}

describe(`unscoped queries on ${ENGINE} with read graphs planted`, () => {
  let manager: BlazegraphNamespaceManager | undefined;
  let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>> = [];
  const stores: TripleStore[] = [];
  let truth: DKGQueryEngine;
  const planted = new Map<Variant, { store: TripleStore; engine: DKGQueryEngine }>();

  async function openStore(data: readonly Quad[], index: number): Promise<TripleStore> {
    const store = endpoint ? new BlazegraphStore(handles[index]!.sparqlUrl) : new OxigraphStore();
    stores.push(store);
    await store.insert([...data]);
    return store;
  }

  beforeAll(async () => {
    const names = (Object.keys(VARIANTS) as Variant[]);
    if (endpoint) {
      manager = new BlazegraphNamespaceManager({ namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(endpoint), requestTimeoutMs: 20_000 });
      handles = await manager.acquireMany([0, 1, 2, 3].map(index => `unscoped-oracle-${index}-${randomUUID()}`));
    }
    truth = new DKGQueryEngine(await openStore(BASE, 0));
    for (const [index, name] of names.entries()) {
      const store = await openStore(VARIANTS[name], index + 1);
      // As whatever creates read graphs does.
      noteStoreMayHoldReadGraphPartitions(store);
      planted.set(name, { store, engine: new DKGQueryEngine(store) });
    }
  }, 120_000);

  afterAll(async () => {
    try { for (const store of stores) await store.close(); } finally {
      if (manager && handles.length) await manager.disposeAll(handles);
    }
  }, 60_000);

  it('loses the visible subject of the negative shapes when GRAPH ?h may read a read graph (control)', async () => {
    const { store } = planted.get('copies, state and a stale triple')!;
    const subjects = async (engine: Pick<TripleStore, 'query'> | DKGQueryEngine, query: string) => {
      const result = await engine.query(query);
      const rows = 'type' in result ? (result.type === 'bindings' ? result.bindings : []) : result.bindings;
      return rows.map(row => row.s).filter(Boolean);
    };
    for (const query of [SHAPES.find(([label]) => label.startsWith('N1'))![2], SHAPES.find(([label]) => label.startsWith('M1'))![2]]) {
      expect(await subjects(truth, query)).toContain('urn:v');
      expect(await subjects(planted.get('copies, state and a stale triple')!.engine, query)).toContain('urn:v');
      // Sent to the store as it is, the hidden match removes the subject.
      expect(await subjects(store, query)).not.toContain('urn:v');
    }
  });

  it('plants read graphs that a query sent straight to the store would see', async () => {
    for (const { store } of planted.values()) {
      const graphs = await store.query('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }');
      expect(graphs.type === 'bindings' ? graphs.bindings.map(row => row.g) : []).toContain(RCG);
    }
  });

  const cases = (Object.keys(VARIANTS) as Variant[]).flatMap(variant => SHAPES.map(([label, kind, query]) =>
    [`${label} [${variant}]`, variant, kind, query] as const));

  it.each(cases)('%s', async (_label, variant, kind, query) => {
    const { engine } = planted.get(variant)!;
    if (expected(kind) === 'refused') {
      const error = await engine.query(query).then(() => undefined, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(ENGINE === 'blazegraph' && kind !== 'names' ? UnscopedReadGraphQueryError : ScopedQueryViolationError);
      return;
    }
    expect(normalize(await engine.query(query))).toBe(normalize(await truth.query(query)));
  });
});
