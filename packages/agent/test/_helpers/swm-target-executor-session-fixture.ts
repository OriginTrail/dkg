import { deleteSyncPageCheckpoint } from
  '../../src/sync/requester/page-fetch.js';
import {
  SwmTargetExecutorSessionFactoryV1,
  type SwmTargetExecutorPortsV1,
  type SwmTargetExecutorV1,
} from '../../src/sync/requester/swm-target-executor.js';
import { createSwmRecoveryMutationRuntimeV1 } from
  '../../src/sync/requester/swm-recovery-apply.js';

type CheckpointStore = Parameters<typeof deleteSyncPageCheckpoint>[0];

/**
 * Test-only constructor bridge for lifecycle fixtures that deliberately bypass
 * `DKGAgent.create()`, where production ports are normally composed once.
 */
export function createSwmTargetExecutorSessionFactoryForTest(owner: {
  store: SwmTargetExecutorPortsV1['store'];
  writeLocks?: SwmTargetExecutorPortsV1['writeLocks'];
  listSubGraphs: SwmTargetExecutorPortsV1['listSubGraphs'];
  createContextGraphSyncDeadline: SwmTargetExecutorPortsV1['createContextGraphSyncDeadline'];
  fetchSyncPages: SwmTargetExecutorPortsV1['fetchSyncPages'];
  getOrCreateSyncVerifyWorker: () => {
    processSharedMemoryBatch: SwmTargetExecutorPortsV1['processSharedMemoryBatch'];
  };
  publicSnapshotStore?: SwmTargetExecutorPortsV1['publicSnapshotStore'];
  oversizeTombstoneLog?: { record: SwmTargetExecutorPortsV1['recordDrops'] };
  invalidateListContextGraphsCache?: SwmTargetExecutorPortsV1[
    'invalidateListContextGraphsCache'
  ];
  contextGraphMetaProjection?: {
    markDirtyFromQuads: SwmTargetExecutorPortsV1['markMetaProjectionDirty'];
  };
  syncCheckpoints: CheckpointStore;
  workspaceOwnedEntities: Map<
    string,
    ReturnType<SwmTargetExecutorPortsV1['ensureOwnedMap']>
  >;
  retireFinalizedSwmTwinCandidate?: SwmTargetExecutorPortsV1['retireFinalizedSwmTwin'];
  log?: {
    info?: SwmTargetExecutorPortsV1['logInfo'];
    warn?: SwmTargetExecutorPortsV1['logWarn'];
    debug?: SwmTargetExecutorPortsV1['logDebug'];
  };
}): () => SwmTargetExecutorV1 {
  const factory = new SwmTargetExecutorSessionFactoryV1({
    store: owner.store,
    writeLocks: owner.writeLocks ?? new Map(),
    listSubGraphs: owner.listSubGraphs,
    createContextGraphSyncDeadline: owner.createContextGraphSyncDeadline,
    fetchSyncPages: owner.fetchSyncPages,
    processSharedMemoryBatch: (...args) => owner
      .getOrCreateSyncVerifyWorker()
      .processSharedMemoryBatch(...args),
    publicSnapshotStore: owner.publicSnapshotStore,
    recordDrops: owner.oversizeTombstoneLog?.record ?? (() => {}),
    invalidateListContextGraphsCache: owner.invalidateListContextGraphsCache ?? (() => {}),
    markMetaProjectionDirty: owner.contextGraphMetaProjection?.markDirtyFromQuads
      ?? (() => {}),
    recoveryMutation: createSwmRecoveryMutationRuntimeV1({
      store: owner.store,
      recordDrops: owner.oversizeTombstoneLog?.record ?? (() => {}),
      invalidateListContextGraphsCache: owner.invalidateListContextGraphsCache ?? (() => {}),
      markMetaProjectionDirty: owner.contextGraphMetaProjection?.markDirtyFromQuads
        ?? (() => {}),
    }),
    setCheckpoint: (key, offset) => owner.syncCheckpoints.set(key, offset),
    deleteCheckpoint: (key) => owner.syncCheckpoints.delete(key),
    deletePublicCheckpoint: (key) => deleteSyncPageCheckpoint(owner.syncCheckpoints, key),
    ensureOwnedMap: (key) => {
      let map = owner.workspaceOwnedEntities.get(key);
      if (map === undefined) {
        map = new Map();
        owner.workspaceOwnedEntities.set(key, map);
      }
      return map;
    },
    retireFinalizedSwmTwin: (...args) => owner.retireFinalizedSwmTwinCandidate
      ? owner.retireFinalizedSwmTwinCandidate(...args)
      : Promise.resolve(),
    logInfo: (...args) => owner.log?.info?.(...args),
    logWarn: (...args) => owner.log?.warn?.(...args),
    logDebug: (...args) => owner.log?.debug?.(...args),
  });
  return () => factory.createSession();
}
