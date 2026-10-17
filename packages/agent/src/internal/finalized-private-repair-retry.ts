// SPDX-License-Identifier: Apache-2.0
import { resetPrivatePlacementFailureStateV1, type CatalogRepairFailureKindV1, PRIVATE_REPAIR_MAX_BACKOFF_MS, isDeterministicPrivateRepairFailureV1, parsePrivatePlacementFailureStateV1, type PrivatePlacementFailureStateV1 } from '../rfc64/private-placement-failure-state-v1.js';

/** Private repair identity is exact and durable; unrelated inventory traffic cannot reset it. */
export class FinalizedPrivateRepairRetryV1 {
  #activeLane: boolean | undefined;
  generation = 0;
  consecutiveFailures = 0;
  nextAttemptAtMs: number | null = null;
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

  observeLane(active: boolean): boolean {
    const changed = this.#activeLane !== undefined && active !== this.#activeLane;
    this.#activeLane = active;
    if (changed) { this.generation += 1; this.reset(); }
    return changed;
  }

  eligible(nowMs: number): boolean {
    return !this.parked && (this.nextAttemptAtMs === null || nowMs >= this.nextAttemptAtMs);
  }

  reset(): void {
    const state = this.snapshot();
    if (state) Object.assign(this, resetPrivatePlacementFailureStateV1(state));
  }

  /** Explicit operator retry invalidates any in-flight failure's scheduling generation. */
  retryNow(persistedReset?: PrivatePlacementFailureStateV1 | null): void {
    this.generation += 1;
    if (persistedReset) Object.assign(this, persistedReset);
    else this.reset();
  }

  fail(generation: number, nowMs: number, intervalMs?: number, kind: CatalogRepairFailureKindV1 = 'unknown'): boolean {
    if (generation !== this.generation) return false;
    this.consecutiveFailures = Math.min(Number.MAX_SAFE_INTEGER, this.consecutiveFailures + 1);
    this.sameKindFailures = kind === this.kind ? Math.min(Number.MAX_SAFE_INTEGER, this.sameKindFailures + 1) : 1;
    this.kind = kind;
    this.firstFailedAtMs = Math.min(this.firstFailedAtMs ?? nowMs, nowMs);
    this.lastFailedAtMs = nowMs;
    this.parked = isDeterministicPrivateRepairFailureV1(kind) && this.sameKindFailures >= 3;
    const base = intervalMs !== undefined && intervalMs > 0 ? intervalMs : 5_000;
    this.nextAttemptAtMs = this.parked ? null : nowMs + Math.min(PRIVATE_REPAIR_MAX_BACKOFF_MS,
      base * 2 ** Math.min(30, this.sameKindFailures - 1));
    return true;
  }

  /** Capacity owns wakeups; retain evidence without adding a generic cooldown. */
  recordCapacityFailure(generation: number, nowMs: number): boolean {
    if (!this.fail(generation, nowMs, undefined, 'catalog_full')) return false;
    this.nextAttemptAtMs = null;
    return true;
  }

  snapshot(): PrivatePlacementFailureStateV1 | null {
    if (this.kind === null || this.firstFailedAtMs === null || this.lastFailedAtMs === null) return null;
    return Object.freeze({ kind: this.kind, consecutiveFailures: this.consecutiveFailures,
      sameKindFailures: this.sameKindFailures, firstFailedAtMs: this.firstFailedAtMs,
      lastFailedAtMs: this.lastFailedAtMs, nextAttemptAtMs: this.nextAttemptAtMs, parked: this.parked });
  }
}
