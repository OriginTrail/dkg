import type { AsyncLiftPublisher } from './async-lift-publisher.js';
import { assertNodeTimerDelayMs } from '@origintrail-official/dkg-core';

export interface AsyncLiftRunnerConfig {
  readonly publisher: AsyncLiftPublisher;
  readonly walletIds: readonly string[];
  readonly pollIntervalMs?: number;
  readonly errorBackoffMs?: number;
  readonly recoveryIntervalMs?: number;
  /**
   * Reconciliation cadence while the publisher reports transaction-bearing jobs awaiting chain
   * proof. `recoveryIntervalMs` stays the idle sweep for work no wake-up can announce (crash
   * recovery, jobs stranded by a listener that never fired). Only consulted when the publisher
   * implements `hasPendingTransactionReconciliation`.
   */
  readonly activeRecoveryIntervalMs?: number;
  /** Start recovery, but do not claim accepted jobs until an operator restarts unpaused. */
  readonly startPaused?: boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onError?: (error: unknown) => void | Promise<void>;
  readonly hasIncludedRecoveryResolver?: boolean;
}

export class AsyncLiftRunner {
  private readonly pollIntervalMs: number;
  private readonly errorBackoffMs: number;
  private readonly recoveryIntervalMs: number;
  private readonly activeRecoveryIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onError?: (error: unknown) => void | Promise<void>;
  private started = false;
  private stopped = false;
  private running?: Promise<void>;
  private lastRecoveryAt = 0;
  private lastRecoveryAttemptAt = 0;
  private recoveryInFlight?: Promise<void>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  /** A demand poke arrived since the last pass started; the next pass is due now, not next cadence. */
  private reconciliationDemanded = false;
  /** Last answer from `hasPendingTransactionReconciliation`; selects active vs idle cadence. */
  private pendingReconciliation = false;

  constructor(private readonly config: AsyncLiftRunnerConfig) {
    this.pollIntervalMs = config.pollIntervalMs ?? 1000;
    this.errorBackoffMs = config.errorBackoffMs ?? 1000;
    this.recoveryIntervalMs = config.recoveryIntervalMs ?? 60_000;
    assertNodeTimerDelayMs(this.recoveryIntervalMs, 'AsyncLiftRunner recoveryIntervalMs');
    this.activeRecoveryIntervalMs = config.activeRecoveryIntervalMs ?? 5_000;
    assertNodeTimerDelayMs(this.activeRecoveryIntervalMs, 'AsyncLiftRunner activeRecoveryIntervalMs');
    this.sleep = config.sleep ?? defaultSleep;
    this.onError = config.onError;
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error('AsyncLiftRunner already started');
    }
    if (this.config.walletIds.length === 0) {
      throw new Error('AsyncLiftRunner requires at least one walletId');
    }

    this.stopped = false;
    try {
      if (this.config.startPaused === true) {
        await this.config.publisher.pause();
      }
      await this.config.publisher.recover();
      this.lastRecoveryAt = Date.now();
      if (!this.config.hasIncludedRecoveryResolver) {
        const includedJobs = await this.config.publisher.list({ status: 'included' });
        if (includedJobs.length > 0) {
          throw new Error('AsyncLiftRunner requires included-job recovery support when included jobs remain after startup recovery');
        }
      }
    } catch (error) {
      this.started = false;
      throw error;
    }

    this.started = true;
    // A tx-bearing job leaves executor ownership (detached receipt settles, ambiguous broadcast)
    // between passes; the poke pulls the next pass forward instead of waiting out the cadence.
    this.config.publisher.setReconciliationDemandListener?.(() => this.demandTransactionReconciliation());
    // Startup recovery may have left unresolved tx-bearing jobs behind (chain proof still
    // pending); seed the cadence choice from the queue rather than assuming idle.
    await this.refreshPendingReconciliation();
    this.scheduleTransactionReconciliation();
    this.running = Promise.all(
      this.config.walletIds.map((walletId) => this.walletLoop(walletId)),
    ).then(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    await this.running;
    await this.recoveryInFlight;
    await this.config.publisher.drainDetachedExecutions?.();
  }

  private async walletLoop(walletId: string): Promise<void> {
    while (!this.stopped) {
      try {
        const processed = await this.config.publisher.processNext(walletId);
        if (!processed && !this.stopped) {
          await this.sleep(this.pollIntervalMs);
        }
      } catch (error) {
        try {
          await this.onError?.(error);
        } catch {
          // Error reporting must not stop the runner loop.
        }
        if (!this.stopped) {
          await this.sleep(this.errorBackoffMs);
        }
      }
    }
  }

  /**
   * The publisher's poke that reconciliation gained actionable work. Coalesced: during an
   * in-flight pass it only marks the flag, and the pass's own rescheduling turns any number of
   * pokes into one follow-up pass. `errorBackoffMs` since the last attempt stays the floor, so a
   * reconciliation that keeps throwing cannot be poked into a hot loop.
   */
  private demandTransactionReconciliation(): void {
    if (this.stopped || !this.started) return;
    this.reconciliationDemanded = true;
    if (this.recoveryInFlight) return;
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    this.scheduleTransactionReconciliation();
  }

  private async refreshPendingReconciliation(): Promise<void> {
    const hasPending = this.config.publisher.hasPendingTransactionReconciliation;
    if (!hasPending) return;
    try {
      this.pendingReconciliation = await hasPending.call(this.config.publisher);
    } catch {
      // An unanswerable queue read keeps the previous cadence; the idle sweep bounds staleness.
    }
  }

  private scheduleTransactionReconciliation(): void {
    if (this.stopped || this.recoveryTimer || this.recoveryInFlight) return;
    const now = Date.now();
    const cadenceMs = this.pendingReconciliation ? this.activeRecoveryIntervalMs : this.recoveryIntervalMs;
    const nextAt = Math.max(
      this.reconciliationDemanded ? now : this.lastRecoveryAt + cadenceMs,
      this.lastRecoveryAttemptAt + this.errorBackoffMs,
    );
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      this.startTransactionReconciliation();
    }, Math.max(1, nextAt - now));
  }

  private startTransactionReconciliation(): void {
    if (this.stopped || this.recoveryInFlight) return;
    // Consumed at pass START: a poke that lands while this pass runs re-arms the flag, because
    // this pass may already be past the job the poke announced.
    this.reconciliationDemanded = false;
    this.lastRecoveryAttemptAt = Date.now();
    const recovery = (this.config.publisher.reconcileTransactions?.() ?? this.config.publisher.recover())
      .then(async () => {
        this.lastRecoveryAt = Date.now();
        await this.refreshPendingReconciliation();
      })
      .catch(async (error) => {
        try {
          await this.onError?.(error);
        } catch {
          // Error reporting must not stop transaction reconciliation.
        }
      })
      .finally(() => {
        if (this.recoveryInFlight === recovery) {
          this.recoveryInFlight = undefined;
        }
        this.scheduleTransactionReconciliation();
      });
    this.recoveryInFlight = recovery;
  }

}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
