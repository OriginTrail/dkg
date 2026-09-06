// SPDX-License-Identifier: Apache-2.0

/** Composition-root wiring for graph-complete SWM target execution sessions. */

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import { createContextGraphSyncDeadline } from
  './sync/requester/durable-sync-budget.js';
import { deleteSyncPageCheckpoint } from './sync/requester/page-fetch.js';
import { SwmTargetExecutorV1 } from
  './sync/requester/swm-target-executor.js';

/**
 * Build one execution-scoped requester. A fresh instance deliberately gives
 * each multi-target synchronization its own subgraph-admission cache.
 */
export class SwmTargetExecutorCompositionMethods extends DKGAgentBase {
  createSwmTargetExecutorV1(this: DKGAgent): SwmTargetExecutorV1 {
    return new SwmTargetExecutorV1({
      store: this.store,
      writeLocks: this.writeLocks,
      listSubGraphs: (contextGraphId) => this.listSubGraphs(contextGraphId),
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
      ) => this.fetchSyncPages(
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
        this.getOrCreateSyncVerifyWorker().processSharedMemoryBatch(
          data,
          meta,
          contextGraphId,
          registered,
          excluded,
        )
      ),
      publicSnapshotStore: this.publicSnapshotStore,
      recordDrops: (drops, seam) => this.oversizeTombstoneLog.record(drops, seam),
      invalidateListContextGraphsCache: () => this.invalidateListContextGraphsCache(),
      markMetaProjectionDirty: (quads) => this.contextGraphMetaProjection.markDirtyFromQuads(quads),
      setCheckpoint: (key, offset) => this.syncCheckpoints.set(key, offset),
      deleteCheckpoint: (key) => this.syncCheckpoints.delete(key),
      deletePublicCheckpoint: (key) => deleteSyncPageCheckpoint(this.syncCheckpoints, key),
      ensureOwnedMap: (ownershipKey) => {
        let owned = this.workspaceOwnedEntities.get(ownershipKey);
        if (owned === undefined) {
          owned = new Map();
          this.workspaceOwnedEntities.set(ownershipKey, owned);
        }
        return owned;
      },
      retireFinalizedSwmTwin: (candidate, ctx) => (
        this.retireFinalizedSwmTwinCandidate(candidate, ctx)
      ),
      logInfo: (ctx, message) => this.log.info(ctx, message),
      logWarn: (ctx, message) => this.log.warn(ctx, message),
      logDebug: (ctx, message) => this.log.debug(ctx, message),
    });
  }
}
