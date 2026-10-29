/**
 * The one timer of queue retention (OT-RFC-73 P10b): it runs every registered sweep's `runBatch` on that sweep's interval.
 *
 * A sweep is passive (the share core, and later the publisher's, only does work when called). Each sweep gets its own chain of timeouts: the next tick is scheduled
 * only after the previous one has settled, so a sweep never overlaps itself, and a slow batch simply delays its own next tick. The first tick comes one interval
 * after the start, not at once: the core has no clock baseline for a first tick, and a host that has just booted may not have a synchronised clock yet.
 *
 * A failure never leaves the sweep's chain: a batch that throws, or returns the store failure it already counted, is logged (the first failure of a streak and
 * every tenth after it, so a store that stays down is not logged every interval) and the sweep ticks again after its interval. Nothing here can throw into the
 * daemon. `stop()` clears the pending timeouts, lets a batch that is already running finish (for a bounded time) and starts no further tick.
 *
 * What a sweep is and how it is created is not this module's business (retention-sweeps.ts holds the registry); it only needs the small `RetentionSweep` shape, so
 * the share sweep (P10b) and the publisher sweep (P11) run on it unchanged.
 */
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { VmPublishRetentionAccess } from '@origintrail-official/dkg-publisher';
import type { ActiveRetentionMode, ResolvedRetentionConfig } from '../retention-config.js';

export type RetentionQueueName = 'share' | 'publisher';

/** What one tick reports: a store failure the sweep already counted. The share core's `ShareRetentionBatchResult` satisfies this. */
export interface RetentionTickResult {
  readonly error?: { readonly phase: string; readonly message: string };
}

/** The gauge of the latest complete pass (not cumulative): in `report` mode `wouldDelete` is what delete-gate item 1 reads. */
export interface RetentionPassGauge {
  readonly scanned: number;
  readonly wouldDelete: Readonly<Record<string, number>>;
  readonly deleted: Readonly<Record<string, number>>;
}

/** The counters a sweep exposes for the periodic `async_admission_usage` line. `deleted`, `kept`, `skipped` and `errors` are cumulative since the sweep was created. */
export interface RetentionSweepCounters {
  readonly deleted: Readonly<Record<string, number>>;
  readonly kept: Readonly<Record<string, number>>;
  readonly skipped: Readonly<Record<string, number>>;
  readonly errors: Readonly<Record<string, number>>;
  readonly lastCompletePass: RetentionPassGauge | null;
}

export interface RetentionSweep {
  readonly queue: RetentionQueueName;
  /** Never `off`: a queue whose mode is `off` has no sweep at all. */
  readonly mode: ActiveRetentionMode;
  readonly intervalMs: number;
  /** One tick. May reject; the timer counts and logs it. */
  runBatch(): Promise<RetentionTickResult>;
  counters(): RetentionSweepCounters;
}

/** One sweep's figures for the periodic line: its own counters plus what the timer counted. */
export interface RetentionUsageView extends RetentionSweepCounters {
  readonly queue: RetentionQueueName;
  readonly mode: ActiveRetentionMode;
  /** Ticks since this sweep's timer started (the daemon starts it after the API is listening), each counted when it ends, whatever it did: skipped and failed ticks too. */
  readonly ticks: number;
}

/** What a sweep factory may use of the daemon: the agent (its store object and, lazily, the share queue made over it). */
export type RetentionAgent = Pick<DKGAgent, 'store' | 'promoteQueue'>;

export interface RetentionSweepContext {
  readonly agent: RetentionAgent;
  /** The daemon's admission instance of the publisher queue (`publisherControl`): the publisher sweep reaches the queue's claim transaction only through it. Absent in a test of another queue. */
  readonly publisher?: VmPublishRetentionAccess;
  readonly settings: ResolvedRetentionConfig;
  readonly log: (message: string) => void;
}

/**
 * How a queue registers its sweep (the registry itself is retention-sweeps.ts). `create` returns `undefined`, touching nothing, when the queue's mode is `off`;
 * it may throw when the sweep cannot be built, which the starter reports without stopping the daemon.
 */
