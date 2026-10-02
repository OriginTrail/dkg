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
 * never a wrong version.
 *
 * The update event is the durable record. The event lane never persists its
 * cursor past the oldest held target's block ({@link VmRefreshQueue.oldestBlockNumber}),
 * so after a restart it replays every event whose target was not settled, and
 * the nudge records the target again. A full set refuses a new target, which
 * fails the event's dispatch, so the lane holds and dispatches it again later.
 * A target held past its maximum age is given up
 * ({@link VmRefreshQueue.expire}): it releases its slot and the lane's cursor,
 * and the copy waits for the KA's next update or an explicit asset fetch.
 */

export interface VmRefreshTarget {
  readonly localCgId: string;
  readonly ual: string;
  readonly kaId: bigint;
  /** Root the update event announced, 0x-prefixed lowercase hex. */
  readonly merkleRoot: string;
  /**
   * Block of the update event, when known. A chain view older than it has
   * not seen the update, so it can never settle the target as current. Only
   * targets with a block hold the event lane's persisted cursor.
   */
  readonly blockNumber?: number;
  /** Hash of the event's block, to distinguish a replacement fork. */
  readonly blockHash?: string;
  /** Position within the block, so two updates with the same root remain distinct. */
  readonly logIndex?: number;
  /** Transaction identity when a log position is unavailable or a block reorganizes. */
  readonly txHash?: string;
  /** Required chain-view height when an unseen event arrives behind a held one. */
  readonly proofBlockNumber?: number;
  /**
   * The copy already holds the announced root. Roots name content, not
   * versions, so an update that repeats content (or an A -> B -> A history)
   * can leave the copy at an older version with the same root; the attempt
   * then compares versions with the chain instead of settling on the root.
   */
  readonly checkVersion?: boolean;
}

/** A due target with the failed attempts before it. */
export interface VmRefreshDue extends VmRefreshTarget {
  readonly failures: number;
}

/**
 * What one attempt concluded.
 *  - `current`: the local copy already holds the chain's current version.
 *  - `refreshed`: the current version was fetched and materialized.
 *  - `not-applicable`: nothing for this lane to do (no confirmed copy any
 *    more, or a chain adapter that cannot read or prove the current version).
 *  - `retry`: the chain or the network could not settle it; try again later.
 */
export type VmRefreshOutcome = 'current' | 'refreshed' | 'not-applicable' | 'retry';

/** One attempt's outcome and what decided it, for the lane's log line. */
export interface VmRefreshAttempt {
  readonly outcome: VmRefreshOutcome;
  readonly detail: string;
}

/**
 * What an offer did: recorded a new update, kept the already held event (and
 * its retry schedule), or refused it because the set is full.
 */
export type VmRefreshOfferResult = 'recorded' | 'held' | 'full';

/** A target given up at its maximum age, with the failed attempts behind it. */
export interface VmRefreshGivenUp extends VmRefreshTarget {
  readonly failures: number;
  readonly heldMs: number;
}

export interface VmRefreshQueueOptions {
  /** Upper bound on targets held across all graphs; a full set refuses new ones. */
  readonly maxEntries: number;
  /** Delay before the first retry; doubles per failure. */
  readonly baseBackoffMs: number;
  /** Ceiling of the retry delay. */
  readonly maxBackoffMs: number;
  /** Age, from its first offer, at which a target that never settled is given up. */
  readonly maxAgeMs: number;
  readonly now?: () => number;
}

interface VmRefreshRecord {
  readonly target: VmRefreshTarget;
  readonly firstOfferedAt: number;
  /** Event identities superseded while this target is held. */
  readonly seenUpdateKeys: Set<string>;
  failures: number;
  nextAttemptAt: number;
}

function recordKey(localCgId: string, ual: string): string {
  return `${localCgId}\0${ual}`;
}

function updateKey(target: VmRefreshTarget): string {
  // Complete positions remain distinct, including across forks. Legacy
  // adapters without a position can only coalesce the evidence they supply.
  if (target.blockNumber === undefined) return JSON.stringify(['legacy', target.merkleRoot]);
  if (target.logIndex !== undefined) {
    return JSON.stringify([
      'log', target.blockNumber, target.logIndex, target.blockHash,
      target.txHash, target.merkleRoot,
    ]);
  }
  if (target.txHash !== undefined) {
    return JSON.stringify([
      'transaction', target.blockNumber, target.blockHash, target.txHash, target.merkleRoot,
    ]);
  }
  return JSON.stringify(['legacy-block', target.blockNumber, target.merkleRoot]);
}

