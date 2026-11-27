import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readGraphIri, type ReadGraphKey } from '@origintrail-official/dkg-core';
import { BlazegraphStore } from '../../src/adapters/blazegraph.js';
import { OxigraphStore } from '../../src/adapters/oxigraph.js';
import { BlazegraphNamespaceManager, blazegraphNamespaceApiUrlFromSparqlEndpoint } from '../../src/blazegraph-namespace-manager.js';
import { guardReadGraphPartition } from '../../src/read-graph-partition-store.js';
import { checkReadGraph } from '../../src/read-graph/check.js';
import { matchesGraphNameTest, readGraphMembership, workingMemoryIdentityRule, type ReadGraphRegistrySnapshot } from '../../src/read-graph/membership.js';
import { wrapReadGraphLayer } from '../../src/read-graph/read-graph-store.js';
import { buildReadGraph, markReadGraphDirty, readStoredReadGraphRow, type ReadGraphJobContext } from '../../src/read-graph/rebuild.js';
import { readGraphStateCompareAndSet } from '../../src/read-graph/state.js';
import { readGraphBackfillBatch, readGraphFencedDrop } from '../../src/read-graph/statements.js';
import type { TripleStoreConfig } from '../../src/triple-store-composition.js';
import type { Quad, TripleStore } from '../../src/triple-store.js';
import { AGENT, layerFixture, q, type LayerFixture } from './read-graph-layer-conformance.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SUB_GRAPH = 'http://dkg.io/ontology/SubGraph';
const CONTEXT_GRAPH = 'https://dkg.network/ontology#ContextGraph';
/** The working-memory identity rule of the fixture's default agent. */
export const IDENTITY = workingMemoryIdentityRule({ defaultAgentAddress: AGENT });

/** Registry facts that register `name` as a sub-graph of the fixture's context graph. */
export function subGraphFacts(fixture: LayerFixture, name: string): Quad[] {
  return [
    { subject: `${fixture.root}/${name}`, predicate: RDF_TYPE, object: SUB_GRAPH, graph: `${fixture.root}/_meta` },
    { subject: `${fixture.root}/${name}`, predicate: 'http://schema.org/name', object: `"${name}"`, graph: `${fixture.root}/_meta` },
  ];
}

/** The registry fact that registers `${root}/${name}` as a child context graph, in its own `_meta`. */
export function childFact(fixture: LayerFixture, name: string): Quad {
  return { subject: `${fixture.root}/${name}`, predicate: RDF_TYPE, object: CONTEXT_GRAPH, graph: `${fixture.root}/${name}/_meta` };
}

/** Three triples in every fixture graph, one of them shared by all, and none of the registry facts. */
export function memberData(fixture: LayerFixture): Quad[] {
  return fixture.graphs.flatMap((graph, i) => [q('urn:s:shared', '"both"', graph), q(`urn:s:${i}`, `"v${i}"`, graph), q(`urn:s:${i}b`, `"w${i}"`, graph)]);
}

/** The triples of every graph under the fixture's root, by graph. */
async function graphsUnder(adapter: TripleStore, fixture: LayerFixture) {
  // sparql-scan-allow: R2 -- the graphs of one test context graph, freshly created for this check
  const result = await adapter.query(`SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "${fixture.root}")) }`);
  return (result.type === 'bindings' ? result.bindings : []).map(b => ({ g: b.g!, t: `${b.s} ${b.p} ${b.o}` }));
}

/**
 * Every seeded quad is still stored, in its own graph. This is checked on the adapter, apart from any
 * read graph, so a store that lost source data cannot pass as one rebuilt from all of it.
 */
export async function expectSourcesKept(adapter: TripleStore, fixture: LayerFixture, seeded: readonly Quad[], after: string): Promise<void> {
  const stored = new Set((await graphsUnder(adapter, fixture)).map(x => `${x.g} ${x.t}`));
  const missing = seeded.map(quad => `${quad.graph} ${quad.subject} ${quad.predicate} ${quad.object}`).filter(quad => !stored.has(quad));
  expect(missing, `${after}: seeded quads missing from the store`).toEqual([]);
}

/** The triples a read graph holds. */
export async function readGraphTriples(adapter: TripleStore, fixture: LayerFixture, readGraph: string): Promise<string[]> {
  return [...new Set((await graphsUnder(adapter, fixture)).filter(x => x.g === readGraph).map(x => x.t))].sort();
}

