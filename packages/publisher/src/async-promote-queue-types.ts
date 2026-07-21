/**
 * Async Promote Queue — public types.
 *
 * Companion to the merged RFC at
 * `docs/specs/SPEC_ASYNC_PROMOTE_QUEUE.md` and the implementation plan at
 * `docs/specs/SPEC_ASYNC_PROMOTE_QUEUE_IMPLEMENTATION_PLAN.md`. This file
 * contains only the public interface + types so callers can depend on it
 * without pulling in the impl (and SPARQL surface area) of the
 * `TripleStoreAsyncPromoteQueue`.
 *
 * The queue mirrors `AsyncLiftPublisher`'s claim/lease/retry model but
 * replaces its on-chain pipeline with a single in-process worker that
 * runs `agent.publisher.assertionPromote`. See the plan §1–2 for the
 * differences from `AsyncLiftPublisher`.
 */

import type { TerminalJobClearOutcome } from './terminal-job-clear.js';

export const PROMOTE_JOB_STATES = [
  'queued',
  'running',
  'failed_retrying',
  'succeeded',
  'failed',
] as const;
export type PromoteJobState = (typeof PROMOTE_JOB_STATES)[number];

/**
 * Version stamp written on every job persisted by this implementation
 * — used by startup recovery to refuse legacy rows. Version 2 is the
 * first format that guarantees a `commitMarker.promoteStarted` flag is
 * written **before** the worker enters `assertionPromote()`, so a
 * `running` row with `promoteStarted === false` can be safely
 * reclaimed.
 *
 * Version 3 adds the persisted `agentAddress` storage lane. Without it,
 * an agent-token enqueue can sign as the token agent while the worker
 * replays promote against the daemon-default WM namespace.
 *
 * Anything missing `formatVersion` (or carrying `formatVersion < 2`)
 * predates the marker contract and MUST be routed to the manual /
 * abandoned recovery path — see Codex PR #665 review id=3302135756
 * for the failure mode (upgraded daemon re-running a partially-promoted
 * legacy job). Bump this constant any time the on-disk job shape or
 * the recovery invariants change.
 */
export const ASYNC_PROMOTE_QUEUE_FORMAT_VERSION = 3;

/**
 * Oldest persisted job format safe for automatic startup reclaim when the
 * worker crashed before `promoteStarted=true`. Version 2 introduced the
 * marker contract; version 3 only adds the optional storage-lane field.
 */
export const ASYNC_PROMOTE_QUEUE_MIN_AUTO_RECOVERABLE_FORMAT_VERSION = 2;

/**
 * Classification of a promote failure, used by the queue's retry policy.
 * Set by the worker when calling `fail()` — the queue itself never inspects
 * the error message.
 *
 * - `transient`  — network blip, daemon overload, retry with backoff.
 * - `cap_exceeded` — 256 KB body cap or 10 MB gossip cap. The worker may
 *                   shrink the entity batch and retry, OR mark the whole
 *                   job failed if it can't subdivide further.
 * - `fatal`      — validation failure, unknown assertion, etc.; no retry.
 */
export type PromoteFailureClassification = 'transient' | 'cap_exceeded' | 'fatal';

/**
 * A promote request — the payload the queue persists for the worker to
 * replay. Validated at the HTTP layer; the queue stores it verbatim.
 */
export interface PromoteRequest {
  contextGraphId: string;
  subGraphName?: string;
  assertionName: string;
  entities: readonly string[] | 'all';
  /** Worker-facing storage namespace used to locate the WM draft; conflict keys canonicalize separately. */
  agentAddress?: string;
  /** Signing author used by finalize/seal during promote replay. */
  authorAgentAddress?: string;
}

/**
 * Per-attempt lease metadata. Present only when state is `running`.
 * The lease prevents two workers from claiming the same job; the
 * `claimToken` is included in heartbeat / succeed / fail calls so the
 * queue can reject operations from a worker whose lease already expired
 * and was reassigned elsewhere.
 */
