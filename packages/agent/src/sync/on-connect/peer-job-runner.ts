// SPDX-License-Identifier: Apache-2.0

import {
  executeSyncOnConnectAttempt,
  SyncOnConnectPeerAccountingAccumulator,
} from './attempt-accounting.js';
import type { SyncOnConnectPeerJobRunner } from './peer-scheduler.js';
import type {
  SyncOnConnectOutcome,
  SyncOnConnectPeerOutcome,
} from './sync-on-connect.js';

type SyncAttempt = (
  onSyncAccounting: (outcome: SyncOnConnectPeerOutcome) => void,
) => Promise<SyncOnConnectOutcome | 'not-started'>;

export interface ReconciledSyncOnConnectPeerJobDependencies<SelectedPlan, Probe> {
  readonly acquireProbe: () => Promise<Probe | null>;
  readonly runSelected: (
    recoveryPlan: SelectedPlan | undefined,
    onSyncAccounting: (outcome: SyncOnConnectPeerOutcome) => void,
  ) => Promise<SyncOnConnectOutcome | 'not-started'>;
  readonly runOrdinary: (
    selectedAttempted: boolean,
    onSyncAccounting: (outcome: SyncOnConnectPeerOutcome) => void,
  ) => Promise<SyncOnConnectOutcome | 'not-started'>;
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
  private readonly accounting = new SyncOnConnectPeerAccountingAccumulator();
  private probe: Probe | null | undefined;
  private probePromise: Promise<Probe | null> | null = null;
  private selectedAttempted = false;

  constructor(
    private readonly dependencies: ReconciledSyncOnConnectPeerJobDependencies<
      SelectedPlan,
      Probe
    >,
  ) {}

  async runSelected(recoveryPlan?: SelectedPlan): Promise<void> {
    this.selectedAttempted = true;
    await this.attemptPhase((onSyncAccounting) => (
      this.dependencies.runSelected(recoveryPlan, onSyncAccounting)
    ));
  }

  async runOrdinary(): Promise<void> {
    await this.attemptPhase((onSyncAccounting) => (
      this.dependencies.runOrdinary(this.selectedAttempted, onSyncAccounting)
    ));
  }

  cancel(): void {
    this.accounting.cancel();
  }

  finish(): void {
    const combined = this.accounting.combine();
    if (combined === null || this.probe === null || this.probe === undefined) return;
    const outcome: SyncOnConnectPeerOutcome = this.selectedAttempted
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
    this.dependencies.commitAccounting(outcome, this.probe);
  }

  private async ensureProbe(): Promise<Probe | null> {
    this.probePromise ??= this.dependencies.acquireProbe();
    this.probe = await this.probePromise;
    return this.probe;
  }

  private async attemptPhase(attempt: SyncAttempt): Promise<void> {
    if (await this.ensureProbe() === null) return;
    await executeSyncOnConnectAttempt(attempt, {
      recordAccounting: (outcome) => { this.accounting.record(outcome); },
      onBackpressure: this.dependencies.logBackpressure,
    });
  }
}
