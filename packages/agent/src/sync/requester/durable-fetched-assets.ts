// SPDX-License-Identifier: Apache-2.0
import type { GraphScopedDurableManifestPlan } from '../durable-integrity.js';
import { recordDurableSyncDiagnostics, type DurableSyncAccumulator } from '../durable-progress.js';
import type { DurableSyncContext } from './durable-sync.js';
import type { DurableSyncContextGraphBudget } from './durable-sync-budget.js';
import type { DurableAssetConsumer } from './durable-asset-consumer.js';
import type { DurableGraphSettlementGuard } from './durable-prefix-proof.js';
import type { SyncPageResult } from './page-fetch.js';
import type { partitionVerifiedGraphScopedAssets } from './verified-asset-preparation.js';
import { createManifestSettlementCheckpointer } from './manifest-settlement-checkpointer.js';

export interface FetchedDurableAssetSettlementRequest {
  readonly context: Pick<DurableSyncContext, 'signal' | 'storeInsert' | 'setCheckpoint'>;
  readonly settleAsset: DurableAssetConsumer;
  readonly graphScopedManifest: GraphScopedDurableManifestPlan | null;
  readonly dataResult: SyncPageResult;
  readonly updateDataCheckpoint: boolean;
  readonly descriptorCoverageComplete: boolean;
  readonly accumulator: DurableSyncAccumulator;
  readonly settlement: Pick<DurableGraphSettlementGuard, 'covers' | 'assertCurrent' | 'assertPrefixCurrent'>;
  readonly contextGraphBudget: DurableSyncContextGraphBudget;
  readonly deadline: number;
  readonly settlementSliceDeadline?: number;
}
export interface FetchedDurableAssetSettlementOutcome {
  readonly kind: 'stored' | 'yielded';
  readonly checkpointAdvanceRecorded: boolean;
}

/** Own fetched writes and their incremental checkpoint state; return the completion evidence. */
export async function settleFetchedDurableAssets(
  request: FetchedDurableAssetSettlementRequest,
  partitioned: ReturnType<typeof partitionVerifiedGraphScopedAssets>,
): Promise<FetchedDurableAssetSettlementOutcome> {
  const { graphScopedManifest, dataResult, updateDataCheckpoint, descriptorCoverageComplete,
    settleAsset, settlement, contextGraphBudget, deadline, settlementSliceDeadline, accumulator } = request;
  const { signal, storeInsert, setCheckpoint } = request.context;
  let incrementalCheckpointAdvanceRecorded = false;
  // A rootless manifest contains only exact graph assets in the DATA
  // ordering. When there are no deferred legacy rows, each authenticated
  // atomic materialization is therefore a durable continuation boundary.
  // Persisting it immediately turns a later authentication deadline into
  // partial progress instead of replaying every earlier chain lookup.
  const checkpointSettledManifestGraph = graphScopedManifest
    && updateDataCheckpoint
    && descriptorCoverageComplete
    && partitioned.remainingData.length === 0
    && partitioned.remainingMeta.length === 0
    ? createManifestSettlementCheckpointer({
        manifest: graphScopedManifest,
        checkpointKey: dataResult.checkpointKey,
        resumedFromOffset: dataResult.resumedFromOffset,
        rawResumedFromOffset: dataResult.rawResumedFromOffset
          ?? dataResult.resumedFromOffset,
        maximumOffset: dataResult.nextOffset,
        dataQuads: dataResult.quads,
        quadRawOffsets: dataResult.quadRawOffsets,
        setCheckpoint,
      })
    : undefined;
  let mayYieldAtSettledManifestBoundary = false;
  let yieldedAtSettledManifestBoundary = false;
  const graphScopedAuthenticationDeadline = partitioned.assets.length > 0
    ? contextGraphBudget.createGraphScopedAuthenticationDeadline()
    : deadline;
  for (const [assetIndex, asset] of partitioned.assets.entries()) {
    // Bounded verification includes private-only assets in every round.
    // The proven prefix already owns these copies; rewriting them would
    // invalidate its content watch without adding any settled work.
    if (settlement.covers(asset.ual)) continue;
    if (
      assetIndex > 0
      && mayYieldAtSettledManifestBoundary
      && settlementSliceDeadline !== undefined
      && Date.now() >= settlementSliceDeadline
    ) {
      yieldedAtSettledManifestBoundary = true;
      break;
    }
    settlement.assertCurrent();
    await settleAsset(asset, graphScopedAuthenticationDeadline);
    // Preserve a physically settled first prefix on cancellation. A reused
    // prefix still must pass its ownership/content proof before advancing.
    settlement.assertPrefixCurrent();
    const settledCheckpoint = checkpointSettledManifestGraph?.(asset.assertionGraph);
    if (settledCheckpoint) mayYieldAtSettledManifestBoundary = true;
    if (settledCheckpoint?.numericAdvance && !incrementalCheckpointAdvanceRecorded) {
      recordDurableSyncDiagnostics(accumulator, { checkpointAdvances: 1 });
      incrementalCheckpointAdvanceRecorded = true;
    }
  }
  if (yieldedAtSettledManifestBoundary) return { kind: 'yielded', checkpointAdvanceRecorded: incrementalCheckpointAdvanceRecorded };
  if (partitioned.remainingData.length > 0) {
    settlement.assertCurrent();
    await storeInsert({
      quads: partitioned.remainingData,
      signal,
    });
    recordDurableSyncDiagnostics(accumulator, {
      insertedTriples: partitioned.remainingData.length,
      insertedDataTriples: partitioned.remainingData.length,
    });
  }
  return { kind: 'stored', checkpointAdvanceRecorded: incrementalCheckpointAdvanceRecorded };
}
