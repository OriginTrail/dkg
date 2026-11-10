import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLayer, readGraphIri, readGraphStateGraphIri, readScope } from '@origintrail-official/dkg-core';
import { GraphManager, GraphSetIndexStore, OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '@origintrail-official/dkg-query';
import { createListContextGraphsCacheInvalidatingStore } from '../src/internal/context-graph-cache-invalidating-store.js';
import { createResponderGraphListMemo } from '../src/sync/responder/graph-plan.js';
import { isLegacySyncGraphCandidateV1 } from '../src/sync/legacy-sync-graph-candidate.js';
import { canReadUnscopedQuery } from '../src/unscoped-query-admission.js';

// Read graphs are node-local derived data. Every surface that enumerates a
// store must answer the same with and without them.
const CG = 'comparison';
const ROOT = `did:dkg:context-graph:${CG}`;
const CHILD = `${CG}/child`;
const row = (graph: string, subject: string, object = '"v"'): Quad => ({ graph, subject, predicate: 'urn:p', object });
const MEMBERS: Quad[] = [
  row(`${ROOT}/_verifiable_memory/0xab/1`, 'urn:a'),
  row(`${ROOT}/_shared_memory/0xab/1`, 'urn:b'),
  row(`${ROOT}/code/_verifiable_memory/0xab/2`, 'urn:c'),
  row(`${ROOT}/_meta`, 'urn:m'),
  row(`did:dkg:context-graph:${CHILD}/_verifiable_memory/0xab/3`, 'urn:d'),
];
const READ_GRAPHS: Quad[] = [
  row(readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory }), 'urn:a'),
  row(readGraphIri({ scope: readScope(CG), layer: MemoryLayer.SharedWorkingMemory }), 'urn:b'),
  row(readGraphIri({ scope: readScope(CG, 'code'), layer: MemoryLayer.VerifiableMemory }), 'urn:c'),
  row(readGraphIri({ scope: readScope(CG), layer: MemoryLayer.WorkingMemory, agentAddress: '0x' + 'a'.repeat(40) }), 'urn:w'),
  row(readGraphIri({ scope: readScope(CHILD), layer: MemoryLayer.VerifiableMemory }), 'urn:d'),
  row(readGraphStateGraphIri(CG), 'urn:state', '"ready"'),
  row(`${ROOT}/_read/stray`, 'urn:x'),
];

let adapters: OxigraphStore[] = [];
let plain: TripleStore;
let planted: TripleStore;
beforeEach(async () => {
  const [bare, withReadGraphs] = [new OxigraphStore(), new OxigraphStore()];
  adapters = [bare, withReadGraphs];
  await bare.insert(MEMBERS);
  // Planted below every decorator, as only storage itself writes them.
  await withReadGraphs.insert([...MEMBERS, ...READ_GRAPHS]);
  plain = new GraphSetIndexStore(bare);
  planted = new GraphSetIndexStore(withReadGraphs);
});
afterEach(async () => { await Promise.all(adapters.map(adapter => adapter.close())); });

describe('surfaces that enumerate the store, with read graphs planted', () => {
  it('builds the same sync responder graph plan and the same sync candidates', async () => {
    const snapshot = await createResponderGraphListMemo(planted).get();
    const reference = await createResponderGraphListMemo(plain).get();
    expect(snapshot.graphs).toEqual(reference.graphs);
    for (const lane of ['durable-data', 'changelog'] as const) {
      const candidates = (graphs: readonly string[]) => graphs.filter(graph => isLegacySyncGraphCandidateV1(graph, CG, lane));
      expect(candidates(snapshot.graphs)).toEqual(candidates(reference.graphs));
    }
    for (const quad of READ_GRAPHS) expect(snapshot.has(quad.graph)).toBe(false);
  });

  it('lists the same graph inventories through the agent store wrapper', async () => {
    const wrapped = createListContextGraphsCacheInvalidatingStore(planted, () => undefined);
    const reference = createListContextGraphsCacheInvalidatingStore(plain, () => undefined);
    expect(await wrapped.listGraphs()).toEqual(await reference.listGraphs());
    expect(await wrapped.listGraphsByPrefix!(ROOT)).toEqual(await reference.listGraphsByPrefix!(ROOT));
    expect(await wrapped.readGraphInventory!(undefined, {})).toEqual(await reference.readGraphInventory!(undefined, {}));
    expect(await wrapped.readGraphInventory!(`${ROOT}/`, {})).toEqual(await reference.readGraphInventory!(`${ROOT}/`, {}));
    for (const quad of READ_GRAPHS) expect(await wrapped.hasGraph(quad.graph), quad.graph).toBe(false);
  });

  it('lists the same context graphs and stored owners', async () => {
    expect((await new GraphManager(planted).listContextGraphs()).sort())
      .toEqual((await new GraphManager(plain).listContextGraphs()).sort());
    expect((await new GraphManager(planted).listStoredContextGraphOwnerCandidates()).sort())
      .toEqual((await new GraphManager(plain).listStoredContextGraphOwnerCandidates()).sort());
  });

  it('admits an unscoped query on the same authority checks', async () => {
    const checked = async (store: TripleStore) => {
      const ids: string[] = [];
      const allowed = await canReadUnscopedQuery({
        store, knownContextGraphIds: [],
        canReadContextGraph: async (id) => { ids.push(id); return true; },
      });
      return { allowed, ids: ids.sort() };
    };
    expect(await checked(planted)).toEqual(await checked(plain));
  });

  it('answers unscoped and scoped queries the same, through the agent store wrapper as in the daemon', async () => {
    const queries: Array<[string, Record<string, unknown> | undefined]> = [
      ['SELECT ?g (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g ORDER BY ?g', undefined],
      ['SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } }', undefined],
      ['SELECT ?g ?s WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s', { contextGraphId: CG, includeContextGraphPartitions: true }],
      ['SELECT ?s WHERE { ?s ?p ?o } ORDER BY ?s', { contextGraphId: CG, view: 'verifiable-memory' }],
    ];
    const wrap = (store: TripleStore) => createListContextGraphsCacheInvalidatingStore(store, () => undefined);
    for (const [engine, reference] of [
      [new DKGQueryEngine(planted), new DKGQueryEngine(plain)],
      [new DKGQueryEngine(wrap(planted)), new DKGQueryEngine(wrap(plain))],
    ]) {
      for (const [sparql, options] of queries) {
        expect(await engine.query(sparql, options), sparql).toEqual(await reference.query(sparql, options));
      }
    }
  });
});
