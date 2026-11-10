import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { materializePreparedSparql, prepareSparql } from '@origintrail-official/dkg-rdf-utils/sparql';
import { MemoryLayer, readGraphIri, readGraphStateGraphIri, readScope } from '@origintrail-official/dkg-core';
import {
  noteStoreMayHoldReadGraphPartitions, OxigraphStore,
  type Quad, type QueryOptions, type QueryResult, type TripleStore,
} from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { ScopedQueryViolationError } from '../src/scoped-query-error.js';
import { prepareGraphScope } from '../src/sparql-graph-scope.js';
import {
  hideReadGraphPartitions, readGraphPartitionExclusionFilter, UNSCOPED_READ_GRAPH_QUERY_CODE, UnscopedReadGraphQueryError,
} from '../src/unscoped-read-graph-scope.js';

const CG = 'unscoped-partition';
const ROOT = `did:dkg:context-graph:${CG}`;
const VM = `${ROOT}/_verifiable_memory/0xab/1`;
const SWM = `${ROOT}/_shared_memory/0xab/1`;
const READ_VM = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory });
const STATE = readGraphStateGraphIri(CG);
// A context graph from before the naming rule whose own ID has a `_read` segment.
const LEGACY = 'did:dkg:context-graph:old/_read/x/_verifiable_memory/0xab/1';
const LOOK_ALIKE = `${ROOT}/_reader/1`;

const quad = (graph: string, subject: string, predicate: string, object: string): Quad => ({ graph, subject, predicate, object });
const MEMBERS: Quad[] = [
  quad(VM, 'urn:a', 'urn:p', 'urn:x'), quad(VM, 'urn:x', 'urn:r', 'urn:z'),
  quad(SWM, 'urn:a', 'urn:q', '"swm"'), quad(LOOK_ALIKE, 'urn:b', 'urn:p', '"look-alike"'),
];
const READ_GRAPHS: Quad[] = [
  quad(READ_VM, 'urn:a', 'urn:p', 'urn:x'), quad(READ_VM, 'urn:x', 'urn:r', 'urn:z'),
  // A triple left behind in a read graph that nothing maintained.
  quad(READ_VM, 'urn:gone', 'urn:p', 'urn:x'),
  quad(STATE, READ_VM, 'urn:state', '"dirty"'),
];

function scope(source: string) {
  const prepared = prepareSparql(source);
  if (prepared.status !== 'valid') throw new Error('Expected valid test input');
  return prepareGraphScope(prepared);
}

const hidden = (source: string) => materializePreparedSparql(hideReadGraphPartitions(scope(source)).prepared);
const FILTER_G = readGraphPartitionExclusionFilter('?g');

function refusal(source: string): unknown {
  try {
    hideReadGraphPartitions(scope(source));
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('the read-graph partition filter', () => {
  it('follows each GRAPH clause with a variable, in the group that holds it', () => {
    expect(hidden('SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } }')).toBe(`SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } ${FILTER_G} }`);
    expect(hidden('SELECT ?s WHERE { GRAPH $g { ?s ?p ?o } . GRAPH <urn:const> { ?s ?p ?x } }'))
      .toBe(`SELECT ?s WHERE { GRAPH $g { ?s ?p ?o } ${readGraphPartitionExclusionFilter('$g')} . GRAPH <urn:const> { ?s ?p ?x } }`);
    expect(hidden('ASK { GRAPH ?g { ?x ?y ?z . GRAPH ?h { ?s ?p ?o } } }'))
      .toBe(`ASK { GRAPH ?g { ?x ?y ?z . GRAPH ?h { ?s ?p ?o } ${readGraphPartitionExclusionFilter('?h')} } ${FILTER_G} }`);
    // Arithmetic and sequence paths are not repetition.
    expect(hidden('SELECT ?s WHERE { GRAPH ?g { ?s <urn:p>/<urn:q> ?v FILTER((?v + 1) * 2 > 3) BIND(?v * 2 AS ?w) } }'))
      .toContain(`} ${FILTER_G}`);
    const nested = hidden([
      'SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o }',
      'OPTIONAL { GRAPH ?a { ?s ?p ?y } } MINUS { GRAPH ?b { ?s ?q ?z } }',
      'FILTER(NOT EXISTS { GRAPH ?c { ?s ?r ?w } }) { GRAPH ?d { ?s ?p ?o } } UNION { GRAPH ?e { ?s ?p ?o } }',
      '{ SELECT ?s WHERE { GRAPH ?f { ?s ?p ?o } } } }',
    ].join(' '));
    for (const variable of ['?g', '?a', '?b', '?c', '?d', '?e', '?f']) {
      expect(nested).toContain(`} ${readGraphPartitionExclusionFilter(variable)}`);
    }
  });

  it('leaves a query without a graph variable as it is', () => {
    const source = 'SELECT ?s WHERE { GRAPH <urn:const> { ?s ?p ?o } }';
    expect(hidden(source)).toBe(source);
  });

  it('keeps exactly the graphs outside every read-graph partition', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([...MEMBERS, ...READ_GRAPHS, quad(LEGACY, 'urn:c', 'urn:p', '"legacy"')]);
      const result = await store.query(hidden('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }'));
      const graphs = result.type === 'bindings' ? result.bindings.map(row => row.g).sort() : [];
      // The look-alike `_reader` stays; the legacy ID with a `_read` segment counts as a partition, as it does everywhere.
      expect(graphs).toEqual([LOOK_ALIKE, SWM, VM].sort());
    } finally {
      await store.close();
    }
  });
});

