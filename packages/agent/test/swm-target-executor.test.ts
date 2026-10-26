import { resolvePrivateSwmRecoveryBudgetMs } from '../src/sync/requester/private-swm-recovery-budget.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  DKG_ENTITY,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
  createGraphKnowledgeAssetScope,
  createOperationContext,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  generateKnowledgeAssetShareMetadata,
  workspacePublicQuadsDigest,
  type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import type { FinalizedSwmTwinRetirement } from
  '../src/sync/requester/finalized-swm-twin-reconciliation.js';
import {
  SwmTargetExecutorSessionFactoryV1,
  SwmTargetExecutorV1,
  type SwmTargetExecutorPortsV1,
} from '../src/sync/requester/swm-target-executor.js';
import { createSwmRecoveryMutationRuntimeV1 } from
  '../src/sync/requester/swm-recovery-apply.js';

describe('SwmTargetExecutorV1 private recovery wiring', () => {
  const stores: OxigraphStore[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  it.each([
    { limit: 'job window', budgetMs: 50, roundMs: 500, outcome: 'local_yield' },
    { limit: 'round deadline', budgetMs: 500, roundMs: 50, outcome: 'timed_out' },
    { limit: 'initial round only', budgetMs: 0, roundMs: 50, outcome: 'timed_out' },
    { limit: 'legacy omitted budget port', budgetMs: undefined, roundMs: 50, outcome: 'timed_out' },
  ])('pins authorization, lease signal and $limit on private page fetches', async ({ budgetMs, roundMs, outcome }) => {
    let elapsedMs = 0;
    const startedAt = Date.now();
    vi.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
    vi.spyOn(Date, 'now').mockImplementation(() => startedAt + elapsedMs);
    const store = new OxigraphStore();
    stores.push(store);
    const controller = new AbortController();
    const fetchSyncPages = vi.fn<SwmTargetExecutorPortsV1['fetchSyncPages']>(
      async (_ctx, _peerId, _contextGraphId, _includeSharedMemory, phase) => ({
        quads: [],
        bytesReceived: 0,
        timedOut: false,
        resumedFromOffset: 0,
        nextOffset: 0,
        checkpointKey: `private:${phase}`,
        completed: true,
      }),
    );
    const executor = new SwmTargetExecutorV1({
      ...(budgetMs === undefined ? {} : { privateRecoveryBudgetMs: budgetMs }),
      store,
      writeLocks: new Map(),
      listSubGraphs: async () => [],
      createContextGraphSyncDeadline: () => startedAt + roundMs,
      fetchSyncPages,
      processSharedMemoryBatch: async () => ({
        verifiedData: [],
        verifiedMeta: [],
        totalFetchedDataQuads: 0,
        totalFetchedMetaQuads: 0,
        droppedDataTriples: 0,
        emptyResponses: 0,
        entityCreators: [],
      }),
      recordDrops: () => undefined,
      invalidateListContextGraphsCache: () => undefined,
      recoveryMutation: createSwmRecoveryMutationRuntimeV1({
        store,
        recordDrops: () => undefined,
        invalidateListContextGraphsCache: () => undefined,
      }),
      setCheckpoint: () => undefined,
      deleteCheckpoint: () => undefined,
      deletePublicCheckpoint: () => undefined,
      ensureOwnedMap: () => new Map(),
      retireFinalizedSwmTwin: async () => undefined,
      logInfo: () => undefined,
      logWarn: () => undefined,
      logDebug: () => undefined,
    });

    await expect(executor.recoverPrivateTarget({
      remotePeerId: '12D3KooWCompletePrivateProvider',
      contextGraphId: 'private-rfc64-context-graph',
      recoveryGuard: {
        signal: controller.signal,
        assertCurrent: () => undefined,
      },
    })).resolves.toMatchObject({ completed: true });

    expect(fetchSyncPages).toHaveBeenCalled();
    for (const call of fetchSyncPages.mock.calls) {
      expect(call[7]).toMatchObject({
        recovery: true,
        signal: controller.signal,
      });
      // The composed capability owns both bounds at the transport boundary.
      expect(call[7]?.workAdmission?.capTimeout(1_000)).toBe(50);
    }
    elapsedMs = 20;
    for (const call of fetchSyncPages.mock.calls) {
      expect(call[7]?.workAdmission?.capTimeout(1_000)).toBe(30);
      expect(call[7]?.workAdmission?.capTimeout(7)).toBe(7);
    }
    elapsedMs = 51;
    for (const call of fetchSyncPages.mock.calls) {
      const work = call[7]!.workAdmission!;
      expect(work.canAdmitWork()).toBe(false);
      expect(work.capTimeout(1_000)).toBe(0);
      expect(() => work.assertCurrent()).toThrowError(expect.objectContaining({ outcome }));
    }
  });

  it('replaces stale root state and hydrates fresh metadata and ownership', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const contextGraphId = 'private-rfc64-executor-integrity';
    const dataGraph = contextGraphWorkspaceGraphUri(contextGraphId);
    const metaGraph = contextGraphWorkspaceMetaGraphUri(contextGraphId);
    const entity = 'urn:dkg:test:private-recovery-root';
    const status = 'http://schema.org/status';
    const staleOperation = 'urn:dkg:test:stale-operation';
    const freshOperation = 'urn:dkg:test:fresh-operation';
    const creator = '0x1111111111111111111111111111111111111111';
    const shareOperationId = 'http://dkg.io/ontology/shareOperationId';
    const freshData = [{
      subject: entity,
      predicate: status,
      object: '"fresh"',
      graph: dataGraph,
    }];
    const freshMeta = [
      {
        subject: freshOperation,
        predicate: DKG_ENTITY,
        object: entity,
        graph: metaGraph,
      },
      {
        subject: freshOperation,
        predicate: shareOperationId,
        object: '"fresh-id"',
        graph: metaGraph,
      },
    ];
    await store.insert([
      {
        subject: entity,
        predicate: status,
        object: '"stale"',
        graph: dataGraph,
      },
      {
        subject: staleOperation,
        predicate: DKG_ENTITY,
        object: entity,
        graph: metaGraph,
      },
      {
        subject: staleOperation,
        predicate: shareOperationId,
        object: '"stale-id"',
        graph: metaGraph,
      },
    ]);

    const ownership = new Map<string, Map<string, string>>();
    const ensureOwnedMap = (key: string): Map<string, string> => {
      let owned = ownership.get(key);
      if (owned === undefined) {
        owned = new Map();
        ownership.set(key, owned);
      }
      return owned;
    };
    const executor = new SwmTargetExecutorV1({
      privateRecoveryBudgetMs: resolvePrivateSwmRecoveryBudgetMs(),
      store,
      writeLocks: new Map(),
      listSubGraphs: async () => [],
      createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (
        _ctx,
        _peerId,
        _contextGraphId,
        _includeSharedMemory,
        phase,
      ) => {
        const quads = phase === 'meta' ? freshMeta : phase === 'data' ? freshData : [];
        return {
          quads,
          bytesReceived: 0,
        timedOut: false,
          resumedFromOffset: 0,
          nextOffset: quads.length,
          checkpointKey: `private:${phase}`,
          completed: true,
        };
      },
      processSharedMemoryBatch: async (dataQuads, metaQuads) => ({
        verifiedData: dataQuads,
        verifiedMeta: metaQuads,
        totalFetchedDataQuads: dataQuads.length,
        totalFetchedMetaQuads: metaQuads.length,
        droppedDataTriples: 0,
        emptyResponses: 0,
        entityCreators: [{ dataGraph, entity, creator }],
      }),
      recordDrops: () => undefined,
      invalidateListContextGraphsCache: () => undefined,
      recoveryMutation: createSwmRecoveryMutationRuntimeV1({
        store,
        recordDrops: () => undefined,
        invalidateListContextGraphsCache: () => undefined,
      }),
      setCheckpoint: () => undefined,
      deleteCheckpoint: () => undefined,
      deletePublicCheckpoint: () => undefined,
      ensureOwnedMap,
      retireFinalizedSwmTwin: async () => undefined,
      logInfo: () => undefined,
      logWarn: () => undefined,
      logDebug: () => undefined,
    });

    await expect(executor.recoverPrivateTarget({
      remotePeerId: '12D3KooWCompletePrivateProvider',
      contextGraphId,
    })).resolves.toMatchObject({
      completed: true,
      replacedRoots: 1,
      insertedDataQuads: 1,
      insertedMetaQuads: 2,
    });

    const data = await store.query(
      `SELECT ?o WHERE { GRAPH <${dataGraph}> { <${entity}> <${status}> ?o } }`,
    );
    expect(data.type === 'bindings' ? data.bindings.map((row) => row['o']) : [])
      .toEqual(['"fresh"']);
    const staleMeta = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${metaGraph}> { <${staleOperation}> ?p ?o } }`,
    );
    expect(staleMeta.type === 'bindings' ? staleMeta.bindings : []).toHaveLength(0);
    const currentMeta = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${metaGraph}> { <${freshOperation}> ?p ?o } }`,
    );
    expect(currentMeta.type === 'bindings' ? currentMeta.bindings : []).toHaveLength(2);
    expect(ownership.get(contextGraphId)?.get(entity)).toBe(creator);
  });
});

