import { createPromoteExecutionAuthority } from './promote-execution-authority.js';
import { executePromoteRequest } from './execute-promote-request.js';
/**
 * Durable queue worker: claim, prepare immutable recovery, execute, persist outcome.
 * Shutdown leaves running leases for recovery; ambiguous legacy attempts stay parked.
 */

import type {
  DKGAgent,
} from '@origintrail-official/dkg-agent';
import {
  isStoreOperationTimeoutError,
  StoreSchedulerBusyError,
} from '@origintrail-official/dkg-storage';
import {
  PromoteJobLeaseError, PromoteAdmissionUncertainError, jobFailureText,
  type AsyncPromoteQueue,
  type PromoteAttemptError,
  type PromoteJob,
  type PromoteRequest, type PromoteExecutionAuthority,
} from '@origintrail-official/dkg-publisher';
import { asyncAdmissionUsage } from '@origintrail-official/dkg-core';
import { createClaimFailureBackoff } from './claim-failure-backoff.js';
import { logPromoteAttemptFailure, promoteAttemptAuthorityReason, promoteFailureReason } from './async-promote-attempt-diagnostics.js';
import {
  classifyPromoteError,
  safePromoteErrorIdentity,
  type ClassifiedPromoteError,
} from './async-promote-error-classification.js';

export { classifyPromoteError } from './async-promote-error-classification.js';
export type { ClassifiedPromoteError } from './async-promote-error-classification.js';

/**
 * Convenience type for the daemon's existing `emitMemoryGraphChanged`
 * callback. Kept local so this module doesn't have to import the
 * `MemoryGraphChangedEvent` shape from `routes/context.ts` and pull in
 * its full route surface.
 */
export interface PromoteMemoryGraphChangedEvent {
  contextGraphId: string;
  layers: ('wm' | 'swm')[];
  subGraphName?: string;
  operation: string;
  source: string;
  counts?: { triples?: number };
}

/**
 * Logging is strictly best-effort: sinks may be synchronous or asynchronous,
 * but worker progress never waits for them and sink failures are discarded.
 */
export type PromoteWorkerLogger = (message: string) => void | Promise<void>;

/**
 * Internal logger shape: normalization makes every worker call fire-and-forget.
 * Worker code holds only this type and calls it directly. A public
 * `PromoteWorkerLogger` is assignable to it, so the rule that keeps a raw sink
 * out is structural: normalize at the entry point, pass nothing else down.
 */
export type PromoteWorkerSyncLogger = (message: string) => void;

const defaultPromoteWorkerLogger: PromoteWorkerLogger = (message) => {
  console.warn(`[promote-worker] ${message}`);
};

/**
 * Normalize a public logger once at the worker boundary. The worker's internal
 * paths can then emit diagnostics without each call having to know whether the
 * configured sink is synchronous, asynchronous, or hostile.
 */
export function normalizePromoteWorkerLogger(
  configured: PromoteWorkerLogger | undefined,
): PromoteWorkerSyncLogger {
  const sink = configured ?? defaultPromoteWorkerLogger;
  return (message: string): void => {
    try {
      void Promise.resolve(sink(message)).catch(() => {});
    } catch {
      // Logging must never delay or alter queue state transitions.
    }
  };
}

