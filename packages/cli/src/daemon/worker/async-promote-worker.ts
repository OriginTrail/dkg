/**
 * Async-promote queue worker supervisor.
 *
 * PR #3 of the async-promote-queue series. PR #1 shipped the queue
 * library; PR #2 exposed it to the agent + HTTP routes. This module
 * drains the queue: N worker loops, each polling `claimNext` on a
 * short interval, calling `agent.assertion.promote(...)` on the
 * claimed job, then recording success or classified failure back into
 * the queue.
 *
 * Open questions from the plan §10 are resolved here:
 *
 * 1. **Worker model**: in-process `setInterval(claimNext, pollIntervalMs)`
 *    × `workerConcurrency` instances. AsyncLift's on-demand
 *    `processNext` model is rejected because the promote queue has no
 *    external trigger — the daemon owns its own clock.
 *
 * 2. **Backoff curve**: defined in `async-promote-queue-utils.ts`,
 *    inherited by the queue itself; the worker just calls `fail()` with
 *    a classification and the queue handles backoff bookkeeping.
 *
 * 3. **Error classification**: see `classifyPromoteError` below.
 *    Seeded from the rc.10 Graphify import patterns (see
 *    `INTEGRATION_NOTES_GRAPHIFY.md` and `dkg-graphify-rc10-test/FINDINGS_v2.md`).
 *
 * 4. **Telemetry**: the supervisor emits `memoryGraphChanged` on every
 *    `succeeded` transition that promoted >0 triples, mirroring the
 *    sync `/promote` route. State transitions to `queued`/`running`/
 *    `failed_retrying` are NOT emitted — they're queue internals.
 *
 * Shutdown semantics: RFC §6.2 says do NOT mark `running → queued`
 * on shutdown. We stop polling, let in-flight jobs complete (or
 * timeout), and rely on `recoverOnStartup()` at the next boot to
 * decide what to do with any leases the old worker held.
 */

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  isStoreOperationTimeoutError,
  isReadOnlyStoreOperation,
  StoreSchedulerBusyError,
} from '@origintrail-official/dkg-storage';
import {
  PromoteJobLeaseError,
  type AsyncPromoteQueue,
  type PromoteAttemptError,
  type PromoteFailureClassification,
  type PromoteJob,
  type PromoteRequest,
} from '@origintrail-official/dkg-publisher';

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

export interface PromoteWorkerConfig {
  /** The host DKG agent — provides the queue + the sync `promote` call. */
  agent: DKGAgent;
  /** Number of concurrent worker loops (default 4 — RFC §4.5). */
  workerConcurrency?: number;
  /** Polling interval for claimNext (default 100ms). */
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
  /** Defaults to `console.warn`. The daemon passes its own logger. */
  log?: PromoteWorkerLogger;
  /** Retry interval for queue-only outcome bookkeeping (default 5s). */
  bookkeepingRetryIntervalMs?: number;
  /** Maximum queue-only bookkeeping recovery window (default 10min). */
  bookkeepingRetryBudgetMs?: number;
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
}

export type ClassifiedPromoteError = {
  classification: PromoteFailureClassification;
  retryable: boolean;
  message?: string;
};

const PROMOTE_STEP_TAG = /^\[promote:([^\]]*)\]\s*/;
const PROMOTE_DIAGNOSTIC_STAGES = new Set([
  'ensureSubGraphRegistered',
  'assertGraphScopedLifecycleWritable',
  'knowledgeAssetPrivateQuads',
  'assertionScopedQuads',
  'assertTrustedCatalogTriplesAllowed',
  'encodeWorkspaceGossipPayload',
]);
// Only producer-owned, source-defined identities are safe to retain verbatim.
// Arbitrary upstream name/code strings can be credentials even when they are
// syntactically simple, so everything outside these closed sets becomes unknown.
const SAFE_ERROR_NAMES = new Set([
  'Error',
  'DKGError',
  'DKGUserError',
  'DKGInternalError',
  'PayloadTooLargeError',
  'SwmGossipPayloadTooLargeError',
  'CuratorUnconfirmedError',
  'CuratorRejectedError',
  'AssertionNotPersistedError',
]);
const SAFE_ERROR_CODES = new Set([
  'PAYLOAD_TOO_LARGE',
  'SWM_GOSSIP_PAYLOAD_TOO_LARGE',
  'CURATOR_UNCONFIRMED',
  'CURATOR_REJECTED',
  'ASSERTION_NOT_PERSISTED',
]);