/**
 * The read graph of `key` holds exactly its members' triples under `registry`, by a direct comparison
 * on the adapter, and the full check of the layered `store` agrees. Returns the read graph's triples.
 */
export async function expectEqualToMembers(
  opened: { readonly adapter: TripleStore; readonly store: TripleStore; readonly fixture: LayerFixture },
  key: ReadGraphKey,
  registry: ReadGraphRegistrySnapshot,
  after: string,
): Promise<string[]> {
  const readGraph = readGraphIri(key);
  const membership = readGraphMembership(key, registry, IDENTITY);
  const quads = await graphsUnder(opened.adapter, opened.fixture);
  const expected = [...new Set(quads.filter(x => x.g !== readGraph && matchesGraphNameTest(membership, x.g)).map(x => x.t))].sort();
  const actual = [...new Set(quads.filter(x => x.g === readGraph).map(x => x.t))].sort();
  expect(actual, `${after}: ${readGraph}`).toEqual(expected);
  expect(await checkReadGraph(opened.store, readGraph, 'full'), after).toMatchObject({ outcome: 'consistent' });
  return actual;
}

/** One update a test can hold back: the adapter's own `update`, called after `onUpdate` sees the text. */
function watchUpdates(adapter: TripleStore): { onUpdate?: (sparql: string) => void } {
  const watch: { onUpdate?: (sparql: string) => void } = {};
  const update = adapter.update!.bind(adapter);
  adapter.update = (sparql, options) => { watch.onUpdate?.(sparql); return update(sparql, options); };
  return watch;
}

/**
 * Builder-level qualification rows on one engine, through its production adapter under the read-graph
 * layer: a build that a newer dirty mark overtakes, and registrations that change a read graph's
 * membership after its data exists. Each ends with the read graph equal to its members, as the full
 * check of #3809 and a direct comparison both say.
 */