describe('SwmTargetExecutorV1 public finalized-twin wiring', () => {
  const stores: OxigraphStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  it('keeps retired SWM metadata out of the bulk append when legacy marker retirement fails', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const contextGraphId = 'public-finalized-twin-marker-deferral';
    const author = '0x1111111111111111111111111111111111111111';
    const ual = `did:dkg:hardhat:31337/${author}/7`;
    const dkg = 'http://dkg.io/ontology/';
    const xsdInteger = 'http://www.w3.org/2001/XMLSchema#integer';
    const scope = createGraphKnowledgeAssetScope(ual, 1);
    const vmGraph = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.VerifiableMemory, scope);
    const swmGraph = knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.SharedWorkingMemory,
      scope,
    );
    const vmMetaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
    const swmMetaGraph = contextGraphWorkspaceMetaGraphUri(contextGraphId);
    const shareOperationId = 'finalized-twin-marker-deferral-op';
    const operationSubject = `urn:dkg:share:${contextGraphId}:${shareOperationId}`;
    const headSubject = `${ual}#dkg-swm-head`;
    const payload: Quad[] = [
      { subject: 'urn:twin:a', predicate: 'http://schema.org/status', object: '"finalized"', graph: '' },
      { subject: 'urn:twin:b', predicate: 'http://schema.org/status', object: '"finalized"', graph: '' },
    ];
    const digest = workspacePublicQuadsDigest(payload);
    // Finalized VM is already local: the SWM snapshot below arrives second.
    await store.insert([
      ...payload.map((quad) => ({ ...quad, graph: vmGraph })),
      { subject: ual, predicate: `${dkg}assertionVersion`, object: `"1"^^<${xsdInteger}>`, graph: vmMetaGraph },
      { subject: ual, predicate: `${dkg}assertionGraph`, object: vmGraph, graph: vmMetaGraph },
      { subject: ual, predicate: `${dkg}status`, object: '"confirmed"', graph: vmMetaGraph },
      { subject: ual, predicate: `${dkg}publicTripleCount`, object: `"${payload.length}"^^<${xsdInteger}>`, graph: vmMetaGraph },
      { subject: ual, predicate: `${dkg}privateTripleCount`, object: `"0"^^<${xsdInteger}>`, graph: vmMetaGraph },
      {
        subject: ual,
        predicate: `${dkg}merkleRoot`,
        object: `"${ethers.hexlify(computeFlatKCRootV10(payload, []))}"`,
        graph: vmMetaGraph,
      },
    ]);
    const remoteMeta: Quad[] = [
      ...generateKnowledgeAssetShareMetadata({
        shareOperationId,
        contextGraphId,
        kaUal: ual,
        assertionVersion: 1,
        publicTripleCount: payload.length,
        privateTripleCount: 0,
        publisherPeerId: 'peer-source',
        timestamp: new Date(0),
      }, swmMetaGraph),
      { subject: operationSubject, predicate: `${dkg}publicQuadsDigest`, object: `"${digest}"`, graph: swmMetaGraph },
      { subject: operationSubject, predicate: `${dkg}publicSnapshotRef`, object: `"${digest}"`, graph: swmMetaGraph },
      { subject: headSubject, predicate: `${dkg}contentScopeVersion`, object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${xsdInteger}>`, graph: swmMetaGraph },
      { subject: headSubject, predicate: `${dkg}kaUal`, object: ual, graph: swmMetaGraph },
      { subject: headSubject, predicate: `${dkg}assertionVersion`, object: `"1"^^<${xsdInteger}>`, graph: swmMetaGraph },
      { subject: headSubject, predicate: `${dkg}assertionGraph`, object: swmGraph, graph: swmMetaGraph },
      { subject: headSubject, predicate: `${dkg}shareOperationId`, object: `"${shareOperationId}"`, graph: swmMetaGraph },
    ];
    const snapshots = new Map<string, Quad[]>([[digest, payload]]);
    const publicSnapshotStore: WorkspacePublicSnapshotStore = {
      putSnapshot: async (input) => {
        snapshots.set(input.digest, input.quads.map((quad) => ({ ...quad })));
        return { ref: input.digest, byteLength: 0 };
      },
      getSnapshot: async (ref) => snapshots.get(ref)?.map((quad) => ({ ...quad })) ?? null,
    };
    const subjectRows = async (subject: string) => {
      const result = await store.query(
        `SELECT ?p ?o WHERE { GRAPH <${swmMetaGraph}> { <${subject}> ?p ?o } }`,
      );
      return result.type === 'bindings' ? result.bindings : [];
    };
    const swmRowsWhenRetired: number[] = [];
    // Stand-in for the publisher's named-lifecycle cleanup: graph, then head and operation.
    const retireFinalizedSwmTwin = vi.fn(async (candidate: FinalizedSwmTwinRetirement) => {
      swmRowsWhenRetired.push(
        await store.countQuads(candidate.swmGraph),
        (await subjectRows(headSubject)).length,
      );
      await store.dropGraph(candidate.swmGraph);
      await store.deleteByPattern({ graph: swmMetaGraph, subject: headSubject });
      await store.deleteByPattern({ graph: swmMetaGraph, subject: operationSubject });
    });
    const invalidateListContextGraphsCache = vi.fn();
    let invalidationsBeforeMarkerRetirement = -1;
    const retireLegacySwmAfterVerifiedVmTwin = vi.fn(async () => {
      invalidationsBeforeMarkerRetirement = invalidateListContextGraphsCache.mock.calls.length;
      throw new Error('legacy boundary store unavailable');
    });
    const logInfo = vi.fn();
    const logWarn = vi.fn();
    const ctx = createOperationContext('sync');
    const executor = new SwmTargetExecutorV1({
      store,
      writeLocks: new Map(),
      listSubGraphs: async () => [],
      createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (
        _ctx,
        _peerId,
        _contextGraphId,
        _includeSharedMemory,
        phase,
      ) => {
        const quads = phase === 'meta' ? remoteMeta.map((quad) => ({ ...quad })) : [];
        return {
          quads,
          bytesReceived: 0,
          timedOut: false,
          resumedFromOffset: 0,
          nextOffset: quads.length,
          checkpointKey: `public:${phase}`,
          completed: true,
        };
      },
      processSharedMemoryBatch: async (dataQuads, metaQuads) => ({
        verifiedData: dataQuads,
        verifiedMeta: metaQuads,
        totalFetchedDataQuads: dataQuads.length,
        totalFetchedMetaQuads: metaQuads.length,
        droppedDataTriples: 0,
        emptyResponses: 0,
        entityCreators: [],
      }),
      publicSnapshotStore,
      recordDrops: () => undefined,
      invalidateListContextGraphsCache,
      recoveryMutation: createSwmRecoveryMutationRuntimeV1({
        store,
        recordDrops: () => undefined,
        invalidateListContextGraphsCache: () => undefined,
      }),
      setCheckpoint: () => undefined,
      deleteCheckpoint: () => undefined,
      deletePublicCheckpoint: () => undefined,
      ensureOwnedMap: () => new Map(),
      retireFinalizedSwmTwin,
      retireLegacySwmAfterVerifiedVmTwin,
      logInfo,
      logWarn,
      logDebug: () => undefined,
    });

    const summary = await executor.syncPublicTarget({
      ctx,
      remotePeerId: 'peer-source',
      contextGraphId,
      remainingContextGraphs: 1,
      mode: { kind: 'ordinary' },
    });

    expect(summary.failedPhases).toBe(0);
    // The snapshot was materialized with its head, then the twin was retired.
    expect(retireFinalizedSwmTwin).toHaveBeenCalledOnce();
    expect(swmRowsWhenRetired).toEqual([payload.length, 5]);
    expect(retireLegacySwmAfterVerifiedVmTwin).toHaveBeenCalledExactlyOnceWith({
      contextGraphId,
      kaUal: ual,
      assertionVersion: '1',
      subGraphName: undefined,
    });
    // The round's closing bulk append must not put the retired rows back.
    expect(await store.countQuads(swmGraph)).toBe(0);
    expect(await subjectRows(headSubject)).toEqual([]);
    expect(await subjectRows(operationSubject)).toEqual([]);
    expect(await store.countQuads(vmGraph)).toBe(payload.length);
    // The retirement itself is still completed and reported; only the marker is deferred.
    expect(invalidateListContextGraphsCache.mock.calls.length)
      .toBeGreaterThan(invalidationsBeforeMarkerRetirement);
    expect(logInfo).toHaveBeenCalledWith(
      ctx,
      `Retired byte-identical SWM twin after SWM recovery found finalized VM for ${ual}`,
    );
    expect(logWarn).toHaveBeenCalledWith(
      ctx,
      expect.stringMatching(/legacy SWM boundary.*legacy boundary store unavailable/),
    );
  });

  /**
   * A finalized asset whose shared-memory snapshot a peer still serves: VM is
   * local with the same bytes, so a round writes the snapshot and retires it.
   * `retireMarker` undefined: the node has no legacy marker lane.
   */
  async function finalizedTwinRounds(
    contextGraphId: string,
    options: {
      readonly retireMarker?: () => Promise<void>;
      readonly markerOutstanding?: () => boolean;
    } = {},
  ) {
    const store = new OxigraphStore();
    stores.push(store);
    const ual = `did:dkg:hardhat:31337/0x2222222222222222222222222222222222222222/9`;
    const dkg = 'http://dkg.io/ontology/';
    const xsdInteger = 'http://www.w3.org/2001/XMLSchema#integer';
    const scope = createGraphKnowledgeAssetScope(ual, 1);
    const vmGraph = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.VerifiableMemory, scope);
    const swmGraph = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.SharedWorkingMemory, scope);
    const vmMetaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
    const swmMetaGraph = contextGraphWorkspaceMetaGraphUri(contextGraphId);
    const shareOperationId = `${contextGraphId}-op`;
    const operationSubject = `urn:dkg:share:${contextGraphId}:${shareOperationId}`;
    const headSubject = `${ual}#dkg-swm-head`;
    const payload: Quad[] = [
      { subject: 'urn:twin:c', predicate: 'http://schema.org/status', object: '"finalized"', graph: '' },
    ];
    const digest = workspacePublicQuadsDigest(payload);
    await store.insert([
      ...payload.map((quad) => ({ ...quad, graph: vmGraph })),
      { subject: ual, predicate: `${dkg}assertionVersion`, object: `"1"^^<${xsdInteger}>`, graph: vmMetaGraph },
      { subject: ual, predicate: `${dkg}assertionGraph`, object: vmGraph, graph: vmMetaGraph },
      { subject: ual, predicate: `${dkg}status`, object: '"confirmed"', graph: vmMetaGraph },
      { subject: ual, predicate: `${dkg}publicTripleCount`, object: `"${payload.length}"^^<${xsdInteger}>`, graph: vmMetaGraph },
      { subject: ual, predicate: `${dkg}privateTripleCount`, object: `"0"^^<${xsdInteger}>`, graph: vmMetaGraph },
      {
        subject: ual,
        predicate: `${dkg}merkleRoot`,
        object: `"${ethers.hexlify(computeFlatKCRootV10(payload, []))}"`,
        graph: vmMetaGraph,
      },
    ]);
    const remoteMeta: Quad[] = [
      ...generateKnowledgeAssetShareMetadata({
        shareOperationId,
        contextGraphId,
        kaUal: ual,
        assertionVersion: 1,
        publicTripleCount: payload.length,
        privateTripleCount: 0,
        publisherPeerId: 'peer-source',
        timestamp: new Date(0),
      }, swmMetaGraph),
      { subject: operationSubject, predicate: `${dkg}publicQuadsDigest`, object: `"${digest}"`, graph: swmMetaGraph },
      { subject: operationSubject, predicate: `${dkg}publicSnapshotRef`, object: `"${digest}"`, graph: swmMetaGraph },
      { subject: headSubject, predicate: `${dkg}contentScopeVersion`, object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${xsdInteger}>`, graph: swmMetaGraph },
      { subject: headSubject, predicate: `${dkg}kaUal`, object: ual, graph: swmMetaGraph },
      { subject: headSubject, predicate: `${dkg}assertionVersion`, object: `"1"^^<${xsdInteger}>`, graph: swmMetaGraph },
      { subject: headSubject, predicate: `${dkg}assertionGraph`, object: swmGraph, graph: swmMetaGraph },
      { subject: headSubject, predicate: `${dkg}shareOperationId`, object: `"${shareOperationId}"`, graph: swmMetaGraph },
    ];
    const snapshots = new Map<string, Quad[]>([[digest, payload]]);
    const retireFinalizedSwmTwin = vi.fn(async (candidate: FinalizedSwmTwinRetirement) => {
      await store.dropGraph(candidate.swmGraph);
      await store.deleteByPattern({ graph: swmMetaGraph, subject: headSubject });
      await store.deleteByPattern({ graph: swmMetaGraph, subject: operationSubject });
    });
    const logInfo = vi.fn();
    const logWarn = vi.fn();
    const ctx = createOperationContext('sync');
    const ports: SwmTargetExecutorPortsV1 = {
      store,
      writeLocks: new Map(),
      listSubGraphs: async () => [],
      createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (_ctx, _peerId, _contextGraphId, _includeSharedMemory, phase) => {
        const quads = phase === 'meta' ? remoteMeta.map((quad) => ({ ...quad })) : [];
        return {
          quads,
          bytesReceived: 0,
          timedOut: false,
          resumedFromOffset: 0,
          nextOffset: quads.length,
          checkpointKey: `public:${phase}`,
          completed: true,
        };
      },
      processSharedMemoryBatch: async (dataQuads, metaQuads) => ({
        verifiedData: dataQuads,
        verifiedMeta: metaQuads,
        totalFetchedDataQuads: dataQuads.length,
        totalFetchedMetaQuads: metaQuads.length,
        droppedDataTriples: 0,
        emptyResponses: 0,
        entityCreators: [],
      }),
      publicSnapshotStore: {
        putSnapshot: async (input) => {
          snapshots.set(input.digest, input.quads.map((quad) => ({ ...quad })));
          return { ref: input.digest, byteLength: 0 };
        },
        getSnapshot: async (ref) => snapshots.get(ref)?.map((quad) => ({ ...quad })) ?? null,
      },
      recordDrops: () => undefined,
      invalidateListContextGraphsCache: () => undefined,
      recoveryMutation: createSwmRecoveryMutationRuntimeV1({
        store,
        recordDrops: () => undefined,
        invalidateListContextGraphsCache: () => undefined,
      }),
      setCheckpoint: () => undefined,
      deleteCheckpoint: () => undefined,
      deletePublicCheckpoint: () => undefined,
      ensureOwnedMap: () => new Map(),
      retireFinalizedSwmTwin,
      ...(options.retireMarker === undefined ? {} : { retireLegacySwmAfterVerifiedVmTwin: options.retireMarker }),
      ...(options.markerOutstanding === undefined ? {} : { hasOutstandingLegacySwmMarker: options.markerOutstanding }),
      logInfo,
      logWarn,
      logDebug: () => undefined,
    };
    const sessions = new SwmTargetExecutorSessionFactoryV1(ports);
    // Each round is a catch-up job's own session, as on a node.
    const round = () => sessions.createSession().syncPublicTarget({
      ctx,
      remotePeerId: 'peer-source',
      contextGraphId,
      remainingContextGraphs: 1,
      mode: { kind: 'ordinary' },
    });
    // A share that brings the copy back: graph, head and operation, as its apply writes them.
    const shareAgain = () => store.insert([
      ...payload.map((quad) => ({ ...quad, graph: swmGraph })),
      ...remoteMeta,
    ]);
    // A later publication finalized another version: VM metadata moved on, its graph name did not.
    const finalizeLaterVersion = async () => {
      await store.deleteByPattern({ graph: vmMetaGraph, subject: ual, predicate: `${dkg}assertionVersion` });
      await store.insert([
        { subject: ual, predicate: `${dkg}assertionVersion`, object: `"2"^^<${xsdInteger}>`, graph: vmMetaGraph },
      ]);
    };
    return {
      store, payload, vmGraph, swmGraph, retireFinalizedSwmTwin, logInfo, logWarn, ctx, round, shareAgain,
      finalizeLaterVersion,
    };
  }
  type FinalizedTwinRounds = Awaited<ReturnType<typeof finalizedTwinRounds>>;
  const loggedTimes = (log: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }, text: string) => (
    log.mock.calls.filter(([, message]) => String(message).includes(text)).length
  );

  it.each([
    ['done', { retireMarker: async () => undefined }],
    // The proof does not wait on the marker: its cleanup has a lifecycle of its own.
    ['failed', { retireMarker: async () => { throw new Error('legacy boundary store unavailable'); } }],
    ['no-lane', {}],
  ] as const)('writes nothing in a later round for a snapshot it retired as a finalized twin (marker %s)', async (label, options) => {
    const rounds = await finalizedTwinRounds(`public-finalized-twin-remembered-${label}`, options);
    expect((await rounds.round()).failedPhases).toBe(0);
    expect(rounds.retireFinalizedSwmTwin).toHaveBeenCalledOnce();

    const later = await rounds.round();
    expect(later.failedPhases).toBe(0);
    expect(later.alreadyHeldAssets).toBe(1);
    expect(later.swmCoverage).toMatchObject({ snapshotsResolved: 1, snapshotsTotal: 1, missingCount: 0 });
    // Not written and retired a second time: the copy stays gone, VM stays whole.
    expect(rounds.retireFinalizedSwmTwin).toHaveBeenCalledOnce();
    expect(await rounds.store.countQuads(rounds.swmGraph)).toBe(0);
    expect(await rounds.store.countQuads(rounds.vmGraph)).toBe(rounds.payload.length);
    expect(rounds.logInfo).toHaveBeenCalledWith(
      rounds.ctx,
      expect.stringContaining('1 snapshot(s) already retired here as finalized Verified Memory twins'),
    );
  });

  it('retires a copy a share brought back as it holds the twin, and writes nothing', async () => {
    const rounds = await finalizedTwinRounds('public-finalized-twin-shared-again');
    await rounds.round();
    expect(rounds.retireFinalizedSwmTwin).toHaveBeenCalledOnce();

    await rounds.shareAgain();
    expect(await rounds.store.countQuads(rounds.swmGraph)).toBe(rounds.payload.length);
    // The proof that holds the twin finds the copy back, and retires it.
    expect((await rounds.round()).alreadyHeldAssets).toBe(1);
    expect(loggedTimes(rounds.logInfo, 'already retired here as finalized Verified Memory twins')).toBe(1);
    expect(loggedTimes(rounds.logInfo, 'Retired byte-identical SWM twin')).toBe(2);
    expect(rounds.retireFinalizedSwmTwin).toHaveBeenCalledTimes(2);
    expect(await rounds.store.countQuads(rounds.swmGraph)).toBe(0);

    // Its head and operation rows stayed out of the round's writes: a third round finds nothing to retire.
    expect((await rounds.round()).alreadyHeldAssets).toBe(1);
    expect(rounds.retireFinalizedSwmTwin).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['its graph dropped', (rounds: FinalizedTwinRounds) => rounds.store.dropGraph(rounds.vmGraph)],
    ['a later version finalized', (rounds: FinalizedTwinRounds) => rounds.finalizeLaterVersion()],
  ] as const)('takes the snapshot again once Verified Memory no longer proves the retirement (%s)', async (label, change) => {
    const rounds = await finalizedTwinRounds(`public-finalized-twin-vm-${label.replace(/ /g, '-')}`);
    await rounds.round();
    expect(rounds.retireFinalizedSwmTwin).toHaveBeenCalledOnce();
    expect(await rounds.store.countQuads(rounds.swmGraph)).toBe(0);

    await change(rounds);
    const later = await rounds.round();
    // Not held: the round wrote the snapshot back, and its own proof keeps the copy.
    expect(later.failedPhases).toBe(0);
    expect(later.alreadyHeldAssets).toBe(0);
    expect(loggedTimes(rounds.logInfo, 'already retired here as finalized Verified Memory twins')).toBe(0);
    expect(await rounds.store.countQuads(rounds.swmGraph)).toBe(rounds.payload.length);
    expect(rounds.retireFinalizedSwmTwin).toHaveBeenCalledOnce();
  });

  it('takes the snapshot the usual way when the proof that would hold it cannot run', async () => {
    const rounds = await finalizedTwinRounds('public-finalized-twin-proof-failed');
    await rounds.round();
    await rounds.shareAgain();
    rounds.retireFinalizedSwmTwin.mockImplementationOnce(async () => {
      throw new Error('store unavailable');
    });

    const later = await rounds.round();
    expect(later.failedPhases).toBe(0);
    expect(loggedTimes(rounds.logWarn, 'its proof did not run: store unavailable')).toBe(1);
    expect(loggedTimes(rounds.logInfo, 'already retired here as finalized Verified Memory twins')).toBe(0);
    // The usual way proved the twin and retired the copy, and remembered it: a third round holds it.
    expect(rounds.retireFinalizedSwmTwin).toHaveBeenCalledTimes(3);
    expect(await rounds.store.countQuads(rounds.swmGraph)).toBe(0);
    expect((await rounds.round()).alreadyHeldAssets).toBe(1);
    expect(rounds.retireFinalizedSwmTwin).toHaveBeenCalledTimes(3);
  });

  it.each([
    [true, 2],
    [false, 1],
  ] as const)('retries the legacy marker while it holds the twin only when one is outstanding (%s)', async (outstanding, calls) => {
    const retireMarker = vi.fn(async () => undefined);
    const rounds = await finalizedTwinRounds(`public-finalized-twin-marker-outstanding-${outstanding}`, {
      retireMarker,
      markerOutstanding: () => outstanding,
    });
    await rounds.round();
    expect(retireMarker).toHaveBeenCalledOnce();

    expect((await rounds.round()).alreadyHeldAssets).toBe(1);
    expect(rounds.retireFinalizedSwmTwin).toHaveBeenCalledOnce();
    expect(retireMarker).toHaveBeenCalledTimes(calls);
  });
});
