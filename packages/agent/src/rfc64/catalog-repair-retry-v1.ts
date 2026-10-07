// SPDX-License-Identifier: Apache-2.0

import type { CatalogRepairDiagnosticV1 } from './catalog-repair-diagnostics-v1.js';

const survivesInventoryChange = (kind: CatalogRepairDiagnosticV1['kind']): boolean => (
  kind === 'integrity' || kind === 'queue_wait' || kind === 'queue_full'
  || kind === 'store_timeout_not_started' || kind === 'store_timeout_indeterminate'
);

/** Production hints bind lane kind, target policy, scope digest, then inventory head. */
function authoringScopeIdentity(revision: string): string | undefined {
  try {
    const value: unknown = JSON.parse(revision);
    return Array.isArray(value) && value.length === 4 && typeof value[2] === 'string'
      ? JSON.stringify(value.slice(0, 3)) : undefined;
  } catch { return undefined; }
}

/** Constant-size scheduling hint; canonical reconciliation remains authoritative. */
export class CatalogRepairRetryV1 {
  #revision: string | null | undefined;
  #scopeIdentity: string | undefined;
  #retainCooldown = false;
  #lastLaneGeneration = 0;
  generation = 0;
  consecutiveFailures = 0;
  nextAttemptAtMs: number | null = null;

  observe(revision: string | null | undefined): boolean {
    // A failed local hint read is neither a mutation nor a lane transition.
    if (revision === undefined) return false;
    const changed = this.#revision !== undefined && this.#revision !== revision;
    const scopeIdentity = revision === null ? undefined : authoringScopeIdentity(revision);
    const scopeChanged = (this.#scopeIdentity !== undefined || scopeIdentity !== undefined)
      && this.#scopeIdentity !== scopeIdentity;
    const laneChanged = this.#revision === null || revision === null || scopeChanged;
    this.#scopeIdentity = scopeIdentity;
    this.#revision = revision;
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
    this.nextAttemptAtMs = nowMs + delay;
    return true;
  }
}
