import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { GraphScopedMaterializationOutcome } from './graph-scoped-materialization.js';
import type { SyncPageResult } from './page-fetch.js';
import type { VerifiedGraphScopedAsset } from './graph-scoped-materialization.js';
import type { DurableSyncBudget } from './durable-sync-budget.js';
import type { DurableSyncContext } from './durable-sync.js';

/**
 * Deprecated deep-import shape retained at the public requester boundary for
 * rolling upgrades. New code should provide a modern `DurableSyncContext`.
 */
export interface LegacyDurableSyncContext extends Omit<
  DurableSyncContext,
  'durableSyncBudget' | 'fetchSyncPages' | 'storeInsert' | 'storeGraphScopedAsset'
> {
  /**
   * @deprecated Deep-import compatibility for callers from before durable sync
   * split fetch and authentication into separate bounded phases.
   */
  createContextGraphSyncDeadline: (remainingContextGraphs: number) => number;
  fetchSyncPages: (
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphId: string,
    includeSharedMemory: boolean,
    phase: 'data' | 'meta',
    graphUri: string,
    deadline: number,
    snapshotRef?: string,
    sinceBatchId?: string,
    assetUals?: string[],
  ) => Promise<SyncPageResult>;
  storeInsert: (quads: Quad[]) => Promise<void>;
  storeGraphScopedAsset?: (
    asset: VerifiedGraphScopedAsset,
    deadline: number,
  ) => Promise<GraphScopedMaterializationOutcome>;
}

function legacyDurableSyncBudget(
  createContextGraphSyncDeadline: (remainingContextGraphs: number) => number,
): DurableSyncBudget {
  return {
    createContextGraphBudget: ({ remainingContextGraphs }) => {
      const deadline = createContextGraphSyncDeadline(remainingContextGraphs);
      return {
        fetchDeadline: deadline,
        createGraphScopedAuthenticationDeadline: () => deadline,
      };
    },
  };
}

export function normalizeDurableSyncContext(
  context: DurableSyncContext | LegacyDurableSyncContext,
): DurableSyncContext {
  if ('durableSyncBudget' in context) return context;
  const {
    createContextGraphSyncDeadline,
    fetchSyncPages,
    storeInsert,
    storeGraphScopedAsset,
    ...sharedContext
  } = context;
  return {
    ...sharedContext,
    durableSyncBudget: legacyDurableSyncBudget(createContextGraphSyncDeadline),
    fetchSyncPages: (request) => fetchSyncPages(
      request.ctx,
      request.remotePeerId,
      request.contextGraphId,
      false,
      request.phase,
      request.graphUri,
      request.fetchContext.deadline,
      request.snapshotRef,
      request.sinceBatchId,
      request.exactAssetUals,
    ),
    storeInsert: ({ quads }) => storeInsert(quads),
    storeGraphScopedAsset: storeGraphScopedAsset
      ? ({ asset, authenticationDeadline }) => storeGraphScopedAsset(
        asset,
        authenticationDeadline,
      )
      : undefined,
  };
}
