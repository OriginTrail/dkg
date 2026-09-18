/**
 * Generic prover-loop driver: takes a prover-shaped object and runs
 * `tick()` on a timer with single-flight semantics. Lives in
 * `dkg-random-sampling` so it has a cheap unit-test surface (no
 * Hardhat / agent fixtures needed); the agent's bind layer is the
 * only caller.
 *
 * Why split this out: the agent's bind layer is ~30 lines of
 * role-gating + dependency wiring; the timer + onTick + idempotent
 * stop logic is the part with non-trivial behavior. Putting it here
 * makes both files easy to read and test.
 */

import type { ProverLogger, TickOutcome } from './prover.js';

export interface TickableProver {
  tick(): Promise<TickOutcome>;
  cancel?(reason?: unknown): void;
  close(): Promise<void>;
}

/**
 * Snapshot of the loop's most recent activity. The bind layer
 * surfaces this through the agent's HTTP API so operators can
 * answer "is my prover working?" without tailing logs.
 */
export interface ProverLoopStatus {
  /** Number of ticks attempted since `start()`. Reset on a new loop. */
  totalTicks: number;
  /** Whether a tick is currently in flight. */
  inflight: boolean;
  /** Wall-clock ISO-8601 timestamp of the most recent tick (or null). */
  lastTickAt: string | null;
  /** Outcome of the most recent tick (or null if no tick has run). */
  lastOutcome: TickOutcome | null;
  /** Number of ticks that produced a `submitted` outcome. */
  submittedCount: number;
  /** Most recent submitted txHash, if any. */
  lastSubmittedTxHash: string | null;
  /** Wall-clock ISO-8601 timestamp of the most recent `submitted` outcome. */
  lastSubmittedAt: string | null;
  /** Number of challenges observed during the process-local trailing 24-hour window. */
  challengesReceived24h?: number;
  /** Number of proofs submitted during the process-local trailing 24-hour window. */
  proofsSubmitted24h?: number;
  /** Most recent classified proof-path failure, if one has occurred. */
  lastFailureClassification?: string | null;
  /** Wall-clock ISO-8601 timestamp of the most recent classified failure. */
  lastFailureAt?: string | null;
}

export interface ProverLoopOptions {
  prover: TickableProver;
  /** Tick cadence in ms. */
  intervalMs: number;
  /** Fired after every tick (success or mapped failure) — observability only. */
  onTick?: (outcome: TickOutcome) => void;
  log?: ProverLogger;
  /** Injectable clock for deterministic health-window tests. */
  now?: () => number;
}

const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;

type HealthEvent = {
  at: number;
  challengeReceived: boolean;
  proofSubmitted: boolean;
};

function outcomeHasChallenge(outcome: TickOutcome): boolean {
  // A no-challenge result is the only explicit proof that no challenge was
  // available. All later outcomes came from a challenge-scoped path.
  return outcome.kind !== 'no-challenge' && outcome.kind !== 'period-closed' && outcome.kind !== 'error';
}

function outcomeIsFailure(outcome: TickOutcome): boolean {
  return outcome.kind === 'cg-not-found'
    || outcome.kind === 'kc-not-synced'
    || outcome.kind === 'data-corrupted'
    || outcome.kind === 'submit-stale'
    || outcome.kind === 'error';
}

export interface ProverLoopHandle {
  /** Idempotent: subsequent calls are no-ops. */
  start(): void;
  /**
   * Idempotent. Cancels the timer and handle-owned work, then returns the one
   * stable physical-close promise. The owning lifecycle may apply its own
   * bounded wait without changing when the prover is actually safe to release.
   */
  stop(): Promise<void>;
  /** Snapshot of recent activity for observability surfaces. */
  getStatus(): ProverLoopStatus;
}

