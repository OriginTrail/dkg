// SPDX-License-Identifier: Apache-2.0

import {
  combineSyncOnConnectPeerAccounting,
  executeSyncOnConnectAttempt,
  type SyncOnConnectAttemptResult,
  type SyncOnConnectPeerAccountingEntry,
  type SyncReconcilerAttemptOutcome,
} from './attempt-accounting.js';
import type { SyncOnConnectPeerJobRunner } from './peer-scheduler.js';
import type { SyncOnConnectPeerOutcome } from './sync-on-connect.js';

type SyncAttempt = () => Promise<SyncOnConnectAttemptResult>;

export interface ReconciledSyncOnConnectPeerJobDependencies<SelectedPlan, Probe> {
  readonly acquireProbe: () => Promise<Probe | null>;
  readonly runSelected: (
    recoveryPlan: SelectedPlan | undefined,
  ) => Promise<SyncOnConnectAttemptResult>;
  readonly runAutomaticSelected?: () => Promise<SyncOnConnectAttemptResult>;
  readonly runOrdinary: () => Promise<SyncOnConnectAttemptResult>;
  readonly selectedRetryStillRequired: () => boolean;
  readonly resetBackoffBeforeRetry: () => void;
  readonly commitAccounting: (
    outcome: SyncOnConnectPeerOutcome,
    probe: Probe,
  ) => void;
  readonly logBackpressure: (detail?: string) => void;
}

/**
 * One peer-job transaction: lazy probe acquisition, ordered phase accounting,
 * cancellation, and exactly one final reconciler commit.
 */
export class ReconciledSyncOnConnectPeerJobRunner<SelectedPlan, Probe>
implements SyncOnConnectPeerJobRunner<SelectedPlan> {
  private readonly accountingEntries: SyncOnConnectPeerAccountingEntry<Probe>[] = [];
  private selectedPhaseExecuted = false;
  private automaticSelectedPhase: SyncAttempt | null;
  private pendingInitialProbe: Readonly<{ value: Probe }> | null;
  private ordinaryFailedWithoutAccounting = false;
  private terminalState: 'active' | 'cancelled' | 'finished' = 'active';

  constructor(
    private readonly dependencies: ReconciledSyncOnConnectPeerJobDependencies<
      SelectedPlan,
      Probe
    >,
    options: Readonly<{ initialProbe?: Probe }> = {},
  ) {
    // A job is one explicit phase plan: optional automatic selected work,
    // followed by invariant ordinary work. An explicitly queued selected lane
    // consumes/replaces the automatic item before ordinary execution.
    this.automaticSelectedPhase = this.dependencies.runAutomaticSelected ?? null;
    this.pendingInitialProbe = options.initialProbe === undefined
      ? null
      : { value: options.initialProbe };
  }

  async runSelected(recoveryPlan?: SelectedPlan): Promise<SyncReconcilerAttemptOutcome> {
    this.assertActive();
    this.automaticSelectedPhase = null;
    return this.runSelectedPhase(() => this.dependencies.runSelected(recoveryPlan));
  }

  async runAutomaticSelectedThenOrdinary(): Promise<SyncReconcilerAttemptOutcome> {
    this.assertActive();
    const automaticSelectedPhase = this.automaticSelectedPhase;
    this.automaticSelectedPhase = null;
    let selectedError: unknown;
    if (automaticSelectedPhase !== null) {
      try {
        await this.runSelectedPhase(automaticSelectedPhase);
      } catch (error: unknown) {
        // Automatic selected work must not starve unrelated ordinary work.
        // Its retry accounting remains in the job ledger and its error is
        // reported by the owning ordinary lane after that work drains.
        selectedError = error;
      }
    }
    let ordinaryOutcome: SyncReconcilerAttemptOutcome;
    try {
      ordinaryOutcome = await this.attemptPhase('ordinary', this.dependencies.runOrdinary);
    } catch (ordinaryError: unknown) {
      if (selectedError !== undefined) {
        throw new AggregateError(
          [selectedError, ordinaryError],
          'Automatic selected and ordinary sync-on-connect phases both failed',
        );
      }
      throw ordinaryError;
    }
    if (selectedError !== undefined) throw selectedError;
    return ordinaryOutcome;
  }

  cancel(): void {
    if (this.terminalState !== 'active') return;
    this.terminalState = 'cancelled';
    this.automaticSelectedPhase = null;
    this.pendingInitialProbe = null;
    this.accountingEntries.length = 0;
  }

  finish(): void {
    if (this.terminalState !== 'active') return;
    this.terminalState = 'finished';
    if (this.ordinaryFailedWithoutAccounting) {
      // A later ordinary post-sync failure must not let an earlier selected
      // result establish peer freshness/progress and suppress the next retry.
      // The selected transfer owns its own persisted terminal state.
      this.accountingEntries.length = 0;
      return;
    }
    const combined = combineSyncOnConnectPeerAccounting(this.accountingEntries);
    this.accountingEntries.length = 0;
    if (combined === null) return;
    const outcome: SyncOnConnectPeerOutcome = this.selectedPhaseExecuted
      && this.dependencies.selectedRetryStillRequired()
      && combined.outcome.reconcilerDisposition === 'clear'
      ? {
          reconcilerDisposition: 'defer',
          fresh: false,
          progress: combined.outcome.progress,
        }
      : combined.outcome;
    if (combined.resetBackoffBeforeRetry) {
      this.dependencies.resetBackoffBeforeRetry();
    }
    this.dependencies.commitAccounting(outcome, combined.probe);
  }

  private assertActive(): void {
    if (this.terminalState !== 'active') {
      throw new Error(`Sync-on-connect peer job is already ${this.terminalState}`);
    }
  }

  private async acquirePhaseProbe(): Promise<Probe | null> {
    const initial = this.pendingInitialProbe;
    if (initial !== null) {
      this.pendingInitialProbe = null;
      return initial.value;
    }
    return this.dependencies.acquireProbe();
  }

  private async runSelectedPhase(attempt: SyncAttempt): Promise<SyncReconcilerAttemptOutcome> {
    this.selectedPhaseExecuted = true;
    return this.attemptPhase('selected', attempt);
  }

  private async attemptPhase(
    lane: SyncOnConnectPeerAccountingEntry<Probe>['lane'],
    attempt: SyncAttempt,
  ): Promise<SyncReconcilerAttemptOutcome> {
    const probe = await this.acquirePhaseProbe();
    if (probe === null || this.terminalState !== 'active') return 'not-started';
    const entriesBeforeAttempt = this.accountingEntries.length;
    try {
      return await executeSyncOnConnectAttempt(attempt, {
        recordAccounting: (outcome) => {
          if (this.terminalState === 'active') {
            // A later selected generation supersedes the earlier selected
            // disposition for the same admission. Ordinary outcomes are kept:
            // a selected clear must never erase an unrelated ordinary retry.
            if (lane === 'selected') {
              for (let i = this.accountingEntries.length - 1; i >= 0; i -= 1) {
                if (this.accountingEntries[i]!.lane === 'selected') {
                  this.accountingEntries.splice(i, 1);
                }
              }
            }
            this.accountingEntries.push({ lane, outcome, probe });
          }
        },
        onBackpressure: this.dependencies.logBackpressure,
      });
    } catch (error: unknown) {
      if (
        lane === 'ordinary'
        && this.accountingEntries.length === entriesBeforeAttempt
      ) {
        this.ordinaryFailedWithoutAccounting = true;
      }
      throw error;
    }
  }
}