export interface PromoteWorkerConfig {
  /** The host DKG agent — provides the queue + the sync `promote` call. */
  agent: DKGAgent;
  /** Number of concurrent worker loops (default 4 — RFC §4.5). */
  workerConcurrency?: number;
  /** Durable fallback poll interval (default 100ms, including with queue wake support). */
  pollIntervalMs?: number;
  /**
   * Heartbeat interval. Must be SHORTER than the queue's `leaseMs`
   * (default 15min); default 60s = 15× safety margin.
   */
  heartbeatIntervalMs?: number;
  /**
   * Max time `stop()` will wait for in-flight jobs to complete before
   * returning. After the timeout, the in-flight `agent.assertion.promote`
   * continues in the background but the supervisor stops tracking it —
   * the next boot's `recoverOnStartup()` reconciles.
   */
  shutdownTimeoutMs?: number;
  /** Deterministic time source for tests. */
  now?: () => number;
  /** Deterministic randomness source for claim-failure jitter tests. */
  random?: () => number;
  /** Defaults to `console.warn`. The daemon passes its own logger. */
  log?: PromoteWorkerLogger;
  /** Retry interval for queue-only outcome bookkeeping (default 5s). */
  bookkeepingRetryIntervalMs?: number;
  /** Maximum queue-only bookkeeping recovery window (default 10min). */
  bookkeepingRetryBudgetMs?: number;
  /**
   * Interval of the post-commit recovery sweep (default 30s). The sweep also
   * runs once right after `recoverOnStartup()`; `0` disables only the
   * periodic repetition.
   */
  postCommitRecoveryIntervalMs?: number;
  /** Deterministic sleep hook for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to a no-op. The daemon passes its `memoryGraphChanged` emitter. */
  emitMemoryGraphChanged?: (event: PromoteMemoryGraphChangedEvent) => void;
  /**
   * Worker-id prefix used when minting each loop's `workerId`. Defaults
   * to `daemon-<pid>`. Tests inject a stable prefix.
   */
  workerIdPrefix?: string;
}

export interface PromoteWorkerSupervisor {
  /** Run `recoverOnStartup()` once, then spawn the polling loops. */
  start(): Promise<void>;
  /** Stop polling and wait (up to `shutdownTimeoutMs`) for in-flight jobs. */
  stop(): Promise<void>;
  /**
   * Test-only: drive one full poll across every worker slot
   * synchronously. Returns the number of jobs picked up by this round.
   */
  tickOnce(): Promise<number>;
  /**
   * Observability — counts of completed runs since start. Counters reset
   * on every `start()` call (a new supervisor lifecycle).
   */
  getCounters(): PromoteWorkerCounters;
}

class PromoteWorkerShutdownError extends Error {
  constructor(jobId: string) {
    super(`Promote worker shutdown interrupted bookkeeping for ${jobId}`);
    this.name = 'PromoteWorkerShutdownError';
  }
}

/** Queue uncertainty is not an operation verdict or permission to replay it. */
function failureBookkeepingUncertainty(error: unknown): { errorName: string; errorCode: string } {
  let errorName = 'unknown';
  let errorCode = 'unknown';
  // Capture closed identities only; never retain an arbitrary cause/message.
  try {
    if (error instanceof StoreSchedulerBusyError) {
      errorName = 'StoreSchedulerBusyError';
      errorCode = 'STORE_SCHEDULER_BUSY';
    } else if (isStoreOperationTimeoutError(error)) {
      errorName = 'TimeoutError';
      errorCode = 'STORE_OPERATION_TIMEOUT';
    } else if (error instanceof PromoteJobLeaseError) {
      errorName = 'PromoteJobLeaseError';
    } else {
      errorName = safePromoteErrorIdentity(error, 'name') ?? 'unknown';
      errorCode = safePromoteErrorIdentity(error, 'code') ?? 'unknown';
    }
  } catch {
    // Even hostile diagnostic getters cannot turn uncertainty into fatality.
  }
  return { errorName, errorCode };
}

export type PromoteJobRunResult<T extends { promotedCount: number }> =
  | { outcome: 'succeeded'; result: T }
  | { outcome: 'failed_retrying' | 'failed_terminal'; cause: unknown; error: ClassifiedPromoteError; retiredNoEffect?: true }
  | { outcome: 'partial_promote_ambiguity'; result: T; cause: unknown; error: ClassifiedPromoteError }
  | { outcome: 'failure_bookkeeping_uncertain'; cause: unknown; bookkeepingCause: unknown;
      diagnostic: { errorName: string; errorCode: string } };

export interface PromoteWorkerCounters {
  succeeded: number;
  failedTerminal: number;
  failedRetrying: number;
  /**
   * Codex #665: jobs whose promote ran successfully but whose post-promote
   * bookkeeping (commit-marker write / queue.succeed) failed mid-flight.
   * These remain in `running` state until next startup recovery; operators
   * MUST inspect SWM/VM before any explicit `/recover`.
   */
  partialPromoteAmbiguity: number;
  /** Number of `runJob` invocations that started (regardless of outcome). */
  attempted: number;
  /** Set when shuttingDown was hit mid-job; ops can correlate with abandoned counts at next startup. */
  interruptedAtShutdown: number;
  /** Terminal post-commit failures the recovery sweep requeued for the idempotent replay. */
  postCommitRequeued: number;
  /** Post-commit failures whose replay budget is spent; they wait for an operator `recover`. */
  postCommitExhausted: number;
}