function untagPromoteMessage(message: string): string {
  return message.replace(PROMOTE_STEP_TAG, '');
}

function diagnosticPromoteStage(message: string): string {
  const candidate = PROMOTE_STEP_TAG.exec(message)?.[1];
  return candidate !== undefined && PROMOTE_DIAGNOSTIC_STAGES.has(candidate)
    ? candidate
    : 'unknown';
}

function safeErrorIdentity(
  err: unknown,
  field: 'name' | 'code',
  allowed: ReadonlySet<string>,
): string | undefined {
  if ((typeof err !== 'object' && typeof err !== 'function') || err === null) return undefined;
  try {
    const value = Reflect.get(err, field);
    return typeof value === 'string' && allowed.has(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function bestEffortLog(log: PromoteWorkerLogger, message: string): void {
  try {
    void Promise.resolve(log(message)).catch(() => {});
  } catch {
    // Logging must never delay or alter queue state transitions.
  }
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
 * Emit privacy-bounded evidence before queue.fail() makes a terminal row
 * externally clearable. Diagnostics are best-effort and can never change the
 * promote state transition, even when the injected logger fails synchronously
 * or asynchronously.
 */
function logPromoteAttemptFailure(input: {
  job: PromoteJob;
  err: unknown;
  message: string;
  classified: ClassifiedPromoteError;
  promoteStarted: boolean;
  log: PromoteWorkerLogger;
}): void {
  try {
    bestEffortLog(
      input.log,
      `[async-promote-worker] ${JSON.stringify({
        event: 'async_promote_attempt_failed',
        schemaVersion: 1,
        jobId: input.job.jobId,
        attempt: input.job.attempt.count,
        maxAttempts: input.job.attempt.maxRetries,
        promoteStartedMarkerPersisted: input.promoteStarted,
        swmCommitObserved: false,
        stage: diagnosticPromoteStage(input.message),
        classification: input.classified.classification,
        retryable: input.classified.retryable,
        errorName: safeErrorIdentity(input.err, 'name', SAFE_ERROR_NAMES) ?? 'unknown',
        errorCode: safeErrorIdentity(input.err, 'code', SAFE_ERROR_CODES) ?? 'unknown',
      })}`,
    );
  } catch {
    // Diagnostics must never prevent fail-closed queue bookkeeping.
  }
}

/**
 * Map a promote error message to a `PromoteAttemptError` classification.
 * Seeded from the three rc.10 Graphify import patterns documented in
 * `dkg-graphify-rc10-test/FINDINGS_v2.md`. Returns `fatal` for unknown
 * patterns — the operator can re-classify and call `/recover` after
 * inspecting the failure.
 *
 * Exported so the daemon supervisor (and future tooling like an
 * operator dashboard) can preview the verdict without going through
 * the worker.
 */
export function classifyPromoteError(err: unknown): ClassifiedPromoteError {
  const raw = err instanceof Error ? err.message : String(err);
  // #1464 — strip a leading diagnostic "[promote:<step>] " tag (added by the publisher's
  // promote step-tagging) BEFORE substring-classifying, so a step LABEL can never inject a
  // classifier trigger token (e.g. the step "encodeWorkspaceGossipPayload" would otherwise make
  // every error from it match the "gossip" cap-check). We classify on the ORIGINAL error text;
  // the tag stays on the operator-facing message. The tag is single (idempotent, innermost wins).
  const untagged = untagPromoteMessage(raw ?? '');
  const message = untagged.toLowerCase();
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code ?? '').toLowerCase()
      : '';

  // 1. 4 MiB gossip cap — surfaced as
  //    "Promoted assertion too large for gossip (XXXX KB, limit 4 MB)"
  //    by the daemon's promote pipeline.
  if (
    code === 'swm_gossip_payload_too_large' ||
    code === 'payload_too_large' ||
    (message.includes('gossip') && (message.includes('limit') || message.includes('too large'))) ||
    message.includes('promoted assertion too large')
  ) {
    return { classification: 'cap_exceeded', retryable: false };
  }

  // 2. 256 KB body cap on /promote — surfaced as
  //    "Request body too large (>262144 bytes)".
  if (message.includes('request body too large') || message.includes('payload too large')) {
    return { classification: 'cap_exceeded', retryable: false };
  }

  // Managed-store recovery can declare the exact operation outcome. A request
  // rejected before dispatch is safe to retry. Interrupted reads cannot have
  // mutated WM/SWM. The one safe mutation is atomic exact-graph replacement:
  // replaying the same frozen promote payload converges from either permitted
  // old-or-new outcome. Every other interrupted write remains fail-closed.
  if (isStoreOperationTimeoutError(err)) {
    if (
      err.outcome === 'not_started' ||
      (
        err.outcome === 'indeterminate' &&
        err.storeOperation !== undefined &&
        (
          isReadOnlyStoreOperation(err.storeOperation)
          // Promote replaces the complete UAL-derived SWM graph through the
          // atomic replaceGraph capability. Replaying the same frozen payload
          // converges from either permitted old-or-new outcome.
          || err.storeOperation === 'replaceGraph'
        )
      )
    ) {
      return { classification: 'transient', retryable: true };
    }

    // Typed store outcomes are authoritative. In particular, never let an
    // indeterminate mutation fall through to generic words such as "timeout"
    // below: its first attempt may already have changed durable state.
    return { classification: 'fatal', retryable: false };
  }

  // Scheduler overload is a typed pre-dispatch rejection: the store closure
  // never started, so both promotion execution and fenced queue bookkeeping
  // may retry it without relying on the diagnostic wording.
  if (err instanceof StoreSchedulerBusyError) {
    return { classification: 'transient', retryable: true };
  }

  // Store failures without the canonical typed outcome are not safe to infer
  // from prose. Keep them out of the generic network-timeout fallback even
  // when a legacy message happens to contain words such as "timeout".
  if (
    code === 'store_operation_timeout'
    || code === 'store_scheduler_busy'
    || message.includes('managed oxigraph')
    || message.includes('store scheduler')
  ) {
    return { classification: 'fatal', retryable: false };
  }

  // 3. Transient network / IO — the rc.10 importer hit "fetch failed"
  //    multiple times under sustained load. Worker should retry.
  if (
    message.includes('fetch failed') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('etimedout') ||
    message.includes('socket hang up') ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('timed out')
  ) {
    return { classification: 'transient', retryable: true };
  }

  // 4. Default: fatal, no retry. Operator can `POST .../recover` after
  //    fixing whatever's wrong.
  return { classification: 'fatal', retryable: false };
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
export async function runPromoteJob(
  args: {
    job: PromoteJob;
    queue: AsyncPromoteQueue;
    workerId: string;
    runPromote: (
      request: PromoteRequest,
      markPromoteStarted: () => Promise<void>,
    ) => Promise<{ promotedCount: number }>;
    now: () => number;
    heartbeatIntervalMs: number;
    bookkeepingRetryIntervalMs?: number;
    bookkeepingRetryBudgetMs?: number;
    sleep?: (ms: number) => Promise<void>;
    shutdownSignal?: AbortSignal;
    log: PromoteWorkerLogger;
    emitMemoryGraphChanged?: (event: PromoteMemoryGraphChangedEvent) => void;
  },
): Promise<{
  outcome:
    | 'succeeded'
    | 'failed_retrying'
    | 'failed_terminal'
    | 'partial_promote_ambiguity';
  error?: ClassifiedPromoteError;
}> {
  const {
    job,
    queue,
    runPromote,
    now,
    heartbeatIntervalMs,
    bookkeepingRetryIntervalMs = 5_000,
    bookkeepingRetryBudgetMs = 10 * 60 * 1000,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    shutdownSignal,
    log,
    emitMemoryGraphChanged,
  } = args;
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
      queue.heartbeat(job.jobId, claimToken).catch((err: unknown) => {
        if (err instanceof PromoteJobLeaseError) {
          // Expected when the job has already succeeded/failed and the lease was cleared.
          return;
        }
        bestEffortLog(
          log,
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
          bestEffortLog(
            log,
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

  try {
    let result: { promotedCount: number };
    let promoteStartedMarked = false;
    const markPromoteStarted = async (): Promise<void> => {
      if (promoteStartedMarked) return;
      throwIfShutdownInterrupted();
      await queue.recordCommitMarker(job.jobId, claimToken, 'promoteStarted');
      promoteStartedMarked = true;
    };
    try {
      result = await runPromote(job.request, markPromoteStarted);
    } catch (err: unknown) {
      throwIfShutdownInterrupted();
      const classified = classifyPromoteError(err);
      const message = err instanceof Error ? err.message : String(err);
      logPromoteAttemptFailure({
        job,
        err,
        message,
        classified,
        promoteStarted: promoteStartedMarked,
        log,
      });
      const attemptError: PromoteAttemptError = {
        message,
        retryable: classified.retryable,
        classification: classified.classification,
        recordedAt: now(),
      };
      try {
        const bookkeepingDeadlineAt = now() + Math.max(0, bookkeepingRetryBudgetMs);
        await persistWithRecovery(
          'record failure',
          bookkeepingDeadlineAt,
          () => queue.fail(job.jobId, claimToken, attemptError),
        );
      } catch (failErr: unknown) {
        if (failErr instanceof PromoteJobLeaseError) {
          bestEffortLog(log, `Lease lost while recording failure for ${job.jobId}: ${message}`);
        } else {
          throw failErr;
        }
      }
      // Determine final outcome by re-reading state — the queue decides retrying vs terminal.
      throwIfShutdownInterrupted();
      const updated = await queue.getStatus(job.jobId);
      const outcome = updated?.state === 'failed_retrying' ? 'failed_retrying' : 'failed_terminal';
      return { outcome, error: classified };
    }

    // Plan §7 recommendation (b): single OUTER commit-marker after
    // `assertionPromote` returns. We can't observe the internal phases
    // (WM clean / lifecycle stamp / gossip), so only stamp the recovery
    // gate the queue actually consumes.
    //
    // Codex (#665#discussion_r3302646439): `assertion.promote()` has
    // ALREADY mutated SWM / gossiped data at this point. Retry only the
    // queue bookkeeping when a recognized transient store/network error
    // interrupts either of the next two writes. We MUST NOT rerun the
    // promote itself or let the outer worker park this as a normal
    // `failed` row — that would expose it to
    // `/promote-async/{jobId}/recover`, which blindly re-queues
    // `failed` jobs. Re-running an already-completed promote risks
    // duplicate WM/SWM writes and re-gossip. Instead, return the
    // dedicated `partial_promote_ambiguity` outcome so the supervisor
    // leaves the job in `running` state; on next daemon boot the lease
    // will have expired and `recoverOnStartup()` will correctly route
    // it into the "abandoned partial promote" bucket (promoteStarted
    // = true, swmInserted = false → operator action required).
    throwIfShutdownInterrupted();
    const bookkeepingDeadlineAt = now() + Math.max(0, bookkeepingRetryBudgetMs);
    try {
      await persistWithRecovery('record swmInserted', bookkeepingDeadlineAt, () =>
        queue.recordCommitMarker(job.jobId, claimToken, 'swmInserted'),
      );
      await persistWithRecovery('record success', bookkeepingDeadlineAt, () =>
        queue.succeed(job.jobId, claimToken, {
          promotedCount: result.promotedCount,
          succeededAt: now(),
        }),
      );
    } catch (bookkeepingErr: unknown) {
      if (bookkeepingErr instanceof PromoteWorkerShutdownError) throw bookkeepingErr;
      const message =
        bookkeepingErr instanceof Error
          ? bookkeepingErr.message
          : String(bookkeepingErr);
      bestEffortLog(
        log,
        `PARTIAL-PROMOTE-AMBIGUITY: jobId=${job.jobId} ` +
          `assertion.promote() returned successfully (promotedCount=${result.promotedCount}) ` +
          `but post-promote bookkeeping failed: ${message}. ` +
          `Leaving job in 'running' state; recoverOnStartup() will pick this up ` +
          `on next boot as abandoned partial promote. ` +
          `Operator action: inspect SWM/VM for the assertion before any /recover.`,
      );
      return {
        outcome: 'partial_promote_ambiguity',
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
        bestEffortLog(
          log,
          `memoryGraphChanged emit failed for ${job.jobId}: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`,
        );
      }
    }

    return { outcome: 'succeeded' };
  } finally {
    shutdownSignal?.removeEventListener('abort', stopHeartbeats);
    stopHeartbeats();
  }
}

interface WorkerSlot {
  workerId: string;
  inFlight: Promise<void> | null;
  tickInFlight: Promise<boolean> | null;
  timer: ReturnType<typeof setInterval> | null;
}

export function createPromoteWorkerSupervisor(config: PromoteWorkerConfig): PromoteWorkerSupervisor {
  const concurrency = Math.max(1, config.workerConcurrency ?? 4);
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
  const now = config.now ?? (() => Date.now());
  const log: PromoteWorkerLogger =
    config.log ?? ((msg: string) => console.warn(`[promote-worker] ${msg}`));
  const workerIdPrefix = config.workerIdPrefix ?? `daemon-${process.pid}`;
  const slots: WorkerSlot[] = Array.from({ length: concurrency }, (_, i) => ({
    workerId: `${workerIdPrefix}-slot-${i}`,
    inFlight: null,
    tickInFlight: null,
    timer: null,
  }));
  let shuttingDown = false;
  let started = false;
  let lifecycleAbortController: AbortController | null = null;
  let counters: PromoteWorkerCounters = freshCounters();

  function freshCounters(): PromoteWorkerCounters {
    return {
      succeeded: 0,
      failedTerminal: 0,
      failedRetrying: 0,
      partialPromoteAmbiguity: 0,
      attempted: 0,
      interruptedAtShutdown: 0,
    };
  }

  async function tickSlot(slot: WorkerSlot): Promise<boolean> {
    if (shuttingDown || slot.inFlight) return false;
    const claimed = await config.agent.promoteQueue.claimNext(slot.workerId).catch((err: unknown) => {
      bestEffortLog(
        log,
        `claimNext error on ${slot.workerId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    });
    if (!claimed) return false;

    counters.attempted += 1;
    const shutdownSignal = lifecycleAbortController?.signal;
    const run = (async () => {
      try {
        const outcome = await runPromoteJob({
          job: claimed,
          queue: config.agent.promoteQueue,
          workerId: slot.workerId,
          runPromote: async (request, markPromoteStarted) => {
            const entities: 'all' | string[] | undefined =
              request.entities === undefined
                ? undefined
                : request.entities === 'all'
                ? 'all'
                : [...request.entities];
            await markPromoteStarted();
            return config.agent.assertion.promote(request.contextGraphId, request.assertionName, {
              entities,
              subGraphName: request.subGraphName,
              ...(request.agentAddress ? { agentAddress: request.agentAddress } : {}),
              ...(request.authorAgentAddress ? { authorAgentAddress: request.authorAgentAddress } : {}),
            });
          },
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
          case 'partial_promote_ambiguity':
            counters.partialPromoteAmbiguity += 1;
            break;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof PromoteWorkerShutdownError || shutdownSignal?.aborted) {
          bestEffortLog(
            log,
            `Worker ${slot.workerId} stopped bookkeeping for ${claimed.jobId} after shutdown timeout`,
          );
          return;
        }
        bestEffortLog(log, `Worker ${slot.workerId} crashed processing ${claimed.jobId}: ${message}`);
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
              bestEffortLog(
                log,
                `Lease lost while parking crashed job ${claimed.jobId}: ${failMessage}`,
              );
            } else {
              bestEffortLog(
                log,
                `Failed to park crashed job ${claimed.jobId}; next startup recovery must reconcile it: ` +
                  `${failMessage}`,
              );
            }
          }
        }
      } finally {
        slot.inFlight = null;
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
    for (const slot of slots) {
      const claimed = await scheduleTick(slot);
      if (claimed) picked += 1;
    }
    return picked;
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
      try {
        const summary = await config.agent.promoteQueue.recoverOnStartup();
        if (summary.reclaimed > 0 || summary.abandoned > 0) {
          bestEffortLog(
            log,
            `recoverOnStartup: reclaimed=${summary.reclaimed} abandoned=${summary.abandoned}`,
          );
        }
      } catch (err: unknown) {
        lifecycleAbortController.abort();
        lifecycleAbortController = null;
        started = false;
        shuttingDown = true;
        throw new Error(`recoverOnStartup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (shuttingDown) {
        started = false;
        return;
      }
      for (const slot of slots) {
        slot.timer = setInterval(() => {
          if (shuttingDown) return;
          void scheduleTick(slot);
        }, pollIntervalMs);
        if (slot.timer.unref) slot.timer.unref();
      }
    },
    async stop() {
      if (!started) return;
      shuttingDown = true;
      for (const slot of slots) {
        if (slot.timer) {
          clearInterval(slot.timer);
          slot.timer = null;
        }
      }
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
        bestEffortLog(
          log,
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