describe('unscoped queries the rewrite cannot keep out of read-graph partitions', () => {
  it.each([
    ['a short CONSTRUCT with a blank node', 'CONSTRUCT WHERE { ?s <urn:p> [] }'],
    ['DESCRIBE over GRAPH', 'DESCRIBE ?s WHERE { GRAPH ?g { ?s ?p ?o } }'],
    ['FROM', 'SELECT ?s FROM <urn:g> WHERE { GRAPH ?g { ?s ?p ?o } }'],
    ['FROM NAMED', 'SELECT ?s FROM NAMED <urn:g> WHERE { GRAPH ?g { ?s ?p ?o } }'],
    ['a hint IRI', 'SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o . <http://www.bigdata.com/queryHints#Prior> <http://www.bigdata.com/queryHints#runFirst> "true" } }'],
    ['the built-in hint prefix', 'SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o . hint:Prior hint:runFirst "true" } }'],
    ['a prefix bound to hints', 'PREFIX h: <http://www.bigdata.com/queryHints#> SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o . h:Prior h:runFirst "true" } }'],
    ['a relative hint IRI', 'BASE <http://www.bigdata.com/> SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o . <queryHints#Prior> <queryHints#runFirst> "true" } }'],
    ['a GRAPH clause that names neither an IRI nor a variable', 'SELECT ?s WHERE { GRAPH undeclared:g { ?s ?p ?o } }'],
    ['an empty GRAPH group', 'SELECT ?g WHERE { GRAPH ?g { } }'],
    ['a GRAPH group with only a FILTER', 'SELECT ?g WHERE { GRAPH ?g { FILTER(true) } }'],
    ['a GRAPH group with only a BIND', 'SELECT ?g WHERE { GRAPH ?g { BIND(1 AS ?x) } }'],
    ['a GRAPH group with only VALUES', 'SELECT ?g WHERE { GRAPH ?g { VALUES ?x { 1 } } }'],
    ['a GRAPH group that opens with a group', 'SELECT ?g WHERE { GRAPH ?g { { ?s ?p ?o } } }'],
    ['a GRAPH group that opens with OPTIONAL', 'SELECT ?g WHERE { GRAPH ?g { OPTIONAL { ?s ?p ?o } } }'],
    ['a GRAPH group that opens with GRAPH', 'SELECT ?g WHERE { GRAPH ?g { GRAPH ?h { ?s ?p ?o } } }'],
    ['a one-or-more path in GRAPH', 'SELECT ?g WHERE { GRAPH ?g { ?s <urn:p>+ ?o } }'],
    ['a zero-or-more path in GRAPH', 'SELECT ?g WHERE { GRAPH ?g { ?s a* ?o } }'],
    ['a zero-or-one path in GRAPH', 'SELECT ?g WHERE { GRAPH ?g { ?s <urn:p>? ?o } }'],
    ['a repeated group path in GRAPH', 'SELECT ?g WHERE { GRAPH ?g { ?s (<urn:p>/<urn:q>)* ?o } }'],
    ['a repeated path inside EXISTS in GRAPH', 'SELECT ?g WHERE { GRAPH ?g { ?s ?p ?o FILTER EXISTS { ?s pre:p+ ?x } } }'],
  ])('refuses %s', (_label, source) => {
    const error = refusal(source);
    expect(error).toBeInstanceOf(UnscopedReadGraphQueryError);
    expect(error).toBeInstanceOf(ScopedQueryViolationError);
    expect((error as UnscopedReadGraphQueryError).code).toBe(UNSCOPED_READ_GRAPH_QUERY_CODE);
    expect((error as Error).message).toMatch(/^Scoped query violation: .*give the query a context graph$/);
  });

  it('does not take a hint prefix bound elsewhere, or a hint in a string, for a hint', () => {
    expect(refusal('PREFIX hint: <urn:not-hints#> SELECT ?s WHERE { GRAPH ?g { ?s hint:p ?o } }')).toBeUndefined();
    expect(refusal('SELECT ?s WHERE { GRAPH ?g { ?s ?p "http://www.bigdata.com/queryHints#Prior" } }')).toBeUndefined();
    expect(refusal('BASE <urn:base/> SELECT ?s WHERE { GRAPH ?g { ?s <relative> ?o } }')).toBeUndefined();
  });

  it('refuses a GRAPH clause whose group it cannot find', () => {
    const malformed = scope('SELECT ?s WHERE { GRAPH ?g ?s }');
    expect(() => hideReadGraphPartitions(malformed)).toThrow(UnscopedReadGraphQueryError);
  });
});

