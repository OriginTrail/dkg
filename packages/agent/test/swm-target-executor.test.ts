import { completeSettledSwmRetirement } from './_helpers/finalized-swm-retirement.js';
import { Rfc64BackgroundWorkDispatcherV1 } from '../src/rfc64/background-work-dispatcher-v1.js';
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
  swmKaWriteLockKey,
  type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import type { FinalizedSwmTwinRetirement } from
  '../src/sync/requester/finalized-swm-twin-reconciliation.js';
import {
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
      markMetaProjectionDirty: () => undefined,
      recoveryMutation: createSwmRecoveryMutationRuntimeV1({
        store,
        recordDrops: () => undefined,
        invalidateListContextGraphsCache: () => undefined,
        markMetaProjectionDirty: () => undefined,
      }),
      setCheckpoint: () => undefined,
      deleteCheckpoint: () => undefined,
      deletePublicCheckpoint: () => undefined,
      ensureOwnedMap: () => new Map(),
      retireFinalizedSwmTwin: async () => undefined,
      completeFinalizedSwmTwinRetirement: (result) => completeSettledSwmRetirement(result, {
        retireMarker: async () => {}, warn: () => {}, scheduleRetry: () => false,
      }),
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
      markMetaProjectionDirty: () => undefined,
      recoveryMutation: createSwmRecoveryMutationRuntimeV1({
        store,
        recordDrops: () => undefined,
        invalidateListContextGraphsCache: () => undefined,
        markMetaProjectionDirty: () => undefined,
      }),
      setCheckpoint: () => undefined,
      deleteCheckpoint: () => undefined,
      deletePublicCheckpoint: () => undefined,
      ensureOwnedMap,
      retireFinalizedSwmTwin: async () => undefined,
      completeFinalizedSwmTwinRetirement: (result) => completeSettledSwmRetirement(result, {
        retireMarker: async () => {}, warn: () => {}, scheduleRetry: () => false,
      }),
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
  const dispatchers: Rfc64BackgroundWorkDispatcherV1[] = [];

  afterEach(async () => {
    await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.closeAndDrain()));
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
    const writeLocks = new Map<string, Promise<void>>();
    const retirementLock = swmKaWriteLockKey(contextGraphId, undefined, ual);
    const swmRowsWhenRetired: number[] = [];
    // Stand-in for the publisher's named-lifecycle cleanup: graph, then head and operation.
    const retireFinalizedSwmTwin = vi.fn(async (candidate: FinalizedSwmTwinRetirement) => {
      expect(writeLocks.has(retirementLock)).toBe(true);
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
    const retireLegacySwmAfterVerifiedVmTwin = vi.fn(async (_evidence: { contextGraphId: string; kaUal: string; assertionVersion: string; subGraphName?: string }) => {
      expect(writeLocks.has(retirementLock)).toBe(false);
      invalidationsBeforeMarkerRetirement = invalidateListContextGraphsCache.mock.calls.length;
      throw new Error('legacy boundary store unavailable');
    });
    const logInfo = vi.fn();
    const logWarn = vi.fn();
    const ctx = createOperationContext('sync');
    const dispatcher = new Rfc64BackgroundWorkDispatcherV1();
    dispatchers.push(dispatcher);
    const scheduleRetry = vi.spyOn(dispatcher, 'scheduleKeyed');
    const executor = new SwmTargetExecutorV1({
      store,
      writeLocks,
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
      markMetaProjectionDirty: () => undefined,
      recoveryMutation: createSwmRecoveryMutationRuntimeV1({
        store,
        recordDrops: () => undefined,
        invalidateListContextGraphsCache: () => undefined,
        markMetaProjectionDirty: () => undefined,
      }),
      setCheckpoint: () => undefined,
      deleteCheckpoint: () => undefined,
      deletePublicCheckpoint: () => undefined,
      ensureOwnedMap: () => new Map(),
      retireFinalizedSwmTwin,
      completeFinalizedSwmTwinRetirement: (result, ctx) => completeSettledSwmRetirement(result, {
        retireMarker: (evidence) => retireLegacySwmAfterVerifiedVmTwin({
          contextGraphId: evidence.contextGraphId, kaUal: evidence.kaUal,
          assertionVersion: String(evidence.assertionVersion), subGraphName: evidence.subGraphName,
        }),
        warn: (message) => logWarn(ctx, message),
        scheduleRetry: (key, work) => dispatcher.scheduleKeyed(key, work),
      }),
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
    expect(scheduleRetry).toHaveBeenCalledOnce();
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
});
