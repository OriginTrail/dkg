import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphSetIndexStore, noteStoreMayHoldReadGraphPartitions, OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { MemoryLayer, READ_GRAPH_SEGMENT, readGraphIri, readGraphStateGraphIri, readScope } from '@origintrail-official/dkg-core';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { classifyScopedContentGraph, describeScopedContentGraph, isExcludedContentGraph } from '../src/scoped-content-partition.js';
import { createScopedContentGraphRoutePolicy, selectLegacyScopedRouteGraphs } from '../src/scoped-content-graph-policy.js';
import { prepareSparql } from '@origintrail-official/dkg-rdf-utils/sparql';
import { ScopedQueryViolationError } from '../src/scoped-query-error.js';
import { prepareGraphScope, rewriteGraphSet } from '../src/sparql-graph-scope.js';
import type { QueryOptions } from '../src/query-engine.js';

const CG = 'read-partition';
const ROOT = `did:dkg:context-graph:${CG}`;
const VM = `${ROOT}/_verifiable_memory/0xab/1`;
const VM_CODE = `${ROOT}/code/_verifiable_memory/0xab/2`;
const SWM = `${ROOT}/_shared_memory/0xab/1`;
const META = `${ROOT}/_meta`;
const OTHER = 'did:dkg:context-graph:other/_verifiable_memory/0xcd/1';
const READ_VM = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory });
const READ_SWM = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.SharedWorkingMemory });
const READ_CODE = readGraphIri({ scope: readScope(CG, 'code'), layer: MemoryLayer.VerifiableMemory });
const STATE = readGraphStateGraphIri(CG);
// A context graph whose ID has a `_read` segment, as IDs from before the reservation may.
const LEGACY_CG = `${CG}/_read/project`;
const LEGACY = `did:dkg:context-graph:${LEGACY_CG}/_verifiable_memory/0xaa/1`;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const row = (graph: string, subject: string, object: string): Quad => ({ graph, subject, predicate: 'urn:p', object });
const MEMBERS: Quad[] = [
  row(VM, 'urn:a', '"vm"'), row(VM_CODE, 'urn:b', '"code"'), row(SWM, 'urn:c', '"swm"'), row(OTHER, 'urn:d', '"other"'),
  row(LEGACY, 'urn:e', '"legacy"'),
  { graph: META, subject: `${ROOT}/code`, predicate: RDF_TYPE, object: 'http://dkg.io/ontology/SubGraph' },
  { graph: META, subject: `${ROOT}/code`, predicate: 'http://schema.org/name', object: '"code"' },
];
// Copies of member triples, as read graphs hold them, and a state row.
const READ_GRAPHS: Quad[] = [
  row(READ_VM, 'urn:a', '"vm"'), row(READ_VM, 'urn:b', '"code"'), row(READ_SWM, 'urn:c', '"swm"'),
  row(READ_CODE, 'urn:b', '"code"'), { graph: STATE, subject: READ_VM, predicate: 'urn:state', object: '"ready"' },
];

let planted: OxigraphStore;
let oracle: OxigraphStore;
beforeEach(async () => {
  planted = new OxigraphStore();
  oracle = new OxigraphStore();
  await planted.insert([...MEMBERS, ...READ_GRAPHS]);
  // As whatever creates read graphs does, so unscoped queries leave them out.
  noteStoreMayHoldReadGraphPartitions(planted);
  // The behavioural oracle: the same store without read graphs.
  await oracle.insert(MEMBERS);
});
afterEach(async () => { await planted.close(); await oracle.close(); });

function normalize(result: { bindings: Array<Record<string, string>>; quads?: Quad[] }) {
  return JSON.stringify({
    bindings: result.bindings.map(binding => JSON.stringify(Object.entries(binding).sort())).sort(),
    quads: (result.quads ?? []).map(quad => JSON.stringify([quad.subject, quad.predicate, quad.object, quad.graph])).sort(),
  });
}

