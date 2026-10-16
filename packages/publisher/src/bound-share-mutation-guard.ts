import type { TripleStore } from '@origintrail-official/dkg-storage';
import { trustedPromoteControlGraphs, promoteOwnershipLookup, readPromoteOwnershipCandidates,
  hasUnfinishedBoundObligation } from './async-promote-ownership.js';

/** Called under the publisher lifecycle lock, including after its own SWM tail completes. */
export async function assertNoUnfinishedBoundShare(
  store: TripleStore, contextGraphId: string, assertionName: string, agentAddress: string, subGraphName?: string,
): Promise<void> {
  const lookup = promoteOwnershipLookup({ contextGraphId, assertionName, agentAddress, subGraphName });
  for (const graph of trustedPromoteControlGraphs(store)) {
    const job = (await readPromoteOwnershipCandidates(store, graph, lookup)).find(hasUnfinishedBoundObligation);
    if (job) throw Object.assign(new Error('The original share still owns recovery; wait for its completion before changing the sealed asset'),
      { code: 'KA_PROMOTE_RECOVERY_REQUIRED', recoveryJobId: job.jobId });
  }
}
