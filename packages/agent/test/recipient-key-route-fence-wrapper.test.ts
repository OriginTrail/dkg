// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';

import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';
import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';
import { createProjectionWriteHooks } from '../src/internal/projection-write-hooks.js';
import { RECIPIENT_KEY_ROUTE_PREDICATES } from '../src/internal/recipient-key-route-fence.js';

const AGENT = 'did:dkg:agent:0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const KEY_IRI = `${AGENT.toLowerCase()}#x25519-0123456789abcdef0123456789abcdef`;
const CG_DID = 'did:dkg:context-graph:0xabc/proj';
const PROFILE_GRAPH = 'did:dkg:context-graph:agents';
const JOIN_CACHE = 'urn:dkg:local:join-encryption-key-cache';
const META_GRAPH = `${CG_DID}/_meta`;
const SWM_META_GRAPH = `${CG_DID}/_shared_memory_meta`;
const CONTROL_GRAPH = 'urn:dkg:promote-queue:control-plane';
const KA_GRAPH = `${CG_DID}/assertion/0xdef/notes`;
const KA_UAL = 'did:dkg:base:84532/0x1234567890123456789012345678901234567890/7';
const NAME = 'http://schema.org/name';
const MEMORY_LAYER = 'http://dkg.io/ontology/memoryLayer';

const quad = (subject: string, predicate: string, graph: string): Quad => ({ subject, predicate, object: '"v"', graph });
const keyFact = (graph = PROFILE_GRAPH, predicate = DKG_ONTOLOGY.DKG_PEER_ID): Quad => quad(AGENT, predicate, graph);

async function stack(options: { anticipate?: boolean; inner?: (store: OxigraphStore) => TripleStore } = {}) {
  const store = new OxigraphStore();
  const projection = new ContextGraphMetaProjection(store);
  const hooks = createProjectionWriteHooks(() => projection);
  const wrapper = createListContextGraphsCacheInvalidatingStore(
    options.inner ? options.inner(store) : store,
    () => {},
    hooks.markDirty,
    options.anticipate === false ? undefined : hooks.anticipate,
  );
  await store.insert([
    keyFact(PROFILE_GRAPH, DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY),
    keyFact(PROFILE_GRAPH, DKG_ONTOLOGY.DKG_PEER_ID),
    quad(KEY_IRI, DKG_ONTOLOGY.DKG_REVOKED_AT, PROFILE_GRAPH),
    quad(CG_DID, DKG_ONTOLOGY.DKG_ACCESS_POLICY, META_GRAPH),
    quad(KA_UAL, NAME, META_GRAPH),
    quad('urn:dkg:share:s1', NAME, SWM_META_GRAPH),
    quad('urn:x:doc', NAME, KA_GRAPH),
  ]);
  await projection.recipientKeyRouteFence.ensureReady();
  const fence = projection.recipientKeyRouteFence;
  return { store, projection, wrapper, fence };
}

