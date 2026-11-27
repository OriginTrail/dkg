import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MemoryLayer, readGraphIri, readScope, type ReadGraphKey } from '@origintrail-official/dkg-core';
import { BlazegraphStore } from '../../src/adapters/blazegraph.js';
import { BlazegraphNamespaceManager, blazegraphNamespaceApiUrlFromSparqlEndpoint } from '../../src/blazegraph-namespace-manager.js';
import { guardReadGraphPartition } from '../../src/read-graph-partition-store.js';
import { matchesGraphNameTest, readGraphMembership, type ReadGraphRegistrySnapshot } from '../../src/read-graph/membership.js';
import { wrapReadGraphLayer, type ReadGraphStore } from '../../src/read-graph/read-graph-store.js';
import { CURRENT_READ_GRAPH_VERSIONS, type ReadGraphStateRow } from '../../src/read-graph/state.js';
import { readGraphCopy } from '../../src/read-graph/statements.js';
import type { TripleStoreConfig } from '../../src/triple-store-composition.js';
import type { Quad, TripleStore } from '../../src/triple-store.js';
import { PlanningOxigraphStore } from './read-graph-planning-store.js';
import { authorCommitInput, seedOldState } from '../rfc64-author-commit-cas-harness.js';
import { propertyOptions } from '../../../../scripts/testing/property-options.js';

export const AGENT = '0x' + 'ab'.repeat(20);
export const P = 'urn:test:p';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * One context graph with four read graphs (whole-graph VM and SWM, a registered
 * sub-graph's VM, and one agent's WM), graphs that are members of them, a
 * registered child's graph, and a graph of a context graph whose ID extends
 * this one's, which is no member either.
 */
export function layerFixture(contextGraphId: string) {
  const root = `did:dkg:context-graph:${contextGraphId}`;
  const keys: ReadGraphKey[] = [
    { scope: readScope(contextGraphId), layer: MemoryLayer.VerifiableMemory },
    { scope: readScope(contextGraphId), layer: MemoryLayer.SharedWorkingMemory },
    { scope: readScope(contextGraphId, 'code'), layer: MemoryLayer.VerifiableMemory },
    { scope: readScope(contextGraphId), layer: MemoryLayer.WorkingMemory, agentAddress: AGENT },
  ];
  const graphs = [
    root,
    `${root}/_verifiable_memory/${AGENT}/1`,
    `${root}/_verifiable_memory/${AGENT}/2`,
    `${root}/code`,
    `${root}/code/_verifiable_memory/${AGENT}/3`,
    `${root}/_shared_memory`,
    `${root}/_shared_memory/${AGENT}/4`,
    `${root}/_working_memory/${AGENT}/5`,
    `${root}/kid/_verifiable_memory/${AGENT}/6`,
    `${root}y/_verifiable_memory/${AGENT}/7`,
  ];
  const registry: ReadGraphRegistrySnapshot = { contextGraphId, subGraphNames: ['code'], childContextGraphRoots: [`${root}/kid`] };
  const facts: Quad[] = [
    { subject: `${root}/code`, predicate: RDF_TYPE, object: 'http://dkg.io/ontology/SubGraph', graph: `${root}/_meta` },
    { subject: `${root}/code`, predicate: 'http://schema.org/name', object: '"code"', graph: `${root}/_meta` },
    { subject: `${root}/kid`, predicate: RDF_TYPE, object: 'https://dkg.network/ontology#ContextGraph', graph: `${root}/kid/_meta` },
  ];
  const [wholeVm, wholeSwm, codeVm, agentWm] = keys.map((key) => readGraphIri(key));
  return { contextGraphId, root, keys, graphs, registry, facts, readGraphs: { wholeVm: wholeVm!, wholeSwm: wholeSwm!, codeVm: codeVm!, agentWm: agentWm! } };
}

export type LayerFixture = ReturnType<typeof layerFixture>;

export const q = (subject: string, object: string, graph: string): Quad => ({ subject, predicate: P, object, graph });

export const readyRow = (readGraph: string, generation = 1): ReadGraphStateRow => ({
  readGraph, state: 'ready', generation,
  ruleVersion: CURRENT_READ_GRAPH_VERSIONS.ruleVersion, builderVersion: CURRENT_READ_GRAPH_VERSIONS.builderVersion,
});

export function isLayerMember(layer: ReadGraphStore, fixture: LayerFixture, key: ReadGraphKey, graph: string): boolean {
  return matchesGraphNameTest(readGraphMembership(key, fixture.registry, layer.runtime.workingMemoryIdentity), graph);
}

