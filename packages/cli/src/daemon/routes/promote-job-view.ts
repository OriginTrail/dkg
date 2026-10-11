import type { PromoteJob, PromoteJobState } from '@origintrail-official/dkg-publisher';

// ── Async-promote wire schema (RFC §3.2 + §3.3) ──────────────────────────────
//
// The internal `PromoteJob` shape persisted by the queue carries
// implementation details the HTTP contract is not allowed to leak:
//   - `lease.claimToken` (opaque worker-side capability),
//   - `lease.workerId` / heartbeat metadata,
//   - numeric epoch timestamps,
//   - `commitMarker` (internal idempotency bookkeeping).
//
// `PromoteJobView` is the documented public shape per RFC §3.2; ISO-8601
// timestamps, a flat top level for assertion identity, and a stable
// `lastError.code` enum mapped from the queue's failure classification.
// The list (§3.3) and status (§3.2) endpoints share `promoteJobToView()`
// so both surfaces stay in lockstep.

export interface PromoteJobErrorView {
  code: string;
  diagnosticCode?: string;
  message: string;
  retryable: boolean;
}

export interface PromoteJobView {
  jobId: string;
  state: PromoteJobState;
  contextGraphId: string;
  assertionName: string;
  subGraphName?: string;
  entities: readonly string[] | 'all';
  enqueuedAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  entitiesPromoted?: number;
  attempts: number;
  maxAttempts: number;
  nextRetryAt?: string;
  lastError?: PromoteJobErrorView;
  reason?: string;
}

export function isoFromEpochMs(ms: number | undefined): string | undefined {
  if (ms === undefined || ms === null) return undefined;
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

export function promoteJobToView(job: PromoteJob): PromoteJobView {
  // `startedAt` reflects the current attempt's lease acquisition; while
  // running the lease is present, after success/failure the queue clears
  // it so the field naturally goes away. `finishedAt` is sourced from
  // the terminal-state evidence the queue already records:
  // `result.succeededAt` for success and `attempt.lastError.recordedAt`
  // for failed / failed_retrying. Cancelled jobs (no lastError, no
  // result) fall back to `updatedAt` because that's the only durable
  // timestamp for that transition.
  const startedAt = isoFromEpochMs(job.lease?.acquiredAt);
  let finishedAt: string | undefined;
  if (job.state === 'succeeded') {
    finishedAt = isoFromEpochMs(job.result?.succeededAt) ?? isoFromEpochMs(job.updatedAt);
  } else if (job.state === 'failed' || job.state === 'failed_retrying') {
    finishedAt =
      isoFromEpochMs(job.attempt.lastError?.recordedAt) ?? isoFromEpochMs(job.updatedAt);
  }

  const lastError: PromoteJobErrorView | undefined = job.attempt.lastError
    ? {
        code: job.attempt.lastError.classification,
        message: job.attempt.lastError.message,
        retryable: job.attempt.lastError.retryable,
        ...(job.attempt.lastError.diagnosticCode ? { diagnosticCode: job.attempt.lastError.diagnosticCode } : {}),
      }
    : undefined;

  const view: PromoteJobView = {
    jobId: job.jobId,
    state: job.state,
    contextGraphId: job.request.contextGraphId,
    assertionName: job.request.assertionName,
    entities: job.request.entities,
    enqueuedAt: new Date(job.enqueuedAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    attempts: job.attempt.count,
    maxAttempts: job.attempt.maxRetries,
  };
  if (job.request.subGraphName !== undefined) view.subGraphName = job.request.subGraphName;
  if (startedAt !== undefined) view.startedAt = startedAt;
  if (finishedAt !== undefined) view.finishedAt = finishedAt;
  if (job.result?.promotedCount !== undefined) view.entitiesPromoted = job.result.promotedCount;
  const nextRetryAt = isoFromEpochMs(job.attempt.nextRetryAt);
  if (nextRetryAt !== undefined) view.nextRetryAt = nextRetryAt;
  if (lastError !== undefined) view.lastError = lastError;
  if (job.reason !== undefined) view.reason = job.reason;
  return view;
}

