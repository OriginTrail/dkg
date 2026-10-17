// SPDX-License-Identifier: Apache-2.0
import type { CatalogRepairFailureKindV1 } from '../rfc64/catalog-repair-diagnostics-v1.js';
import { CatalogRepairRetryV1 } from '../rfc64/catalog-repair-retry-v1.js';

export const PRIVATE_REPAIR_MAX_BACKOFF_MS = 30 * 60_000;
const deterministic = new Set<CatalogRepairFailureKindV1>(['policy_conflict', 'version_conflict', 'signer_mismatch']);
const kinds = new Set<CatalogRepairFailureKindV1>([
  'queue_wait', 'queue_full', 'store_timeout_not_started', 'store_timeout_indeterminate',
  'transport', 'cancelled', 'integrity', 'lane_inactive', 'catalog_full', 'unknown',
  'policy_conflict', 'version_conflict', 'signer_mismatch', 'persistence_unavailable',
]);

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

export function summarizePrivatePlacementFailuresV1(retries: Iterable<FinalizedPrivateRepairRetryV1>, nowMs = Date.now()): PrivatePlacementFailureSummaryV1 {
  let failedMarkers = 0, parkedMarkers = 0, maxConsecutiveFailures = 0;
  let oldest: number | null = null;
  const counts = new Map<CatalogRepairFailureKindV1, number>();
  for (const retry of retries) {
    const state = retry.snapshot(); if (!state) continue;
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
    if (!kinds.has(kind) || typeof parked !== 'boolean') return null;
    if (![consecutiveFailures, sameKindFailures, firstFailedAtMs, lastFailedAtMs]
      .every(value => Number.isSafeInteger(value) && value >= 0)) return null;
    if (sameKindFailures > consecutiveFailures || firstFailedAtMs > lastFailedAtMs) return null;
    if (nextAttemptAtMs !== null && (!Number.isSafeInteger(nextAttemptAtMs)
      || nextAttemptAtMs < lastFailedAtMs
      || nextAttemptAtMs - lastFailedAtMs > PRIVATE_REPAIR_MAX_BACKOFF_MS)) return null;
    if (parked && (!deterministic.has(kind) || sameKindFailures < 3 || nextAttemptAtMs !== null)) return null;
    return Object.freeze({ kind, consecutiveFailures, sameKindFailures, firstFailedAtMs,
      lastFailedAtMs, nextAttemptAtMs, parked });
  } catch { return null; }
}

/** Private repair identity is exact and durable; unrelated inventory traffic cannot reset it. */
export class FinalizedPrivateRepairRetryV1 extends CatalogRepairRetryV1 {
  kind: CatalogRepairFailureKindV1 | null = null;
  sameKindFailures = 0;
  firstFailedAtMs: number | null = null;
  lastFailedAtMs: number | null = null;
  parked = false;

  restore(input: unknown, nowMs: number): void {
    const state = parsePrivatePlacementFailureStateV1(input);
    if (!state) return;
    Object.assign(this, state);
    // A backwards wall-clock jump cannot turn a transient cooldown into an unbounded delay.
    if (this.nextAttemptAtMs !== null) this.nextAttemptAtMs = Math.min(this.nextAttemptAtMs, nowMs + PRIVATE_REPAIR_MAX_BACKOFF_MS);
  }

  override eligible(nowMs: number): boolean { return !this.parked && super.eligible(nowMs); }

  override reset(): void {
    super.reset();
    this.sameKindFailures = 0;
    this.parked = false;
  }

  /** Explicit operator retry invalidates any in-flight failure's scheduling generation. */
  retryNow(): void { this.generation += 1; this.reset(); }

  override fail(generation: number, nowMs: number, intervalMs?: number, kind: CatalogRepairFailureKindV1 = 'unknown'): boolean {
    if (generation !== this.generation) return false;
    if (!super.fail(generation, nowMs, intervalMs, kind)) return false;
    this.sameKindFailures = kind === this.kind ? Math.min(Number.MAX_SAFE_INTEGER, this.sameKindFailures + 1) : 1;
    this.kind = kind;
    this.firstFailedAtMs = Math.min(this.firstFailedAtMs ?? nowMs, nowMs);
    this.lastFailedAtMs = nowMs;
    this.parked = deterministic.has(kind) && this.sameKindFailures >= 3;
    const base = intervalMs !== undefined && intervalMs > 0 ? intervalMs : 5_000;
    this.nextAttemptAtMs = this.parked ? null : nowMs + Math.min(PRIVATE_REPAIR_MAX_BACKOFF_MS,
      base * 2 ** Math.min(30, this.sameKindFailures - 1));
    return true;
  }

  snapshot(): PrivatePlacementFailureStateV1 | null {
    if (this.kind === null || this.firstFailedAtMs === null || this.lastFailedAtMs === null) return null;
    return Object.freeze({ kind: this.kind, consecutiveFailures: this.consecutiveFailures,
      sameKindFailures: this.sameKindFailures, firstFailedAtMs: this.firstFailedAtMs,
      lastFailedAtMs: this.lastFailedAtMs, nextAttemptAtMs: this.nextAttemptAtMs, parked: this.parked });
  }
}
