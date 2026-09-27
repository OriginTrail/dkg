// SPDX-License-Identifier: Apache-2.0

/**
 * Refresh of confirmed Verifiable Memory copies after a Knowledge Asset update.
 *
 * An update keeps the KA id and moves its latest on-chain root. The ordinal
 * sweep never revisits a settled ordinal, so a node whose only copy is a
 * confirmed VM copy (a member of a catalog graph, a core outside the update's
 * ACK set) has no other lane that brings the new version. The live
 * `KnowledgeAssetUpdated` nudge records one target per holding graph; a
 * refresh worker the graph's reconcile pass starts works the targets off,
 * reading the chain before it fetches anything.
 *
 * This module owns only the bounded, process-local target set and its retry
 * schedule. A target is a hint: every attempt re-derives the decision from the
 * local copy and the chain, so a stale target costs at most a chain read,
 * never a wrong version. An update that lands while the node is down reaches
 * it after the restart, replayed from the event lane's persisted cursor. A
 * target lost to eviction, or to a restart after its event was consumed,
 * leaves the copy as it was until the KA's next update or an explicit asset
 * fetch.
 */

export interface VmRefreshTarget {
  readonly localCgId: string;
  readonly ual: string;
  readonly kaId: bigint;
  /** Root the update event announced, 0x-prefixed lowercase hex. */
  readonly merkleRoot: string;
}

/** A due target with the failed attempts before it. */
export interface VmRefreshDue extends VmRefreshTarget {
  readonly failures: number;
}

/**
 * What one attempt concluded.
 *  - `current`: the local copy already holds the chain's current root.
 *  - `refreshed`: the current version was fetched and materialized.
 *  - `not-applicable`: nothing for this lane to do (no confirmed copy any
 *    more, or a newer version staged locally, whose promotion another lane
 *    owns).
 *  - `retry`: the chain or the network could not settle it; try again later.
 */
export type VmRefreshOutcome = 'current' | 'refreshed' | 'not-applicable' | 'retry';

/** One attempt's outcome and what decided it, for the lane's log line. */
export interface VmRefreshAttempt {
  readonly outcome: VmRefreshOutcome;
  readonly detail: string;
}

export interface VmRefreshQueueOptions {
  /** Upper bound on targets held across all graphs; the oldest is dropped first. */
  readonly maxEntries: number;
  /** Delay before the first retry; doubles per failure. */
  readonly baseBackoffMs: number;
  /** Ceiling of the retry delay. */
  readonly maxBackoffMs: number;
  readonly now?: () => number;
}

interface VmRefreshRecord {
  readonly target: VmRefreshTarget;
  failures: number;
  nextAttemptAt: number;
}

function recordKey(localCgId: string, ual: string): string {
  return `${localCgId}\0${ual}`;
}

export class VmRefreshQueue {
  readonly #records = new Map<string, VmRefreshRecord>();
  readonly #maxEntries: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #now: () => number;

  constructor(options: VmRefreshQueueOptions) {
    this.#maxEntries = Math.max(1, Math.floor(options.maxEntries));
    this.#baseBackoffMs = Math.max(0, options.baseBackoffMs);
    this.#maxBackoffMs = Math.max(this.#baseBackoffMs, options.maxBackoffMs);
    this.#now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.#records.size;
  }

  /**
   * Record a target. The same KA at the same root keeps its retry schedule, so
   * a replayed event cannot defeat the backoff; a different root is new
   * evidence and replaces the target, due at once. Returns whether anything
   * new was recorded.
   */
  offer(target: VmRefreshTarget): boolean {
    const key = recordKey(target.localCgId, target.ual);
    const held = this.#records.get(key);
    if (held !== undefined && held.target.merkleRoot === target.merkleRoot) return false;
    this.#records.delete(key);
    this.#records.set(key, {
      target: Object.freeze({ ...target }),
      failures: 0,
      nextAttemptAt: 0,
    });
    while (this.#records.size > this.#maxEntries) {
      const oldest = this.#records.keys().next().value;
      if (oldest === undefined) break;
      this.#records.delete(oldest);
    }
    return true;
  }

  /** Due targets of one graph, oldest first, at most `limit`. */
  due(localCgId: string, limit: number): VmRefreshDue[] {
    const now = this.#now();
    const out: VmRefreshDue[] = [];
    for (const record of this.#records.values()) {
      if (out.length >= limit) break;
      if (record.target.localCgId !== localCgId || record.nextAttemptAt > now) continue;
      out.push(Object.freeze({ ...record.target, failures: record.failures }));
    }
    return out;
  }

  hasDue(localCgId: string): boolean {
    return this.due(localCgId, 1).length > 0;
  }

  /** Graphs with at least one due target, in the order of their oldest one. */
  dueContextGraphIds(): string[] {
    const now = this.#now();
    const out = new Set<string>();
    for (const record of this.#records.values()) {
      if (record.nextAttemptAt <= now) out.add(record.target.localCgId);
    }
    return [...out];
  }

  /**
   * Settle one attempt. Only the exact target that was attempted is settled:
   * a newer root recorded while the attempt ran stays queued and due.
   * Returns when a retried target is due again.
   */
  settle(target: VmRefreshTarget, outcome: VmRefreshOutcome): number | undefined {
    const key = recordKey(target.localCgId, target.ual);
    const held = this.#records.get(key);
    if (held === undefined || held.target.merkleRoot !== target.merkleRoot) return undefined;
    if (outcome !== 'retry') {
      this.#records.delete(key);
      return undefined;
    }
    held.failures += 1;
    const exponent = Math.min(held.failures - 1, 16);
    held.nextAttemptAt = this.#now()
      + Math.min(this.#maxBackoffMs, this.#baseBackoffMs * 2 ** exponent);
    return held.nextAttemptAt;
  }

  clearContextGraph(localCgId: string): void {
    for (const [key, record] of this.#records) {
      if (record.target.localCgId === localCgId) this.#records.delete(key);
    }
  }

  clear(): void {
    this.#records.clear();
  }

  /** Every held target with its retry state, oldest first. */
  snapshot(): ReadonlyArray<VmRefreshTarget & { failures: number; nextAttemptAt: number }> {
    return [...this.#records.values()].map((record) => Object.freeze({
      ...record.target,
      failures: record.failures,
      nextAttemptAt: record.nextAttemptAt,
    }));
  }
}
