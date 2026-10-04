import { ASYNC_PROMOTE_QUEUE_FORMAT_VERSION, ASYNC_PROMOTE_QUEUE_MIN_AUTO_RECOVERABLE_FORMAT_VERSION, type PromoteJob } from './async-promote-queue-types.js';
import { isPromotePostCommitAttemptError } from './async-promote-queue-utils.js';

export function isAutomaticallyRecoverablePostCommitFailure(job: PromoteJob): boolean {
  return job.state === 'failed'
    && job.reason === undefined
    && job.commitMarker?.swmInserted !== true
    && (job.formatVersion ?? 0) >= ASYNC_PROMOTE_QUEUE_MIN_AUTO_RECOVERABLE_FORMAT_VERSION
    && !missingStorageLaneForAuthorOnlyJob(job)
    && !requiresManualInspection(job)
    && isPromotePostCommitAttemptError(job.attempt.lastError);
}

export function missingStorageLaneForAuthorOnlyJob(job: PromoteJob): boolean {
  return (job.formatVersion ?? 0) < ASYNC_PROMOTE_QUEUE_FORMAT_VERSION
    && job.request.agentAddress === undefined
    && job.request.authorAgentAddress !== undefined;
}

export function requiresManualInspection(job: PromoteJob): boolean {
  const reason = (job.reason ?? '').toLowerCase();
  const lastError = (job.attempt.lastError?.message ?? '').toLowerCase();
  return reason.includes('partial promote ambiguity')
    || lastError.includes('partial promote ambiguity')
    || reason.includes('legacy promote job')
    || lastError.includes('legacy promote job')
    || reason.includes('missing storage lane')
    || lastError.includes('cannot prove the wm storage lane');
}
