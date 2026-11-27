// SPDX-License-Identifier: Apache-2.0
import type { GraphScopedDurableManifestPlan } from '../durable-integrity.js';
import { markDurableTerminalBoundary, type DurableSyncAccumulator } from '../durable-progress.js';
import { exactAssetUalsForSelection } from '../exact-assets.js';
import { settleDurableDataFromHoldings } from './durable-data-holdings.js';
import { settleFetchedDurableAssets, type FetchedDurableAssetSettlementRequest } from './durable-fetched-assets.js';
import type { DurableGraphSettlementGuard } from './durable-prefix-proof.js';
import type { DurableSyncContext } from './durable-sync.js';
import type { DurableAssetConsumer } from './durable-asset-consumer.js';
import type { SyncPageResult } from './page-fetch.js';
import { prepareDurableVerifiedPage, persistDurableRemainingMetadata, type PreparedDurableVerificationInput } from './durable-verified-page.js';
import { classifyExactDurableFetch, classifyExactAssetResponderCapability,
  type ExactAssetFetchSessionPolicy, type ExactDurableFetchDisposition, type ExactAssetResponderCapability } from './exact-durable-fetch.js';

export interface DurablePhaseSettlementOptions {
  readonly updateCheckpoint: boolean;
  readonly countProgress?: boolean;
  readonly checkpointAdvanceAlreadyRecorded?: boolean;
  readonly emptyPhase?: boolean;
  readonly manifestPlan?: GraphScopedDurableManifestPlan;
  readonly terminal?: boolean;
}
type SettlementPorts = FetchedDurableAssetSettlementRequest['context'] &
  Pick<DurableSyncContext, 'ctx' | 'admitVerifiedPage' | 'deleteCheckpoint' | 'logInfo' | 'onVerifiedFullSnapshot' | 'remotePeerId'> & {
  readonly settleAsset: DurableAssetConsumer;
  recordPhaseOutcome(result: SyncPageResult, options: DurablePhaseSettlementOptions): void;
  onStoreStart(): void;
};
interface SettlementOptions extends Pick<FetchedDurableAssetSettlementRequest,
  'graphScopedManifest' | 'contextGraphBudget' | 'deadline' | 'settlementSliceDeadline'> {
  readonly contextGraphId: string;
  readonly metaResult: SyncPageResult;
  readonly exactFetchPolicy?: ExactAssetFetchSessionPolicy;
  readonly sinceBatchId?: string;
  readonly skipAgentsMeta: boolean;
  readonly settlement: DurableGraphSettlementGuard;
}
type SettlementOutcome = { readonly kind: 'yielded' } | {
  readonly kind: 'settled'; readonly timedOut: boolean;
  readonly exactDisposition?: ExactDurableFetchDisposition;
  readonly exactCapability?: ExactAssetResponderCapability;
};

