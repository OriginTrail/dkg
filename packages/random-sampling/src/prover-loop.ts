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

import {
  classifyTickOutcome,
  type ChallengePeriod,
  type ProverLogger,
  type TickFailureKind,
  type TickOutcome,
} from './prover.js';

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
  /**
   * Distinct challenges (proof periods) this process first saw in the trailing
   * 24 hours. Repeated ticks on one period count once. Process-local: a period
   * first seen as already solved (for example, proved before a restart) counts
   * here without a matching proof below. A tick that threw is not attributed
   * to any period.
   */
  challengesReceived24h: number;
  /**
   * Of the periods counted in `challengesReceived24h`, how many this process
   * submitted a proof for. Never exceeds `challengesReceived24h`.
   */
  proofsSubmitted24h: number;
  /** Kind of the most recent failed tick, or null if none has failed. */
  lastFailureClassification: TickFailureKind | null;
  /** Wall-clock ISO-8601 timestamp of the most recent failed tick. */
  lastFailureAt: string | null;
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

/** One distinct challenge (proof period) inside the health window. */
interface ObservedChallenge {
  /** Completion time of the first tick that reported this period. */
  readonly firstSeenAt: number;
  proofSubmitted: boolean;
}

function challengeKey(period: ChallengePeriod): string {
  return `${period.epoch}:${period.periodStartBlock}`;
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
  // One entry per proof period, in first-seen order, so pruning pops the front.
  const observedChallenges = new Map<string, ObservedChallenge>();
  let lastFailureClassification: TickFailureKind | null = null;
  let lastFailureAt: string | null = null;

  const pruneObservedChallenges = (at: number): void => {
    const cutoff = at - HEALTH_WINDOW_MS;
    for (const [key, observed] of observedChallenges) {
      if (observed.firstSeenAt > cutoff) break;
      observedChallenges.delete(key);
    }
  };

  /** The one place a settled tick, returned or thrown, updates the snapshot. */
  const recordOutcome = (outcome: TickOutcome, at: number): void => {
    lastOutcome = outcome;
    pruneObservedChallenges(at);
    const health = classifyTickOutcome(outcome);
    if (health.challenge !== null) {
      const key = challengeKey(health.challenge);
      let observed = observedChallenges.get(key);
      if (observed === undefined) {
        observed = { firstSeenAt: at, proofSubmitted: false };
        observedChallenges.set(key, observed);
      }
      if (health.proofSubmitted) observed.proofSubmitted = true;
    }
    if (outcome.kind === 'submitted') {
      submittedCount += 1;
      lastSubmittedTxHash = outcome.txHash;
      lastSubmittedAt = new Date(at).toISOString();
    }
    if (health.failure !== null) {
      lastFailureClassification = health.failure;
      lastFailureAt = new Date(at).toISOString();
    }
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
        recordOutcome(outcome, now());
        try {
          opts.onTick?.(outcome);
        } catch (err) {
          opts.log?.warn('rs.loop.onTick-threw', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const outcome: TickOutcome = { kind: 'error', error };
        recordOutcome(outcome, now());
        // The orchestrator already maps known errors to TickOutcome
        // variants. An exception here means an unmapped path
        // (typically a transient adapter / RPC issue). Log and keep
        // the timer alive so the next tick has a chance.
        opts.log?.error('rs.loop.tick-threw', {
          err: error.message,
        });
        try {
          opts.onTick?.(outcome);
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
      pruneObservedChallenges(now());
      let proofsSubmitted24h = 0;
      for (const observed of observedChallenges.values()) {
        if (observed.proofSubmitted) proofsSubmitted24h += 1;
      }
      return {
        totalTicks,
        inflight,
        lastTickAt,
        lastOutcome,
        submittedCount,
        lastSubmittedTxHash,
        lastSubmittedAt,
        challengesReceived24h: observedChallenges.size,
        proofsSubmitted24h,
        lastFailureClassification,
        lastFailureAt,
      };
    },
  };
}
