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
  /**
   * Stamped only when a pass FAILS. The errorBackoffMs floor paces retries after failures —
   * and nothing else: a wake after a successful pass runs immediately, so wake latency is
   * independent of the operator's errorBackoffMs choice.
   */
  private lastFailedRecoveryAttemptAt = 0;
  private recoveryInFlight?: Promise<void>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  /**
   * Demand latch: set by a poke, consumed at pass start, restored if that pass FAILS — so a
   * transient error cannot spend the only wake-up. A mid-pass poke sets it after the consume
   * and therefore survives a successful pass that may already be past its job; repeated pokes
   * coalesce naturally. Only one pass runs at a time, so a boolean is the whole state.
   */
  private reconciliationDemanded = false;
  /** Whether unresolved tx work remains, from the last pass outcome (boot-seeded); selects active vs idle cadence. */
  private pendingReconciliation = false;
  private unsubscribeReconciliationDemand?: () => void;
  private unsubscribeWalletRelease?: () => void;
  /** Wallet wake latch: a release poke landing while its loop is mid-processNext skips the next sleep. */
  private readonly walletWakePending = new Set<string>();
  /** At most one parked idle sleeper per wallet, resolvable by a release poke (or by stop()). */
  private readonly walletSleepers = new Map<string, () => void>();

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
      // Startup recovery IS the first pass: with the scheduling capability its outcome seeds
      // the cadence choice directly — one inventory, no second boot-time outlook read. Without
      // the capability the legacy numeric recover() runs and the idle cadence is the seed.
      const scheduling = this.config.publisher.reconciliationScheduling;
      if (scheduling) {
        this.pendingReconciliation = (await scheduling.recover()).pendingWork;
      } else {
        await this.config.publisher.recover();
      }
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
    // No in-process work can settle before this point — executors only run once the wallet
    // loops below start — so attaching after startup recovery loses nothing.
    this.unsubscribeReconciliationDemand = this.config.publisher.reconciliationScheduling
      ?.attachDemandListener(() => this.demandTransactionReconciliation());
    // A released wallet is claimable NOW; the poke lets its loop claim immediately instead of
    // idling out the poll — turnover becomes chain-time-bound, not pollIntervalMs-bound.
    this.unsubscribeWalletRelease = this.config.publisher.reconciliationScheduling
      ?.attachWalletReleaseListener((walletId) => this.wakeWallet(walletId));
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
    this.unsubscribeWalletRelease?.();
    this.unsubscribeWalletRelease = undefined;
    // Wake every parked wallet loop so shutdown does not wait out a poll interval.
    for (const wake of this.walletSleepers.values()) wake();
    this.walletSleepers.clear();
    this.walletWakePending.clear();
    await this.running;
    await this.recoveryInFlight;
    await this.config.publisher.drainDetachedExecutions?.();
  }

  private async walletLoop(walletId: string): Promise<void> {
    while (!this.stopped) {
      try {
        const processed = await this.config.publisher.processNext(walletId);
        if (!processed && !this.stopped) {
          // Interruptible idle wait: a wallet-release poke ends it early, and one that landed
          // during processNext is latched and skips it entirely. The error backoff below stays
          // deliberately un-interruptible — failure pacing must not be poked away.
          await this.idleWalletWait(walletId);
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

  /** The publisher's poke that walletId's lock was deleted: its next claim attempt can run now. */
  private wakeWallet(walletId: string): void {
    if (this.stopped || !this.started) return;
    // A release for a wallet this runner does not drive must not accumulate latch state.
    if (!this.config.walletIds.includes(walletId)) return;
    const sleeper = this.walletSleepers.get(walletId);
    if (sleeper) {
      this.walletSleepers.delete(walletId);
      sleeper();
      return;
    }
    this.walletWakePending.add(walletId);
  }

  private async idleWalletWait(walletId: string): Promise<void> {
    // Latch consumed on entry: a poke that landed during processNext means claimable work may
    // already exist, so skip the sleep entirely.
    if (this.walletWakePending.delete(walletId)) return;
    let wake!: () => void;
    const woken = new Promise<void>((resolve) => { wake = resolve; });
    this.walletSleepers.set(walletId, wake);
    // Re-check AFTER registering: a poke in the gap between the entry check and the
    // registration would otherwise be latched against a sleeper that never sees it.
    if (this.walletWakePending.delete(walletId)) {
      this.walletSleepers.delete(walletId);
      return;
    }
    try {
      await Promise.race([this.sleep(this.pollIntervalMs), woken]);
    } finally {
      if (this.walletSleepers.get(walletId) === wake) {
        this.walletSleepers.delete(walletId);
      }
    }
  }

  /**
   * The publisher's poke that reconciliation gained actionable work. Coalesced: during an
   * in-flight pass it only marks the flag, and the pass's own rescheduling turns any number of
   * pokes into one follow-up pass. `errorBackoffMs` since the last FAILED attempt stays the
   * floor, so a reconciliation that keeps throwing cannot be poked into a hot loop — while a
   * wake after a successful pass runs immediately, independent of the errorBackoffMs setting.
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

  private scheduleTransactionReconciliation(): void {
    if (this.stopped || this.recoveryTimer || this.recoveryInFlight) return;
    const now = Date.now();
    const cadenceMs = this.pendingReconciliation ? this.activeRecoveryIntervalMs : this.recoveryIntervalMs;
    const nextAt = Math.max(
      this.reconciliationDemanded ? now : this.lastRecoveryAt + cadenceMs,
      this.lastFailedRecoveryAttemptAt + this.errorBackoffMs,
    );
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      this.startTransactionReconciliation();
    }, Math.max(1, nextAt - now));
  }

  private startTransactionReconciliation(): void {
    if (this.stopped || this.recoveryInFlight) return;
    // Consume the latch; a failed pass restores what it consumed (errorBackoffMs floor paces
    // the retry), and a mid-pass poke re-sets the latch independently of this capture.
    const demandConsumed = this.reconciliationDemanded;
    this.reconciliationDemanded = false;
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
      })
      .catch(async (error) => {
        this.lastFailedRecoveryAttemptAt = Date.now();
        this.reconciliationDemanded = this.reconciliationDemanded || demandConsumed;
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