/** Admit and settle the verified input directly, sharing META and cancellation order. */
export async function settleDurableVerifiedPage(
  input: PreparedDurableVerificationInput,
  processed: Awaited<ReturnType<DurableSyncContext['processDurableBatchInWorker']>>,
  ports: SettlementPorts,
  accumulator: DurableSyncAccumulator,
  options: SettlementOptions,
): Promise<SettlementOutcome> {
  const { contextGraphId, metaResult, graphScopedManifest, exactFetchPolicy, sinceBatchId,
    skipAgentsMeta, settlement, contextGraphBudget, deadline, settlementSliceDeadline } = options;
  const { ctx, remotePeerId, deleteCheckpoint, setCheckpoint, recordPhaseOutcome, logInfo } = ports;
  const batchVerifiedCleanly = processed.rejectedKcs === 0;
  const exactAssetSelection = exactFetchPolicy?.selection;
  let updateMetaCheckpoint = true;
  let countMetaProgress = true;
  let updateDataCheckpoint = false;
  let terminal = false;
  let empty = false;
  if (input.kind === 'held') {
    if (!batchVerifiedCleanly || processed.dataRejectedMissingMeta > 0) {
      throw new Error('Held durable generation has rejected metadata');
    }
  } else {
    // Store independently verified assets, but never acknowledge rejected DATA.
    if (graphScopedManifest && (!batchVerifiedCleanly || processed.dataRejectedMissingMeta !== 0)) {
      deleteCheckpoint(input.rawDataResult.checkpointKey);
    }
    const metadataOnlyResponse = processed.metaOnlyResponses > 0;
    // The verifier's reason-agnostic count includes discarded sync controls and
    // non-IRI META subjects. Advancing fully consumed metadata avoids replay loops.
    const discardedOnlyMetadataResponse = metadataOnlyResponse
      && processed.verifiedData.length === 0 && processed.verifiedMeta.length === 0
      && processed.consumedUnpersistedMetaTriples > 0
      && processed.consumedUnpersistedMetaTriples === processed.totalFetchedMetaQuads;
    const metaPhaseCanAdvance = batchVerifiedCleanly && processed.dataRejectedMissingMeta === 0
      && (!metadataOnlyResponse || processed.verifiedMeta.length > 0 || discardedOnlyMetadataResponse);
    const dataPhaseCanAdvance = batchVerifiedCleanly && processed.dataRejectedMissingMeta === 0 && !metadataOnlyResponse;
    const allowDurableCheckpoints = exactFetchPolicy?.allowDurableCheckpoints ?? true;
    updateMetaCheckpoint = metaPhaseCanAdvance && allowDurableCheckpoints;
    countMetaProgress = !metadataOnlyResponse;
    updateDataCheckpoint = dataPhaseCanAdvance && allowDurableCheckpoints;
    terminal = batchVerifiedCleanly && processed.dataRejectedMissingMeta === 0 && input.descriptorCoverageComplete
      && metaPhaseCanAdvance && dataPhaseCanAdvance && metaResult.completed && !metaResult.timedOut
      && input.dataResult.completed && !input.dataResult.timedOut;
    empty = processed.emptyResponses > 0 || processed.dataRejectedMissingMeta > 0
      || (processed.verifiedData.length === 0 && processed.verifiedMeta.length === 0 && metadataOnlyResponse);
  }

  let checkpointAdvanceRecorded = false;
  if (!empty) {
    ports.onStoreStart();
    const partitioned = prepareDurableVerifiedPage(ports, contextGraphId, processed, input);
    if (input.kind === 'fetched') {
      const assets = await settleFetchedDurableAssets({ context: ports, graphScopedManifest,
        dataResult: input.dataResult, updateDataCheckpoint, descriptorCoverageComplete: input.descriptorCoverageComplete,
        settleAsset: ports.settleAsset, accumulator, settlement, contextGraphBudget, deadline, settlementSliceDeadline }, partitioned);
      checkpointAdvanceRecorded = assets.checkpointAdvanceRecorded;
      if (assets.kind === 'yielded') {
        logInfo(ctx, `Yielding durable recovery for "${contextGraphId}" at an authenticated manifest boundary after the settlement slice expired`);
        if (updateMetaCheckpoint && metaResult.completed) deleteCheckpoint(metaResult.checkpointKey);
        markDurableTerminalBoundary(accumulator, false);
        return { kind: 'yielded' };
      }
    }
    await persistDurableRemainingMetadata(ports, partitioned.remainingMeta, accumulator, settlement.assertCurrent);
  }
  // Count started writes truthfully, but cancellation cannot settle the page.
  settlement.assertCurrent();
  if (input.kind === 'fetched' && ports.onVerifiedFullSnapshot && exactAssetSelection === undefined && sinceBatchId === undefined
    && batchVerifiedCleanly && processed.dataRejectedMissingMeta === 0
    && input.dataResult.completed && !input.dataResult.timedOut && input.dataResult.resumedFromOffset === 0
    && (skipAgentsMeta || (metaResult.completed && !metaResult.timedOut && metaResult.resumedFromOffset === 0))) {
    await ports.onVerifiedFullSnapshot({ contextGraphId,
      verifiedDataGraphs: new Set([...processed.verifiedData.map(quad => quad.graph), ...(processed.verifiedGraphScopedDataGraphs ?? [])]),
      verifiedMetaGraphs: new Set(processed.verifiedMeta.map(quad => quad.graph)), metaFetched: !skipAgentsMeta });
  }
  settlement.assertCurrent();
  const emptyPhase = empty && processed.emptyResponses > 0;
  recordPhaseOutcome(metaResult, { updateCheckpoint: updateMetaCheckpoint, countProgress: countMetaProgress, emptyPhase });
  if (input.kind === 'held') {
    logInfo(ctx, settleDurableDataFromHoldings({ plan: input.holdings, remotePeerId, contextGraphId,
      manifest: input.holdings.manifest, accumulator, deleteCheckpoint, setCheckpoint }));
    return { kind: 'settled', timedOut: false };
  }
  recordPhaseOutcome(input.dataResult, { updateCheckpoint: updateDataCheckpoint, emptyPhase,
    manifestPlan: graphScopedManifest ?? undefined, terminal, checkpointAdvanceAlreadyRecorded: checkpointAdvanceRecorded });
  markDurableTerminalBoundary(accumulator, terminal);
  const exactFacts = {
    requestedAssetCount: exactAssetSelection ? exactAssetUalsForSelection(exactAssetSelection).length : 0,
    metaResult, dataResult: input.rawDataResult, metaFetched: !skipAgentsMeta,
    descriptorCoverageComplete: input.descriptorCoverageComplete, returnedDescriptorCount: input.returnedDescriptorCount,
    rejectedKcs: processed.rejectedKcs, dataRejectedMissingMeta: processed.dataRejectedMissingMeta,
  };
  return { kind: 'settled', timedOut: metaResult.timedOut || input.dataResult.timedOut,
    exactDisposition: exactAssetSelection === undefined ? undefined : classifyExactDurableFetch(exactFacts),
    exactCapability: exactAssetSelection?.kind !== 'ual-only' ? undefined : classifyExactAssetResponderCapability(exactFacts) };
}
