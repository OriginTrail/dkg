// SPDX-License-Identifier: Apache-2.0
import { type CatalogRepairFailureKindV1, PRIVATE_REPAIR_MAX_BACKOFF_MS, isDeterministicPrivateRepairFailureV1, parsePrivatePlacementFailureStateV1, type PrivatePlacementFailureStateV1 } from '../rfc64/private-placement-failure-state-v1.js';

/** Exact durable identity owns one failure record and its attempt-generation fence. */
export class FinalizedPrivateRepairRetryV1 {
  #generation = 0;
  #failure: PrivatePlacementFailureStateV1 | null = null;
  #restoredDeadline: number | null = null;

  get generation(): number { return this.#generation; }
  get consecutiveFailures(): number { return this.#failure?.consecutiveFailures ?? 0; }
  get nextAttemptAtMs(): number | null {
    return this.#failure?.nextAttemptAtMs == null ? null : this.#restoredDeadline ?? this.#failure.nextAttemptAtMs;
  }
  get sameKindFailures(): number { return this.#failure?.sameKindFailures ?? 0; }
  get parked(): boolean { return this.#failure?.parked ?? false; }

  restore(input: unknown, nowMs: number): void {
    const state = parsePrivatePlacementFailureStateV1(input);
    if (!state) return;
    // A backwards wall-clock jump cannot turn a transient cooldown into an unbounded delay.
    this.#failure = state;
    this.#restoredDeadline = state.nextAttemptAtMs === null ? null
      : Math.min(state.nextAttemptAtMs, nowMs + PRIVATE_REPAIR_MAX_BACKOFF_MS);
  }

  eligible(nowMs: number): boolean {
    return !this.parked && (this.nextAttemptAtMs === null || nowMs >= this.nextAttemptAtMs);
  }

  /** Apply the owner's committed reset and invalidate older in-flight failures. */
  retryNow(persistedReset: PrivatePlacementFailureStateV1 | null): void {
    this.#generation += 1;
    this.#restoredDeadline = null;
    this.#failure = persistedReset;
  }

  fail(generation: number, nowMs: number, intervalMs?: number, kind: CatalogRepairFailureKindV1 = 'unknown'): boolean {
    if (generation !== this.#generation) return false;
    this.#restoredDeadline = null;
    const sameKindFailures = kind === this.#failure?.kind ? Math.min(Number.MAX_SAFE_INTEGER, this.sameKindFailures + 1) : 1;
    const parked = isDeterministicPrivateRepairFailureV1(kind) && sameKindFailures >= 3;
    const base = intervalMs !== undefined && intervalMs > 0 ? intervalMs : 5_000;
    this.#failure = Object.freeze({ kind, consecutiveFailures: Math.min(Number.MAX_SAFE_INTEGER, this.consecutiveFailures + 1),
      sameKindFailures, firstFailedAtMs: Math.min(this.#failure?.firstFailedAtMs ?? nowMs, nowMs), lastFailedAtMs: nowMs,
      parked, nextAttemptAtMs: parked ? null : nowMs + Math.min(PRIVATE_REPAIR_MAX_BACKOFF_MS,
        base * 2 ** Math.min(30, sameKindFailures - 1)) });
    return true;
  }

  /** Capacity owns wakeups; retain evidence without adding a generic cooldown. */
  recordCapacityFailure(generation: number, nowMs: number): boolean {
    if (!this.fail(generation, nowMs, undefined, 'catalog_full')) return false;
    this.#failure = Object.freeze({ ...this.#failure!, nextAttemptAtMs: null });
    return true;
  }

  snapshot(): PrivatePlacementFailureStateV1 | null { return this.#failure; }
}
