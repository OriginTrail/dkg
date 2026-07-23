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

export interface PromoteWorkerConfig {
  /** The host DKG agent — provides the queue + the sync `promote` call. */
  agent: DKGAgent;
  /** Number of concurrent worker loops (default 4 — RFC §4.5). */
  workerConcurrency?: number;
  /** Polling interval for claimNext (default 100ms). */
  pollIntervalMs?: number;
  /**
   * Heartbeat interval. Must be SHORTER than the queue's `leaseMs`
   * (default 5min); default 60s = 5× safety margin.
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
  log?: (msg: string) => void;
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
  const untagged = (raw ?? '').replace(/^\[promote:[^\]]*\]\s*/, '');
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
    log: (msg: string) => void;
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
  const { job, queue, runPromote, now, heartbeatIntervalMs, log, emitMemoryGraphChanged } = args;
  if (!job.lease) {
    throw new Error(`runPromoteJob requires a job with an active lease (jobId=${job.jobId})`);
  }
  const claimToken = job.lease.claimToken;

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let cancelled = false;
  if (heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      if (cancelled) return;
      queue.heartbeat(job.jobId, claimToken).catch((err: unknown) => {
        if (err instanceof PromoteJobLeaseError) {
          // Expected when the job has already succeeded/failed and the lease was cleared.
          return;
        }
        log(`Heartbeat error for ${job.jobId}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, heartbeatIntervalMs);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }

  try {
    let result: { promotedCount: number };
    let promoteStartedMarked = false;
    const markPromoteStarted = async (): Promise<void> => {
      if (promoteStartedMarked) return;
      await queue.recordCommitMarker(job.jobId, claimToken, 'promoteStarted');
      promoteStartedMarked = true;
    };
    try {
      result = await runPromote(job.request, markPromoteStarted);
    } catch (err: unknown) {
      const classified = classifyPromoteError(err);
      const message = err instanceof Error ? err.message : String(err);
      const attemptError: PromoteAttemptError = {
        message,
        retryable: classified.retryable,
        classification: classified.classification,
        recordedAt: now(),
      };
      try {
        await queue.fail(job.jobId, claimToken, attemptError);
      } catch (failErr: unknown) {
        if (failErr instanceof PromoteJobLeaseError) {
          log(`Lease lost while recording failure for ${job.jobId}: ${message}`);
        } else {
          throw failErr;
        }
      }
      // Determine final outcome by re-reading state — the queue decides retrying vs terminal.
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
    // ALREADY mutated SWM / gossiped data at this point. If either of
    // the next two writes throws (store hiccup, lost lease, transient
    // FS error, …), we MUST NOT let the outer worker catch park this
    // job as a normal `failed` row — that would expose it to
    // `/promote-async/{jobId}/recover`, which blindly re-queues
    // `failed` jobs. Re-running an already-completed promote risks
    // duplicate WM/SWM writes and re-gossip. Instead, return the
    // dedicated `partial_promote_ambiguity` outcome so the supervisor
    // leaves the job in `running` state; on next daemon boot the lease
    // will have expired and `recoverOnStartup()` will correctly route
    // it into the "abandoned partial promote" bucket (promoteStarted
    // = true, swmInserted = false → operator action required).
    try {
      await queue.recordCommitMarker(job.jobId, claimToken, 'swmInserted');
      await queue.succeed(job.jobId, claimToken, {
        promotedCount: result.promotedCount,
        succeededAt: now(),
      });
    } catch (bookkeepingErr: unknown) {
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
        log(`memoryGraphChanged emit failed for ${job.jobId}: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`);
      }
    }

    return { outcome: 'succeeded' };
  } finally {
    cancelled = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

interface WorkerSlot {
  workerId: string;
  inFlight: Promise<void> | null;
  tickInFlight: Promise<boolean> | null;
  timer: ReturnType<typeof setInterval> | null;
}

const DEFAULT_PROMOTE_LEASE_MS = 5 * 60 * 1000;

export function createPromoteWorkerSupervisor(config: PromoteWorkerConfig): PromoteWorkerSupervisor {
  const concurrency = Math.max(1, config.workerConcurrency ?? 4);
  const pollIntervalMs = Math.max(10, config.pollIntervalMs ?? 100);
  const heartbeatIntervalMs = config.heartbeatIntervalMs ?? 60_000;
  if (heartbeatIntervalMs > 0 && heartbeatIntervalMs >= DEFAULT_PROMOTE_LEASE_MS) {
    throw new Error(
      `promoteQueue.heartbeatIntervalMs must be shorter than the queue lease (${DEFAULT_PROMOTE_LEASE_MS}ms)`,
    );
  }
  const shutdownTimeoutMs = config.shutdownTimeoutMs ?? 30_000;
  const now = config.now ?? (() => Date.now());
  const log = config.log ?? ((msg: string) => console.warn(`[promote-worker] ${msg}`));
  const workerIdPrefix = config.workerIdPrefix ?? `daemon-${process.pid}`;
  const slots: WorkerSlot[] = Array.from({ length: concurrency }, (_, i) => ({
    workerId: `${workerIdPrefix}-slot-${i}`,
    inFlight: null,
    tickInFlight: null,
    timer: null,
  }));
  let shuttingDown = false;
  let started = false;
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
      log(`claimNext error on ${slot.workerId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (!claimed) return false;

    counters.attempted += 1;
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
        log(`Worker ${slot.workerId} crashed processing ${claimed.jobId}: ${message}`);
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
              log(`Lease lost while parking crashed job ${claimed.jobId}: ${failMessage}`);
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
      counters = freshCounters();
      try {
        const summary = await config.agent.promoteQueue.recoverOnStartup();
        if (summary.reclaimed > 0 || summary.abandoned > 0) {
          log(`recoverOnStartup: reclaimed=${summary.reclaimed} abandoned=${summary.abandoned}`);
        }
      } catch (err: unknown) {
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
      }
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
