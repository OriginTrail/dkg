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
 * Apply the common attempt policy to either an immediate accounting sink or a
 * deferred peer-job accumulator. Callers only choose the sink; normalization,
 * local-backpressure logging, and error propagation stay centralized here.
 */
export async function executeSyncOnConnectAttempt(
  attempt: () => Promise<SyncOnConnectAttemptResult>,
  options: Readonly<{
    recordAccounting: (accounting: SyncOnConnectPeerOutcome) => void;
    onBackpressure: (detail?: string) => void;
  }>,
): Promise<SyncReconcilerAttemptOutcome> {
  try {
    const result = await attempt();
    if (result.accounting !== null) options.recordAccounting(result.accounting);
    if (result.outcome === 'deferred-backpressure') options.onBackpressure();
    return result.outcome;
  } catch (error: unknown) {
    const backpressureError = getSyncBackpressureBusyError(error);
    if (backpressureError) {
      options.onBackpressure(backpressureError.message);
      return 'deferred-backpressure';
    }
    if (!(error instanceof SyncOnConnectPostSyncError) || error.backoffEligible) {
      options.recordAccounting(RETRY_ACCOUNTING);
    }
    throw error;
  }
}

export interface CombinedSyncOnConnectPeerAccounting<Probe> {
  readonly outcome: SyncOnConnectPeerOutcome;
  /** Probe owned by the phase that determines the final disposition. */
  readonly probe: Probe;
  readonly resetBackoffBeforeRetry: boolean;
}

export interface SyncOnConnectPeerAccountingEntry<Probe> {
  readonly lane: 'selected' | 'ordinary';
  readonly outcome: SyncOnConnectPeerOutcome;
  readonly probe: Probe;
}

/** Pure phase-order reduction; lifecycle and late-record gating stay in the runner. */
export function combineSyncOnConnectPeerAccounting<Probe>(
  entries: readonly Readonly<SyncOnConnectPeerAccountingEntry<Probe>>[],
): CombinedSyncOnConnectPeerAccounting<Probe> | null {
  if (entries.length === 0) return null;
  let disposition: SyncOnConnectPeerOutcome['reconcilerDisposition'] | undefined;
  let ownerProbe = entries[0]!.probe;
  let progress = false;
  let anyFresh = false;
  let effectiveClearBeforeRetry = false;
  let resetBackoffBeforeRetry = false;
  // Reduce in phase order. A retry/defer owner cannot be erased by a later
  // clear, while clear-before-retry begins a fresh backoff generation.
  for (const { outcome, probe } of entries) {
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