/** The fixture's data: its registry facts, three triples in each graph, and a blank node in one member graph. */
export function fixtureData(fixture: LayerFixture): Quad[] {
  return [
    ...fixture.facts,
    ...fixture.graphs.flatMap((graph, i) => [q('urn:s:shared', '"both"', graph), q(`urn:s:${i}`, `"v${i}"`, graph), q(`urn:s:${i}`, 'urn:o:iri', graph)]),
    // A blank node anchored in one member graph, which only the reference procedure can retract.
    q('_:anchor', '"anchored"', fixture.graphs[2]!),
  ];
}

/** A store as `createTripleStore` composes it over `adapter`, with the fixture's data and every read graph built and in the mirror. */
export async function layeredStore(adapter: TripleStore, config: TripleStoreConfig, fixture: LayerFixture) {
  const layer = wrapReadGraphLayer(adapter, config);
  const store = guardReadGraphPartition(layer);
  await adapter.insert(fixtureData(fixture));
  for (const key of fixture.keys) {
    const readGraph = readGraphIri(key);
    for (const graph of fixture.graphs) if (isLayerMember(layer, fixture, key, graph)) await adapter.update!(readGraphCopy(readGraph, graph));
    layer.runtime.mirror.set(readyRow(readGraph));
  }
  return { layer, store };
}

/** Every read graph of the fixture holds exactly the union of its member graphs. */
export async function expectLayerUnions(adapter: TripleStore, layer: ReadGraphStore, fixture: LayerFixture, after: string): Promise<void> {
  const result = await adapter.query(`SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "${fixture.root}")) }`);
  const quads = result.type === 'bindings' ? result.bindings : [];
  const triple = (binding: Record<string, string>) => `${binding.s} ${binding.p} ${binding.o}`;
  for (const key of fixture.keys) {
    const readGraph = readGraphIri(key);
    const expected = [...new Set(quads.filter((binding) => isLayerMember(layer, fixture, key, binding.g!)).map(triple))].sort();
    const actual = quads.filter((binding) => binding.g === readGraph).map(triple).sort();
    expect(actual, `${readGraph} after ${after}`).toEqual(expected);
  }
}

/**
 * The fixture's graphs hold what the same writes leave in a reference fixture
 * written through the bare adapter, with no read graph: so a write the layer
 * changed or dropped shows, whatever its read graphs hold.
 */
export async function expectSameMembers(
  adapter: TripleStore, fixture: LayerFixture, reference: TripleStore, referenceFixture: LayerFixture, after: string,
): Promise<void> {
  const triples = async (store: TripleStore, graph: string) => {
    const result = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
    // Blank-node labels differ between stores; one stands for any.
    const term = (value: string | undefined) => (value?.startsWith('_:') ? '_:b' : value);
    return (result.type === 'bindings' ? result.bindings : []).map((row) => `${term(row.s)} ${row.p} ${term(row.o)}`).sort();
  };
  for (const [i, graph] of fixture.graphs.entries()) {
    expect(await triples(adapter, graph), `${graph} after ${after}`).toEqual(await triples(reference, referenceFixture.graphs[i]!));
  }
}