export function startProverLoop(opts: ProverLoopOptions): ProverLoopHandle {
  const now = opts.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let stopping = false;
  let inflight = false;
  let inflightRun: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let totalTicks = 0;
  let lastTickAt: string | null = null;
  let lastOutcome: TickOutcome | null = null;
  let submittedCount = 0;
  let lastSubmittedTxHash: string | null = null;
  let lastSubmittedAt: string | null = null;
  const healthEvents: HealthEvent[] = [];
  let lastFailureClassification: string | null = null;
  let lastFailureAt: string | null = null;

  const pruneHealthEvents = (at: number): void => {
    const cutoff = at - HEALTH_WINDOW_MS;
    while (healthEvents.length > 0 && healthEvents[0]!.at <= cutoff) healthEvents.shift();
  };

  const runOnce = (): Promise<void> => {
    if (inflight || stopping) return Promise.resolve();
    inflight = true;
    totalTicks += 1;
    const tickStartedAt = now();
    lastTickAt = new Date(tickStartedAt).toISOString();
    const run = (async (): Promise<void> => {
      try {
        const outcome = await opts.prover.tick();
        lastOutcome = outcome;
        const completedAt = now();
        healthEvents.push({
          at: completedAt,
          challengeReceived: outcomeHasChallenge(outcome),
          proofSubmitted: outcome.kind === 'submitted',
        });
        pruneHealthEvents(completedAt);
        if (outcome.kind === 'submitted') {
          submittedCount += 1;
          lastSubmittedTxHash = outcome.txHash;
          lastSubmittedAt = new Date(completedAt).toISOString();
        }
        if (outcomeIsFailure(outcome)) {
          lastFailureClassification = outcome.kind;
          lastFailureAt = new Date(completedAt).toISOString();
        }
        try {
          opts.onTick?.(outcome);
        } catch (err) {
          opts.log?.warn('rs.loop.onTick-threw', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastOutcome = { kind: 'error', error };
        const completedAt = now();
        healthEvents.push({ at: completedAt, challengeReceived: false, proofSubmitted: false });
        pruneHealthEvents(completedAt);
        lastFailureClassification = 'error';
        lastFailureAt = new Date(completedAt).toISOString();
        // The orchestrator already maps known errors to TickOutcome
        // variants. An exception here means an unmapped path
        // (typically a transient adapter / RPC issue). Log and keep
        // the timer alive so the next tick has a chance.
        opts.log?.error('rs.loop.tick-threw', {
          err: error.message,
        });
        try {
          opts.onTick?.(lastOutcome);
        } catch (hookErr) {
          opts.log?.warn('rs.loop.onTick-threw', {
            err: hookErr instanceof Error ? hookErr.message : String(hookErr),
          });
        }
      } finally {
        inflight = false;
      }
    })();
    inflightRun = run;
    void run.finally(() => {
      if (inflightRun === run) inflightRun = null;
    });
    return run;
  };

  return {
    start() {
      if (started || stopping) return;
      started = true;
      // One immediate tick so the operator sees activity in logs
      // without waiting `intervalMs`.
      runOnce();
      timer = setInterval(() => { runOnce(); }, opts.intervalMs);
      if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref?: () => void }).unref?.();
      }
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      opts.prover.cancel?.(new DOMException(
        'Random Sampling prover loop stopped',
        'AbortError',
      ));
      const running = inflightRun;
      stopPromise = (async () => {
        // Never release builder / WAL resources underneath a tick. The owner
        // may stop waiting at a bounded deadline, but this physical shutdown
        // remains attached until the tick retires and close finishes.
        if (running) await running;
        await opts.prover.close();
      })();
      void stopPromise.catch((err) => {
        opts.log?.error('rs.loop.shutdown-failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      });
      return stopPromise;
    },
    getStatus(): ProverLoopStatus {
      const at = now();
      pruneHealthEvents(at);
      return {
        totalTicks,
        inflight,
        lastTickAt,
        lastOutcome,
        submittedCount,
        lastSubmittedTxHash,
        lastSubmittedAt,
        challengesReceived24h: healthEvents.filter((event) => event.challengeReceived).length,
        proofsSubmitted24h: healthEvents.filter((event) => event.proofSubmitted).length,
        lastFailureClassification,
        lastFailureAt,
      };
    },
  };
}
