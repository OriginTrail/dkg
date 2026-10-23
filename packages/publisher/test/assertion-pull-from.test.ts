import { CG, AGENT, NAME, SCHEMA, DKG, ENTITY_1, ENTITY_2, ENTITY_3, makePublisher, q, key, seedDirtyDraft, seedShared, registerSubGraph, cleanupPullFixtures } from './_helpers/assertion-pull.js';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  ASSERTION_SEAL_PREDICATES,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  TypedEventBus,
  assertionLifecycleUri,
  buildAssertionSealQuads,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  contextGraphPrivateUri,
  contextGraphSubGraphPrivateUri,
  contextGraphSubGraphUri,
  createGraphKnowledgeAssetScope,
  generateEd25519Keypair,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, PrivateContentStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher, TripleStoreAsyncPromoteQueue, assertionScopedGraphUri } from '../src/index.js';
import { resolveKnowledgeAssetWorkspaceHead, storeKnowledgeAssetWorkspaceHead, storeKnowledgeAssetOperationPublicQuads } from '../src/workspace-resolution.js';
import { finalizeRootlessAssertionForTest } from './_helpers/rootless-lifecycle.js';

const LEGACY_SWM_GRAPH = `did:dkg:context-graph:${CG}/_shared_memory`;
const LEGACY_DATA_GRAPH = `did:dkg:context-graph:${CG}`;

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupPullFixtures();
});


function legacySeal(rootEntities: string[]): Quad[] {
  return buildAssertionSealQuads({
    assertionUri: contextGraphAssertionUri(CG, AGENT, NAME),
    metaGraph: contextGraphMetaUri(CG),
    merkleRoot: new Uint8Array(32).fill(7),
    authorAddress: AGENT,
    authorAttestationR: new Uint8Array(32).fill(1),
    authorAttestationVS: new Uint8Array(32).fill(2),
    authorSchemeVersion: 1,
    chainId: 31337n,
    kav10Address: AGENT,
    reservedKaId: (BigInt(AGENT) << 96n) | 1n,
    finalizedAtIso: '2026-01-01T00:00:00.000Z',
    rootEntities,
  }) as Quad[];
}

