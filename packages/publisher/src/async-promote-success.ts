import type { PromoteJob, PromoteResult } from './async-promote-queue-types.js';
import { shareEvidenceMatchesRequest } from './share-completion-evidence.js';

/** Pure success transition; callers must hold and validate the current lease. */
export function promoteSuccessTransition(job: PromoteJob, result: PromoteResult, now: number): PromoteJob {
  if (!job.commitMarker?.swmInserted) {
    throw new Error(`Cannot succeed job ${job.jobId}: commitMarker.swmInserted is false. Worker must record SWM commit before declaring success.`);
  }
  if (result.shareEvidence && !shareEvidenceMatchesRequest(result.shareEvidence, job.request))
    throw new Error('Share completion evidence does not match the leased request');
  return { ...job, state: 'succeeded', updatedAt: now, lease: undefined, result };
}
