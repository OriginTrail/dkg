// SPDX-License-Identifier: Apache-2.0

/** Internal composition-root wiring for graph-complete SWM execution sessions. */

import type { DKGAgent } from './dkg-agent.js';
import { createContextGraphSyncDeadline } from
  './sync/requester/durable-sync-budget.js';
import { deleteSyncPageCheckpoint } from './sync/requester/page-fetch.js';
import { SwmTargetExecutorV1 } from
  './sync/requester/swm-target-executor.js';

type SwmTargetExecutorPortsV1 = ConstructorParameters<typeof SwmTargetExecutorV1>[0];

/** Runtime-owned state intentionally kept off the public DKGAgent type. */
interface SwmTargetExecutorAgentRuntimeV1 {
  readonly writeLocks: SwmTargetExecutorPortsV1['writeLocks'];
  readonly publicSnapshotStore: SwmTargetExecutorPortsV1['publicSnapshotStore'];
  readonly oversizeTombstoneLog: {
    record: SwmTargetExecutorPortsV1['recordDrops'];
  };
  readonly contextGraphMetaProjection: {
    markDirtyFromQuads: SwmTargetExecutorPortsV1['markMetaProjectionDirty'];
  };
  readonly syncCheckpoints: Parameters<typeof deleteSyncPageCheckpoint>[0];
  readonly workspaceOwnedEntities: Map<
    string,
    ReturnType<SwmTargetExecutorPortsV1['ensureOwnedMap']>
  >;
  readonly log: {
    info: SwmTargetExecutorPortsV1['logInfo'];
    warn: SwmTargetExecutorPortsV1['logWarn'];
    debug: SwmTargetExecutorPortsV1['logDebug'];
  };
  invalidateListContextGraphsCache(): void;
}

class SwmTargetExecutorServiceV1 {
  readonly #ports: SwmTargetExecutorPortsV1;

  constructor(agent: DKGAgent) {
    const runtime = agent as unknown as SwmTargetExecutorAgentRuntimeV1;
    this.#ports = {
      store: agent.store,
      writeLocks: runtime.writeLocks,
      listSubGraphs: (contextGraphId) => agent.listSubGraphs(contextGraphId),
      createContextGraphSyncDeadline: (remainingContextGraphs) => (
        createContextGraphSyncDeadline({ remainingContextGraphs })
      ),
      fetchSyncPages: (
        ctx,
        peerId,
        contextGraphId,
        includeSharedMemory,
        phase,
        graphUri,
        deadline,
        options,
      ) => agent.fetchSyncPages(
        ctx,
        peerId,
        contextGraphId,
        includeSharedMemory,
        phase,
        graphUri,
        deadline,
        options,
      ),
      processSharedMemoryBatch: (data, meta, contextGraphId, registered, excluded) => (
        agent.getOrCreateSyncVerifyWorker().processSharedMemoryBatch(
          data,
          meta,
          contextGraphId,
          registered,
          excluded,
        )
      ),
      publicSnapshotStore: runtime.publicSnapshotStore,
      recordDrops: (drops, seam) => runtime.oversizeTombstoneLog.record(drops, seam),
      invalidateListContextGraphsCache: () => runtime.invalidateListContextGraphsCache(),
      markMetaProjectionDirty: (quads) => runtime.contextGraphMetaProjection
        .markDirtyFromQuads(quads),
      setCheckpoint: (key, offset) => runtime.syncCheckpoints.set(key, offset),
      deleteCheckpoint: (key) => runtime.syncCheckpoints.delete(key),
      deletePublicCheckpoint: (key) => deleteSyncPageCheckpoint(runtime.syncCheckpoints, key),
      ensureOwnedMap: (ownershipKey) => {
        let owned = runtime.workspaceOwnedEntities.get(ownershipKey);
        if (owned === undefined) {
          owned = new Map();
          runtime.workspaceOwnedEntities.set(ownershipKey, owned);
        }
        return owned;
      },
      retireFinalizedSwmTwin: (candidate, ctx) => (
        agent.retireFinalizedSwmTwinCandidate(candidate, ctx)
      ),
      logInfo: (ctx, message) => runtime.log.info(ctx, message),
      logWarn: (ctx, message) => runtime.log.warn(ctx, message),
      logDebug: (ctx, message) => runtime.log.debug(ctx, message),
    };
  }

  /** A fresh executor keeps mutable subgraph admission scoped to one sync. */
  createSession(): SwmTargetExecutorV1 {
    return new SwmTargetExecutorV1(this.#ports);
  }
}

const services = new WeakMap<object, SwmTargetExecutorServiceV1>();

/**
 * Return an execution-scoped requester from the agent's internal stable-port
 * service. This is deliberately not mixed into the public `DKGAgent` API.
 */
export function createSwmTargetExecutorSessionV1(
  agent: DKGAgent,
): SwmTargetExecutorV1 {
  let service = services.get(agent);
  if (service === undefined) {
    service = new SwmTargetExecutorServiceV1(agent);
    services.set(agent, service);
  }
  return service.createSession();
}
