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
 * Execute and classify one sync phase through the single reconciler policy.
 * Immediate callers apply the returned accounting at once; queued peer jobs
 * aggregate the same value and apply it once when every admitted lane drains.
 */
export async function classifySyncOnConnectAttempt(
  attempt: (
    onSyncAccounting: (outcome: SyncOnConnectPeerOutcome) => void,
  ) => Promise<SyncOnConnectOutcome | 'not-started'>,
  options: Readonly<{
    /** Compatibility guard for attempts that applied accounting themselves. */
    hasExternalAccountingEvidence?: () => boolean;
  }> = {},
): Promise<ClassifiedSyncOnConnectAttempt> {
  let accounting: SyncOnConnectPeerOutcome | undefined;
  try {
    const outcome = await attempt((next) => { accounting = next; });
    const synthesizedAccounting = accounting === undefined
      && outcomeNeedsRetryAccounting(outcome)
      && options.hasExternalAccountingEvidence?.() !== true
      ? RETRY_ACCOUNTING
      : undefined;
    return {
      execution: { state: 'completed', outcome },
      ...(accounting === undefined
        ? synthesizedAccounting === undefined ? {} : { accounting: synthesizedAccounting }
        : { accounting }),
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

export interface CombinedSyncOnConnectPeerAccounting {
  readonly outcome: SyncOnConnectPeerOutcome;
  readonly resetBackoffBeforeRetry: boolean;
}

/** One cancellation-aware ledger for every phase admitted to a peer job. */
export class SyncOnConnectPeerAccountingAccumulator {
  private readonly outcomes: SyncOnConnectPeerOutcome[] = [];
  private cancelled = false;

  record(accounting: SyncOnConnectPeerOutcome | undefined): void {
    if (!this.cancelled && accounting !== undefined) this.outcomes.push(accounting);
  }

  cancel(): void {
    this.cancelled = true;
    this.outcomes.length = 0;
  }

  combine(): CombinedSyncOnConnectPeerAccounting | null {
    if (this.cancelled || this.outcomes.length === 0) return null;
    let disposition: SyncOnConnectPeerOutcome['reconcilerDisposition'] | undefined;
    let progress = false;
    let anyFresh = false;
    let effectiveClearBeforeRetry = false;
    let resetBackoffBeforeRetry = false;
    // Reduce in phase order. A retry/defer owner cannot be erased by a later
    // clear, while clear-before-retry begins a fresh backoff generation.
    for (const outcome of this.outcomes) {
      progress ||= outcome.progress;
      anyFresh ||= outcome.fresh;
      if (outcome.reconcilerDisposition === 'retry') {
        resetBackoffBeforeRetry ||= effectiveClearBeforeRetry;
        disposition = 'retry';
        continue;
      }
      if (outcome.reconcilerDisposition === 'defer') {
        if (disposition !== 'retry') disposition = 'defer';
        continue;
      }
      if (disposition === undefined || disposition === 'clear') {
        disposition = 'clear';
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
        resetBackoffBeforeRetry: false,
      };
    }
    return {
      outcome: {
        reconcilerDisposition: disposition ?? 'defer',
        fresh: false,
        progress,
      },
      resetBackoffBeforeRetry,
    };
  }
}
