import {
  ASYNC_PROMOTE_QUEUE_FORMAT_VERSION,
  ASYNC_PROMOTE_QUEUE_MIN_AUTO_RECOVERABLE_FORMAT_VERSION,
  type PromoteAttemptError,
  type PromoteAttemptState,
  type PromoteJob,
  type PromoteFailureTransition,
} from './async-promote-queue-types.js';
import { isPromotePostCommitAttemptError } from './async-promote-queue-utils.js';
import { PROMOTE_RETRYABLE_FAILURE_CODE } from './promote-replay-safety.js';

/**
 * How long after it was enqueued a job keeps retrying a typed prerequisite
 * failure (`PROMOTE_RETRYABLE_FAILURE`) once its attempt budget is spent.
 */
export const PROMOTE_PREREQUISITE_RETRY_WINDOW_MS = 60 * 60_000;

/**
 * The attempt state of the retry a retryable failure earns, or undefined when
 * the job has none left.
 *
 * Attempts are counted against the job's budget. One kind of failure also has
 * a time budget: a typed prerequisite failure is raised before the promote
 * writes anything and names a condition that ends on its own (a retirement's
 * fence, an authority read that was not answered). A job that met one on each
 * of its attempts would otherwise end `failed` and wait for an explicit
 * `recover`, which a consumer that clears failed jobs never issues (GH#3052).
 * Inside the window such a job is granted one more attempt at a time, on the
 * same backoff curve. The row's budget is left as it was, so an attempt count
 * above it shows that the job is being kept by the window, and an operator
 * `recover` starts from the original budget.
 */
export function promoteRetryAttempt(
  job: PromoteJob,
  error: PromoteAttemptError,
  attemptCount: number,
  now: number,
  backoff: (attemptCount: number) => number,
): (PromoteAttemptState & { nextRetryAt: number }) | undefined {
  const withinWindow = error.diagnosticCode === PROMOTE_RETRYABLE_FAILURE_CODE
    && now - job.enqueuedAt < PROMOTE_PREREQUISITE_RETRY_WINDOW_MS;
  if (attemptCount >= job.attempt.maxRetries && !withinWindow) return undefined;
  return {
    count: attemptCount,
    maxRetries: job.attempt.maxRetries,
    nextRetryAt: now + backoff(attemptCount),
    lastError: error,
  };
}

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

/** Build the failure once under the queue lock; acknowledge only after persistence. */
export function promoteFailureTransition(
  job: PromoteJob,
  error: PromoteAttemptError,
  now: number,
  backoff: (attemptCount: number) => number,
): { job: PromoteJob; transition: PromoteFailureTransition } {
  const attemptCount = Math.max(1, job.attempt.count);
  const swmInserted = job.commitMarker?.swmInserted === true;
  const retryAttempt = error.retryable && !swmInserted
    ? promoteRetryAttempt(job, error, attemptCount, now, backoff)
    : undefined;
  if (retryAttempt) {
    return {
      job: { ...job, state: 'failed_retrying', updatedAt: now, lease: undefined, attempt: retryAttempt },
      transition: { state: 'failed_retrying', jobId: job.jobId, attemptCount, nextRetryAt: retryAttempt.nextRetryAt },
    };
  }
  return {
    job: {
      ...job, state: 'failed', updatedAt: now, lease: undefined,
      attempt: { count: attemptCount, maxRetries: job.attempt.maxRetries, lastError: error },
      reason: swmInserted
        ? 'partial promote ambiguity: failed after SWM insert; needs operator inspection'
        : job.reason,
    },
    transition: { state: 'failed', jobId: job.jobId, attemptCount },
  };
}