export interface RetentionSweepFactory {
  readonly queue: RetentionQueueName;
  create(context: RetentionSweepContext): RetentionSweep | undefined;
}

export interface RetentionTimer {
  usage(): readonly RetentionUsageView[];
  /** Stop ticking and wait (at most `timeoutMs`, default 5 s) for a batch that is running. Never rejects; calling it again is harmless. */
  stop(timeoutMs?: number): Promise<void>;
}

export const RETENTION_STOP_TIMEOUT_MS = 5_000;
/** A failure streak is logged at its first failure and then every this many. */
export const RETENTION_FAILURE_LOG_EVERY = 10;

const messageOf = (cause: unknown): string => String((cause as Error)?.message ?? cause).slice(0, 200);

class SweepRunner {
  ticks = 0;
  /** Ticks in a row that failed; 0 after a clean tick. */
  streak = 0;
  /** Ticks whose batch threw (the sweep did not count them). */
  thrown = 0;
  inFlight: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(readonly sweep: RetentionSweep, private readonly log: (message: string) => void) {}

  start(): void { this.schedule(); }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = this.tick().finally(() => {
        this.inFlight = undefined;
        this.schedule();
      });
    }, this.sweep.intervalMs);
    this.timer.unref?.();
  }

  /** Never rejects. */
  private async tick(): Promise<void> {
    let failure: string | undefined;
    try {
      const result = await this.sweep.runBatch();
      if (result.error) failure = `${result.error.phase} phase: ${result.error.message}`;
    } catch (cause) {
      this.thrown += 1;
      failure = messageOf(cause);
    }
    this.ticks += 1;
    this.note(failure);
  }

  private note(failure: string | undefined): void {
    const name = `${this.sweep.queue} retention (${this.sweep.mode})`;
    try {
      if (failure === undefined) {
        if (this.streak > 0) this.log(`[retention] ${name} tick succeeded again after ${this.streak} failed tick(s)`);
        this.streak = 0;
        return;
      }
      this.streak += 1;
      if (this.streak === 1 || this.streak % RETENTION_FAILURE_LOG_EVERY === 0) {
        this.log(`[warn] [retention] ${name} tick failed (${this.streak} in a row): ${failure}. The sweep keeps ticking every ${this.sweep.intervalMs} ms.`);
      }
    } catch { /* a failing logger never alters the sweep */ }
  }

  view(): RetentionUsageView {
    const counters = this.sweep.counters();
    return {
      queue: this.sweep.queue, mode: this.sweep.mode, ticks: this.ticks,
      deleted: counters.deleted, kept: counters.kept, skipped: counters.skipped,
      errors: this.thrown > 0 ? { ...counters.errors, tick: this.thrown } : counters.errors,
      lastCompletePass: counters.lastCompletePass,
    };
  }
}

/** Start the timers of the given sweeps. */
export function startRetentionTimer(sweeps: readonly RetentionSweep[], log: (message: string) => void): RetentionTimer {
  const runners = sweeps.map(sweep => new SweepRunner(sweep, log));
  for (const runner of runners) runner.start();
  let stopping: Promise<void> | undefined;
  return {
    usage: () => runners.map(runner => runner.view()),
    stop(timeoutMs = RETENTION_STOP_TIMEOUT_MS): Promise<void> {
      for (const runner of runners) runner.stop();
      return stopping ??= (async () => {
        const running = runners.flatMap(runner => (runner.inFlight ? [runner.inFlight] : []));
        if (running.length === 0) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
          Promise.allSettled(running).then(() => 'settled' as const),
          new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); timer.unref?.(); }),
        ]);
        clearTimeout(timer);
        if (outcome === 'timeout') {
          try { log(`[warn] [retention] ${running.length} retention batch(es) still running ${timeoutMs} ms after the stop request; shutting down without waiting for them`); } catch { /* ignore */ }
        }
      })();
    },
  };
}
