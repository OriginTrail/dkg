import { isStoreOperationTimeoutError, isStoreSchedulerBusyError } from '@origintrail-official/dkg-storage';

export const WRITE_PREFLIGHT_SITES = ['existence', 'content', 'subscription', 'declaration',
  'caller-access', 'exact-probe', 'metadata', 'list', 'decision'] as const;
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

/** A bounded set of closed sites; its order is not a causal ordering. */
export function sanitizeWritePreflightFailures(input: unknown): WritePreflightFailure[] {
  const result: WritePreflightFailure[] = [];
  try {
    if (!Array.isArray(input)) return result;
    for (let i = 0; i < Math.min(input.length, WRITE_PREFLIGHT_SITES.length); i++) {
      const row = input[i];
      const rawSite = row?.site; const rawKind = row?.kind;
      const site = WRITE_PREFLIGHT_SITES.includes(rawSite) ? rawSite : 'decision';
      const kind = WRITE_PREFLIGHT_FAILURE_KINDS.includes(rawKind) ? rawKind : 'unknown';
      if (!result.some(value => value.site === site && value.kind === kind)) result.push({ site, kind });
    }
  } catch { result.push({ site: 'decision', kind: 'unknown' }); }
  return result.slice(0, WRITE_PREFLIGHT_SITES.length);
}
