// SPDX-License-Identifier: Apache-2.0

import {
  executeSyncOnConnectAttempt,
  SyncOnConnectPeerAccountingAccumulator,
  type SyncOnConnectAttemptResult,
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
  private readonly accounting = new SyncOnConnectPeerAccountingAccumulator<Probe>();
  private readonly selectedPhaseExecutions: Array<Readonly<{
    outcome?: SyncReconcilerAttemptOutcome;
    error?: unknown;
  }>> = [];
  private automaticSelectedPhase: SyncAttempt | null;
  private pendingInitialProbe: Readonly<{ value: Probe }> | null;

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
    this.automaticSelectedPhase = null;
    return this.runSelectedPhase(() => this.dependencies.runSelected(recoveryPlan));
  }

  async runOrdinary(): Promise<SyncReconcilerAttemptOutcome> {
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
    const ordinaryOutcome = await this.attemptPhase(this.dependencies.runOrdinary);
    if (selectedError !== undefined) throw selectedError;
    return ordinaryOutcome;
  }

  cancel(): void {
    this.accounting.cancel();
  }

  finish(): void {
    const combined = this.accounting.combine();
    if (combined === null) return;
    const outcome: SyncOnConnectPeerOutcome = this.selectedPhaseExecutions.length > 0
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

  private async acquirePhaseProbe(): Promise<Probe | null> {
    const initial = this.pendingInitialProbe;
    if (initial !== null) {
      this.pendingInitialProbe = null;
      return initial.value;
    }
    return this.dependencies.acquireProbe();
  }

  private async runSelectedPhase(attempt: SyncAttempt): Promise<SyncReconcilerAttemptOutcome> {
    const execution: { outcome?: SyncReconcilerAttemptOutcome; error?: unknown } = {};
    this.selectedPhaseExecutions.push(execution);
    try {
      execution.outcome = await this.attemptPhase(attempt);
      return execution.outcome;
    } catch (error: unknown) {
      execution.error = error;
      throw error;
    }
  }

  private async attemptPhase(attempt: SyncAttempt): Promise<SyncReconcilerAttemptOutcome> {
    const probe = await this.acquirePhaseProbe();
    if (probe === null) return 'not-started';
    return executeSyncOnConnectAttempt(attempt, {
      recordAccounting: (outcome) => { this.accounting.record(outcome, probe); },
      onBackpressure: this.dependencies.logBackpressure,
    });
  }
}
