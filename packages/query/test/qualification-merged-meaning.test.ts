import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryLayer, readGraphIri, readScope } from '@origintrail-official/dkg-core';
import {
  BlazegraphStore, CURRENT_READ_GRAPH_VERSIONS, OxigraphStore, workingMemoryIdentityRule,
  type Quad, type ReadGraphStateRow, type TripleStore,
} from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import type { QueryOptions } from '../src/query-engine.js';
import type { ViewReadGraphs } from '../src/view-dataset-plan.js';

// The meaning rows of the qualification matrix: each query's merged answer and its per-asset
// answer, pinned. CI's tornado-blazegraph lane runs this file on a live server; elsewhere it
// runs on Oxigraph.
const endpoint = process.env.BLAZEGRAPH_TEST_URL;
if (process.env.DKG_REQUIRE_BLAZEGRAPH === '1' && !endpoint) throw new Error('Blazegraph CI endpoint is required');

const id = `qualification-meaning-${randomUUID()}`;
const ROOT = `did:dkg:context-graph:${id}`;
const G1 = `${ROOT}/_verifiable_memory/0xaa/1`;
const G2 = `${ROOT}/_verifiable_memory/0xaa/2`;
const READ = readGraphIri({ scope: readScope(id), layer: MemoryLayer.VerifiableMemory });
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PRODUCT = 'urn:Product';

const quad = (subject: string, predicate: string, object: string, graph: string): Quad => ({ subject, predicate, object, graph });
const MEMBERS = [
  // p1 is typed in one asset and priced in the other; p2 is typed and priced in one; p3 has no price.
  quad('urn:p1', RDF_TYPE, PRODUCT, G1), quad('urn:p1', 'urn:price', '"5"', G2),
  quad('urn:p2', RDF_TYPE, PRODUCT, G1), quad('urn:p2', 'urn:price', '"7"', G1),
  quad('urn:p3', RDF_TYPE, PRODUCT, G2),
  // A path through two predicates, one step in each asset.
  quad('urn:s1', 'urn:a', 'urn:m1', G1), quad('urn:m1', 'urn:b', 'urn:e1', G2),
  // A triple both assets hold, and a mirror: the same triple in the root graph and in an asset.
  quad('urn:shared', 'urn:in', 'urn:cg', G1), quad('urn:shared', 'urn:in', 'urn:cg', G2),
  quad('urn:mirror', 'urn:in', 'urn:cg', ROOT), quad('urn:mirror', 'urn:in', 'urn:cg', G1),
];
// The read graph holds the merge of its members: each triple once.
const READ_GRAPH = [...new Map(MEMBERS.map(row => [`${row.subject} ${row.predicate} ${row.object}`, { ...row, graph: READ }])).values()];

class ReadyReadGraphs implements ViewReadGraphs {
  readonly identity = workingMemoryIdentityRule({ defaultAgentAddress: '0x' + 'a1'.repeat(20), peerId: '12D3KooWQualification' });
  keeps(): boolean { return true; }
  state(readGraph: string): ReadGraphStateRow | undefined {
    return readGraph === READ ? { readGraph, state: 'ready', generation: 3, ...CURRENT_READ_GRAPH_VERSIONS } : undefined;
  }
}

const VM: QueryOptions = { contextGraphId: id, view: 'verifiable-memory', semantics: 'per-asset' };
const MERGED: QueryOptions = { ...VM, semantics: 'merged' };
const rows = (result: { bindings: Array<Record<string, string>> }) => result.bindings.map(row => JSON.stringify(row)).sort();
const count = (result: { bindings: Array<Record<string, string>> }) =>
  Number.parseInt(String(Object.values(result.bindings[0] ?? {})[0]).replace(/^"?(\d+).*$/, '$1'), 10);

describe(`the meaning of merged and per-asset view queries on ${endpoint ? 'Blazegraph' : 'Oxigraph'}`, () => {
  let store: TripleStore;
  let engine: DKGQueryEngine;

  beforeAll(async () => {
    store = endpoint ? new BlazegraphStore(endpoint) : new OxigraphStore();
    await store.insert([...MEMBERS, ...READ_GRAPH]);
    engine = new DKGQueryEngine(store, { readGraphs: new ReadyReadGraphs() });
  }, 60_000);

  afterAll(async () => {
    if (endpoint) await store.update([ROOT, G1, G2, READ].map(graph => `DROP SILENT GRAPH <${graph}>`).join('; '));
    await store.close();
  }, 60_000);

  const both = async (sparql: string) => ({
    merged: await engine.query(sparql, MERGED),
    perAsset: await engine.query(sparql, VM),
  });

  it('binds an OPTIONAL part held by another asset only when merged', async () => {
    const { merged, perAsset } = await both(`SELECT ?p ?x WHERE { ?p a <${PRODUCT}> OPTIONAL { ?p <urn:price> ?x } }`);
    expect(rows(merged)).toEqual(rows({ bindings: [{ p: 'urn:p1', x: '"5"' }, { p: 'urn:p2', x: '"7"' }, { p: 'urn:p3' }] }));
    expect(rows(perAsset)).toEqual(rows({ bindings: [{ p: 'urn:p1' }, { p: 'urn:p2', x: '"7"' }, { p: 'urn:p3' }] }));
  });

  it('removes with MINUS what another asset holds only when merged', async () => {
    const { merged, perAsset } = await both(`SELECT ?p WHERE { ?p a <${PRODUCT}> MINUS { ?p <urn:price> ?x } }`);
    expect(rows(merged)).toEqual(rows({ bindings: [{ p: 'urn:p3' }] }));
    expect(rows(perAsset)).toEqual(rows({ bindings: [{ p: 'urn:p1' }, { p: 'urn:p3' }] }));
  });

  it('follows a property path across two assets only when merged', async () => {
    const { merged, perAsset } = await both('SELECT ?o WHERE { <urn:s1> <urn:a>/<urn:b> ?o }');
    expect(rows(merged)).toEqual(rows({ bindings: [{ o: 'urn:e1' }] }));
    expect(perAsset.bindings).toEqual([]);
  });

  it('aggregates a join that spans assets only when merged', async () => {
    const { merged, perAsset } = await both(`SELECT (COUNT(DISTINCT ?p) AS ?n) WHERE { ?p a <${PRODUCT}> . ?p <urn:price> ?x }`);
    expect(count(merged)).toBe(2);
    expect(count(perAsset)).toBe(1);
  });

  it('counts a triple held by two assets, and a mirror, once when merged', async () => {
    const counted = await both('SELECT (COUNT(*) AS ?n) WHERE { ?s <urn:in> <urn:cg> }');
    expect(count(counted.merged)).toBe(2);
    expect(count(counted.perAsset)).toBe(PER_ASSET.copiesCounted);
    const listed = await both('SELECT ?s WHERE { ?s <urn:in> <urn:cg> }');
    expect(rows(listed.merged)).toEqual(rows({ bindings: [{ s: 'urn:mirror' }, { s: 'urn:shared' }] }));
    expect(rows(listed.perAsset)).toEqual(rows({ bindings: PER_ASSET.copiesListed }));
  });
});

/** Today's per-asset answers for repeated triples, pinned as they are. */
const PER_ASSET = {
  copiesCounted: 2,
  copiesListed: [{ s: 'urn:mirror' }, { s: 'urn:shared' }],
};
