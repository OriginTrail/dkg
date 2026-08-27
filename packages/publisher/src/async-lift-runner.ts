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
   *
   * When omitted, the effective active cadence is `min(recoveryIntervalMs, 5000)`: never slower
   * than the 5s default, and never slower than an explicitly configured `recoveryIntervalMs` —
   * a consumer that already checks pending transactions faster than 5s keeps that rate.
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
   * Demand invariant: pending exactly while `served < demanded`. A poke advances `demanded`;
   * only a SUCCESSFUL pass advances `served`, and only to the generation it captured at start —
   * so a failed pass keeps the demand due (retried on the errorBackoffMs floor) and a mid-pass
   * poke survives the pass that may already be past its job. Pending is derived, never stored.
   */
  private demandedGeneration = 0;
  private servedDemandGeneration = 0;
  private get reconciliationDemanded(): boolean {
    return this.servedDemandGeneration < this.demandedGeneration;
  }
  /** Whether unresolved tx work remains, from the last pass outcome (boot-seeded); selects active vs idle cadence. */
  private pendingReconciliation = false;
  private unsubscribeReconciliationDemand?: () => void;

  constructor(private readonly config: AsyncLiftRunnerConfig) {
    this.pollIntervalMs = config.pollIntervalMs ?? 1000;
    this.errorBackoffMs = config.errorBackoffMs ?? 1000;
    this.recoveryIntervalMs = config.recoveryIntervalMs ?? 60_000;
    assertNodeTimerDelayMs(this.recoveryIntervalMs, 'AsyncLiftRunner recoveryIntervalMs');
    // The active cadence must never be SLOWER than an explicitly configured recoveryIntervalMs:
    // that setting was a consumer's pending-transaction check rate before the active/idle split
    // existed, and the new default must not override a faster explicit choice.
    this.activeRecoveryIntervalMs = config.activeRecoveryIntervalMs
      ?? Math.min(config.recoveryIntervalMs ?? 5_000, 5_000);
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
    await this.seedPendingReconciliation();
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

  /**
   * BOOT-TIME cadence seed only — the per-tick outlook comes atomically out of the pass itself
   * (see startTransactionReconciliation). Fail-open by design: a probe that cannot read the
   * queue must neither abort startup nor stop scheduling; it reports through onError, keeps
   * the previous (idle) cadence, and lets the idle sweep bound the staleness.
   */
  private async seedPendingReconciliation(): Promise<void> {
    const scheduling = this.config.publisher.reconciliationScheduling;
    if (!scheduling) return;
    try {
      this.pendingReconciliation = await scheduling.hasPendingWork();
    } catch (error) {
      try {
        await this.onError?.(error);
      } catch {
        // Error reporting must not turn the fail-open probe into a startup failure.
      }
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
    // Demand is served only by a pass that SUCCEEDS: `served` advances to the generation
    // captured here, never past it. A failed pass keeps the demand due (errorBackoffMs floor);
    // a poke landing mid-pass keeps `demanded` ahead of this capture.
    const generationAtStart = this.demandedGeneration;
    this.lastRecoveryAttemptAt = Date.now();
    const scheduling = this.config.publisher.reconciliationScheduling;
    // The outlook arrives IN the pass result: serving the demand and learning whether work
    // remains are one atomic step, so no separate post-pass queue read exists to fail after a
    // successful pass and park an unresolved transaction on the idle cadence. A publisher
    // without the capability has no outlook to report; its passes keep the seeded cadence.
    const pass: Promise<{ reconciled: number; pendingWork: boolean }> = scheduling
      ? scheduling.reconcile()
      : (this.config.publisher.reconcileTransactions?.() ?? this.config.publisher.recover())
        .then((reconciled) => ({ reconciled, pendingWork: this.pendingReconciliation }));
    const recovery = pass
      .then((outcome) => {
        this.lastRecoveryAt = Date.now();
        this.pendingReconciliation = outcome.pendingWork;
        this.servedDemandGeneration = Math.max(this.servedDemandGeneration, generationAtStart);
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
