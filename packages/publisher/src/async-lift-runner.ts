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
   * implements the `reconciliationScheduling` capability.
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
  /**
   * r2-2 (🟡 3872744751) — ONE invariant, two monotonic cursors: demand is pending exactly while
   * `servedDemandGeneration < demandedGeneration`. A poke advances `demanded`; only a pass that
   * SUCCEEDS advances `served`, and only to the generation it captured at start — so a failed
   * pass leaves the demand standing (retried on the errorBackoffMs floor) and a poke landing
   * mid-pass stays ahead of the pass that may already be past its job. No separate boolean can
   * drift out of sync, because the pending state is derived, never stored.
   */
  private demandedGeneration = 0;
  private servedDemandGeneration = 0;
  private get reconciliationDemanded(): boolean {
    return this.servedDemandGeneration < this.demandedGeneration;
  }
  /** Last answer from the publisher's `reconciliationScheduling.hasPendingWork`; selects active vs idle cadence. */
  private pendingReconciliation = false;
  private unsubscribeReconciliationDemand?: () => void;

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
    this.unsubscribeReconciliationDemand = this.config.publisher.reconciliationScheduling
      ?.attachDemandListener(() => this.demandTransactionReconciliation());
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
    // Dispose the demand subscription so the publisher does not keep (or invoke) a callback
    // into a stopped runner — the drain below settles detached executions, which would
    // otherwise poke this corpse on every settle.
    this.unsubscribeReconciliationDemand?.();
    this.unsubscribeReconciliationDemand = undefined;
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
    this.demandedGeneration += 1;
    if (this.recoveryInFlight) return;
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    this.scheduleTransactionReconciliation();
  }

  private async refreshPendingReconciliation(): Promise<void> {
    const scheduling = this.config.publisher.reconciliationScheduling;
    if (!scheduling) return;
    try {
      this.pendingReconciliation = await scheduling.hasPendingWork();
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
    // r2 (🔴 3872361404) — the demand is served only by a pass that SUCCEEDS: `served` advances
    // to the generation captured here, never past it. Consuming demand at pass start let one
    // transient reconcile error spend the only wake-up and park the job for the idle interval;
    // a failed pass now leaves `served` behind `demanded`, so the demand stays due on the
    // errorBackoffMs floor, and a poke landing mid-pass keeps `demanded` ahead of this capture.
    const generationAtStart = this.demandedGeneration;
    this.lastRecoveryAttemptAt = Date.now();
    const recovery = (this.config.publisher.reconcileTransactions?.() ?? this.config.publisher.recover())
      .then(async () => {
        this.lastRecoveryAt = Date.now();
        this.servedDemandGeneration = Math.max(this.servedDemandGeneration, generationAtStart);
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