export function readGraphBuilderQualificationSuite(backend: 'oxigraph' | 'blazegraph') {
  describe(`read-graph builder qualification (${backend})`, () => {
    let manager: BlazegraphNamespaceManager | undefined;
    let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>> | undefined;
    let shared: { readonly url: string } | undefined;
    const run = `qualb${randomUUID().slice(0, 8)}`;
    let sequence = 0;

    beforeAll(async () => {
      if (backend !== 'blazegraph') return;
      if (!process.env.BLAZEGRAPH_TEST_URL) throw new Error('The live Blazegraph lane requires BLAZEGRAPH_TEST_URL');
      manager = new BlazegraphNamespaceManager({ namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(process.env.BLAZEGRAPH_TEST_URL) });
      handles = await manager.acquireMany([`read-graph-builder-qualification-${randomUUID()}`]);
      shared = { url: handles[0]!.sparqlUrl };
    }, 60_000);
    afterAll(async () => {
      if (manager && handles) await manager.disposeAll(handles);
    }, 60_000);

    /** A fresh context graph over a fresh embedded store, or over the shared Blazegraph namespace. */
    const open = async () => {
      const fixture = layerFixture(`${run}-${sequence += 1}`);
      const adapter: TripleStore = shared ? new BlazegraphStore(shared.url, { timeout: 120_000 }) : new OxigraphStore();
      const config: TripleStoreConfig = shared ? { backend: 'blazegraph', options: { url: shared.url } } : { backend: 'oxigraph' };
      const watch = watchUpdates(adapter);
      const layer = wrapReadGraphLayer(adapter, { ...config, readGraphs: { workingMemoryIdentity: IDENTITY } });
      const store = guardReadGraphPartition(layer);
      const context: ReadGraphJobContext = { store, batching: { graphsPerBatch: 1, maxGraphsPerBatch: 1, pauseRatio: 0.5 } };
      return { fixture, adapter, watch, layer, store, context, close: () => adapter.close() };
    };


    it('ends a build that a newer dirty mark overtakes, lands nothing of it later, and rebuilds to its members', async () => {
      const opened = await open();
      const { fixture, adapter, watch, context } = opened;
      try {
        await adapter.insert([...fixture.facts, ...memberData(fixture)]);
        const [vm] = fixture.keys as [ReadGraphKey];
        const { wholeVm } = fixture.readGraphs;
        let marked: Promise<unknown> | undefined;
        watch.onUpdate = (sparql) => {
          if (marked || !sparql.includes('VALUES ?g')) return;
          // A dirty mark, as a write through the layer or a check makes one, queued behind this copy batch.
          marked = markReadGraphDirty(context, wholeVm);
        };
        const lost = await buildReadGraph(context, vm);
        await marked;
        watch.onUpdate = undefined;
        expect(lost).toMatchObject({ outcome: 'lost', row: { state: 'dirty' } });
        const overtaken = lost.row!.generation - 1;
        const done = await buildReadGraph(context, vm);
        expect(done).toMatchObject({ outcome: 'done', row: { state: 'ready', generation: lost.row!.generation + 1 } });
        const before = await expectEqualToMembers(opened, vm, fixture.registry, 'the build after the mark');
        // The overtaken build's operations arrive late: a copy of a graph that is no member, a drop, and its publish.
        const stale = { state: 'building' as const, generation: overtaken };
        await adapter.update!(readGraphBackfillBatch(wholeVm, stale, [fixture.graphs[9]!]));
        await adapter.update!(readGraphFencedDrop(wholeVm, stale));
        await adapter.update!(readGraphStateCompareAndSet(
          { ...done.row!, state: 'building', generation: overtaken }, { ...done.row!, state: 'ready', generation: overtaken }));
        expect(await expectEqualToMembers(opened, vm, fixture.registry, 'the late operations')).toEqual(before);
        expect(await readStoredReadGraphRow(adapter, wholeVm)).toMatchObject({ row: { state: 'ready', generation: done.row!.generation } });
      } finally { await opened.close(); }
    }, 180_000);

    it('takes a sub-graph registered after its data exists into the whole read graph at the rebuild', async () => {
      const opened = await open();
      const { fixture, adapter, layer, store, context } = opened;
      try {
        const withoutCode: ReadGraphRegistrySnapshot = { ...fixture.registry, subGraphNames: [] };
        // The data of `code` is there, and only the child context graph is registered.
        await adapter.insert([...fixture.facts.filter(fact => fact.graph !== `${fixture.root}/_meta`), ...memberData(fixture)]);
        const [vm] = fixture.keys as [ReadGraphKey];
        const { wholeVm } = fixture.readGraphs;
        expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
        const before = await expectEqualToMembers(opened, vm, withoutCode, 'before the registration');
        // Registering `code` through the layer marks the read graph whose membership it changes dirty.
        await store.insert(subGraphFacts(fixture, 'code'));
        expect(layer.runtime.mirror.get(wholeVm)?.state).toBe('dirty');
        expect(await readStoredReadGraphRow(adapter, wholeVm)).toMatchObject({ row: { state: 'dirty' } });
        expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
        const after = await expectEqualToMembers(opened, vm, fixture.registry, 'after the registration');
        expect(after.length).toBeGreaterThan(before.length);
      } finally { await opened.close(); }
    }, 180_000);

    it('takes a sub-graph that becomes a child context graph out of its parent at the rebuild', async () => {
      const opened = await open();
      const { fixture, adapter, layer, store, context } = opened;
      try {
        // `kid` starts as a sub-graph of the context graph, so its graphs are members.
        const kidAsSubGraph: ReadGraphRegistrySnapshot = { ...fixture.registry, subGraphNames: ['code', 'kid'], childContextGraphRoots: [] };
        await adapter.insert([...fixture.facts.filter(fact => fact.graph === `${fixture.root}/_meta`), ...subGraphFacts(fixture, 'kid'), ...memberData(fixture)]);
        const [vm] = fixture.keys as [ReadGraphKey];
        const { wholeVm } = fixture.readGraphs;
        expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
        const before = await expectEqualToMembers(opened, vm, kidAsSubGraph, 'while kid is a sub-graph');
        // Registering `kid` as a child context graph takes its graphs out of the parent's read graph.
        await store.insert([childFact(fixture, 'kid')]);
        expect(layer.runtime.mirror.get(wholeVm)?.state).toBe('dirty');
        expect(await buildReadGraph(context, vm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
        const asChild: ReadGraphRegistrySnapshot = { ...kidAsSubGraph, childContextGraphRoots: [`${fixture.root}/kid`] };
        const after = await expectEqualToMembers(opened, vm, asChild, 'once kid is a child context graph');
        expect(after.length).toBeLessThan(before.length);
      } finally { await opened.close(); }
    }, 180_000);
  });
}
