// daemon/catchup-telemetry.ts
//
// Catch-up request/job accounting (W1 instruments I7–I9) plus the job ledger
// the graceful-shutdown path drains.
//
// Lives in its own module — rather than on `CatchupTracker` — because two
// modules that never import each other need the SAME object: the subscribe
// route in `routes/context-graph.ts` mints jobs, and `lifecycle.ts` drains
// them during shutdown. That is the same reason `state.ts` exists, and it
// keeps `CatchupTracker` a plain data bag that route tests can build by hand.
//
// Two invariants govern everything here:
//
//   1. **Requests are not jobs.** They are N:1 — a dedupe returns a running
//      job, an already-ready replay returns a completed one, and `400`/`403`
//      plus authority/shutdown `503`s mint nothing at all. I7 counts route returns;
//      I8 counts job identities.
//   2. **Instrumentation never throws.** Every record site is synchronous and
//      swallowed. The walk job's terminal point is emitted from a detached,
//      `void`ed continuation, where an escaping throw would become an
//      unhandled rejection rather than a failed metric.

import { getMetrics } from '@origintrail-official/dkg-core';
import type { CatchupJob, CatchupJobState } from './types.js';
import { isTerminalCatchupJobState } from '../catchup-status.js';

/**
 * Grace period the shutdown drain gives in-flight walks to settle normally.
 *
 * Sized against `SHUTDOWN_HARD_TIMEOUT_MS` (15 s): 5 s here plus the 2 s
 * terminal-flush reserve leaves ~8 s for runner close, `agent.stop()`, the
 * final telemetry shutdown and the database close.
 */
export const CATCHUP_SHUTDOWN_DRAIN_BUDGET_MS = 5_000;

/** Which of the two mint sites produced a job. */
export type CatchupAdmission = 'walk' | 'synthetic';

/**
 * Closed `result` vocabulary for I7 — one value per subscribe-route return.
 * `shutting_down` covers BOTH admission guards; they are distinguishable by
 * `admission` on the job side only when a job exists, which for a 503 it never
 * does, and that is the point.
 */
export type CatchupRequestResult =
  | 'bad_request'
  | 'forbidden'
  | 'authority_unavailable'
  | 'deduped'
  | 'ready_replay'
  | 'ready_synthetic'
  | 'queued'
  | 'shutting_down';

/**
 * A job whose terminal record is still owed, plus the continuation that will
 * produce it.
 *
 * `terminalRecorded` lives on THIS object rather than being derived from
 * `catchupTracker.jobs`, and the difference is load-bearing: that map prunes
 * to 100 entries by oldest `queuedAt` regardless of status, so a long-running
 * job can be evicted while still in flight. Keying idempotency off it would
 * let a job be counted twice, or not at all.
 */
export interface CatchupJobLedgerEntry {
  readonly job: CatchupJob;
  readonly admission: CatchupAdmission;
  /**
   * Monotonic start for I9. `Date.now()` deltas can go negative across an NTP
   * step, and catch-up walks are long enough (measured runs of 305 s and
   * 382 s) for that to be a real sample.
   */
  readonly startedAtMono: number;
  /** Retained continuation; the shutdown drain awaits it. Never rejects. */
  task?: Promise<void>;
  terminalRecorded: boolean;
}

/**
 * Live walk jobs, keyed by jobId. Synthetic jobs are born terminal and never
 * enter it — there is nothing to drain and their record is emitted at once.
 */
const ledger = new Map<string, CatchupJobLedgerEntry>();

/**
 * A job that never reached a terminal state is reported as `failed`.
 *
 * Reached when the shutdown drain expires with a walk still in flight. It is
 * the truthful label: the daemon is about to terminate the worker, whose exit
 * handler rejects every pending run, so the job's own `finally` — if it ever
 * runs — would have written `failed` anyway. Clamping here keeps `status` a
 * closed vocabulary instead of leaking `running` into the series.
 */
function terminalStatusFor(job: CatchupJob): CatchupJobState {
  return isTerminalCatchupJobState(job.status) ? job.status : 'failed';
}

/** I7 — one point per subscribe-route return. Never throws. */
export function recordCatchupRequest(
  result: CatchupRequestResult,
  includeSharedMemory: boolean,
): void {
  try {
    getMetrics().contextGraphCatchupRequestsTotal.add(1, {
      result,
      include_shared_memory: includeSharedMemory,
    });
  } catch {
    /* instrumentation must never break the route */
  }
}