function behindHeld(incoming: VmRefreshTarget, held: VmRefreshTarget): boolean {
  if (incoming.blockNumber === undefined || held.blockNumber === undefined) return false;
  if (incoming.blockNumber !== held.blockNumber) return incoming.blockNumber < held.blockNumber;
  return incoming.logIndex !== undefined && held.logIndex !== undefined
    && incoming.logIndex < held.logIndex;
}

export class VmRefreshQueue {
  readonly #records = new Map<string, VmRefreshRecord>();
  readonly #maxEntries: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  #refusedTotal = 0;
  #givenUpTotal = 0;

  constructor(options: VmRefreshQueueOptions) {
    this.#maxEntries = Math.max(1, Math.floor(options.maxEntries));
    this.#baseBackoffMs = Math.max(0, options.baseBackoffMs);
    this.#maxBackoffMs = Math.max(this.#baseBackoffMs, options.maxBackoffMs);
    this.#maxAgeMs = Math.max(0, options.maxAgeMs);
    this.#now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.#records.size;
  }

  /** Offers refused because the set was full, since this queue was made. */
  get refusedTotal(): number {
    return this.#refusedTotal;
  }

  /** Targets given up at their maximum age, since this queue was made. */
  get givenUpTotal(): number {
    return this.#givenUpTotal;
  }

  /**
   * Record a target, due after `delayMs`. A replay of a held or superseded
   * update keeps the current retry schedule. An unseen update replaces it,
   * even at a lower position: that event could be from a replacement fork.
   * A same-root or lower-position replacement must check the chain version.
   */
  offer(target: VmRefreshTarget, delayMs = 0): VmRefreshOfferResult {
    const key = recordKey(target.localCgId, target.ual);
    const held = this.#records.get(key);
    const keyOfUpdate = updateKey(target);
    if (held !== undefined
      && (updateKey(held.target) === keyOfUpdate || held.seenUpdateKeys.has(keyOfUpdate))) {
      return 'held';
    }
    if (held === undefined && this.#records.size >= this.#maxEntries) {
      this.#refusedTotal += 1;
      return 'full';
    }
    const seenUpdateKeys = new Set(held?.seenUpdateKeys);
    if (held !== undefined) seenUpdateKeys.add(updateKey(held.target));
    // The queue is bounded, and so is the replay memory for a busy KA.
    if (seenUpdateKeys.size > 128) seenUpdateKeys.delete(seenUpdateKeys.values().next().value!);
    const behind = held !== undefined && behindHeld(target, held.target);
    const previousProof = held?.target.proofBlockNumber ?? held?.target.blockNumber;
    const incomingProof = target.proofBlockNumber ?? target.blockNumber;
    const proofBlockNumber = previousProof === undefined ? incomingProof
      : incomingProof === undefined ? previousProof
        : Math.max(previousProof, incomingProof);
    this.#records.delete(key);
    const now = this.#now();
    this.#records.set(key, {
      target: Object.freeze({
        ...target,
        ...(held?.target.merkleRoot === target.merkleRoot || behind ? { checkVersion: true } : {}),
        ...(proofBlockNumber !== undefined && proofBlockNumber !== target.blockNumber
          ? { proofBlockNumber } : {}),
      }),
      firstOfferedAt: now,
      seenUpdateKeys,
      failures: 0,
      nextAttemptAt: delayMs > 0 ? now + delayMs : 0,
    });
    return 'recorded';
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
   * Lowest event block of the held targets that carry one: the event lane
   * must replay from it after a restart. Undefined when none is held.
   */
  oldestBlockNumber(): number | undefined {
    let oldest: number | undefined;
    for (const record of this.#records.values()) {
      const block = record.target.blockNumber;
      if (block === undefined) continue;
      if (oldest === undefined || block < oldest) oldest = block;
    }
    return oldest;
  }

  /**
   * Settle one attempt. Only the exact target that was attempted is settled:
   * a newer event recorded while the attempt ran stays queued and due.
   * Returns when a retried target is due again.
   */
  settle(target: VmRefreshTarget, outcome: VmRefreshOutcome): number | undefined {
    const key = recordKey(target.localCgId, target.ual);
    const held = this.#records.get(key);
    if (held === undefined || updateKey(held.target) !== updateKey(target)) return undefined;
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

  /**
   * Give up every target held for `maxAgeMs` or longer since its first offer,
   * whether it kept failing or was never attempted (a graph whose pass no
   * longer runs). Returns the targets given up.
   */
  expire(): VmRefreshGivenUp[] {
    const now = this.#now();
    const out: VmRefreshGivenUp[] = [];
    for (const [key, record] of this.#records) {
      const heldMs = now - record.firstOfferedAt;
      if (heldMs < this.#maxAgeMs) continue;
      this.#records.delete(key);
      this.#givenUpTotal += 1;
      out.push(Object.freeze({ ...record.target, failures: record.failures, heldMs }));
    }
    return out;
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
