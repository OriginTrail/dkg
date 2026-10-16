import type { PromoteOwnershipReader } from './async-promote-ownership.js';

/** Called under the publisher lifecycle lock, including after its own SWM tail completes. */
export async function assertNoUnfinishedBoundShare(
  readOwner: PromoteOwnershipReader, contextGraphId: string, assertionName: string, agentAddress: string, subGraphName?: string,
): Promise<void> {
  const job = await readOwner({ contextGraphId, assertionName, agentAddress, subGraphName });
  if (job) throw Object.assign(new Error('The original share still owns recovery; wait for its completion before changing the sealed asset'),
    { code: 'KA_PROMOTE_RECOVERY_REQUIRED', recoveryJobId: job.jobId });
}