/** A store that answers every query over all of its graphs and refuses to withhold any, as a remote SPARQL store does. */
class UnrestrictedStore {
  readonly sent: string[] = [];

  constructor(private readonly inner: OxigraphStore) {}

  async query(sparql: string, options?: QueryOptions): Promise<QueryResult> {
    if (options?.withheldGraphRoots !== undefined) {
      throw Object.assign(new Error('cannot withhold graphs'), { code: 'QUERY_DATASET_UNRESTRICTED' });
    }
    this.sent.push(sparql);
    return this.inner.query(sparql);
  }
}

describe('DKGQueryEngine on a store that cannot restrict its dataset', () => {
  let planted: OxigraphStore;
  let oracle: OxigraphStore;
  let store: UnrestrictedStore;

  beforeEach(async () => {
    planted = new OxigraphStore();
    oracle = new OxigraphStore();
    await planted.insert([...MEMBERS, ...READ_GRAPHS]);
    await oracle.insert(MEMBERS);
    store = new UnrestrictedStore(planted);
  });
  afterEach(async () => { await planted.close(); await oracle.close(); });

  const sorted = (result: { bindings: Array<Record<string, string>> }) => result.bindings.map(row => JSON.stringify(row)).sort();

  it('answers a graph variable as a store without read graphs does, once they may exist', async () => {
    const engine = new DKGQueryEngine(store as unknown as TripleStore);
    const query = 'SELECT ?g ?s ?o WHERE { GRAPH ?g { ?s <urn:p> ?o } }';
    // Before anything says the store may hold read graphs, the query goes out as it is.
    await engine.query(query);
    expect(store.sent.at(-1)).toBe(query);
    noteStoreMayHoldReadGraphPartitions(store as unknown as TripleStore);
    const answer = await engine.query(query);
    expect(store.sent.at(-1)).toContain(FILTER_G);
    expect(sorted(answer)).toEqual(sorted(await new DKGQueryEngine(oracle).query(query)));
  });

  it('refuses what the rewrite cannot cover, before the store sees it', async () => {
    noteStoreMayHoldReadGraphPartitions(store as unknown as TripleStore);
    const engine = new DKGQueryEngine(store as unknown as TripleStore);
    await expect(engine.query('SELECT ?s WHERE { ?s <urn:p>* ?o }')).rejects.toBeInstanceOf(UnscopedReadGraphQueryError);
    await expect(engine.query('DESCRIBE *')).rejects.toBeInstanceOf(UnscopedReadGraphQueryError);
    expect(store.sent).toEqual([]);
  });

  it('sends patterns outside GRAPH with an existence check per pattern', async () => {
    noteStoreMayHoldReadGraphPartitions(store as unknown as TripleStore);
    const engine = new DKGQueryEngine(store as unknown as TripleStore);
    await engine.query('SELECT ?s WHERE { ?s <urn:p> ?o }');
    expect(store.sent.at(-1)).toContain(`FILTER EXISTS { GRAPH ?_holder { ?s <urn:p> ?o } ${readGraphPartitionExclusionFilter('?_holder')} }`);
  });

  it('leaves scoped queries and withheld roots to their own rules', async () => {
    noteStoreMayHoldReadGraphPartitions(store as unknown as TripleStore);
    const engine = new DKGQueryEngine(store as unknown as TripleStore);
    // Withheld roots keep their answer on such a store: it refuses them.
    await expect(engine.query('SELECT ?s WHERE { ?s ?p ?o }', { withheldGraphRoots: [`${ROOT}/x`] }))
      .rejects.toMatchObject({ code: 'QUERY_DATASET_UNRESTRICTED' });
    expect(store.sent).toEqual([]);
  });
});

describe('DKGQueryEngine on a store that restricts its dataset', () => {
  it('keeps leaving read graphs out by dataset, for every unscoped query', async () => {
    const planted = new OxigraphStore();
    try {
      await planted.insert([...MEMBERS, ...READ_GRAPHS]);
      noteStoreMayHoldReadGraphPartitions(planted);
      const seen: Array<QueryOptions | undefined> = [];
      const query = planted.query.bind(planted);
      planted.query = async (sparql, options) => { seen.push(options); return query(sparql, options); };
      const engine = new DKGQueryEngine(planted);
      const graphs = await engine.query('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }');
      expect(graphs.bindings.map(row => row.g).sort()).toEqual([LOOK_ALIKE, SWM, VM].sort());
      expect(seen.at(-1)?.withheldGraphRoots).toEqual([]);
      await engine.query('SELECT ?s WHERE { ?s ?p ?o }');
      expect(seen.at(-1)?.withheldGraphRoots).toEqual([]);
    } finally {
      await planted.close();
    }
  });
});