describe('rootless assertionPullFrom', () => {
  const sealPredicates = Object.values(ASSERTION_SEAL_PREDICATES);
  async function interruptClear(publisher: DKGPublisher, store: TripleStore, boundary: number) {
    const original = store.deleteByPatternWithoutCount!.bind(store);
    const subjects = new Set([contextGraphAssertionUri(CG, AGENT, NAME), await publisher.wmGraphUri(CG, AGENT, NAME)]);
    let deleted = 0;
    const fault = vi.spyOn(store, 'deleteByPatternWithoutCount').mockImplementation(async (pattern, options) => {
      if (pattern.subject && subjects.has(pattern.subject) && sealPredicates.includes(pattern.predicate as never)) {
        if (deleted++ === boundary) throw new Error('injected active-seal clear failure');
        await original(pattern, options);
        if (boundary === sealPredicates.length * subjects.size && deleted === boundary) {
          throw new Error('injected active-seal clear failure');
        }
        return;
      }
      return original(pattern, options);
    });
    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm'))
      .rejects.toThrow('injected active-seal clear failure');
    fault.mockRestore();
  }

  it('checks the exact source pin even through partial-seal recovery (#3350)', async () => {
    const { publisher, store } = await makePublisher();
    const source = await seedShared(publisher, store);
    await interruptClear(publisher, store, 4);
    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', {
      recoverExact: { ...source, merkleRoot: `0x${'ab'.repeat(32)}` },
    })).rejects.toMatchObject({ code: 'WM_RECOVERY_SOURCE_UNAVAILABLE' });
  });

  it.each(Array.from({ length: sealPredicates.length * 2 + 1 }, (_, i) => i))(
    'recovers active-seal clear boundary %i after publisher restart (#3332)', async (boundary) => {
      const { publisher, store } = await makePublisher();
      const finalized = await seedShared(publisher, store, {
        privateQuads: [q(ENTITY_1, 'urn:secret', '"Private"')],
      });
      await interruptClear(publisher, store, boundary);
      const container = process.env.DKG_PULL_RECOVERY_BLAZEGRAPH_CONTAINER;
      if (container && (boundary === 4 || boundary === sealPredicates.length * 2)) {
        if (!process.env.DKG_PULL_RECOVERY_BLAZEGRAPH_URL) throw new Error('Restart coverage requires Blazegraph URL');
        execFileSync('docker', ['restart', container], { timeout: 60_000, stdio: 'pipe' });
        const deadline = Date.now() + 30_000;
        while (true) {
          try { await store.query('ASK { ?s ?p ?o }'); break; }
          catch (error) {
            if (Date.now() >= deadline) throw error;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      }
      const restarted = new DKGPublisher({ store, chain: new NoChainAdapter(),
        eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair() });
      await expect(restarted.assertionPullFrom(CG, NAME, AGENT, 'swm'))
        .resolves.toMatchObject({ kaUal: finalized.kaUal, assertionVersion: finalized.assertionVersion, seededPrivate: 1 });
      expect(new Set((await restarted.assertionQuery(CG, NAME, AGENT)).map(key)))
        .toEqual(new Set(finalized.publicQuads.map(key)));
      expect(new Set((await restarted.assertionQueryPrivate(CG, NAME, AGENT)).map(key)))
        .toEqual(new Set(finalized.privateQuads.map(key)));
    },
  );

  it.each(['marker', 'archive-root', 'archive-version', 'remaining-field', 'operation-digest',
    'head-version', 'operation-private-root', 'operation-id', 'orphan-intent', 'private-source', 'public-source', 'lifecycle-ual'])(
    'rejects invalid recovery proof: %s without changing storage (#3332)', async (damage) => {
      const { publisher, store } = await makePublisher();
      const finalized = await seedShared(publisher, store, { privateQuads: [q(ENTITY_1, 'urn:secret', '"Private"')] });
      await interruptClear(publisher, store, 4);
      const meta = contextGraphMetaUri(CG);
      const subject = contextGraphAssertionUri(CG, AGENT, NAME);
      const archive = `${subject}/_recovery_seal`;
      const privateGraph = contextGraphPrivateUri(CG);
      const swmMeta = new GraphManager(store).sharedMemoryMetaUri(CG);
      const lifecycle = assertionLifecycleUri(CG, AGENT, NAME);
      async function replace(graph: string, target: string, predicate: string, object: string) {
        await store.deleteByPattern({ graph, subject: target, predicate });
        await store.insert([q(target, predicate, object, graph)]);
      }
      if (damage === 'marker') await publisher.clearSwmShareComplete(CG, NAME, AGENT);
      if (damage === 'archive-root') await replace(privateGraph, archive, ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT, `"${'ff'.repeat(32)}"^^<http://www.w3.org/2001/XMLSchema#hexBinary>`);
      if (damage === 'archive-version') await replace(privateGraph, archive, ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION, '"2"^^<http://www.w3.org/2001/XMLSchema#integer>');
      if (damage === 'remaining-field') await replace(meta, subject, ASSERTION_SEAL_PREDICATES.AUTHOR_SCHEME_VERSION, '"2"^^<http://www.w3.org/2001/XMLSchema#integer>');
      if (damage === 'operation-digest') await store.update!(`DELETE { GRAPH <${swmMeta}> { ?s <${DKG}publicQuadsDigest> ?o } } INSERT { GRAPH <${swmMeta}> { ?s <${DKG}publicQuadsDigest> "wrong" } } WHERE { GRAPH <${swmMeta}> { ?s <${DKG}publicQuadsDigest> ?o } }`);
      if (damage === 'head-version') await replace(swmMeta, `${finalized.kaUal}#dkg-swm-head`, `${DKG}assertionVersion`, '"2"^^<http://www.w3.org/2001/XMLSchema#integer>');
      if (damage === 'operation-private-root') {
        const differentRoot = `0x${'ff'.repeat(32)}`;
        await store.update!(`DELETE { GRAPH <${swmMeta}> { ?s <${DKG}privateMerkleRoot> ?o } } INSERT { GRAPH <${swmMeta}> { ?s <${DKG}privateMerkleRoot> "${differentRoot}" } } WHERE { GRAPH <${swmMeta}> { ?s <${DKG}privateMerkleRoot> ?o } }`);
        await expect(resolveKnowledgeAssetWorkspaceHead({ store, graphManager: new GraphManager(store),
          contextGraphId: CG, kaUal: finalized.kaUal }))
          .resolves.toMatchObject({ assertionVersion: '1', privateMerkleRoot: differentRoot });
      }
      if (damage === 'operation-id') await replace(meta, lifecycle, `${DKG}shareOperationId`, '"unrelated"');
      if (damage === 'orphan-intent') {
        await store.deleteByPattern({ graph: meta, subject: lifecycle, predicate: `${DKG}shareOperationId` });
        await replace(meta, lifecycle, `${DKG}promoteOperationIntent`, '"orphan"');
      }
      if (damage === 'lifecycle-ual') await replace(meta, lifecycle, `${DKG}reservedUal`, '"invalid"');
      if (damage === 'public-source') await store.insert([q(ENTITY_1, SCHEMA, '"Tampered"', assertionScopedGraphUri(finalized.sharedGraphUri, ''))]);
      if (damage === 'private-source') {
        const privateStore = new PrivateContentStore(store, new GraphManager(store));
        await privateStore.replaceKnowledgeAssetPrivateTriples(CG, createGraphKnowledgeAssetScope(finalized.kaUal, 1), [q(ENTITY_1, 'urn:secret', '"Changed"')]);
      }
      const before = await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o');
      await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { onConflict: 'replace' })).rejects.toThrow();
      expect(await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o')).toEqual(before);
    },
  );

  it('reuses the verified SWM payload but separately validates a requested VM source (#3332)', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store);
    await interruptClear(publisher, store, 4);
    const vm = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(finalized.kaUal, 1));
    await store.insert(finalized.publicQuads.map((quad) => ({ ...quad,
      object: '"Different same-count VM payload"', graph: assertionScopedGraphUri(vm, quad.graph) })));
    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'vm')).rejects.toThrow('Merkle mismatch');
    const sourceGraph = assertionScopedGraphUri(finalized.sharedGraphUri, '');
    const reads = vi.spyOn(store, 'query');
    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm')).resolves.toMatchObject({ seededPublic: 2 });
    expect(reads.mock.calls.filter(([query]) => query.includes('CONSTRUCT') && query.includes(`GRAPH <${sourceGraph}>`))).toHaveLength(1);
  });

  it('refuses a coherent newer SWM head with the same content and a consumed lifecycle pointer (#3332)', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store);
    await interruptClear(publisher, store, 4);
    const graphManager = new GraphManager(store);
    const next = { store, graphManager, contextGraphId: CG, kaUal: finalized.kaUal,
      assertionVersion: '2', shareOperationId: 'newer-completed-share' };
    await storeKnowledgeAssetOperationPublicQuads({ ...next, quads: finalized.publicQuads, publisherPeerId: 'test-peer' });
    await storeKnowledgeAssetWorkspaceHead(next);
    const graph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, createGraphKnowledgeAssetScope(finalized.kaUal, 2));
    await store.insert(finalized.publicQuads.map((quad) => ({ ...quad, graph: assertionScopedGraphUri(graph, quad.graph) })));
    for (const predicate of [`${DKG}shareOperationId`, `${DKG}promoteOperationIntent`]) {
      await store.deleteByPattern({ graph: contextGraphMetaUri(CG), subject: assertionLifecycleUri(CG, AGENT, NAME), predicate });
    }
    await expect(resolveKnowledgeAssetWorkspaceHead({ store, graphManager, contextGraphId: CG, kaUal: finalized.kaUal }))
      .resolves.toMatchObject({ assertionVersion: '2', shareOperationId: next.shareOperationId });
    const before = await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o');
    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm')).rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
    expect(await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o')).toEqual(before);
  });

  it('recovers when the completed lifecycle operation pointer was consumed (#3332)', async () => {
    const { publisher, store } = await makePublisher();
    await seedShared(publisher, store);
    await interruptClear(publisher, store, 4);
    for (const predicate of [`${DKG}shareOperationId`, `${DKG}promoteOperationIntent`]) {
      await store.deleteByPattern({ graph: contextGraphMetaUri(CG), subject: assertionLifecycleUri(CG, AGENT, NAME), predicate });
    }
    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm')).resolves.toMatchObject({ seededPublic: 2 });
  });

  it.each(['delete', 'insert'])('retries failed archive replacement at %s without clearing the active seal (#3332)', async (stage) => {
    const { publisher, store } = await makePublisher();
    await seedShared(publisher, store);
    const archive = `${contextGraphAssertionUri(CG, AGENT, NAME)}/_recovery_seal`;
    const originalDelete = store.deleteByPatternWithoutCount.bind(store);
    const originalInsert = store.insert.bind(store);
    const fault = stage === 'delete'
      ? vi.spyOn(store, 'deleteByPatternWithoutCount').mockImplementation(async (pattern, options) => {
        if (pattern.subject === archive) throw new Error('injected archive failure');
        return originalDelete(pattern, options);
      })
      : vi.spyOn(store, 'insert').mockImplementation(async (quads, options) => {
        if (quads.some((quad) => quad.subject === archive)) throw new Error('injected archive failure');
        return originalInsert(quads, options);
      });
    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm')).rejects.toThrow('injected archive failure');
    fault.mockRestore();
    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm')).resolves.toMatchObject({ seededPublic: 2 });
  });

  it('keeps a torn seal blocked by a durable share owner until that owner succeeds (#3300, #3332)', async () => {
    const { publisher, store } = await makePublisher();
    await publisher.assertionCreate(CG, NAME, AGENT);
    await publisher.assertionWrite(CG, NAME, AGENT, [q(ENTITY_1, SCHEMA, '"Alice"')]);
    await publisher.assertionWritePrivate(CG, NAME, AGENT, [q(ENTITY_1, 'urn:secret', '"Private"')]);
    await finalizeRootlessAssertionForTest({ publisher, store, contextGraphId: CG, name: NAME, agentAddress: AGENT });
    const binding = await publisher.prepareAssertionPromoteRecovery(CG, NAME, AGENT, undefined, true);
    if ('completedResult' in binding) throw new Error('Expected a fresh share binding');
    await publisher.assertionPromote(CG, NAME, AGENT, { recoveryBinding: binding });
    await interruptClear(publisher, store, 4);
    // Model a historical torn clear alongside a persisted unfinished owner.
    const queue = new TripleStoreAsyncPromoteQueue(store);
    const job = await queue.enqueueAndClaim({ contextGraphId: CG, assertionName: NAME,
      agentAddress: AGENT, entities: 'all', recoveryBinding: binding }, 'owner');
    const restarted = new DKGPublisher({ store, chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair() });
    const before = await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o');
    await expect(restarted.assertionPullFrom(CG, NAME, AGENT, 'swm'))
      .rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED', recoveryJobId: job.jobId });
    expect(await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o')).toEqual(before);
    await queue.recordCommitMarker(job.jobId, job.lease!.claimToken, 'swmInserted');
    await queue.succeed(job.jobId, job.lease!.claimToken, { promotedCount: 0, succeededAt: Date.now() });
    await expect(restarted.assertionPullFrom(CG, NAME, AGENT, 'swm'))
      .resolves.toMatchObject({ seededPublic: 1, seededPrivate: 1 });
  });

  it('preserves conflicting drafts and ordinary mutation guards after partial clear (#3332)', async () => {
    const { publisher, store } = await makePublisher();
    await seedShared(publisher, store);
    await interruptClear(publisher, store, 4);
    await expect(publisher.assertionCreate(CG, NAME, AGENT)).rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
    await seedDirtyDraft(publisher, store, [q(ENTITY_1, SCHEMA, '"Local"')]);
    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm')).rejects.toMatchObject({ code: 'WM_DRAFT_CONFLICT' });
    expect((await publisher.assertionQuery(CG, NAME, AGENT))[0].object).toBe('"Local"');
  });

  it('re-opens the complete exact SWM graph and ignores bucket and root-row decoys', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store, {
      publicQuads: [
        q(ENTITY_1, 'urn:predicate:detail', '_:detail'),
        q('_:detail', SCHEMA, '"Alice detail"'),
        q(ENTITY_2, SCHEMA, '"Bob"'),
        q(ENTITY_3, SCHEMA, '"Carol in the same KA"'),
      ],
    });
    const lifecycle = assertionLifecycleUri(CG, AGENT, NAME);
    const meta = contextGraphMetaUri(CG);
    await store.insert([
      q('urn:e:legacy-decoy', SCHEMA, '"Legacy bucket decoy"', LEGACY_SWM_GRAPH),
      q(lifecycle, `${DKG}rootEntity`, ENTITY_1, meta),
    ]);

    const result = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');

    expect(result).toMatchObject({
      seeded: finalized.publicQuads.length,
      seededPublic: finalized.publicQuads.length,
      seededPrivate: 0,
      fromLayer: 'swm',
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: finalized.kaUal,
      assertionVersion: finalized.assertionVersion,
    });
    expect(result).not.toHaveProperty('entities');
    const draft = await publisher.assertionQuery(CG, NAME, AGENT);
    expect(new Set(draft.map(key))).toEqual(new Set(finalized.publicQuads.map(key)));
    expect(draft.some((quad) => quad.subject === 'urn:e:legacy-decoy')).toBe(false);
    const staleRoots = await store.query(
      `SELECT ?root WHERE { GRAPH <${meta}> { <${lifecycle}> <${DKG}rootEntity> ?root } }`,
    );
    expect(staleRoots.type).toBe('bindings');
    if (staleRoots.type === 'bindings') expect(staleRoots.bindings).toHaveLength(0);
  });

  it('blocks a destructive pull until a marker-less promote tail is repaired', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store);
    await publisher.clearSwmShareComplete(CG, NAME, AGENT);

    await expect(
      publisher.assertionPullFrom(CG, NAME, AGENT, 'swm'),
    ).rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
    expect(await store.hasGraph(finalized.sharedGraphUri)).toBe(true);
    expect(await publisher.assertionQuery(CG, NAME, AGENT)).toEqual([]);
  });

  it('snapshots pull options before waiting for its lifecycle lock', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store);
    const options: NonNullable<Parameters<DKGPublisher['assertionPullFrom']>[4]> = {
      onConflict: 'replace',
    };

    const pull = publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', options);
    options.subGraphName = 'mutated-after-lock-selection';

    await expect(pull).resolves.toMatchObject({
      seeded: finalized.publicQuads.length,
      fromLayer: 'swm',
    });
  });

  it('rejects a dirty public WM draft by default', async () => {
    const { publisher, store } = await makePublisher();
    await seedShared(publisher, store);
    await publisher.assertionCreate(CG, NAME, AGENT);
    await seedDirtyDraft(publisher, store, [
      q('urn:e:local', SCHEMA, '"Local edit"'),
    ]);

    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm')).rejects.toMatchObject({
      code: 'WM_DRAFT_CONFLICT',
    });
    expect(await publisher.assertionQuery(CG, NAME, AGENT)).toEqual([
      expect.objectContaining({ subject: 'urn:e:local' }),
    ]);
  });

  it('treats a private-only dirty WM draft as a conflict', async () => {
    const { publisher, store } = await makePublisher();
    await seedShared(publisher, store);
    await publisher.assertionCreate(CG, NAME, AGENT);
    await seedDirtyDraft(publisher, store, [], [
      q('urn:e:private-local', 'urn:predicate:secret', '"Local secret"'),
    ]);

    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm')).rejects.toMatchObject({
      code: 'WM_DRAFT_CONFLICT',
    });
    expect(await publisher.assertionQueryPrivate(CG, NAME, AGENT)).toHaveLength(1);
  });

  it('onConflict replace removes public named-graph and private draft residue', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store, {
      publicQuads: [q(ENTITY_2, SCHEMA, '"Bob from SWM"')],
    });
    const localNamedGraph = 'urn:test:graph:stale-local';
    await publisher.assertionCreate(CG, NAME, AGENT);
    const wmGraph = await publisher.wmGraphUri(CG, AGENT, NAME);
    const scopedLocalGraph = assertionScopedGraphUri(wmGraph, localNamedGraph);
    await seedDirtyDraft(publisher, store, [
      q(ENTITY_1, SCHEMA, '"Stale named local"', localNamedGraph),
    ]);
    await seedDirtyDraft(publisher, store, [], [
      q('urn:e:private-local', 'urn:predicate:secret', '"Stale private local"'),
    ]);
    expect(await store.listGraphs()).toContain(scopedLocalGraph);

    const result = await publisher.assertionPullFrom(
      CG,
      NAME,
      AGENT,
      'swm',
      { onConflict: 'replace' },
    );

    expect(result.seededPublic).toBe(1);
    expect(await store.listGraphs()).not.toContain(scopedLocalGraph);
    expect(await publisher.assertionQuery(CG, NAME, AGENT)).toEqual([
      expect.objectContaining({ subject: ENTITY_2, object: '"Bob from SWM"', graph: '' }),
    ]);
    expect(await publisher.assertionQueryPrivate(CG, NAME, AGENT)).toEqual([]);
    expect(await store.hasGraph(finalized.sharedGraphUri)).toBe(true);
  });

  it('validates a missing source before replacing the dirty draft', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store);
    await publisher.assertionCreate(CG, NAME, AGENT);
    await seedDirtyDraft(publisher, store, [
      q('urn:e:precious-local', SCHEMA, '"Precious local edit"'),
    ]);
    await store.dropGraph(finalized.sharedGraphUri);

    await expect(
      publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { onConflict: 'replace' }),
    ).rejects.toMatchObject({ code: 'PULL_FROM_EMPTY_SOURCE' });
    expect(await publisher.assertionQuery(CG, NAME, AGENT)).toEqual([
      expect.objectContaining({ subject: 'urn:e:precious-local' }),
    ]);
  });

  it('rejects a tampered exact source and preserves the dirty draft', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store);
    await publisher.assertionCreate(CG, NAME, AGENT);
    await seedDirtyDraft(publisher, store, [
      q('urn:e:precious-local', SCHEMA, '"Precious local edit"'),
    ]);
    await store.insert([
      q('urn:e:tampered', SCHEMA, '"Injected"', finalized.sharedGraphUri),
    ]);

    await expect(
      publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { onConflict: 'replace' }),
    ).rejects.toThrow(/triple-count mismatch/);
    expect(await publisher.assertionQuery(CG, NAME, AGENT)).toEqual([
      expect.objectContaining({ subject: 'urn:e:precious-local' }),
    ]);
  });

  it('rejects named-graph identity injected into the exact source before replacement', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store);
    await publisher.assertionCreate(CG, NAME, AGENT);
    await seedDirtyDraft(publisher, store, [
      q('urn:e:precious-local', SCHEMA, '"Precious local edit"'),
    ]);
    const tamperedNamedGraph = assertionScopedGraphUri(
      finalized.sharedGraphUri,
      'urn:test:graph:injected',
    );
    await store.insert([
      q(ENTITY_1, SCHEMA, '"Alice"', tamperedNamedGraph),
    ]);

    await expect(
      publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { onConflict: 'replace' }),
    ).rejects.toMatchObject({ code: 'KA_NAMED_GRAPH_SHARE_UNSUPPORTED' });
    expect(await publisher.assertionQuery(CG, NAME, AGENT)).toEqual([
      expect.objectContaining({ subject: 'urn:e:precious-local' }),
    ]);
  });

  it('does not reconstruct an unsealed asset from legacy member rows or a completion marker', async () => {
    const { publisher, store } = await makePublisher();
    await publisher.assertionCreate(CG, NAME, AGENT);
    const lifecycle = assertionLifecycleUri(CG, AGENT, NAME);
    await store.insert([
      q(ENTITY_1, SCHEMA, '"Legacy content"', LEGACY_SWM_GRAPH),
      q(lifecycle, `${DKG}rootEntity`, ENTITY_1, contextGraphMetaUri(CG)),
    ]);
    await publisher.markSwmShareComplete(CG, NAME, AGENT);

    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm')).rejects.toMatchObject({
      code: 'UNSEALED_PULL_FROM_BLOCKED',
    });
  });

  it('keeps legacy root-scoped KAs read-only', async () => {
    const { publisher, store } = await makePublisher();
    await store.insert([
      q(ENTITY_1, SCHEMA, '"Legacy content"', LEGACY_SWM_GRAPH),
      ...legacySeal([ENTITY_1]),
    ]);

    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm')).rejects.toMatchObject({
      code: 'LEGACY_KA_READ_ONLY',
    });
  });

  it('re-opens both public and private partitions from the same sealed scope', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store, {
      publicQuads: [q(ENTITY_1, SCHEMA, '"Public"')],
      privateQuads: [
        q(ENTITY_1, 'urn:predicate:secret', '"Private"'),
        q(ENTITY_2, 'urn:predicate:secret', '"Second private"'),
      ],
    });

    const result = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');

    expect(result).toMatchObject({
      seeded: 3,
      seededPublic: 1,
      seededPrivate: 2,
    });
    expect(new Set((await publisher.assertionQuery(CG, NAME, AGENT)).map(key)))
      .toEqual(new Set(finalized.publicQuads.map(key)));
    expect(new Set((await publisher.assertionQueryPrivate(CG, NAME, AGENT)).map(key)))
      .toEqual(new Set(finalized.privateQuads.map(key)));
  });

  it('re-opens a fully private KA without inventing a public root', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store, {
      publicQuads: [],
      privateQuads: [q(ENTITY_1, 'urn:predicate:secret', '"Private only"')],
    });

    const result = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');

    expect(result).toMatchObject({ seeded: 1, seededPublic: 0, seededPrivate: 1 });
    expect(await publisher.assertionQuery(CG, NAME, AGENT)).toEqual([]);
    expect(new Set((await publisher.assertionQueryPrivate(CG, NAME, AGENT)).map(key)))
      .toEqual(new Set(finalized.privateQuads.map(key)));
  });

  it('reads only the UAL-derived VM graph, never broad VM or data-graph decoys', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store, {
      publicQuads: [q(ENTITY_1, SCHEMA, '"Canonical VM content"')],
    });
    const scope = createGraphKnowledgeAssetScope(
      finalized.kaUal,
      finalized.assertionVersion,
    );
    const vmGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.VerifiableMemory,
      scope,
    );
    await store.insert(finalized.publicQuads.map((quad) => ({ ...quad, graph: vmGraph })));
    await store.insert([
      q('urn:e:vm-decoy', SCHEMA, '"Bare data graph decoy"', LEGACY_DATA_GRAPH),
      q('urn:e:vm-family-decoy', SCHEMA, '"Other VM decoy"', `${LEGACY_DATA_GRAPH}/_verifiable_memory/0x00000000000000000000000000000000000000ff/99`),
    ]);
    await store.dropGraph(finalized.sharedGraphUri);

    const result = await publisher.assertionPullFrom(CG, NAME, AGENT, 'vm');

    expect(result).toMatchObject({ fromLayer: 'vm', seededPublic: 1 });
    const draft = await publisher.assertionQuery(CG, NAME, AGENT);
    expect(draft).toEqual([
      expect.objectContaining({ subject: ENTITY_1, object: '"Canonical VM content"' }),
    ]);
    expect(draft.some((quad) => quad.subject.includes('decoy'))).toBe(false);
  });

  it('recovers confirmed VM v1 after finalizing and discarding an unpublished v2 edit', async () => {
    const { publisher, store } = await makePublisher();
    const v1 = await seedShared(publisher, store, {
      publicQuads: [q(ENTITY_1, SCHEMA, '"Confirmed version one"')],
    });
    const v1Scope = createGraphKnowledgeAssetScope(v1.kaUal, v1.assertionVersion);
    const vmGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.VerifiableMemory,
      v1Scope,
    );
    await store.insert(v1.publicQuads.map((quad) => ({ ...quad, graph: vmGraph })));

    const sealSubject = contextGraphAssertionUri(CG, AGENT, NAME);
    const metaGraph = contextGraphMetaUri(CG);
    const rootResult = await store.query(
      `SELECT ?root WHERE { GRAPH <${metaGraph}> {
        <${sealSubject}> <${ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT}> ?root
      } } LIMIT 1`,
    );
    const rootTerm = rootResult.type === 'bindings'
      ? rootResult.bindings[0]?.['root']
      : undefined;
    const confirmedRoot = rootTerm
      ?.replace(/^"/, '')
      .replace(/"(\^\^<[^>]+>)?$/, '');
    expect(confirmedRoot).toBeTruthy();
    const lifecycle = assertionLifecycleUri(CG, AGENT, NAME);
    await store.insert([
      q(lifecycle, `${DKG}vmCurrentAssertion`, `"${confirmedRoot}"`, metaGraph),
    ]);

    // Pulling v1 archives its seal and unlocks an editable WM draft.
    await publisher.assertionPullFrom(CG, NAME, AGENT, 'vm');
    await publisher.assertionWrite(CG, NAME, AGENT, [
      q(ENTITY_2, SCHEMA, '"Unpublished version two"'),
    ]);
    const v2 = await finalizeRootlessAssertionForTest({
      publisher,
      store,
      contextGraphId: CG,
      name: NAME,
      agentAddress: AGENT,
      assertionVersion: 2,
    });
    expect(v2.publicQuads).toHaveLength(2);

    await publisher.assertionDiscard(CG, NAME, AGENT);
    const reopened = await publisher.assertionPullFrom(CG, NAME, AGENT, 'vm');

    expect(reopened).toMatchObject({
      kaUal: v1.kaUal,
      assertionVersion: v1.assertionVersion,
      seededPublic: v1.publicQuads.length,
    });
    expect(new Set((await publisher.assertionQuery(CG, NAME, AGENT)).map(key)))
      .toEqual(new Set(v1.publicQuads.map(key)));
    expect((await publisher.assertionQuery(CG, NAME, AGENT))
      .some((quad) => quad.object === '"Unpublished version two"')).toBe(false);
  });

  it('retains a durable SWM recovery seal across pull and draft discard', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store);

    await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');
    await publisher.assertionDiscard(CG, NAME, AGENT);
    const reopened = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');

    expect(reopened).toMatchObject({
      kaUal: finalized.kaUal,
      assertionVersion: finalized.assertionVersion,
      seededPublic: finalized.publicQuads.length,
    });
    expect(new Set((await publisher.assertionQuery(CG, NAME, AGENT)).map(key)))
      .toEqual(new Set(finalized.publicQuads.map(key)));
  });

  it('retains private commitments and content across SWM pull, discard, and reopen', async () => {
    const { publisher, store } = await makePublisher();
    const finalized = await seedShared(publisher, store, {
      publicQuads: [q(ENTITY_1, SCHEMA, '"Public recovery content"')],
      privateQuads: [
        q(ENTITY_1, 'urn:predicate:secret', '"Private recovery content"'),
        q(ENTITY_2, 'urn:predicate:secret', '"Second private recovery content"'),
      ],
    });

    await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');
    await publisher.assertionDiscard(CG, NAME, AGENT);
    const reopened = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');

    expect(reopened).toMatchObject({
      kaUal: finalized.kaUal,
      assertionVersion: finalized.assertionVersion,
      seededPrivate: finalized.privateQuads.length,
    });
    expect(new Set((await publisher.assertionQueryPrivate(CG, NAME, AGENT)).map(key)))
      .toEqual(new Set(finalized.privateQuads.map(key)));
  });

  it('keeps a sub-graph recovery seal inside its private partition across pull and discard', async () => {
    const { publisher, store } = await makePublisher();
    const subGraphName = 'code';
    await registerSubGraph(store, subGraphName);
    const finalized = await seedShared(publisher, store, {
      subGraphName,
      publicQuads: [q(ENTITY_1, SCHEMA, '"Sub-graph content"')],
    });

    await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { subGraphName });
    await publisher.assertionDiscard(CG, NAME, AGENT, subGraphName);
    const reopened = await publisher.assertionPullFrom(
      CG,
      NAME,
      AGENT,
      'swm',
      { subGraphName },
    );

    expect(reopened).toMatchObject({
      kaUal: finalized.kaUal,
      assertionVersion: finalized.assertionVersion,
      seededPublic: finalized.publicQuads.length,
    });
    expect(new Set((await publisher.assertionQuery(CG, NAME, AGENT, subGraphName)).map(key)))
      .toEqual(new Set(finalized.publicQuads.map(key)));

    const sealSubject = contextGraphAssertionUri(CG, AGENT, NAME, subGraphName);
    const recoverySubject = `${sealSubject}/_recovery_seal`;
    const recoveryPredicate = ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT;
    const subGraphPrivate = await store.query(
      `ASK { GRAPH <${contextGraphSubGraphPrivateUri(CG, subGraphName)}> {
        <${recoverySubject}> <${recoveryPredicate}> ?root
      } }`,
    );
    expect(subGraphPrivate).toMatchObject({ type: 'boolean', value: true });

    const leakedToRootPrivate = await store.query(
      `ASK { GRAPH <${contextGraphPrivateUri(CG)}> {
        <${recoverySubject}> <${recoveryPredicate}> ?root
      } }`,
    );
    expect(leakedToRootPrivate).toMatchObject({ type: 'boolean', value: false });

    const leakedToRootMeta = await store.query(
      `ASK { GRAPH <${contextGraphMetaUri(CG)}> {
        <${recoverySubject}> <${recoveryPredicate}> ?root
      } }`,
    );
    expect(leakedToRootMeta).toMatchObject({ type: 'boolean', value: false });
  });

  it('archives the source seal while leaving the active draft unlocked for re-finalization', async () => {
    const { publisher, store } = await makePublisher();
    const first = await seedShared(publisher, store);

    await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');
    const sealSubject = contextGraphAssertionUri(CG, AGENT, NAME);
    const meta = contextGraphMetaUri(CG);
    const sealed = await store.query(
      `ASK { GRAPH <${meta}> {
        <${sealSubject}> <${ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT}> ?root
      } }`,
    );
    expect(sealed.type === 'boolean' && sealed.value).toBe(false);
    const recoverySubject = `${sealSubject}/_recovery_seal`;
    const recoverySeal = await store.query(
      `ASK { GRAPH <${contextGraphPrivateUri(CG)}> {
        <${recoverySubject}> <${ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT}> ?root
      } }`,
    );
    expect(recoverySeal).toMatchObject({ type: 'boolean', value: true });
    const leakedRecoverySeal = await store.query(
      `ASK { GRAPH <${meta}> {
        <${recoverySubject}> <${ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT}> ?root
      } }`,
    );
    expect(leakedRecoverySeal).toMatchObject({ type: 'boolean', value: false });
    await publisher.assertionWrite(CG, NAME, AGENT, [
      q('urn:e:new-version', SCHEMA, '"Version two"'),
    ]);
    const second = await finalizeRootlessAssertionForTest({
      publisher,
      store,
      contextGraphId: CG,
      name: NAME,
      agentAddress: AGENT,
      assertionVersion: 2,
    });

    expect(second.kaUal).toBe(first.kaUal);
    expect(second.assertionVersion).toBe('2');
    expect(second.publicQuads.some((quad) => quad.subject === 'urn:e:new-version')).toBe(true);
  });
});
