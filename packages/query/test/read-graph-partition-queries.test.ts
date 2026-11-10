import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphSetIndexStore, noteStoreMayHoldReadGraphPartitions, OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { MemoryLayer, readGraphIri, readGraphStateGraphIri, readScope } from '@origintrail-official/dkg-core';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { classifyScopedContentGraph, describeScopedContentGraph, isExcludedContentGraphTail } from '../src/scoped-content-partition.js';

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
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const row = (graph: string, subject: string, object: string): Quad => ({ graph, subject, predicate: 'urn:p', object });
const MEMBERS: Quad[] = [
  row(VM, 'urn:a', '"vm"'), row(VM_CODE, 'urn:b', '"code"'), row(SWM, 'urn:c', '"swm"'), row(OTHER, 'urn:d', '"other"'),
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
  it.each(['_read', '_read/state', '_read/cg/_verifiable_memory', '_read/sub/code/_shared_memory',
    'code/_read/cg/_verifiable_memory', 'child/_read/state'])('excludes %s wherever it excludes metadata', tail => {
    expect(isExcludedContentGraphTail(tail)).toBe(true);
    expect(describeScopedContentGraph(`${ROOT}/${tail}`, CG)).toBeUndefined();
    expect(classifyScopedContentGraph(`${ROOT}/${tail}`, CG, new Set(['code', 'child']), new Set(), new Set())).toBeUndefined();
  });

  it.each(['_reader', 'reader/_verifiable_memory/0xab/1', '_verifiable_memory/0xab/read'])('keeps look-alike %s', tail => {
    expect(isExcludedContentGraphTail(tail)).toBe(false);
  });
});

// Unscoped shapes that do not name a read graph: each must answer as on a store without read graphs.
const UNSCOPED = [
  'SELECT ?o WHERE { GRAPH ?g { ?s <urn:p> ?o } }',
  'SELECT ?g (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g',
  'SELECT DISTINCT ?g WHERE { GRAPH ?g { } }',
  'SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }',
  'SELECT (COUNT(DISTINCT ?s) AS ?c) WHERE { GRAPH ?g { ?s ?p ?o } }',
  'SELECT ?c WHERE { { SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s ?p ?o } } } }',
  'SELECT ?s WHERE { VALUES ?s { <urn:a> } FILTER NOT EXISTS { GRAPH ?g { ?s <urn:p> "missing" } } }',
  'SELECT ?o WHERE { GRAPH ?g { GRAPH ?h { ?s <urn:p> ?o } } }',
  'SELECT ?o WHERE { BIND(IRI(CONCAT(STR(<did:dkg:context-graph:read-partition>), "/_", "read/cg/_verifiable_memory")) AS ?g) GRAPH ?g { ?s ?p ?o } }',
  `SELECT ?o FROM NAMED <${VM}> WHERE { GRAPH ?g { ?s <urn:p> ?o } }`,
  `SELECT ?o FROM <${VM}> WHERE { ?s <urn:p> ?o }`,
  'SELECT ?o WHERE { ?s <urn:p> ?o }',
  'ASK { GRAPH ?g { <urn:a> <urn:p> "vm" } }',
  'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }',
  'DESCRIBE ?s WHERE { GRAPH ?g { ?s <urn:p> "code" } }',
];

// Shapes that name a read graph or its state, by IRI, prefix or escape.
const NAMING = [
  `SELECT ?o WHERE { GRAPH <${READ_VM}> { ?s ?p ?o } }`,
  `SELECT ?o FROM <${READ_VM}> WHERE { ?s ?p ?o }`,
  `SELECT ?o FROM NAMED <${STATE}> WHERE { GRAPH ?g { ?s ?p ?o } }`,
  `SELECT ?o WHERE { VALUES ?g { <${READ_SWM}> } GRAPH ?g { ?s ?p ?o } }`,
  `SELECT ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(?g = <${READ_CODE}>) }`,
  `PREFIX r: <${ROOT}/> SELECT ?o WHERE { GRAPH r:_read\\/state { ?s ?p ?o } }`,
  `SELECT ?o WHERE { GRAPH <${ROOT}/\\u005Fread/state> { ?s ?p ?o } }`,
];

describe('queries and read-graph partitions', () => {
  it('answers each unscoped shape as on a store without read graphs', async () => {
    for (const store of [planted, new GraphSetIndexStore(planted)] as TripleStore[]) {
      const engine = new DKGQueryEngine(store);
      const reference = new DKGQueryEngine(oracle);
      for (const sparql of UNSCOPED) {
        expect(normalize(await engine.query(sparql)), sparql).toBe(normalize(await reference.query(sparql)));
      }
    }
    // The read graphs are there: the adapter answers a raw graph query with them.
    const raw = await planted.query(`SELECT ?o WHERE { GRAPH <${READ_VM}> { ?s ?p ?o } }`);
    expect(raw.type === 'bindings' && raw.bindings.length).toBe(2);
  });

  it('leaves unscoped queries unchanged on a store that cannot hold read graphs', async () => {
    const fresh = new OxigraphStore();
    try {
      await fresh.insert(MEMBERS);
      const query = vi.spyOn(fresh, 'query');
      await new DKGQueryEngine(fresh).query(UNSCOPED[0]!);
      expect(query.mock.calls.at(-1)?.[1]?.withheldGraphRoots).toBeUndefined();
      // Planted without a record, read graphs reach an unscoped graph variable: whatever
      // creates them has to record it, as the start-up rule and the rollback note do.
      await fresh.insert(READ_GRAPHS);
      const rows = await new DKGQueryEngine(fresh).query('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }');
      expect(rows.bindings.map(row => row.g)).toContain(READ_VM);
    } finally { await fresh.close(); }
  });

  it('refuses a query that names a read-graph partition, scoped or not', async () => {
    const engine = new DKGQueryEngine(planted);
    for (const sparql of NAMING) {
      for (const options of [undefined, { contextGraphId: CG }, { contextGraphId: CG, view: 'verifiable-memory' as const }]) {
        await expect(engine.query(sparql, options), sparql).rejects.toThrow('Scoped query violation: the query names a graph in a read-graph partition');
      }
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
    const partitions = await engine.listContextGraphQueryPartitionReads(CG, { includeSharedMemory: true });
    expect(partitions).toEqual(await reference.listContextGraphQueryPartitionReads(CG, { includeSharedMemory: true }));
  });
});
