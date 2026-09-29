// SPDX-License-Identifier: Apache-2.0

/** Constant-size scheduling hint; canonical reconciliation remains authoritative. */
export class CatalogRepairRetryV1 {
  #revision: string | null | undefined;
  generation = 0;
  consecutiveFailures = 0;
  nextAttemptAtMs: number | null = null;

  observe(revision: string | null | undefined): boolean {
    // A failed local hint read is neither a mutation nor a lane transition.
    if (revision === undefined) return false;
    const changed = this.#revision !== undefined && this.#revision !== revision;
    this.#revision = revision;
    if (changed) {
      this.generation += 1;
      this.reset();
    }
    return changed;
  }

  eligible(nowMs: number): boolean {
    return this.nextAttemptAtMs === null || nowMs >= this.nextAttemptAtMs;
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.nextAttemptAtMs = null;
  }

  /** A stale attempt cannot impose its cooldown on a newer observed revision. */
  fail(attemptGeneration: number, nowMs: number, configuredIntervalMs?: number): boolean {
    if (attemptGeneration !== this.generation) return false;
    this.consecutiveFailures = Math.min(Number.MAX_SAFE_INTEGER, this.consecutiveFailures + 1);
    const base = configuredIntervalMs !== undefined && configuredIntervalMs > 0
      ? configuredIntervalMs : 5_000;
    const delay = Math.min(Math.max(base, 60_000), base * 2 ** Math.min(30, this.consecutiveFailures - 1));
    this.nextAttemptAtMs = nowMs + delay;
    return true;
  }
}