/** The layer's maintenance on one engine: every write method, random writes, and the locks. */
export function readGraphLayerConformance(backend: 'oxigraph' | 'blazegraph') {
  describe(`read-graph layer maintenance (${backend})`, () => {
    let manager: BlazegraphNamespaceManager | undefined;
    let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>> | undefined;
    let shared: { readonly adapter: TripleStore; readonly config: TripleStoreConfig } | undefined;
    const run = `layer${randomUUID().slice(0, 8)}`;
    let sequence = 0;
    const freshFixture = () => layerFixture(`${run}-${sequence += 1}`);
    /** Embedded Oxigraph gets a new store each time; Blazegraph shares one namespace, with a new context graph each time. */
    const open = async (fixture: LayerFixture) => {
      const { adapter, config } = shared ?? { adapter: new PlanningOxigraphStore(), config: { backend: 'oxigraph' } as TripleStoreConfig };
      return { adapter, ...(await layeredStore(adapter, config, fixture)), close: shared ? async () => {} : () => adapter.close() };
    };
    /** A fixture with the same data, written through the bare adapter (a context graph of its own on Blazegraph). */
    const openReference = async () => {
      const fixture = freshFixture();
      const adapter = shared?.adapter ?? new PlanningOxigraphStore();
      await adapter.insert(fixtureData(fixture));
      return { fixture, store: adapter, close: shared ? async () => {} : () => adapter.close() };
    };

    beforeAll(async () => {
      if (backend !== 'blazegraph') return;
      if (!process.env.BLAZEGRAPH_TEST_URL) throw new Error('The live Blazegraph lane requires BLAZEGRAPH_TEST_URL');
      manager = new BlazegraphNamespaceManager({ namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(process.env.BLAZEGRAPH_TEST_URL) });
      handles = await manager.acquireMany([`read-graph-layer-${randomUUID()}`]);
      const url = handles[0]!.sparqlUrl;
      shared = { adapter: new BlazegraphStore(url, { timeout: 60_000 }), config: { backend: 'blazegraph', options: { url } } };
    }, 60_000);
    afterAll(async () => {
      await shared?.adapter.close();
      if (manager && handles) await manager.disposeAll(handles);
    }, 60_000);

    it('keeps every read graph a write touches equal to its members, for every write method', async () => {
      const fixture = freshFixture();
      const { adapter, layer, store, close } = await open(fixture);
      const reference = await openReference();
      const declares = (method: string) => (layer.adapterCapabilities?.methods as readonly string[] | undefined)?.includes(method) ?? false;
      type Step = readonly [string, (target: TripleStore, f: LayerFixture) => Promise<unknown>];
      const steps = (): Step[] => [
        ['insert', (t, f) => t.insert([q('urn:s:new', '"n"', f.graphs[1]!), q('urn:s:new', '"n"', f.graphs[4]!), q('urn:s:new', '"n"', f.graphs[8]!)])],
        ['delete', (t, f) => t.delete([q('urn:s:1', '"v1"', f.graphs[1]!), q('urn:s:shared', '"both"', f.graphs[1]!)])],
        ['delete with a blank node', (t, f) => t.delete([q('_:anchor', '"anchored"', f.graphs[2]!)])],
        ['deleteByPattern', (t, f) => t.deleteByPattern({ graph: f.graphs[4]!, subject: 'urn:s:4' })],
        ['deleteByPatternWithoutCount', (t, f) => t.deleteByPatternWithoutCount!({ graph: f.graphs[6]!, object: 'urn:o:iri' })],
        ['deleteBySubjectPrefix', (t, f) => t.deleteBySubjectPrefix(f.graphs[7]!, 'urn:s:')],
        ['dropGraph', (t, f) => t.dropGraph(f.graphs[2]!)],
        ['replaceGraph', (t, f) => t.replaceGraph!(f.graphs[0]!, [q('urn:s:r', '"r"', f.graphs[0]!)])],
        ['replaceSubject', (t, f) => t.replaceSubject!(f.graphs[5]!, 'urn:s:5', [q('urn:s:5', '"w"', f.graphs[5]!)])],
        ['replaceSubjectAndInsert', (t, f) => t.replaceSubjectAndInsert!(f.graphs[4]!, 'urn:s:shared', [q('urn:s:shared', '"x"', f.graphs[4]!)],
          [q('urn:s:companion', '"c"', f.graphs[4]!)])],
        ['update', (t, f) => t.update!(`INSERT DATA { GRAPH <${f.graphs[1]!}> { <urn:s:u> <${P}> "u" } }`, { writtenGraphs: [f.graphs[1]!] })],
        ['an update that writes no member graph', (t, f) => t.update!(`INSERT DATA { GRAPH <${f.graphs[8]!}> { <urn:s:u> <${P}> "u" } }`,
          { writtenGraphs: [f.graphs[8]!] })],
        ...(declares('replaceAssetGroup') ? [['replaceAssetGroup', (t, f) => t.replaceAssetGroup!([{
          graphUri: f.graphs[2]!, graphQuads: [q('urn:s:ag', '"ag"', f.graphs[2]!)], metaGraphUri: `${f.root}/_meta`, metadataSubject: 'urn:asset:ag',
          metadataQuads: [q('urn:asset:ag', '"m"', `${f.root}/_meta`)],
        }])] as Step] : []),
        ...(declares('replaceGraphAndSubject') ? [['replaceGraphAndSubject', (t, f) => t.replaceGraphAndSubject!(
          f.graphs[1]!, [q('urn:s:gs', '"gs"', f.graphs[1]!)], `${f.root}/_meta`, 'urn:asset:gs', [q('urn:asset:gs', '"m2"', `${f.root}/_meta`)])] as Step] : []),
      ];
      const held = async (graph: string) => {
        const result = await adapter.query(`ASK { GRAPH <${graph}> { ?b <${P}> "anchored" FILTER(isBlank(?b)) } }`);
        return result.type === 'boolean' ? result.value : undefined;
      };
      expect([await held(fixture.graphs[2]!), await held(fixture.readGraphs.wholeVm)]).toEqual([true, true]);
      for (const [name, step] of steps()) {
        await step(store, fixture);
        await step(reference.store, reference.fixture);
        await expectLayerUnions(adapter, layer, fixture, name);
        await expectSameMembers(adapter, fixture, reference.store, reference.fixture, name);
        if (name === 'delete with a blank node') {
          expect([await held(fixture.graphs[2]!), await held(fixture.readGraphs.wholeVm)]).toEqual([false, false]);
        }
      }
      expect(await adapter.countQuads(fixture.readGraphs.wholeVm)).toBeGreaterThan(0);
      await reference.close();
      await close();
    }, 120_000);

    it('keeps every read graph equal to its members across random writes of every method', async () => {
      const subject = fc.constantFrom('urn:s:1', 'urn:s:2', 'urn:s:shared', 'urn:t:1');
      const object = fc.constantFrom('"a"', '"b"@en', 'urn:o:iri', '"both"');
      const write = fc.nat({ max: 9 }).chain((graphIndex) => {
        const triples = (target: string) => fc.array(fc.record({ subject, object }).map(({ subject: s, object: o }) => q(s, o, target)), { maxLength: 3 });
        const at = (fixture: LayerFixture) => fixture.graphs[graphIndex]!;
        type Write = { readonly name: string; readonly run: (store: TripleStore, fixture: LayerFixture) => Promise<unknown> };
        return fc.oneof(
          triples('').map((quads): Write => ({ name: 'insert', run: (store, f) => store.insert(quads.map((quad) => ({ ...quad, graph: at(f) }))) })),
          triples('').map((quads): Write => ({ name: 'delete', run: (store, f) => store.delete(quads.map((quad) => ({ ...quad, graph: at(f) }))) })),
          fc.record({ subject: fc.option(subject, { nil: undefined }), object: fc.option(object, { nil: undefined }) }).map((pattern): Write =>
            ({ name: 'deleteByPattern', run: (store, f) => store.deleteByPattern({ graph: at(f), ...pattern }) })),
          subject.map((s): Write => ({ name: 'deleteByPatternWithoutCount', run: (store, f) => store.deleteByPatternWithoutCount!({ graph: at(f), subject: s }) })),
          fc.constantFrom('urn:s:', 'urn:t', 'urn:').map((prefix): Write =>
            ({ name: 'deleteBySubjectPrefix', run: (store, f) => store.deleteBySubjectPrefix(at(f), prefix) })),
          fc.constant<Write>({ name: 'dropGraph', run: (store, f) => store.dropGraph(at(f)) }),
          triples('').map((quads): Write => ({ name: 'replaceGraph', run: (store, f) => store.replaceGraph!(at(f), quads.map((quad) => ({ ...quad, graph: at(f) }))) })),
          fc.tuple(subject, fc.array(object, { maxLength: 2 }), triples('')).map(([s, objects, companions]): Write => ({
            name: 'replaceSubjectAndInsert',
            run: (store, f) => store.replaceSubjectAndInsert!(at(f), s, objects.map((o) => q(s, o, at(f))),
              companions.filter((companion) => companion.subject !== s).map((quad) => ({ ...quad, graph: at(f) }))),
          })),
          fc.tuple(subject, fc.array(object, { maxLength: 2 })).map(([s, objects]): Write => ({
            name: 'replaceSubject', run: (store, f) => store.replaceSubject!(at(f), s, objects.map((o) => q(s, o, at(f)))),
          })),
          triples('').map((quads): Write => ({
            name: 'update',
            run: (store, f) => store.update!(
              `DELETE { GRAPH <${at(f)}> { ?s ?p ?o } } WHERE { GRAPH <${at(f)}> { ?s ?p ?o FILTER(?o = "both") } } ;\n`
                + `INSERT DATA { GRAPH <${at(f)}> { ${quads.map((quad) => `<${quad.subject}> <${P}> ${quad.object.startsWith('"') ? quad.object : `<${quad.object}>`} .`).join(' ')} } }`,
              { writtenGraphs: [at(f)] }),
          })),
        );
      });
      const runs = backend === 'blazegraph' ? 12 : Math.min(propertyOptions().numRuns, 60);
      await fc.assert(fc.asyncProperty(fc.array(write, { minLength: 1, maxLength: 6 }), async (writes) => {
        const fixture = freshFixture();
        const { adapter, layer, store, close } = await open(fixture);
        const reference = await openReference();
        for (const { name, run: apply } of writes) {
          await apply(store, fixture);
          await apply(reference.store, reference.fixture);
          await expectLayerUnions(adapter, layer, fixture, name);
          await expectSameMembers(adapter, fixture, reference.store, reference.fixture, name);
        }
        await reference.close();
        await close();
      }), { ...propertyOptions(), numRuns: runs });
    }, 300_000);

    it('marks the read graphs whose members a sub-graph registration changes dirty, and leaves the others', async () => {
      const fixture = freshFixture();
      const { layer, store, close } = await open(fixture);
      const meta = `${fixture.root}/_meta`;
      await store.insert([
        { subject: `${fixture.root}/docs`, predicate: RDF_TYPE, object: 'http://dkg.io/ontology/SubGraph', graph: meta },
        { subject: `${fixture.root}/docs`, predicate: 'http://schema.org/name', object: '"docs"', graph: meta },
      ]);
      const state = (readGraph: string) => layer.runtime.mirror.get(readGraph)!.state;
      expect([state(fixture.readGraphs.wholeVm), state(fixture.readGraphs.wholeSwm), state(fixture.readGraphs.agentWm)]).toEqual(['dirty', 'dirty', 'dirty']);
      expect(state(fixture.readGraphs.codeVm)).toBe('ready');
      expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code', 'docs']);
      await close();
    }, 60_000);

    it('maintains the read graphs of an RFC-64 author commit that wins, and changes nothing for one that loses its guard', async () => {
      const fixture = freshFixture();
      const { adapter, layer, store, close } = await open(fixture);
      // Only an adapter that declares author commits runs one with read graphs.
      if ((layer.adapterCapabilities?.methods as readonly string[] | undefined)?.includes('rfc64AuthorCommitCasV1') !== true) {
        await close();
        return;
      }
      // The commit replaces the context graph's shared-memory graph, a member of its whole-graph SWM read graph.
      const projection = fixture.graphs[5]!;
      await seedOldState(adapter);
      const commit = (value: string) => authorCommitInput({ sharedProjectionGraph: projection, sharedProjectionQuads: [q('urn:s:commit', value, projection)] });
      const held = async () => {
        const result = await adapter.query(`SELECT ?s ?o WHERE { GRAPH <${projection}> { ?s <${P}> ?o } }`);
        return (result.type === 'bindings' ? result.bindings : []).map((row) => `${row.s} ${row.o}`).sort();
      };
      await expect(store.rfc64AuthorCommitCasV1!(commit('"won"'))).resolves.toBe('committed');
      expect(await held()).toEqual(['urn:s:commit "won"']);
      await expectLayerUnions(adapter, layer, fixture, 'an author commit that won');
      // Its guard is now stale: the head has moved on.
      await expect(store.rfc64AuthorCommitCasV1!(commit('"lost"'))).resolves.toBe('conflict');
      expect(await held()).toEqual(['urn:s:commit "won"']);
      await expectLayerUnions(adapter, layer, fixture, 'an author commit that lost its guard');
      await close();
    }, 60_000);

    it('waits for the locks of the read graphs it maintains, and maintains one whose row appears while it waits', async () => {
      const fixture = freshFixture();
      const { adapter, layer, store, close } = await open(fixture);
      const { wholeVm, codeVm } = fixture.readGraphs;
      const code = fixture.graphs[4]!;
      const codeRow = layer.runtime.mirror.get(codeVm)!;
      layer.runtime.mirror.remove(codeVm);
      let release!: () => void;
      const held = layer.runtime.locks.withLocks([wholeVm], () => new Promise<void>((resolve) => { release = resolve; }));
      const write = store.insert([q('urn:s:late', '"late"', code)]);
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
      expect(await adapter.countQuads(code)).toBe(3);
      layer.runtime.mirror.set(codeRow);
      release();
      await Promise.all([held, write]);
      await expectLayerUnions(adapter, layer, fixture, 'a write that waited');
      expect(layer.runtime.locks.isLocked(wholeVm) || layer.runtime.locks.isLocked(codeVm)).toBe(false);
      await close();
    }, 60_000);
  });
}