describe('read-graph partitions in content classification', () => {
  it.each(['', '/state', '/cg/_verifiable_memory', '/sub/code/_shared_memory', '/stray']
    .map(rest => `${READ_GRAPH_SEGMENT}${rest}`)
    .concat([`code/${READ_GRAPH_SEGMENT}/cg/_verifiable_memory`, `child/${READ_GRAPH_SEGMENT}/state`]))('excludes %s wherever it excludes metadata', tail => {
    expect(isExcludedContentGraph(`${ROOT}/${tail}`, ROOT)).toBe(true);
  });

  // A child context graph whose older ID continues a content path puts its
  // partition where the parent's content lives: only the exclusion keeps it out.
  const UNDER_SHARED = `${ROOT}/_shared_memory/legacy/${READ_GRAPH_SEGMENT}/cg/_verifiable_memory`;
  const UNDER_VERIFIED = `${ROOT}/_verifiable_memory/legacy/${READ_GRAPH_SEGMENT}/state`;
  const SHARED = `${ROOT}/_shared_memory/legacy/x`;
  const VERIFIED = `${ROOT}/_verifiable_memory/legacy/state`;

  it('keeps partition graphs out of content where their path looks like content', () => {
    for (const graph of [UNDER_SHARED, UNDER_VERIFIED]) {
      expect(describeScopedContentGraph(graph, CG), graph).toBeUndefined();
      expect(classifyScopedContentGraph(graph, CG, new Set(), new Set(), new Set()), graph).toBeUndefined();
    }
    expect(describeScopedContentGraph(SHARED, CG)?.kind).toBe('shared');
    expect(describeScopedContentGraph(VERIFIED, CG)?.kind).toBe('verified');
  });

  it('keeps them out of a route that lists graphs by prefix', () => {
    const policy = createScopedContentGraphRoutePolicy(CG, { includeSharedMemory: true });
    const selected = selectLegacyScopedRouteGraphs(policy, new Map([
      [`${ROOT}/_shared_memory`, [SHARED, UNDER_SHARED]],
      [ROOT, [VERIFIED, UNDER_VERIFIED]],
    ]));
    expect(selected).toEqual(expect.arrayContaining([SHARED, VERIFIED]));
    for (const graph of [UNDER_SHARED, UNDER_VERIFIED]) expect(selected, graph).not.toContain(graph);
  });

  it.each(['_reader', `${READ_GRAPH_SEGMENT}er`, 'reader/_verifiable_memory/0xab/1', '_verifiable_memory/0xab/read',
    '_verifiable_memory/0xab/_read', '_read', '_read/state', '_read/project/_verifiable_memory/0xaa/1'])('keeps look-alike %s', tail => {
    expect(isExcludedContentGraph(`${ROOT}/${tail}`, ROOT)).toBe(false);
  });

  it('classifies a context graph whose ID has the segment as any other', () => {
    expect(describeScopedContentGraph(LEGACY, LEGACY_CG)).toEqual({ kind: 'verified', subGraphName: undefined });
    expect(describeScopedContentGraph(`${ROOT}/_verifiable_memory/0xab/_read`, CG)).toEqual({ kind: 'verified', subGraphName: undefined });
  });
});

// Reaches the whole-context-graph read graph through a computed IRI, which no IRI token names.
const COMPUTED_READ_VM = 'SELECT ?o WHERE { BIND(IRI(CONCAT(STR(<did:dkg:context-graph:read-partition>), '
  + `"/${READ_GRAPH_SEGMENT.slice(0, 1)}", "${READ_GRAPH_SEGMENT.slice(1)}/cg/_verifiable_memory")) AS ?g) GRAPH ?g { ?s ?p ?o } }`;

