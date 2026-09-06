import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  DKG_ENTITY,
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
} from '@origintrail-official/dkg-core';
import {
  SwmTargetExecutorV1,
  type SwmTargetExecutorPortsV1,
} from '../src/sync/requester/swm-target-executor.js';
import { createSwmRecoveryMutationRuntimeV1 } from
  '../src/sync/requester/swm-recovery-apply.js';

describe('SwmTargetExecutorV1 private recovery wiring', () => {
  const stores: OxigraphStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  it('pins recovery authorization and the lease signal on private page fetches', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const controller = new AbortController();
    const fetchSyncPages = vi.fn<SwmTargetExecutorPortsV1['fetchSyncPages']>(
      async (_ctx, _peerId, _contextGraphId, _includeSharedMemory, phase) => ({
        quads: [],
        bytesReceived: 0,
        resumedFromOffset: 0,
        nextOffset: 0,
        checkpointKey: `private:${phase}`,
        completed: true,
      }),
    );
    const executor = new SwmTargetExecutorV1({
      store,
      writeLocks: new Map(),
      listSubGraphs: async () => [],
      createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
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
