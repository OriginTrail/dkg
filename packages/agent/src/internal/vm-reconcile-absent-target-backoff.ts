// SPDX-License-Identifier: Apache-2.0

/**
 * Spacing for the periodic sweep's discovery of graphs the chain does not hold.
 *
 * A Core node subscribes to every context graph it hears of over ontology
 * gossip, and anyone can announce a name. An unbound graph whose name the
 * finalized authority index holds no on-chain id for fails every pass with
 * that answer, and the index pays a live authority scan (block and log reads)
 * to give it. The sweep offered such a graph again on every turn, so a few
 * announced but unregistered names took the unbound lane's whole per-sweep
 * allowance, and its RPC, for as long as the process ran.
 *
 * After that answer the graph waits before the sweep offers it again: one base
 * interval at first, doubling with each further answer, up to the ceiling.
 * Only the sweep's unbound lane waits. Live and operator passes run as before,
 * and their answers count the same way. A pass that succeeds, or a new binding
 * for the graph, ends the wait at once. A graph that gets registered is bound
 * by the chain-event and storage-enumeration lanes, which move it out of the
 * unbound lane, so the ceiling only delays a registration both of them miss.
 */

/** The longest wait between two periodic discovery attempts of an absent graph. */
export const VM_RECONCILE_ABSENT_TARGET_BACKOFF_MAX_MS = 60 * 60_000;
/** The first wait, when the host does not supply its sweep cadence. */
export const VM_RECONCILE_ABSENT_TARGET_BACKOFF_BASE_MS = 60_000;
/** Graphs remembered at once; a forgotten one is offered on the next sweep, as without the backoff. */
export const VM_RECONCILE_ABSENT_TARGET_BACKOFF_MAX_ENTRIES = 1_024;

export interface VmReconcileAbsentTargetBackoffOptions {
  readonly baseMs?: number;
  readonly maxMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

interface AbsentTargetEntry {
  /** Consecutive absent answers since the graph last had a pass succeed or a new binding. */
  readonly answers: number;
  readonly retryAt: number;
}

export class VmReconcileAbsentTargetBackoff {
  private readonly entries = new Map<string, AbsentTargetEntry>();
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: VmReconcileAbsentTargetBackoffOptions = {}) {
    const baseMs = options.baseMs ?? VM_RECONCILE_ABSENT_TARGET_BACKOFF_BASE_MS;
    const maxMs = Math.max(baseMs, options.maxMs ?? VM_RECONCILE_ABSENT_TARGET_BACKOFF_MAX_MS);
    const maxEntries = options.maxEntries ?? VM_RECONCILE_ABSENT_TARGET_BACKOFF_MAX_ENTRIES;
    if (!Number.isFinite(baseMs) || baseMs <= 0 || !Number.isFinite(maxMs)) {
      throw new RangeError('VM reconcile absent-target backoff needs a positive, finite base and ceiling');
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('VM reconcile absent-target backoff needs a positive entry bound');
    }
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.maxEntries = maxEntries;
    this.now = options.now ?? Date.now;
  }

  /** A pass found that the finalized authority index holds no on-chain id for the graph's name. */
  noteAbsent(key: string): void {
    const answers = (this.entries.get(key)?.answers ?? 0) + 1;
    const waitMs = Math.min(this.maxMs, this.baseMs * 2 ** Math.min(answers - 1, 32));
    // Re-inserting keeps the map in order of the latest answer, oldest first.
    this.entries.delete(key);
    this.entries.set(key, { answers, retryAt: this.now() + waitMs });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(oldest);
    }
  }

  /** A pass for the graph succeeded, or the graph has a new binding: it waits no longer. */
  clear(key: string): void {
    this.entries.delete(key);
  }

  /** Whether the periodic sweep should leave the graph out for now. */
  isWaiting(key: string): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && entry.retryAt > this.now();
  }

  /** The keys the sweep may offer now, in their given order. */
  due(keys: readonly string[]): readonly string[] {
    if (this.entries.size === 0) return keys;
    return keys.filter((key) => !this.isWaiting(key));
  }
}