/**
 * I8 (+ I9 for walks) — at most one point per jobId, ever.
 *
 * Synchronous and non-throwing by construction, because the walk call site is
 * a detached task's `finally`. The idempotency bit is set BEFORE the record so
 * that even a throw inside the metric API cannot produce a second point.
 */
export function recordTerminalOnce(entry: CatchupJobLedgerEntry): void {
  if (entry.terminalRecorded) return;
  entry.terminalRecorded = true;
  try {
    const metrics = getMetrics();
    metrics.contextGraphCatchupJobsTotal.add(1, {
      status: terminalStatusFor(entry.job),
      admission: entry.admission,
    });
    // I9 is walk-only. A synthetic job has queuedAt = startedAt = finishedAt
    // and never ran anything, so a 0 ms sample would only dilute the histogram
    // the catch-up buckets exist to resolve.
    if (entry.admission === 'walk') {
      metrics.contextGraphCatchupJobDurationMs.record(
        Math.max(0, performance.now() - entry.startedAtMono),
        { admission: entry.admission },
      );
    }
  } catch {
    /* instrumentation must never break shutdown or a catch-up job */
  }
}

/**
 * Register a walk job and return its ledger entry. The caller assigns
 * `entry.task` once the continuation exists, and must pass the ENTRY (not the
 * jobId) into that closure, so releasing the map slot cannot erase the
 * idempotency bit before a late `finally` runs.
 */
export function beginWalkCatchupJob(job: CatchupJob): CatchupJobLedgerEntry {
  const entry: CatchupJobLedgerEntry = {
    job,
    admission: 'walk',
    startedAtMono: performance.now(),
    terminalRecorded: false,
  };
  ledger.set(job.jobId, entry);
  return entry;
}

/**
 * Drop a settled walk job from the drain set. Deletes only if the slot still
 * holds THIS entry, so a re-used id can never evict a newer job.
 */
export function releaseCatchupJob(entry: CatchupJobLedgerEntry): void {
  if (ledger.get(entry.job.jobId) === entry) ledger.delete(entry.job.jobId);
}

/** I8 for the already-ready mint: born terminal, recorded immediately. */
export function recordSyntheticCatchupJob(job: CatchupJob): void {
  recordTerminalOnce({
    job,
    admission: 'synthetic',
    startedAtMono: performance.now(),
    terminalRecorded: false,
  });
}

/**
 * Grace drain for graceful shutdown: let in-flight walks settle normally,
 * then record a terminal point for every job still owed one.
 *
 * MUST run while the catch-up runner's worker is still alive. `close()` IS
 * `worker.terminate()`, and the constructor-registered `exit` handler rejects
 * every pending run — so draining after termination grants no grace at all, it
 * merely observes every job being forced onto its `failed` path.
 *
 * Bounded by `budgetMs`: on expiry the still-running jobs are recorded as
 * `failed` and their late `finally` becomes a no-op, so a hung walk cannot eat
 * the shutdown deadline.
 */
export async function drainCatchupJobs(
  budgetMs: number,
  log: (message: string) => void = () => {},
): Promise<{ drained: number; expired: boolean }> {
  const entries = [...ledger.values()];
  const tasks = entries.flatMap((entry) => (entry.task ? [entry.task] : []));
  let expired = false;
  if (tasks.length > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), budgetMs);
    });
    try {
      expired = (await Promise.race([Promise.allSettled(tasks), budget])) === 'expired';
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (expired) {
      log(
        `[catchup-drain] ${tasks.length} catch-up job(s) did not settle within ${budgetMs}ms; ` +
          'recording them as failed and continuing shutdown.',
      );
    }
  }
  for (const entry of entries) recordTerminalOnce(entry);
  // TRAP FOR TEST AUTHORS: this `clear()` empties the ledger unconditionally,
  // so ANY `catchupLedgerSize()` assertion placed after a drain is
  // unfalsifiable — it reads 0 whatever `releaseCatchupJob` did, or did not,
  // do. A positive control for the release guard was once written just below a
  // drain for exactly this reason and could not fail. Assert ledger size only
  // in a test that never calls this function.
  ledger.clear();
  return { drained: entries.length, expired };
}

/** Test seam: the ledger is process-global, like `daemonState`. */
export function resetCatchupJobLedger(): void {
  ledger.clear();
}

/** Test seam: current in-flight walk count. */
export function catchupLedgerSize(): number {
  return ledger.size;
}