export interface PromoteLease {
  workerId: string;
  acquiredAt: number;
  expiresAt: number;
  lastHeartbeatAt: number;
  claimToken: string;
}

export interface PromoteAttemptError {
  message: string;
  retryable: boolean;
  classification: PromoteFailureClassification;
  recordedAt: number;
}

export interface PromoteAttemptState {
  count: number;
  maxRetries: number;
  nextRetryAt?: number;
  lastError?: PromoteAttemptError;
}

export interface PromoteResult {
  promotedCount: number;
  succeededAt: number;
  /** Informational only — populated when the worker observed the gossip payload size. */
  gossipMessageSize?: number;
}

/**
 * Per-job commit marker — written by the worker as it observes progress.
 * `promoteStarted` means the worker has crossed into the promote pipeline,
 * so recovery can no longer prove SWM was untouched. `swmInserted` means
 * the outer promote call returned and the worker observed the local commit.
 * The remaining flags are operator-facing evidence reserved for future
 * phase-level plumbing.
 */
export interface PromoteCommitMarker {
  promoteStarted: boolean;
  swmInserted: boolean;
  wmCleaned: boolean;
  lifecycleStamped: boolean;
  gossiped: boolean;
}

export const PROMOTE_COMMIT_MARKER_STEPS = [
  'promoteStarted',
  'swmInserted',
  'wmCleaned',
  'lifecycleStamped',
  'gossiped',
] as const;
export type PromoteCommitMarkerStep = (typeof PROMOTE_COMMIT_MARKER_STEPS)[number];

export interface PromoteJob {
  jobId: string;
  request: PromoteRequest;
  state: PromoteJobState;
  enqueuedAt: number;
  updatedAt: number;
  lease?: PromoteLease;
  attempt: PromoteAttemptState;
  result?: PromoteResult;
  commitMarker?: PromoteCommitMarker;
  /**
   * Stable string describing why a job is currently in its state when
   * that explanation isn't captured by other fields. Populated for
   * cancel/recover transitions and partial-promote ambiguity. Cleared
   * on successful re-queue.
   */
  reason?: string;
  /**
   * Persistence-format version stamped at enqueue / recover time. See
   * `ASYNC_PROMOTE_QUEUE_FORMAT_VERSION`. Optional on the type so
   * legacy rows still parse (so recovery can inspect and quarantine
   * them), but always set to `ASYNC_PROMOTE_QUEUE_FORMAT_VERSION` by
   * the current implementation when it writes a fresh job.
   */
  formatVersion?: number;
}

export interface PromoteListFilter {
  state?: readonly PromoteJobState[];
  contextGraphId?: string;
  limit?: number;
}

/**
 * Result of a startup recovery sweep. See RFC §4.4.
 *
 * - `reclaimed`  — `running` jobs whose lease expired before the worker
 *                  recorded `commitMarker.promoteStarted`. The queue moves
 *                  them back to `queued` for a clean rerun.
 * - `abandoned`  — `running` jobs whose lease expired after
 *                  `commitMarker.promoteStarted` (or after `swmInserted`).
 *                  The queue parks them in `failed` with
 *                  `reason="partial promote ambiguity"` because re-running
 *                  risks duplicate gossip and partial WM state. An operator
 *                  inspects and either cancels or manually `recover()`s
 *                  after verifying SWM.
 */
export interface PromoteRecoverySummary {
  reclaimed: number;
  abandoned: number;
}

export type PromoteStats = Record<PromoteJobState, number>;