// Unscoped shapes that do not name a read graph: each must answer as on a store without read graphs.
const UNSCOPED = [
  'SELECT ?o WHERE { GRAPH ?g { ?s <urn:p> ?o } }',
  'SELECT ?g (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g',
  'SELECT DISTINCT ?g WHERE { GRAPH ?g { } }',
  'SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }',
  'SELECT (COUNT(DISTINCT ?s) AS ?c) WHERE { GRAPH ?g { ?s ?p ?o } }',
  'SELECT ?c WHERE { { SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s ?p ?o } } } }',
  'SELECT ?x WHERE { VALUES ?x { "probe" } FILTER NOT EXISTS { GRAPH ?g { ?s <urn:state> "ready" } } }',
  'SELECT ?o WHERE { GRAPH ?g { GRAPH ?h { ?s <urn:p> ?o } } }',
  COMPUTED_READ_VM,
  'SELECT ?o WHERE { ?s <urn:p> ?o }',
  'ASK { GRAPH ?g { <urn:a> <urn:p> "vm" } }',
  'ASK { GRAPH ?g { ?s <urn:state> "ready" } }',
  'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }',
  'DESCRIBE ?s WHERE { GRAPH ?g { ?s <urn:p> "code" } }',
];
// Of those, the shapes whose answer does not depend on the read graphs, which check that nothing else changes:
// the pattern outside GRAPH and the description read the default graph, which holds nothing here.
const CONTROLS = [
  'SELECT ?o WHERE { ?s <urn:p> ?o }',
  'ASK { GRAPH ?g { <urn:a> <urn:p> "vm" } }',
  'DESCRIBE ?s WHERE { GRAPH ?g { ?s <urn:p> "code" } }',
];

// Unscoped shapes that name their own dataset: while read graphs may exist, they need a context graph.
const DATASET = [
  `SELECT ?o FROM NAMED <${VM}> WHERE { GRAPH ?g { ?s <urn:p> ?o } }`,
  `SELECT ?o FROM <${VM}> WHERE { ?s <urn:p> ?o }`,
];
const SCOPE_REQUIRED = 'Scoped query violation: this store cannot answer that query without a context graph now';

// Shapes that name a read graph or its state, by IRI, prefix or escape.
const NAMING = [
  `SELECT ?o WHERE { GRAPH <${READ_VM}> { ?s ?p ?o } }`,
  `SELECT ?o FROM <${READ_VM}> WHERE { ?s ?p ?o }`,
  `SELECT ?o FROM NAMED <${STATE}> WHERE { GRAPH ?g { ?s ?p ?o } }`,
  `SELECT ?o WHERE { VALUES ?g { <${READ_SWM}> } GRAPH ?g { ?s ?p ?o } }`,
  `SELECT ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(?g = <${READ_CODE}>) }`,
  `PREFIX r: <${ROOT}/> SELECT ?o WHERE { GRAPH r:_\\~read\\/state { ?s ?p ?o } }`,
  `SELECT ?o WHERE { GRAPH <${ROOT}/\\u005F\\u007Eread/state> { ?s ?p ?o } }`,
];

