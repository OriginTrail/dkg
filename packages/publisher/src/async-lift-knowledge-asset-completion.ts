// SPDX-License-Identifier: Apache-2.0
import type { ActiveLiftJobClaim, AsyncKnowledgeAssetVmPublishExecutionResult } from './async-lift-publisher-types.js';
import type { LiftJob, LiftJobBroadcast, LiftJobBroadcastMetadata, LiftJobHex } from './lift-job.js';
import type { LiftJobTransitionScope } from './async-lift-claim-session.js';
import { InvalidLiftPublishResultError, mapKnowledgeAssetVmPublishResultToLiftJobSuccess,
  type AsyncLiftPublishSuccess } from './async-lift-publish-result.js';

interface CompletionPersistence {
  /** Build and validate the canonical broadcast transition before committing it. */
  buildBroadcast(current: LiftJob, broadcast: LiftJobBroadcastMetadata): LiftJobBroadcast;
  flush(): Promise<void>;
  applyMapped(current: LiftJob, mapped: AsyncLiftPublishSuccess): Promise<LiftJob>;
}

/** Caller holds the claim/job transaction through terminal persistence and wallet release.
 * The executor has already attempted lifecycle repair; this boundary only records its result. */
export async function completeClaimedKnowledgeAssetExecution(input: {
  current: LiftJob;
  scope: LiftJobTransitionScope;
  claim: ActiveLiftJobClaim;
  result: AsyncKnowledgeAssetVmPublishExecutionResult;
  publicByteSize?: number;
}, persistence: CompletionPersistence): Promise<boolean> {
  const { current, scope, claim, result, publicByteSize } = input;
  const resultTxHash = result.onChainResult?.txHash;
  if (current.status !== 'validated' && current.status !== 'broadcast' && current.status !== 'included') return false;
  if (current.claim?.claimToken !== claim.claim.claimToken || current.claim?.walletId !== claim.claim.walletId) return false;
  if (current.broadcast && current.broadcast.txHash !== resultTxHash) return false;
  const certified = result.status === 'confirmed' && result.localFinalizationComplete === true;
  if (!certified && current.status !== 'validated') return false;
  // Legacy handlers may send without the pre-send hook. Save a usable hash before
  // mapping: missing receipt fields must never make an accepted send claimable again.
  let recorded: LiftJob = current;
  if (current.status === 'validated' && typeof resultTxHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(resultTxHash)) {
    const next = persistence.buildBroadcast(current, {
      txHash: resultTxHash as LiftJobHex, walletId: current.claim.walletId, publicByteSize,
    });
    recorded = await scope.commit(next, 'broadcast');
    // The transaction has escaped. A flush failure propagates without rolling back its hash.
    await persistence.flush();
  }
  let mapped: AsyncLiftPublishSuccess;
  try {
    mapped = mapKnowledgeAssetVmPublishResultToLiftJobSuccess({ publishResult: result, walletId: current.claim.walletId, publicByteSize });
  } catch (error) {
    throw new InvalidLiftPublishResultError(error instanceof Error ? error.message : String(error));
  }
  return (await persistence.applyMapped(recorded, mapped)).status === 'finalized';
}
