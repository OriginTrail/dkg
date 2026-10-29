import { isStoreOperationTimeoutError, isStoreSchedulerBusyError } from '@origintrail-official/dkg-storage';

export const WRITE_PREFLIGHT_SITES = ['existence', 'content', 'subscription', 'declaration',
  'caller-access'] as const;
export const WRITE_PREFLIGHT_FAILURE_KINDS = ['store-not-started', 'deadline', 'incomplete', 'unknown'] as const;
export type WritePreflightFailureSite = typeof WRITE_PREFLIGHT_SITES[number];
export type WritePreflightFailureKind = typeof WRITE_PREFLIGHT_FAILURE_KINDS[number];
export interface WritePreflightFailure {
  readonly site: WritePreflightFailureSite;
  readonly kind: WritePreflightFailureKind;
}

/** Diagnostics only: never infer causality from raw messages or nested causes. */
export function classifyWritePreflightFailure(error: unknown): WritePreflightFailureKind {
  try {
    if (isStoreSchedulerBusyError(error)) return 'store-not-started';
    if (isStoreOperationTimeoutError(error)) {
      return error.outcome === 'not_started' ? 'store-not-started' : 'deadline';
    }
  } catch { /* Hostile getters must not change the original decision. */ }
  return 'unknown';
}