export interface AsyncPromoteQueue {
  // RFC §3.1
  enqueue(request: PromoteRequest): Promise<string>;
  // RFC §3.2
  getStatus(jobId: string): Promise<PromoteJob | null>;
  // RFC §3.3
  list(filter?: PromoteListFilter): Promise<PromoteJob[]>;
  // RFC §3.4
  cancel(jobId: string): Promise<void>;
  recover(jobId: string): Promise<void>;
  // Worker-side surface — used by the in-process worker loop (PR #3); never
  // exposed via HTTP. Each worker passes its own opaque `workerId` (typically
  // the daemon process id + a slot index).
  claimNext(workerId: string): Promise<PromoteJob | null>;
  heartbeat(jobId: string, claimToken: string): Promise<void>;
  recordCommitMarker(jobId: string, claimToken: string, step: PromoteCommitMarkerStep): Promise<void>;
  succeed(jobId: string, claimToken: string, result: PromoteResult): Promise<void>;
  fail(jobId: string, claimToken: string, error: PromoteAttemptError): Promise<void>;
  // Startup / lifecycle.
  recoverOnStartup(): Promise<PromoteRecoverySummary>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  getStats(): Promise<PromoteStats>;
}

/**
 * #1837 — atomic by-exact-jobId terminal cleanup for the SWM share (promote) queue.
 * Segregated off the base contract (mirrors the publisher-side VmPublishTerminalJobClearer);
 * a mutation/admin capability. Clears the exact job ONLY when in a native terminal state
 * ({succeeded, failed}, no carve-out — nothing background re-drives a terminal promote row),
 * rejects otherwise without mutation, idempotent for an absent job, never broadens to other
 * jobs. Reuses the shared TerminalJobClearOutcome for symmetry with the lift clearer.
 */
export interface PromoteTerminalJobClearer {
  clearTerminalJob(jobId: string): Promise<TerminalJobClearOutcome>;
}

export interface AsyncPromoteQueueConfig {
  /** Defaults to `urn:dkg:promote-queue:control-plane` per RFC §4.1. */
  graphUri?: string;
  /** Defaults to 5 — promote retries are cheap. RFC §4.2. */
  maxRetries?: number;
  /** Defaults to 5 minutes — matches `AsyncLiftPublisher.lockLeaseMs`. */
  leaseMs?: number;
  /** Defaults to `Date.now()`. Tests inject deterministic time. */
  now?: () => number;
  /** Defaults to `crypto.randomUUID()`. Tests inject deterministic ids. */
  idGenerator?: () => string;
  /** Defaults to `crypto.randomUUID()`. Must be fresh for every lease claim. */
  claimTokenGenerator?: () => string;
  /**
   * Backoff curve for `failed_retrying` jobs. Receives the next attempt
   * count (1-indexed — first retry is attempt 1) and returns ms-from-now.
   * Default: `min(60_000 * 2^(attempt-1), 15 * 60_000)`.
   */
  backoff?: (attemptCount: number) => number;
}

/**
 * Thrown when an operation fails because the queue's per-assertion
 * uniqueness key `(contextGraphId, subGraphName, assertionName)` is
 * already held by another active job. Carries the existing jobId so the
 * HTTP layer can return a 409 with the duplicate id.
 */
export class PromoteJobConflictError extends Error {
  override readonly name = 'PromoteJobConflictError';
  constructor(
    readonly existingJobId: string,
    readonly key: { contextGraphId: string; subGraphName?: string; assertionName: string; agentAddress?: string },
  ) {
    const lane = key.agentAddress ? `, agentAddress=${key.agentAddress}` : '';
    super(
      `Promote job already active for (${key.contextGraphId}, ${key.subGraphName ?? '<no-sub>'}, ${key.assertionName}${lane}): ${existingJobId}`,
    );
  }
}

/**
 * Thrown when a worker calls heartbeat / succeed / fail / recordCommitMarker
 * with a `claimToken` that no longer matches the job's current lease.
 * Workers should drop the in-flight job and let the next `claimNext` pick
 * up wherever recovery left it.
 */
export class PromoteJobLeaseError extends Error {
  override readonly name = 'PromoteJobLeaseError';
  constructor(
    readonly jobId: string,
    reason: string,
  ) {
    super(`Stale promote lease for ${jobId}: ${reason}`);
  }
}
