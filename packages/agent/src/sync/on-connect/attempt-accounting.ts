// SPDX-License-Identifier: Apache-2.0

import { getSyncBackpressureBusyError } from '../backpressure.js';
import {
  SyncOnConnectPostSyncError,
  type SyncOnConnectOutcome,
  type SyncOnConnectPeerOutcome,
} from './sync-on-connect.js';

export type SyncReconcilerAttemptOutcome =
  | SyncOnConnectOutcome
  | 'not-started'
  | 'deferred-backpressure';

/** One explicit terminal value for a callback-based legacy sync operation. */
export interface SyncOnConnectAttemptResult {
  readonly outcome: SyncOnConnectOutcome | 'not-started';
  readonly accounting: SyncOnConnectPeerOutcome | null;
}

export type SyncOnConnectAttemptExecution =
  | Readonly<{
      state: 'completed';
      outcome: SyncReconcilerAttemptOutcome;
      /** Present only when a thrown error was normalized as local backpressure. */
      backpressureDetail?: string;
    }>
  | Readonly<{
      state: 'failed';
      error: unknown;
    }>;

export interface ClassifiedSyncOnConnectAttempt {
  readonly execution: SyncOnConnectAttemptExecution;
  /** Accounting emitted by the sync or synthesized from its terminal result. */
  readonly accounting?: SyncOnConnectPeerOutcome;
}

const RETRY_ACCOUNTING: SyncOnConnectPeerOutcome = Object.freeze({
  reconcilerDisposition: 'retry',
  fresh: false,
  progress: false,
});

function outcomeNeedsRetryAccounting(outcome: SyncReconcilerAttemptOutcome): boolean {
  return outcome !== 'skipped-no-sync'
    && outcome !== 'already-syncing'
    && outcome !== 'not-started'
    && outcome !== 'deferred-backpressure';
}

/**
 * Adapt the legacy sync callback at one boundary. Downstream attempt policy
 * consumes only the returned terminal value; it never inspects mutable caller
 * state or waits for a second accounting channel.
 */
export async function captureSyncOnConnectAttempt(
  attempt: (
    onSyncAccounting: (outcome: SyncOnConnectPeerOutcome) => void,
  ) => Promise<SyncOnConnectOutcome | 'not-started'>,
): Promise<SyncOnConnectAttemptResult> {
  let accounting: SyncOnConnectPeerOutcome | undefined;
  const outcome = await attempt((next) => { accounting = next; });
  return Object.freeze({
    outcome,
    accounting: accounting
      ?? (outcomeNeedsRetryAccounting(outcome) ? RETRY_ACCOUNTING : null),
  });
}

/**
 * Execute and classify one sync phase through the single reconciler policy.
 * Immediate callers apply the returned accounting at once; queued peer jobs
 * aggregate the same value and apply it once when every admitted lane drains.
 */
export async function classifySyncOnConnectAttempt(
  attempt: () => Promise<SyncOnConnectAttemptResult>,
): Promise<ClassifiedSyncOnConnectAttempt> {
  try {
    const result = await attempt();
    return {
      execution: { state: 'completed', outcome: result.outcome },
      ...(result.accounting === null ? {} : { accounting: result.accounting }),
    };
  } catch (error: unknown) {
    const backpressureError = getSyncBackpressureBusyError(error);
    if (backpressureError) {
      return {
        execution: {
          state: 'completed',
          outcome: 'deferred-backpressure',
          backpressureDetail: backpressureError.message,
        },
      };
    }
    const retryEligible = !(error instanceof SyncOnConnectPostSyncError)
      || error.backoffEligible;
    return {
      execution: { state: 'failed', error },
      ...(retryEligible ? { accounting: RETRY_ACCOUNTING } : {}),
    };
  }
}

/**
 * Apply the common attempt policy to either an immediate accounting sink or a
 * deferred peer-job accumulator. Callers only choose the sink; normalization,
 * local-backpressure logging, and error propagation stay centralized here.
 */
export async function executeSyncOnConnectAttempt(
  attempt: Parameters<typeof classifySyncOnConnectAttempt>[0],
  options: Readonly<{
    recordAccounting: (accounting: SyncOnConnectPeerOutcome) => void;
    onBackpressure: (detail?: string) => void;
  }>,
): Promise<SyncReconcilerAttemptOutcome> {
  const classified = await classifySyncOnConnectAttempt(attempt);
  if (classified.accounting !== undefined) {
    options.recordAccounting(classified.accounting);
  }
  if (classified.execution.state === 'failed') {
    throw classified.execution.error;
  }
  if (classified.execution.outcome === 'deferred-backpressure') {
    options.onBackpressure(classified.execution.backpressureDetail);
  }
  return classified.execution.outcome;
}

export interface CombinedSyncOnConnectPeerAccounting<Probe> {
  readonly outcome: SyncOnConnectPeerOutcome;
  /** Probe owned by the phase that determines the final disposition. */
  readonly probe: Probe;
  readonly resetBackoffBeforeRetry: boolean;
}

/** One cancellation-aware ledger for every phase admitted to a peer job. */
export class SyncOnConnectPeerAccountingAccumulator<Probe> {
  private readonly entries: Array<Readonly<{
    outcome: SyncOnConnectPeerOutcome;
    probe: Probe;
  }>> = [];
  private cancelled = false;

  record(accounting: SyncOnConnectPeerOutcome | undefined, probe: Probe): void {
    if (!this.cancelled && accounting !== undefined) {
      this.entries.push({ outcome: accounting, probe });
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.entries.length = 0;
  }

  combine(): CombinedSyncOnConnectPeerAccounting<Probe> | null {
    if (this.cancelled || this.entries.length === 0) return null;
    let disposition: SyncOnConnectPeerOutcome['reconcilerDisposition'] | undefined;
    let ownerProbe = this.entries[0]!.probe;
    let progress = false;
    let anyFresh = false;
    let effectiveClearBeforeRetry = false;
    let resetBackoffBeforeRetry = false;
    // Reduce in phase order. A retry/defer owner cannot be erased by a later
    // clear, while clear-before-retry begins a fresh backoff generation.
    for (const { outcome, probe } of this.entries) {
      progress ||= outcome.progress;
      anyFresh ||= outcome.fresh;
      if (outcome.reconcilerDisposition === 'retry') {
        resetBackoffBeforeRetry ||= effectiveClearBeforeRetry;
        disposition = 'retry';
        ownerProbe = probe;
        continue;
      }
      if (outcome.reconcilerDisposition === 'defer') {
        if (disposition !== 'retry') {
          disposition = 'defer';
          ownerProbe = probe;
        }
        continue;
      }
      if (disposition === undefined || disposition === 'clear') {
        disposition = 'clear';
        ownerProbe = probe;
        effectiveClearBeforeRetry = true;
      }
    }
    if (disposition === 'clear') {
      return {
        outcome: {
          reconcilerDisposition: 'clear',
          fresh: anyFresh,
          progress,
        },
        probe: ownerProbe,
        resetBackoffBeforeRetry: false,
      };
    }
    return {
      outcome: {
        reconcilerDisposition: disposition ?? 'defer',
        fresh: false,
        progress,
      },
      probe: ownerProbe,
      resetBackoffBeforeRetry,
    };
  }
}
