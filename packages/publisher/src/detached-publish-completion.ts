import type { PublishResult } from './publisher.js';
import type { ActiveLiftJobClaim } from './async-lift-publisher-types.js';
import type { ActiveLiftJobClaimMutations, AsyncLiftClaimCoordinator } from './async-lift-claim-session.js';

/** Complete only the original claim and transaction, including after proof releases its wallet. */
export async function recordDetachedPublishResult(
  coordinator: AsyncLiftClaimCoordinator,
  mutations: ActiveLiftJobClaimMutations,
  claim: ActiveLiftJobClaim,
  result: PublishResult,
  options: { publicByteSize?: number },
): Promise<boolean> {
  if (result.status !== 'confirmed' || !result.onChainResult) return false;
  // Keep canonical claim -> job lock order through terminal persistence and wallet deletion.
  // Otherwise a claimant can replace the wallet lock between its guarded read and deletion.
  // This short transaction does no lifecycle repair: the executor certified that work already.
  return coordinator.runClaimJobTransaction(claim.jobId, async (transaction) => {
    if (transaction.kind !== 'present') return false;
    const { current, scope } = transaction;
    if (current.status !== 'broadcast' && current.status !== 'included') return false;
    if (current.claim?.claimToken !== claim.claim.claimToken
      || current.claim?.walletId !== claim.claim.walletId) return false;
    if (current.broadcast.txHash !== result.onChainResult!.txHash) return false;
    const completed = await mutations.recordPublishResult(current, scope, result, options);
    return completed.status === 'finalized';
  });
}
