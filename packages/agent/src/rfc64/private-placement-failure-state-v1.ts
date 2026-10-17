// SPDX-License-Identifier: Apache-2.0
/** Dependency-free persisted failure vocabulary, shared by diagnostics and validation. */
export const CATALOG_REPAIR_FAILURE_KINDS_V1 = Object.freeze([
  'queue_wait', 'queue_full', 'store_timeout_not_started', 'store_timeout_indeterminate',
  'transport', 'cancelled', 'integrity', 'lane_inactive', 'catalog_full', 'unknown',
  'policy_conflict', 'version_conflict', 'signer_mismatch', 'persistence_unavailable',
] as const);
export type CatalogRepairFailureKindV1 = typeof CATALOG_REPAIR_FAILURE_KINDS_V1[number];
export const isCatalogRepairFailureKindV1 = (value: unknown): value is CatalogRepairFailureKindV1 =>
  CATALOG_REPAIR_FAILURE_KINDS_V1.some(kind => kind === value);

export const PRIVATE_REPAIR_MAX_BACKOFF_MS = 30 * 60_000;
export const isDeterministicPrivateRepairFailureV1 = (kind: CatalogRepairFailureKindV1): boolean =>
  kind === 'policy_conflict' || kind === 'version_conflict' || kind === 'signer_mismatch';

/** Scheduling evidence only, keyed by the unchanged canonical owed-marker digest. */
export interface PrivatePlacementFailureStateV1 {
  readonly kind: CatalogRepairFailureKindV1;
  readonly consecutiveFailures: number;
  readonly sameKindFailures: number;
  readonly firstFailedAtMs: number;
  readonly lastFailedAtMs: number;
  readonly nextAttemptAtMs: number | null;
  readonly parked: boolean;
}

export interface PrivatePlacementFailureSummaryV1 {
  readonly failedMarkers: number;
  readonly parkedMarkers: number;
  readonly maxConsecutiveFailures: number;
  readonly oldestFailureAgeMs: number | null;
  readonly kinds: readonly Readonly<{ kind: CatalogRepairFailureKindV1; count: number }>[];
}

export function summarizePrivatePlacementFailuresV1(states: Iterable<PrivatePlacementFailureStateV1 | null>, nowMs = Date.now()): PrivatePlacementFailureSummaryV1 {
  let failedMarkers = 0, parkedMarkers = 0, maxConsecutiveFailures = 0;
  let oldest: number | null = null;
  const counts = new Map<CatalogRepairFailureKindV1, number>();
  for (const state of states) {
    if (!state) continue;
    failedMarkers += 1; if (state.parked) parkedMarkers += 1;
    maxConsecutiveFailures = Math.max(maxConsecutiveFailures, state.consecutiveFailures);
    oldest = Math.min(oldest ?? state.firstFailedAtMs, state.firstFailedAtMs);
    counts.set(state.kind, (counts.get(state.kind) ?? 0) + 1);
  }
  return Object.freeze({ failedMarkers, parkedMarkers, maxConsecutiveFailures,
    oldestFailureAgeMs: oldest === null ? null : Math.max(0, nowMs - oldest),
    kinds: Object.freeze([...counts].sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => Object.freeze({ kind, count }))),
  });
}

/** Corrupt hints must never park work or become repair/authorization evidence. */
export function parsePrivatePlacementFailureStateV1(input: unknown): PrivatePlacementFailureStateV1 | null {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    if (Object.keys(input).sort().join(',') !== 'consecutiveFailures,firstFailedAtMs,kind,lastFailedAtMs,nextAttemptAtMs,parked,sameKindFailures') return null;
    const { kind, parked, consecutiveFailures, sameKindFailures, firstFailedAtMs,
      lastFailedAtMs, nextAttemptAtMs } = input as PrivatePlacementFailureStateV1;
    if (!isCatalogRepairFailureKindV1(kind) || typeof parked !== 'boolean') return null;
    if (![consecutiveFailures, sameKindFailures, firstFailedAtMs, lastFailedAtMs]
      .every(value => Number.isSafeInteger(value) && value >= 0)) return null;
    if (sameKindFailures > consecutiveFailures || firstFailedAtMs > lastFailedAtMs) return null;
    if (nextAttemptAtMs !== null && (!Number.isSafeInteger(nextAttemptAtMs)
      || nextAttemptAtMs < lastFailedAtMs
      || nextAttemptAtMs - lastFailedAtMs > PRIVATE_REPAIR_MAX_BACKOFF_MS)) return null;
    if (parked && (!isDeterministicPrivateRepairFailureV1(kind) || sameKindFailures < 3 || nextAttemptAtMs !== null)) return null;
    return Object.freeze({ kind, consecutiveFailures, sameKindFailures, firstFailedAtMs,
      lastFailedAtMs, nextAttemptAtMs, parked });
  } catch { return null; }
}

/** Operator/lane reset changes scheduling only, retaining the last failure and its age. */
export function resetPrivatePlacementFailureStateV1(state: PrivatePlacementFailureStateV1): PrivatePlacementFailureStateV1 {
  return Object.freeze({ ...state, consecutiveFailures: 0, sameKindFailures: 0, nextAttemptAtMs: null, parked: false });
}
