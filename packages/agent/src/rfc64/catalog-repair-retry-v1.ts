// SPDX-License-Identifier: Apache-2.0

import type { CatalogRepairDiagnosticV1 } from './catalog-repair-diagnostics-v1.js';

const survivesInventoryChange = (kind: CatalogRepairDiagnosticV1['kind']): boolean => (
  kind === 'integrity' || kind === 'queue_wait' || kind === 'queue_full'
  || kind === 'store_timeout_not_started' || kind === 'store_timeout_indeterminate'
);

/**
 * GH#3134 — a full catalog refuses the same way until a row is free, so it is not retried on the
 * failure timer. A change of the author's inventory still resets the cooldown and gets one attempt.
 */
export const CATALOG_FULL_RETRY_INTERVAL_MS_V1 = 60 * 60_000;

/** Producer-owned identity separates inventory churn from an authoring-scope transition. */
export interface CatalogRepairRevisionHintV1 {
  readonly scopeIdentity: string;
  readonly headRevision: string | null;
}

/** Constant-size scheduling hint; canonical reconciliation remains authoritative. */
export class CatalogRepairRetryV1 {
  #revision: CatalogRepairRevisionHintV1 | null | undefined;
  #retainCooldown = false;
  #lastLaneGeneration = 0;
  generation = 0;
  consecutiveFailures = 0;
  nextAttemptAtMs: number | null = null;

  observe(revision: CatalogRepairRevisionHintV1 | null | undefined): boolean {
    // A failed local hint read is neither a mutation nor a lane transition.
    if (revision === undefined) return false;
    const previous = this.#revision;
    const changed = previous !== undefined && (previous === null || revision === null
      ? previous !== revision
      : previous.scopeIdentity !== revision.scopeIdentity || previous.headRevision !== revision.headRevision);
    const scopeChanged = previous != null && revision !== null
      && previous.scopeIdentity !== revision.scopeIdentity;
    const laneChanged = previous === null || revision === null || scopeChanged;
    this.#revision = revision === null ? null : { ...revision };
    if (changed) {
      this.generation += 1;
      if (laneChanged) this.#lastLaneGeneration = this.generation;
      if (laneChanged || !this.#retainCooldown) this.reset();
    }
    return changed;
  }

  eligible(nowMs: number): boolean {
    return this.nextAttemptAtMs === null || nowMs >= this.nextAttemptAtMs;
  }

  reset(): void {
    this.#retainCooldown = false;
    this.consecutiveFailures = 0;
    this.nextAttemptAtMs = null;
  }

  /** Integrity and store pressure survive head churn; lane changes and success reset them. */
  fail(attemptGeneration: number, nowMs: number, configuredIntervalMs?: number, kind: CatalogRepairDiagnosticV1['kind'] = 'unknown'): boolean {
    const retain = survivesInventoryChange(kind);
    if (attemptGeneration !== this.generation && (!retain || this.#revision === null || attemptGeneration < this.#lastLaneGeneration)) return false;
    this.#retainCooldown = retain;
    this.consecutiveFailures = Math.min(Number.MAX_SAFE_INTEGER, this.consecutiveFailures + 1);
    const base = configuredIntervalMs !== undefined && configuredIntervalMs > 0
      ? configuredIntervalMs : 5_000;
    const delay = Math.min(Math.max(base, 60_000), base * 2 ** Math.min(30, this.consecutiveFailures - 1));
    this.nextAttemptAtMs = nowMs + (kind === 'catalog_full' ? CATALOG_FULL_RETRY_INTERVAL_MS_V1 : delay);
    return true;
  }
}