describe('queries and read-graph partitions', () => {
  it('answers each unscoped shape as on a store without read graphs', async () => {
    for (const store of [planted, new GraphSetIndexStore(planted)] as TripleStore[]) {
      const engine = new DKGQueryEngine(store);
      const reference = new DKGQueryEngine(oracle);
      for (const sparql of UNSCOPED) {
        expect(normalize(await engine.query(sparql)), sparql).toBe(normalize(await reference.query(sparql)));
      }
      for (const sparql of DATASET) {
        await expect(engine.query(sparql), sparql).rejects.toThrow(SCOPE_REQUIRED);
        expect((await reference.query(sparql)).bindings, sparql).toHaveLength(1);
      }
    }
    // The read graphs are there: the adapter answers the computed IRI with them.
    const raw = await planted.query(COMPUTED_READ_VM);
    expect(raw.type === 'bindings' && raw.bindings.length).toBe(2);
    expect((await new DKGQueryEngine(planted).query(COMPUTED_READ_VM)).bindings).toEqual([]);
  });

  it('compares only shapes whose answer changes once the read graphs are visible', async () => {
    // The same contents without the record, so the engine leaves unscoped queries unrestricted.
    const exposed = new OxigraphStore();
    try {
      await exposed.insert([...MEMBERS, ...READ_GRAPHS]);
      const engine = new DKGQueryEngine(exposed);
      const reference = new DKGQueryEngine(oracle);
      for (const sparql of UNSCOPED) {
        const differs = normalize(await engine.query(sparql)) !== normalize(await reference.query(sparql));
        expect.soft(differs, sparql).toBe(!CONTROLS.includes(sparql));
      }
    } finally { await exposed.close(); }
  });

  it('leaves unscoped queries unchanged on a store that cannot hold read graphs', async () => {
    const fresh = new OxigraphStore();
    try {
      await fresh.insert(MEMBERS);
      const query = vi.spyOn(fresh, 'query');
      await new DKGQueryEngine(fresh).query(UNSCOPED[0]!);
      expect(query.mock.calls.at(-1)?.[1]?.withheldGraphRoots).toBeUndefined();
      // The record is what turns the restriction on; whatever creates read graphs records it.
      await fresh.insert(READ_GRAPHS);
      const rows = await new DKGQueryEngine(fresh).query('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }');
      expect(rows.bindings.map(row => row.g)).toContain(READ_VM);
    } finally { await fresh.close(); }
  });

  it('answers no unscoped query on a store that cannot leave read graphs out', async () => {
    // As the HTTP adapters do: any dataset restriction is refused before dispatch.
    const unrestricted = new Proxy(planted, { get(target, key) {
      if (key === 'query') return (sparql: string, options?: { withheldGraphRoots?: readonly string[] }) => {
        if (options?.withheldGraphRoots !== undefined) {
          return Promise.reject(Object.assign(new Error('cannot withhold graphs from a query'), { code: 'QUERY_DATASET_UNRESTRICTED' }));
        }
        return target.query(sparql, options);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as TripleStore;
    const engine = new DKGQueryEngine(unrestricted);
    // Until the store may hold read graphs, its unscoped queries run as before.
    expect((await engine.query(UNSCOPED[0]!)).bindings.length).toBeGreaterThan(0);
    noteStoreMayHoldReadGraphPartitions(unrestricted);
    for (const sparql of [UNSCOPED[0]!, 'SELECT ?o WHERE { ?s <urn:p> ?o }', ...DATASET]) {
      await expect(engine.query(sparql), sparql).rejects.toThrow(SCOPE_REQUIRED);
    }
    // A scoped query is unaffected.
    expect((await engine.query('SELECT ?s WHERE { ?s ?p ?o }', { contextGraphId: CG, view: 'verifiable-memory' })).bindings)
      .not.toHaveLength(0);
  });

  it('refuses a query that names a read-graph partition, scoped or not', async () => {
    const engine = new DKGQueryEngine(planted);
    for (const sparql of NAMING) {
      for (const options of [undefined, { contextGraphId: CG }, { contextGraphId: CG, view: 'verifiable-memory' as const }]) {
        await expect(engine.query(sparql, options), sparql).rejects.toThrow('Scoped query violation: the query names a graph in a read-graph partition');
      }
    }
  });

  it('answers for a context graph whose ID has the segment as for any other', async () => {
    const engine = new DKGQueryEngine(planted);
    const reference = new DKGQueryEngine(oracle);
    const cases: Array<[string, Record<string, unknown> | undefined]> = [
      [`SELECT ?o WHERE { GRAPH <${LEGACY}> { ?s ?p ?o } }`, undefined],
      ['SELECT ?o WHERE { ?s <urn:p> ?o }', { contextGraphId: LEGACY_CG, view: 'verifiable-memory' }],
    ];
    for (const [sparql, options] of cases) {
      const answer = await engine.query(sparql, options);
      expect(answer.bindings.map(binding => binding.o), sparql).toEqual(['"legacy"']);
      expect(normalize(answer), sparql).toBe(normalize(await reference.query(sparql, options)));
    }
  });

  it('gives scoped reads the same answer with and without read graphs', async () => {
    const engine = new DKGQueryEngine(new GraphSetIndexStore(planted));
    const reference = new DKGQueryEngine(new GraphSetIndexStore(oracle));
    const cases: Array<[string, Record<string, unknown>]> = [
      ['SELECT ?g ?o WHERE { GRAPH ?g { ?s <urn:p> ?o } }', { contextGraphId: CG, includeContextGraphPartitions: true }],
      ['SELECT ?g ?o WHERE { GRAPH ?g { ?s <urn:p> ?o } }', { contextGraphId: CG, includeContextGraphPartitions: true, includeSharedMemory: true }],
      ['SELECT ?o WHERE { ?s <urn:p> ?o }', { contextGraphId: CG, view: 'verifiable-memory' }],
      ['SELECT ?o WHERE { ?s <urn:p> ?o }', { contextGraphId: CG, view: 'shared-working-memory' }],
      ['SELECT ?o WHERE { ?s <urn:p> ?o }', { contextGraphId: CG, subGraphName: 'code' }],
      // The shape `dkg okf export` sends for a view.
      ['SELECT ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?s), "urn:")) }', { contextGraphId: CG, view: 'verifiable-memory' }],
      ['SELECT ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?s), "urn:")) }', { contextGraphId: CG, view: 'shared-working-memory' }],
    ];
    for (const [sparql, options] of cases) {
      expect(normalize(await engine.query(sparql, options)), JSON.stringify(options))
        .toBe(normalize(await reference.query(sparql, options)));
    }
    // Partitions come in the store's enumeration order, which depends on what was inserted.
    const byGraph = (reads: Array<{ graph: string }>) => [...reads].sort((a, b) => a.graph.localeCompare(b.graph));
    expect(byGraph(await engine.listContextGraphQueryPartitionReads(CG, { includeSharedMemory: true })))
      .toEqual(byGraph(await reference.listContextGraphQueryPartitionReads(CG, { includeSharedMemory: true })));
  });
});

describe('read-graph partitions named by query options', () => {
  const SELECT = 'SELECT ?s WHERE { ?s ?p ?o }';
  const PARTITION_ID = `${CG}/${READ_GRAPH_SEGMENT}/cg/_verifiable_memory`;
  it.each<[string, QueryOptions]>([
    ['a view on a context graph ID inside a partition', { contextGraphId: PARTITION_ID, view: 'verifiable-memory' }],
    ['a scoped read of that ID', { contextGraphId: PARTITION_ID }],
    ['a legacy suffix', { contextGraphId: CG, graphSuffix: `${READ_GRAPH_SEGMENT}/cg/_shared_memory` as '_shared_memory' }],
    ['an agent address', { contextGraphId: CG, view: 'working-memory', agentAddress: `0xab/${READ_GRAPH_SEGMENT}` }],
    ['an agent alias', { contextGraphId: CG, view: 'working-memory', agentAddress: '0xab', agentAddressAliases: [`x/${READ_GRAPH_SEGMENT}`] }],
    ['an assertion name', { contextGraphId: CG, view: 'working-memory', agentAddress: '0xab', assertionName: `${READ_GRAPH_SEGMENT}/state` }],
    ['a verified graph', { contextGraphId: CG, view: 'verifiable-memory', verifiedGraph: `${READ_GRAPH_SEGMENT}/state` }],
  ])('refuses %s', async (_, options) => {
    await expect(new DKGQueryEngine(planted).query(SELECT, options)).rejects.toBeInstanceOf(ScopedQueryViolationError);
  });

  it('still answers the context graph itself', async () => {
    const result = await new DKGQueryEngine(planted).query(SELECT, { contextGraphId: CG, view: 'verifiable-memory' });
    expect(result.bindings.map(binding => binding.s)).toContain('urn:a');
  });

  it('refuses a scoped read whose graphs, however built, include a partition graph', () => {
    const scope = prepareGraphScope(prepareSparql(SELECT));
    expect(() => rewriteGraphSet(scope, [VM, READ_VM], 'values-union', 'oxigraph')).toThrow(ScopedQueryViolationError);
    expect(rewriteGraphSet(scope, [VM, LEGACY], 'values-union', 'oxigraph').kind).toBe('ready');
  });
});