describe('recipient key/route fence through the production store wrapper (GH#3067)', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });
  const open = async (options?: Parameters<typeof stack>[0]) => {
    const built = await stack(options);
    stores.push(built.store);
    return built;
  };

  type Wrapper = TripleStore;
  const noise: Array<[string, (store: Wrapper) => Promise<unknown>]> = [
    ['a promote-queue job replace', (s) => s.replaceSubject!(CONTROL_GRAPH, 'urn:dkg:promote-queue:job:j1', [
      quad('urn:dkg:promote-queue:job:j1', 'urn:dkg:promote-queue:state', CONTROL_GRAPH)])],
    ['a lift-queue job replace', (s) => s.replaceSubject!('urn:dkg:publisher:control-plane', 'urn:dkg:publisher:lift-job:l1', [
      quad('urn:dkg:publisher:lift-job:l1', 'urn:dkg:publisher:state', 'urn:dkg:publisher:control-plane')])],
    ['a share metadata delete', (s) => s.deleteByPatternWithoutCount!({ graph: SWM_META_GRAPH, subject: 'urn:dkg:share:s1' })],
    ['a knowledge-asset metadata delete in the graph\'s own _meta', (s) => s.deleteByPatternWithoutCount!({ graph: META_GRAPH, subject: KA_UAL })],
    ['an assertion layer delete in _meta', (s) => s.deleteByPatternWithoutCount!({
      graph: META_GRAPH, subject: KA_GRAPH, predicate: MEMORY_LAYER })],
    ['a delete counted by pattern with a harmless predicate', (s) => s.deleteByPattern({ graph: KA_GRAPH, predicate: NAME })],
    ['a drop of a knowledge-asset graph', (s) => s.dropGraph(KA_GRAPH)],
    ['a replace of a knowledge-asset graph', (s) => s.replaceGraph!(`${CG_DID}/_working_memory/a`, [quad('urn:x:doc', NAME, `${CG_DID}/_working_memory/a`)])],
    ['a replace of a graph and its metadata subject', (s) => s.replaceGraphAndSubject!(
      `${CG_DID}/_shared_memory/b`, [quad('urn:x:doc', NAME, `${CG_DID}/_shared_memory/b`)],
      META_GRAPH, KA_UAL, [quad(KA_UAL, NAME, META_GRAPH)])],
    ['an insert of content and metadata quads', (s) => s.insert([
      quad('urn:x:doc2', NAME, KA_GRAPH), quad(AGENT, NAME, KA_GRAPH), quad('urn:dkg:share:s2', DKG_ONTOLOGY.DKG_PEER_ID, SWM_META_GRAPH)])],
    ['a delete of content quads', (s) => s.delete([quad('urn:x:doc', NAME, KA_GRAPH)])],
    ['a read', (s) => s.query('SELECT * WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 5')],
  ];

  it.each(noise)('does not move for %s, which still moves the node-wide revision where it did before', async (label, run) => {
    const { wrapper, fence, projection } = await open();
    const before = fence.revision;
    const nodeWideBefore = projection.readAuthorityFactsRevision;
    await run(wrapper);
    expect(fence.revision, label).toBe(before);
    if (/promote-queue|lift-queue/.test(label)) expect(projection.readAuthorityFactsRevision).toBeGreaterThan(nodeWideBefore);
  });

  const signal: Array<[string, (store: Wrapper) => Promise<unknown>]> = [
    ['an insert of a key fact', (s) => s.insert([keyFact(KA_GRAPH, DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY)])],
    ...[...RECIPIENT_KEY_ROUTE_PREDICATES].map((predicate): [string, (store: Wrapper) => Promise<unknown>] => [
      `an insert of ${predicate.split('/').pop()}`, (s) => s.insert([quad(KEY_IRI, predicate, PROFILE_GRAPH)])]),
    ['a revocation insert', (s) => s.insert([quad(KEY_IRI, DKG_ONTOLOGY.DKG_REVOKED_AT, KA_GRAPH)])],
    ['a delete of a key fact', (s) => s.delete([keyFact(PROFILE_GRAPH, DKG_ONTOLOGY.DKG_PEER_ID)])],
    ['a route removal by agent subject', (s) => s.deleteByPattern({ graph: PROFILE_GRAPH, subject: AGENT, predicate: DKG_ONTOLOGY.DKG_PEER_ID })],
    ['a route removal by agent subject, counted or not', (s) => s.deleteByPatternWithoutCount!({ graph: PROFILE_GRAPH, subject: AGENT })],
    ['a route removal by predicate in a key graph', (s) => s.deleteByPattern({ graph: PROFILE_GRAPH, predicate: DKG_ONTOLOGY.DKG_PEER_ID })],
    ['a delete by predicate in any graph', (s) => s.deleteByPattern({ predicate: DKG_ONTOLOGY.DKG_REVOKED_AT })],
    ['a delete with nothing named', (s) => s.deleteByPattern({})],
    ['a drop of a key graph', (s) => s.dropGraph(PROFILE_GRAPH)],
    ['a join-cache refresh', (s) => s.replaceSubject!(JOIN_CACHE, AGENT, [
      quad(AGENT, DKG_ONTOLOGY.DKG_PEER_ID, JOIN_CACHE), quad(AGENT, DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY, JOIN_CACHE)])],
    ['a replace of a harmless subject whose payload carries a key fact', (s) => s.replaceSubject!(
      CONTROL_GRAPH, KEY_IRI, [quad(KEY_IRI, DKG_ONTOLOGY.DKG_REVOKED_AT, CONTROL_GRAPH)])],
    ['a replace of a graph with key facts in its payload', (s) => s.replaceGraph!(KA_GRAPH, [keyFact(KA_GRAPH)])],
    ['a replace of a key graph', (s) => s.replaceGraph!(PROFILE_GRAPH, [quad('urn:x:y', NAME, PROFILE_GRAPH)])],
    ['a graph replace whose metadata payload carries a key fact', (s) => s.replaceGraphAndSubject!(
      KA_GRAPH, [], META_GRAPH, AGENT, [quad(AGENT, DKG_ONTOLOGY.DKG_PEER_ID, META_GRAPH)])],
    ['a prefix delete', (s) => s.deleteBySubjectPrefix(KA_GRAPH, 'urn:x:')],
    ['a SPARQL update', (s) => s.update!(`INSERT DATA { GRAPH <${KA_GRAPH}> { <urn:x:a> <${NAME}> "v" } }`)],
  ];

  it.each(signal)('moves for %s', async (label, run) => {
    const { wrapper, fence } = await open();
    const before = fence.revision;
    await run(wrapper);
    expect(fence.revision, label).toBeGreaterThan(before);
  });

  it('moves for a SPARQL update that a backend accepts through query()', async () => {
    const { wrapper, fence } = await open({
      inner: (store) => new Proxy(store, {
        get: (target, property) => property === 'query'
          ? async (sparql: string) => (/^s*(DELETE|INSERT)/i.test(sparql) ? { type: 'bindings' as const, bindings: [] } : target.query(sparql))
          : (typeof Reflect.get(target, property) === 'function'
            ? (Reflect.get(target, property) as (...args: unknown[]) => unknown).bind(target)
            : Reflect.get(target, property)),
      }),
    });
    const before = fence.revision;
    await wrapper.query('SELECT * WHERE { ?s ?p ?o } LIMIT 1');
    expect(fence.revision).toBe(before);
    await wrapper.query(`DELETE WHERE { GRAPH <${KA_GRAPH}> { ?s ?p ?o } }`);
    expect(fence.revision).toBeGreaterThan(before);
  });

  it('learns a graph from the payload of a replace and then moves for a later drop of that graph', async () => {
    const { wrapper, fence } = await open();
    await wrapper.replaceGraph!(`${CG_DID}/fresh`, [keyFact(`${CG_DID}/fresh`)]);
    const before = fence.revision;
    await wrapper.dropGraph(`${CG_DID}/fresh`);
    expect(fence.revision).toBeGreaterThan(before);
  });

  it('is no longer trusted after an UPDATE until the graphs are scanned again, and never reports a harmless drop meanwhile', async () => {
    const { wrapper, fence } = await open();
    await wrapper.update!(`INSERT DATA { GRAPH <urn:dkg:graph:late> { <${AGENT}> <${DKG_ONTOLOGY.DKG_PEER_ID}> "p" } }`);
    const afterUpdate = fence.revision;
    await wrapper.dropGraph('urn:dkg:graph:late');
    expect(fence.revision).toBeGreaterThan(afterUpdate);
    await fence.ensureReady();
    const settled = fence.revision;
    await wrapper.dropGraph(`${CG_DID}/never-held-keys`);
    expect(fence.revision).toBe(settled);
  });

  it('moves for a signed CAS commit whose payload the wrapper cannot see, and not for a refused one', async () => {
    let result: 'committed' | 'conflict' = 'committed';
    const { wrapper, fence } = await open({
      inner: (store) => new Proxy(store, {
        get: (target, property) => property === 'rfc64AuthorCommitCasV1'
          ? async () => result
          : (typeof Reflect.get(target, property) === 'function'
            ? (Reflect.get(target, property) as (...args: unknown[]) => unknown).bind(target)
            : Reflect.get(target, property)),
      }),
    });
    const input = {
      sharedProjectionGraph: 'urn:g:shared', authorSealGraph: 'urn:g:seal', currentHeadGraph: 'urn:g:head',
      kaStateDigest: { graphUri: 'urn:g:ka' }, subgraphMutationGeneration: { graphUri: 'urn:g:sub' },
      contextGraphMutationGeneration: { graphUri: 'urn:g:cg' }, appliedSet: { graphUri: 'urn:g:applied' }, sealInvalidations: [],
    };
    result = 'conflict';
    const refused = fence.revision;
    await wrapper.rfc64AuthorCommitCasV1!(input as never);
    expect(fence.revision).toBe(refused);
    result = 'committed';
    await wrapper.rfc64AuthorCommitCasV1!(input as never);
    expect(fence.revision).toBeGreaterThan(refused);
  });

  describe('a removal that overtakes the notification of an insert into the same graph', () => {
    const racing = (store: OxigraphStore): TripleStore => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      (store as unknown as { release: () => void }).release = release;
      return new Proxy(store, {
        get: (target, property) => {
          if (property === 'replaceGraph') {
            return async (graph: string, quads: Quad[]) => { await gate; return target.replaceGraph(graph, quads); };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    };

    it('is caught because the graph is learned when the insert is dispatched', async () => {
      const { wrapper, fence, store } = await open({ inner: racing });
      const insert = wrapper.replaceGraph!(`${CG_DID}/racing`, [keyFact(`${CG_DID}/racing`)]);
      const before = fence.revision;
      await wrapper.dropGraph(`${CG_DID}/racing`);
      expect(fence.revision).toBeGreaterThan(before);
      (store as unknown as { release: () => void }).release();
      await insert;
    });

    it('would be missed without that hook (control for the test above)', async () => {
      const { wrapper, fence, store } = await open({ inner: racing, anticipate: false });
      const insert = wrapper.replaceGraph!(`${CG_DID}/racing`, [keyFact(`${CG_DID}/racing`)]);
      const before = fence.revision;
      await wrapper.dropGraph(`${CG_DID}/racing`);
      expect(fence.revision).toBe(before);
      (store as unknown as { release: () => void }).release();
      await insert;
    });
  });
});

// ---------------------------------------------------------------------------
// Property: whatever a wrapper operation does to the key and route facts a
// resolution reads, the fence has moved. Oracle: the set of (graph, subject,
// predicate, object) rows with an agent DID subject and a key or route
// predicate, read straight from the store.
// ---------------------------------------------------------------------------

const GRAPHS = [PROFILE_GRAPH, JOIN_CACHE, META_GRAPH, SWM_META_GRAPH, CONTROL_GRAPH, KA_GRAPH, 'urn:dkg:graph:new1', 'urn:dkg:graph:new2'];
const SUBJECTS = [AGENT, AGENT.toLowerCase(), KEY_IRI, CG_DID, 'urn:dkg:share:s1', 'urn:dkg:promote-queue:job:j1', KA_UAL, 'urn:x:other'];
const PREDICATES = [...RECIPIENT_KEY_ROUTE_PREDICATES, NAME, MEMORY_LAYER, DKG_ONTOLOGY.DKG_ACCESS_POLICY, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'];
const IRREGULAR = ['', `<${AGENT}`, `<${AGENT}>`, 'urn:x y', 'urn:x"y'];

const ORACLE = `SELECT ?g ?s ?p ?o WHERE {
  VALUES ?p { ${[...RECIPIENT_KEY_ROUTE_PREDICATES].map((p) => `<${p}>`).join(' ')} }
  GRAPH ?g { ?s ?p ?o }
  FILTER(STRSTARTS(STR(?s), "did:dkg:agent:"))
}`;

async function relevantFacts(store: OxigraphStore): Promise<string> {
  const result = await store.query(ORACLE);
  if (result.type !== 'bindings') throw new Error('oracle returned no bindings');
  return JSON.stringify(result.bindings.map((row) => [row['g'], row['s'], row['p'], row['o']].join(' ')).sort());
}

const iri = (values: readonly string[]) => fc.constantFrom(...values);
const quadIn = (graph: fc.Arbitrary<string>, subject: fc.Arbitrary<string> = iri(SUBJECTS)) =>
  fc.record({ subject, predicate: iri(PREDICATES), object: fc.constantFrom('"a"', '"b"'), graph });

type Operation = (store: TripleStore) => Promise<unknown>;

const operation: fc.Arbitrary<Operation> = fc.oneof(
  fc.array(quadIn(iri(GRAPHS)), { minLength: 1, maxLength: 3 }).map((q): Operation => (s) => s.insert(q)),
  fc.array(quadIn(iri(GRAPHS)), { minLength: 1, maxLength: 3 }).map((q): Operation => (s) => s.delete(q)),
  fc.record({ graph: fc.option(iri([...GRAPHS, ...IRREGULAR]), { nil: undefined }), subject: fc.option(iri([...SUBJECTS, ...IRREGULAR]), { nil: undefined }), predicate: fc.option(iri([...PREDICATES, ...IRREGULAR]), { nil: undefined }) })
    .map((pattern): Operation => (s) => s.deleteByPattern(pattern)),
  fc.record({ graph: fc.option(iri([...GRAPHS, ...IRREGULAR]), { nil: undefined }), subject: fc.option(iri([...SUBJECTS, ...IRREGULAR]), { nil: undefined }), predicate: fc.option(iri([...PREDICATES, ...IRREGULAR]), { nil: undefined }) })
    .map((pattern): Operation => (s) => s.deleteByPatternWithoutCount!(pattern)),
  iri(GRAPHS).map((graph): Operation => (s) => s.dropGraph(graph)),
  fc.tuple(iri(GRAPHS)).chain(([graph]) => fc.array(quadIn(fc.constant(graph)), { maxLength: 3 }).map((q): Operation => (s) => s.replaceGraph!(graph, q))),
  fc.tuple(iri(GRAPHS), iri(SUBJECTS)).chain(([graph, subject]) =>
    fc.array(quadIn(fc.constant(graph), fc.constant(subject)), { maxLength: 3 }).map((q): Operation => (s) => s.replaceSubject!(graph, subject, q))),
  fc.tuple(iri(GRAPHS), iri(SUBJECTS), fc.array(quadIn(iri(GRAPHS)), { maxLength: 2 })).map(([graph, subject, graphQuads]): Operation =>
    (s) => s.replaceGraphAndSubject!(graph, graphQuads.map((q) => ({ ...q, graph })), META_GRAPH, subject, [quad(subject, NAME, META_GRAPH), quad(subject, DKG_ONTOLOGY.DKG_PEER_ID, META_GRAPH)])),
  fc.tuple(iri(GRAPHS), iri(['urn:', 'did:dkg:agent:', 'did:dkg:agent:0xAb', 'did:dkg:', 'urn:x:'])).map(([graph, prefix]): Operation => (s) => s.deleteBySubjectPrefix(graph, prefix)),
  fc.tuple(iri(GRAPHS), iri(SUBJECTS), iri(PREDICATES)).map(([graph, subject, predicate]): Operation =>
    (s) => s.update!(`INSERT DATA { GRAPH <${graph}> { <${subject}> <${predicate}> "u" } }`)),
  iri(GRAPHS).map((graph): Operation => (s) => s.query(`DELETE WHERE { GRAPH <${graph}> { ?s ?p ?o } }`)),
);

describe('recipient key/route fence is sound over random wrapper operations (GH#3067)', () => {
  it('moves whenever an operation changes a key or route fact, whatever the order and whether the graphs were scanned', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.array(operation, { minLength: 1, maxLength: 10 }), async (scanFirst, operations) => {
        const { wrapper, store, fence } = await stack();
        try {
          if (!scanFirst) await wrapper.update!('INSERT DATA { GRAPH <urn:dkg:graph:staler> { <urn:x:s> <urn:x:p> "o" } }');
          for (const run of operations) {
            const factsBefore = await relevantFacts(store);
            const revisionBefore = fence.revision;
            try { await run(wrapper); } catch { /* a refused or failed operation may have changed nothing, or something */ }
            const factsAfter = await relevantFacts(store);
            if (factsAfter !== factsBefore && fence.revision === revisionBefore) {
              throw new Error(`fence did not move although key facts changed\nbefore: ${factsBefore}\nafter: ${factsAfter}`);
            }
          }
        } finally {
          await store.close();
        }
      }),
      { numRuns: 150 },
    );
  }, 120_000);

  it('does not move for operations built only from harmless graphs, subjects, predicates and payloads', async () => {
    const harmlessGraph = iri([META_GRAPH, SWM_META_GRAPH, CONTROL_GRAPH, KA_GRAPH, 'urn:dkg:graph:new1']);
    const harmlessSubject = iri(['urn:dkg:share:s1', 'urn:dkg:promote-queue:job:j1', KA_UAL, 'urn:x:other', CG_DID]);
    const harmlessPredicate = iri([NAME, MEMORY_LAYER, DKG_ONTOLOGY.DKG_ACCESS_POLICY]);
    const harmlessQuad = fc.record({ subject: harmlessSubject, predicate: harmlessPredicate, object: fc.constant('"a"'), graph: harmlessGraph });
    const harmless: fc.Arbitrary<Operation> = fc.oneof(
      fc.array(harmlessQuad, { minLength: 1, maxLength: 3 }).map((q): Operation => (s) => s.insert(q)),
      fc.array(harmlessQuad, { minLength: 1, maxLength: 3 }).map((q): Operation => (s) => s.delete(q)),
      fc.record({ graph: harmlessGraph, subject: harmlessSubject }).map((p): Operation => (s) => s.deleteByPatternWithoutCount!(p)),
      fc.record({ graph: harmlessGraph, predicate: harmlessPredicate }).map((p): Operation => (s) => s.deleteByPattern(p)),
      harmlessGraph.map((g): Operation => (s) => s.dropGraph(g)),
      harmlessGraph.chain((g) => fc.array(fc.record({ subject: harmlessSubject, predicate: harmlessPredicate, object: fc.constant('"a"'), graph: fc.constant(g) }), { maxLength: 3 })
        .map((q): Operation => (s) => s.replaceGraph!(g, q))),
      fc.tuple(harmlessGraph, harmlessSubject).map(([g, subject]): Operation =>
        (s) => s.replaceSubject!(g, subject, [{ subject, predicate: NAME, object: '"a"', graph: g }])),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(harmless, { minLength: 1, maxLength: 10 }), async (operations) => {
        const { wrapper, store, fence } = await stack();
        try {
          const before = fence.revision;
          for (const run of operations) {
            try { await run(wrapper); } catch { /* ignore */ }
          }
          expect(fence.revision).toBe(before);
        } finally {
          await store.close();
        }
      }),
      { numRuns: 100 },
    );
  }, 120_000);
});