/**
 * Queue bookkeeping has its own retry domain. Only typed storage failures
 * whose write definitely did not start are replayable; an indeterminate
 * mutation remains fail-closed even if its diagnostic text contains generic
 * words such as "timeout" or "recovering".
 */
function isRetryableQueueBookkeepingError(error: unknown): boolean {
  return error instanceof StoreSchedulerBusyError
    || (isStoreOperationTimeoutError(error) && error.outcome === 'not_started');
}

/**
 * Per-job execution — extracted so tests can exercise the exact
 * try/catch/heartbeat shape without spinning the supervisor.
 *
 * Resolves once the job's lifecycle transition (succeed or fail) has
 * been written back to the queue. Heartbeats run in the background
 * for the duration; both `succeed` and `fail` clear the lease so any
 * in-flight heartbeat after that point throws a `PromoteJobLeaseError`,
 * which the heartbeat catcher logs and ignores.
 */
export async function runPromoteJob<T extends { promotedCount: number; shareEvidence?: import('@origintrail-official/dkg-publisher').ShareCompletionEvidence }>(
  args: {
    job: PromoteJob;
    queue: AsyncPromoteQueue;
    workerId: string;
    prepareJob?: (job: PromoteJob, authority: PromoteExecutionAuthority) => Promise<{ job: PromoteJob; completedResult?: T }>;
    runPromote: (request: PromoteRequest, authority?: PromoteExecutionAuthority) => Promise<T>;
    now: () => number;
    heartbeatIntervalMs: number;
    bookkeepingRetryIntervalMs?: number;
    bookkeepingRetryBudgetMs?: number;
    sleep?: (ms: number) => Promise<void>;
    shutdownSignal?: AbortSignal;
    log: PromoteWorkerLogger;
    emitMemoryGraphChanged?: (event: PromoteMemoryGraphChangedEvent) => void;
  },
): Promise<PromoteJobRunResult<T>> {
  const {
    queue,
    runPromote,
    now,
    heartbeatIntervalMs,
    bookkeepingRetryIntervalMs = 5_000,
    bookkeepingRetryBudgetMs = 10 * 60 * 1000,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    shutdownSignal,
    log: configuredLog,
    emitMemoryGraphChanged,
  } = args;
  let job = args.job;
  const log = normalizePromoteWorkerLogger(configuredLog);
  if (!job.lease) {
    throw new Error(`runPromoteJob requires a job with an active lease (jobId=${job.jobId})`);
  }
  const claimToken = job.lease.claimToken;

  const throwIfShutdownInterrupted = (): void => {
    if (shutdownSignal?.aborted) throw new PromoteWorkerShutdownError(job.jobId);
  };

  const sleepUntilRetry = async (ms: number): Promise<void> => {
    throwIfShutdownInterrupted();
    if (!shutdownSignal) {
      await sleep(ms);
      return;
    }
    let onAbort: (() => void) | null = null;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new PromoteWorkerShutdownError(job.jobId));
      shutdownSignal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([sleep(ms), interrupted]);
    } finally {
      if (onAbort) shutdownSignal.removeEventListener('abort', onAbort);
    }
    throwIfShutdownInterrupted();
  };

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let cancelled = false;
  const stopHeartbeats = (): void => {
    cancelled = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };
  if (heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      if (cancelled) return;
      asyncAdmissionUsage.observeShareHeartbeat(queue.heartbeat(job.jobId, claimToken)).catch((err: unknown) => {
        if (err instanceof PromoteJobLeaseError) {
          // Expected when the job has already succeeded/failed and the lease was cleared.
          return;
        }
        log(
          `Heartbeat error for ${job.jobId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, heartbeatIntervalMs);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }
  shutdownSignal?.addEventListener('abort', stopHeartbeats, { once: true });
  if (shutdownSignal?.aborted) stopHeartbeats();

  async function persistWithRecovery<T>(
    label: string,
    deadlineAt: number,
    write: () => Promise<T>,
  ): Promise<T> {
    let failures = 0;
    for (;;) {
      throwIfShutdownInterrupted();
      try {
        return await write();
      } catch (err: unknown) {
        throwIfShutdownInterrupted();
        failures += 1;
        const retryable = isRetryableQueueBookkeepingError(err);
        if (err instanceof PromoteJobLeaseError || !retryable || now() >= deadlineAt) throw err;
        if (failures === 1) {
          log(
            `Queue bookkeeping recovery started for ${job.jobId} (${label}) after a transient error`,
          );
        }
        const remainingBudgetMs = Math.max(0, deadlineAt - now());
        await sleepUntilRetry(
          Math.min(Math.max(0, bookkeepingRetryIntervalMs), remainingBudgetMs),
        );
      }
    }
  }

  async function recordPromotionFailure(err: unknown, promoteStarted: boolean): Promise<PromoteJobRunResult<T>> {
    throwIfShutdownInterrupted();
    const classified = classifyPromoteError(err, { boundRecovery: job.request.recoveryBinding !== undefined });
    const message = err instanceof Error ? err.message : String(err);
    logPromoteAttemptFailure({ job, err, message, classified, promoteStarted, log });
    // Persist the producer-owned diagnostic code (closed set) so the
    // post-commit recovery sweep can key on it without parsing prose.
    const attemptError: PromoteAttemptError = {
      message: promoteFailureReason(job, message, log),
      retryable: classified.retryable,
      classification: classified.classification,
      recordedAt: now(),
      ...(classified.diagnostic ? { diagnosticCode: classified.diagnostic.code } : {}),
      ...('noEffectProof' in classified ? {noEffectProof: classified.noEffectProof} : {}),
      // Which authority prerequisite a retryable attempt waited for, shown by the job view.
      ...promoteAttemptAuthorityReason(err, classified),
    };
    try {
      const bookkeepingDeadlineAt = now() + Math.max(0, bookkeepingRetryBudgetMs);
      const transition = await persistWithRecovery(
        'record failure',
        bookkeepingDeadlineAt,
        () => queue.fail(job.jobId, claimToken, attemptError),
      );
      throwIfShutdownInterrupted();
      return { outcome: transition.state === 'failed_retrying' ? 'failed_retrying' : 'failed_terminal', cause: err, error: classified,
        ...(transition.state === 'failed' && transition.retiredNoEffect ? {retiredNoEffect: true as const} : {}) };
    } catch (failErr: unknown) {
      if (failErr instanceof PromoteWorkerShutdownError) throw failErr;
      // The write may have committed without an acknowledgement. A lost lease
      // also forbids attributing another worker's outcome to this attempt.
      return { outcome: 'failure_bookkeeping_uncertain', cause: err, bookkeepingCause: failErr, diagnostic: failureBookkeepingUncertainty(failErr) };
    }
  }

  try {
    let completedResult: T | undefined;
    if (args.prepareJob) {
      try {
        const prepared = await args.prepareJob(job, createPromoteExecutionAuthority(queue, job.jobId, claimToken, now, throwIfShutdownInterrupted));
        job = prepared.job;
        completedResult = prepared.completedResult;
        throwIfShutdownInterrupted();
      } catch (cause) {
        throwIfShutdownInterrupted();
        if (cause instanceof PromoteAdmissionUncertainError || cause instanceof PromoteJobLeaseError) {
          return { outcome: 'failure_bookkeeping_uncertain', cause, bookkeepingCause: cause,
            diagnostic: failureBookkeepingUncertainty(cause) };
        }
        return await recordPromotionFailure(cause, false);
      }
    }
    // Queue ownership is established before the executor can mutate the asset.
    // A failed marker write has its own boundary, separate from promotion failures.
    try {
      await persistWithRecovery('record promoteStarted', now() + Math.max(0, bookkeepingRetryBudgetMs),
        () => queue.recordCommitMarker(job.jobId, claimToken, 'promoteStarted'));
    } catch (cause) {
      throwIfShutdownInterrupted();
      if (job.request.recoveryBinding) {
        // An uncertain fenced write retains its owner for ordinary lease recovery.
        return { outcome: 'failure_bookkeeping_uncertain', cause, bookkeepingCause: cause,
          diagnostic: failureBookkeepingUncertainty(cause) };
      }
      return await recordPromotionFailure(cause, false);
    }
    let result: T;
    try {
      result = completedResult ?? await runPromote(job.request, job.request.recoveryBinding
        ? createPromoteExecutionAuthority(queue, job.jobId, claimToken, now, throwIfShutdownInterrupted) : undefined);
    } catch (err: unknown) {
      return await recordPromotionFailure(err, true);
    }

    // Retry only bookkeeping after promotion returns; never replay content on
    // an uncertain outer marker write. Bound jobs retain their immutable owner.
    const bookkeepingDeadlineAt = now() + Math.max(0, bookkeepingRetryBudgetMs);
    try {
      await persistWithRecovery('record swmInserted', bookkeepingDeadlineAt, () =>
        queue.recordCommitMarker(job.jobId, claimToken, 'swmInserted'),
      );
      await persistWithRecovery('record success', bookkeepingDeadlineAt, () =>
        queue.succeed(job.jobId, claimToken, {
          promotedCount: result.promotedCount,
          succeededAt: now(),
          ...(job.request.agentAddress && result.shareEvidence ? { shareEvidence: result.shareEvidence } : {}),
        }),
      );
    } catch (bookkeepingErr: unknown) {
      if (bookkeepingErr instanceof PromoteWorkerShutdownError) throw bookkeepingErr;
      const message =
        bookkeepingErr instanceof Error
          ? bookkeepingErr.message
          : String(bookkeepingErr);
      log(
        `PARTIAL-PROMOTE-AMBIGUITY: jobId=${job.jobId} ` +
          `assertion.promote() returned successfully (promotedCount=${result.promotedCount}) ` +
          `but post-promote bookkeeping failed: ${message}. ` +
          `Leaving job in 'running' state; recoverOnStartup() will pick this up ` +
          `on next boot as abandoned partial promote. ` +
          `Operator action: inspect SWM/VM for the assertion before any /recover.`,
      );
      return {
        outcome: 'partial_promote_ambiguity', result, cause: bookkeepingErr,
        error: {
          retryable: false,
          classification: 'fatal',
          message: `partial-promote ambiguity (post-promote bookkeeping failed): ${message}`,
        },
      };
    }

    if (result.promotedCount > 0 && emitMemoryGraphChanged) {
      try {
        emitMemoryGraphChanged({
          contextGraphId: job.request.contextGraphId,
          layers: ['wm', 'swm'],
          subGraphName: job.request.subGraphName,
          operation: 'assertion_promoted',
          source: 'async-worker',
          counts: { triples: result.promotedCount },
        });
      } catch (emitErr: unknown) {
        log(
          `memoryGraphChanged emit failed for ${job.jobId}: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`,
        );
      }
    }

    return { outcome: 'succeeded', result };
  } finally {
    shutdownSignal?.removeEventListener('abort', stopHeartbeats);
    stopHeartbeats();
  }
}

interface WorkerSlot {
  workerId: string;
  inFlight: Promise<void> | null;
  tickInFlight: Promise<boolean> | null;
}

export function createPromoteWorkerSupervisor(config: PromoteWorkerConfig): PromoteWorkerSupervisor {
  const concurrency = Math.max(1, config.workerConcurrency ?? 4);
  const supportsWorkWake = typeof config.agent.promoteQueue.workScheduling?.attachScheduler === 'function';
  const pollIntervalMs = Math.max(10, config.pollIntervalMs ?? 100);
  const heartbeatIntervalMs = config.heartbeatIntervalMs ?? 60_000;
  const effectiveLeaseMs = config.agent.promoteQueue.effectiveLeaseMs;
  if (heartbeatIntervalMs > 0 && heartbeatIntervalMs >= effectiveLeaseMs) {
    throw new Error(
      `promoteQueue.heartbeatIntervalMs must be shorter than the queue lease (${effectiveLeaseMs}ms)`,
    );
  }
  const bookkeepingRetryBudgetMs = config.bookkeepingRetryBudgetMs ?? 10 * 60 * 1000;
  if (bookkeepingRetryBudgetMs >= effectiveLeaseMs) {
    throw new Error(
      `promoteQueue.bookkeepingRetryBudgetMs must be shorter than the queue lease (${effectiveLeaseMs}ms)`,
    );
  }
  const shutdownTimeoutMs = config.shutdownTimeoutMs ?? 30_000;
  const postCommitRecoveryIntervalMs = Math.max(0, config.postCommitRecoveryIntervalMs ?? 30_000);
  const now = config.now ?? (() => Date.now());
  const log = normalizePromoteWorkerLogger(config.log);
  const workerIdPrefix = config.workerIdPrefix ?? `daemon-${process.pid}`;
  const slots: WorkerSlot[] = Array.from({ length: concurrency }, (_, i) => ({
    workerId: `${workerIdPrefix}-slot-${i}`,
    inFlight: null,
    tickInFlight: null,
  }));
  let shuttingDown = false;
  let started = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let postCommitRecoveryTimer: ReturnType<typeof setInterval> | null = null;
  let postCommitRecoveryInFlight: Promise<void> | null = null;
  let claimRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let detachWorkScheduler: (() => void) | null = null;
  let wakeRequested = false;
  let wakeLoop: Promise<void> | null = null;
  let lifecycleAbortController: AbortController | null = null;
  let counters: PromoteWorkerCounters = freshCounters();
  const claimFailureBackoff = createClaimFailureBackoff({
    now,
    random: config.random,
  });

  function freshCounters(): PromoteWorkerCounters {
    return {
      succeeded: 0,
      failedTerminal: 0,
      failedRetrying: 0,
      partialPromoteAmbiguity: 0,
      attempted: 0,
      interruptedAtShutdown: 0,
      postCommitRequeued: 0,
      postCommitExhausted: 0,
    };
  }

  function clearPostCommitRecoveryTimer(): void {
    if (postCommitRecoveryTimer === null) return;
    clearInterval(postCommitRecoveryTimer);
    postCommitRecoveryTimer = null;
  }

  /**
   * The same recovery an operator performs through `/recover`, applied
   * automatically to terminal post-commit failures: the queue requeues them
   * for the publisher's idempotent replay within the job's own retry budget.
   * The sweep is best-effort and never changes supervisor lifecycle: a
   * failing sweep is logged and retried on the next interval.
   */
  function runPostCommitRecoverySweep(trigger: 'startup' | 'periodic'): Promise<void> {
    if (postCommitRecoveryInFlight) return postCommitRecoveryInFlight;
    const run = (async () => {
      if (shuttingDown) return;
      try {
        const events = await config.agent.promoteQueue.recoverPostCommitFailures();
        for (const event of events) {
          if (event.action === 'requeued') counters.postCommitRequeued += 1;
          else counters.postCommitExhausted += 1;
          log(
            `[async-promote-worker] ${JSON.stringify({
              event: 'async_promote_post_commit_recovery',
              schemaVersion: 1,
              trigger,
              jobId: event.jobId,
              action: event.action,
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              ...(event.nextRetryAt !== undefined ? { nextRetryAt: event.nextRetryAt } : {}),
            })}`,
          );
        }
      } catch (err: unknown) {
        log(
          `post-commit recovery sweep failed (${trigger}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })().finally(() => {
      if (postCommitRecoveryInFlight === run) postCommitRecoveryInFlight = null;
    });
    postCommitRecoveryInFlight = run;
    return run;
  }

  function clearClaimRetryTimer(): void {
    if (claimRetryTimer === null) return;
    clearTimeout(claimRetryTimer);
    claimRetryTimer = null;
  }

  function scheduleClaimRetry(delayMs: number): void {
    if (!started || shuttingDown || claimRetryTimer !== null) return;
    const timer = setTimeout(() => {
      if (claimRetryTimer === timer) claimRetryTimer = null;
      requestWake();
    }, delayMs);
    if (timer.unref) timer.unref();
    claimRetryTimer = timer;
  }

  async function tickSlot(slot: WorkerSlot): Promise<boolean> {
    if (shuttingDown || slot.inFlight) return false;
    if (!claimFailureBackoff.isDue()) return false;
    let claimed: PromoteJob | null;
    try {
      claimed = await asyncAdmissionUsage.timeShareClaim(() => config.agent.promoteQueue.claimNext(slot.workerId));
      claimFailureBackoff.reset();
      clearClaimRetryTimer();
    } catch (err: unknown) {
      const delayMs = claimFailureBackoff.recordFailure();
      scheduleClaimRetry(delayMs);
      log(
        `claimNext error on ${slot.workerId}; retrying in ${delayMs}ms: `
          + `${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
    if (!claimed) return false;

    counters.attempted += 1;
    const shutdownSignal = lifecycleAbortController?.signal;
    const run = (async () => {
      try {
        const outcome = await runPromoteJob({
          job: claimed,
          queue: config.agent.promoteQueue,
          workerId: slot.workerId,
          prepareJob: (job, authority) => config.agent.assertion.prepareQueuedShare(job, authority),
          runPromote: (request, executionAuthority) => executePromoteRequest(config.agent, request, { executionAuthority }),
          now,
          heartbeatIntervalMs,
          bookkeepingRetryIntervalMs: config.bookkeepingRetryIntervalMs,
          bookkeepingRetryBudgetMs,
          sleep: config.sleep,
          shutdownSignal,
          log,
          emitMemoryGraphChanged: config.emitMemoryGraphChanged,
        });
        switch (outcome.outcome) {
          case 'succeeded':
            counters.succeeded += 1;
            break;
          case 'failed_retrying':
            counters.failedRetrying += 1;
            break;
          case 'failed_terminal':
            counters.failedTerminal += 1;
            break;
          case 'failure_bookkeeping_uncertain':
            log(`[async-promote-worker] ${JSON.stringify({
              event: 'async_promote_failure_bookkeeping_uncertain', schemaVersion: 1,
              jobId: claimed.jobId, attempt: claimed.attempt.count,
              maxAttempts: claimed.attempt.maxRetries, stage: 'record_failure',
              ...outcome.diagnostic,
            })}`);
            // The runner stopped heartbeats. Trust a committed outcome, or let
            // existing lease reconciliation hold an ambiguous started promote.
            break;
          case 'partial_promote_ambiguity':
            counters.partialPromoteAmbiguity += 1;
            break;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof PromoteWorkerShutdownError || shutdownSignal?.aborted) {
          log(
            `Worker ${slot.workerId} stopped bookkeeping for ${claimed.jobId} after shutdown timeout`,
          );
          return;
        }
        log(`Worker ${slot.workerId} crashed processing ${claimed.jobId}: ${jobFailureText(message).detail}`);
        if (claimed.lease) {
          try {
            await config.agent.promoteQueue.fail(claimed.jobId, claimed.lease.claimToken, {
              message: `Worker crashed after claiming job: ${message}`,
              retryable: false,
              classification: 'fatal',
              recordedAt: now(),
            });
          } catch (failErr: unknown) {
            const failMessage = failErr instanceof Error ? failErr.message : String(failErr);
            if (failErr instanceof PromoteJobLeaseError) {
              log(
                `Lease lost while parking crashed job ${claimed.jobId}: ${failMessage}`,
              );
            } else {
              log(
                `Failed to park crashed job ${claimed.jobId}; next startup recovery must reconcile it: ` +
                  `${failMessage}`,
              );
            }
          }
        }
      } finally {
        slot.inFlight = null;
        requestWake();
      }
    })();
    slot.inFlight = run;
    return true;
  }

  function scheduleTick(slot: WorkerSlot): Promise<boolean> {
    if (slot.tickInFlight) return slot.tickInFlight;
    const run = tickSlot(slot).finally(() => {
      if (slot.tickInFlight === run) {
        slot.tickInFlight = null;
      }
    });
    slot.tickInFlight = run;
    return run;
  }

  async function tickAllOnce(): Promise<number> {
    let picked = 0;
    const availableSlots = slots.filter((slot) => slot.inFlight === null);
    for (const slot of availableSlots) {
      const claimed = await scheduleTick(slot);
      if (!claimed) break;
      picked += 1;
    }
    return picked;
  }

  function requestWake(): void {
    if (!started || shuttingDown) return;
    wakeRequested = true;
    if (wakeLoop) return;
    const run = (async () => {
      do {
        wakeRequested = false;
        await tickAllOnce();
      } while (wakeRequested && !shuttingDown);
    })()
      .catch((err: unknown) => {
        log(
          `Promote worker wake failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        if (wakeLoop === run) wakeLoop = null;
        if (wakeRequested && !shuttingDown) requestWake();
      });
    wakeLoop = run;
  }

  function activeShutdownSlotCount(): number {
    return slots.filter((s) => s.tickInFlight || s.inFlight).length;
  }

  async function drainForShutdown(): Promise<number> {
    const pendingTicks = slots.map((s) => s.tickInFlight).filter((p): p is Promise<boolean> => p !== null);
    if (pendingTicks.length > 0) {
      await Promise.allSettled(pendingTicks);
    }
    const inFlight = slots.map((s) => s.inFlight).filter((p): p is Promise<void> => p !== null);
    if (inFlight.length === 0) return 0;
    await Promise.all(inFlight);
    return inFlight.length;
  }

  return {
    async start() {
      if (started) return;
      started = true;
      shuttingDown = false;
      lifecycleAbortController = new AbortController();
      counters = freshCounters();
      clearClaimRetryTimer();
      claimFailureBackoff.reset();
      let recovering = true;
      try {
        const summary = await config.agent.promoteQueue.recoverOnStartup();
        recovering = false;
        if (summary.reclaimed > 0 || summary.abandoned > 0) {
          log(
            `recoverOnStartup: reclaimed=${summary.reclaimed} abandoned=${summary.abandoned}`,
          );
        }
        await runPostCommitRecoverySweep('startup');
        if (shuttingDown) {
          started = false;
          return;
        }
        if (supportsWorkWake) {
          detachWorkScheduler = config.agent.promoteQueue.workScheduling!.attachScheduler({
            onWorkAvailable: requestWake,
          });
        }
        pollTimer = setInterval(requestWake, pollIntervalMs);
        if (pollTimer.unref) pollTimer.unref();
        if (postCommitRecoveryIntervalMs > 0) {
          postCommitRecoveryTimer = setInterval(() => {
            void runPostCommitRecoverySweep('periodic');
          }, postCommitRecoveryIntervalMs);
          if (postCommitRecoveryTimer.unref) postCommitRecoveryTimer.unref();
        }
      } catch (err: unknown) {
        detachWorkScheduler?.();
        detachWorkScheduler = null;
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        clearPostCommitRecoveryTimer();
        clearClaimRetryTimer();
        lifecycleAbortController.abort();
        lifecycleAbortController = null;
        started = false;
        shuttingDown = true;
        if (recovering) {
          throw new Error(`recoverOnStartup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        throw err;
      }
    },
    async stop() {
      if (!started) return;
      shuttingDown = true;
      detachWorkScheduler?.();
      detachWorkScheduler = null;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      clearPostCommitRecoveryTimer();
      clearClaimRetryTimer();
      // A sweep is a short queue transition; let it settle so shutdown never
      // leaves a half-observed requeue behind.
      await postCommitRecoveryInFlight;
      const activeAtStop = activeShutdownSlotCount();
      if (activeAtStop === 0) {
        lifecycleAbortController?.abort();
        lifecycleAbortController = null;
        started = false;
        return;
      }
      const timeout = new Promise<'timeout'>((resolve) => {
        const t = setTimeout(() => resolve('timeout'), shutdownTimeoutMs);
        if (t.unref) t.unref();
      });
      const drained = drainForShutdown().then((count) => ({ kind: 'drained' as const, count }));
      const result = await Promise.race([timeout, drained]);
      if (result === 'timeout') {
        const active = activeShutdownSlotCount() || activeAtStop;
        counters.interruptedAtShutdown += active;
        log(
          `Shutdown timeout (${shutdownTimeoutMs}ms) reached; ${active} in-flight promote(s) abandoned to next-boot recovery`,
        );
        lifecycleAbortController?.abort();
      }
      lifecycleAbortController = null;
      started = false;
    },
    async tickOnce() {
      return tickAllOnce();
    },
    getCounters() {
      return { ...counters };
    },
  };
}
