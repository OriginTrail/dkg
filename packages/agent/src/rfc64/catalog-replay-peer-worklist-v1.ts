// SPDX-License-Identifier: Apache-2.0
import { RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 } from './catalog-peers-v1.js';
import type { Rfc64CatalogReplayPeerDemandV1, Rfc64CatalogReplayPeerReservationV1 } from './catalog-replay-recovery-runtime-v1.js';

/**
 * One owner for reconnect generations, pending-peer deduplication, and the
 * finite amount of peer work a coalesced replay may perform. A peer ID is not
 * itself a completion token: enqueueing the same peer after its earlier demand
 * was drained creates a newer generation that must be replayed or left
 * fail-closed when the run budget is exhausted.
 */
export class Rfc64CatalogReplayPeerWorklistV1 {
  readonly #pending = new Map<string, number>();
  readonly #staged = new Map<string, number>();
  /** Full-pass coverage waits for these exact staged generations to execute. */
  readonly #fullCoveragePending = new Map<string, number>();
  #fullRequested = false;
  #splitFullPass = false;
  #nextGeneration = 0;
  #remaining = RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1;
  #overflowed = false;

  beginRun(): void {
    this.#remaining = RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1;
  }

  reserve(peerId: string): Rfc64CatalogReplayPeerReservationV1 | null {
    const owned = new Set([...this.#pending.keys(), ...this.#staged.keys()]);
    if (!owned.has(peerId) && owned.size >= RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1) {
      this.#overflowed = true;
      return null;
    }
    const generation = ++this.#nextGeneration;
    this.#staged.set(peerId, generation);
    if (this.#fullCoveragePending.has(peerId)) this.#fullCoveragePending.set(peerId, generation);
    let released = false;
    return Object.freeze({
      peerId, generation,
      admit: () => {
        if (released || this.#staged.get(peerId) !== generation) return;
        this.#staged.delete(peerId);
        this.#pending.set(peerId, generation);
      },
      release: () => {
        if (released) return;
        released = true;
        if (this.#staged.get(peerId) === generation) this.#staged.delete(peerId);
        if (this.#pending.get(peerId) === generation) this.#pending.delete(peerId);
        if (this.#fullCoveragePending.get(peerId) === generation) {
          // Released without execution: a later unrelated run cannot donate its coverage.
          this.#fullCoveragePending.clear(); this.#fullRequested = false; this.#splitFullPass = false;
        }
      },
    });
  }

  /**
   * Bounded seeding: a peer that does not fit the worklist is deferred to a
   * later run instead of overflowing it. Returns false when the peer was not
   * queued, so a caller can withhold full-pass entitlement from a pass that
   * could not cover every peer it was asked to cover. Seeding may not raise a
   * full-replay witness: not dialing a peer is no evidence about applied rows.
   */
  seedBounded(peerId: string): boolean {
    if (this.#staged.has(peerId)) return false;
    if (this.#pending.has(peerId)) return true;
    if (new Set([...this.#pending.keys(), ...this.#staged.keys()]).size >= RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1) return false;
    this.#pending.set(peerId, ++this.#nextGeneration);
    return true;
  }

  /** Retain staged coverage without taking transport admission from its connection owner. */
  seedFullPass(peers: readonly string[]): void {
    const staged = new Map<string, number>();
    let covered = true;
    for (const peer of peers) {
      const generation = this.#staged.get(peer);
      if (generation !== undefined) staged.set(peer, generation);
      else if (!this.seedBounded(peer)) covered = false;
    }
    if (!covered) {
      // A later partial command cannot inherit an earlier complete pass's entitlement.
      this.#fullCoveragePending.clear(); this.#fullRequested = false; this.#splitFullPass = false;
      return;
    }
    this.#fullRequested = true;
    for (const [peer, generation] of staged) this.#fullCoveragePending.set(peer, generation);
    this.#splitFullPass ||= staged.size > 0;
  }

  get fullPassEntitled(): boolean { return this.#fullRequested && this.#fullCoveragePending.size === 0; }
  get splitFullPass(): boolean { return this.#splitFullPass; }
  settleFullPass(): void {
    if (this.#fullCoveragePending.size === 0) { this.#fullRequested = false; this.#splitFullPass = false; }
  }

  /** Forget a queued demand for a peer that can no longer be replayed from. */
  discard(peerId: string): void {
    this.#pending.delete(peerId);
  }

  /**
   * Deliberately unbounded, unlike `seedBounded`. Every demand here was already
   * reserved then admitted by `reserve`, whose own bound is what limits concurrent reconnect
   * ownership; refusing one at this point would silently cancel a live peer's
   * replay with no retry, because the connection runtime debounces re-prepare
   * for 60s. Re-seeding after `drain` freed the slot can therefore carry
   * `#pending` past the bound, and `#remaining === 0 && hasPending` then trips
   * the fail-closed `exhausted` fence into a full-replay witness for what was
   * really run-budget exhaustion. That conflation is a known residual (review
   * thread "the dead-dial / overflow problem"): fixing it means giving fresh
   * demands their own budget or starting a follow-on run, not dropping them.
   */
  seedDemand(demand: Rfc64CatalogReplayPeerDemandV1): void {
    const current = this.#pending.get(demand.peerId);
    if (current === undefined || current < demand.generation) {
      this.#pending.set(demand.peerId, demand.generation);
    }
    this.#nextGeneration = Math.max(this.#nextGeneration, demand.generation);
  }

  drain(): readonly Rfc64CatalogReplayPeerDemandV1[] {
    if (this.#remaining === 0) return Object.freeze([]);
    const demands = [...this.#pending.entries()]
      .slice(0, this.#remaining)
      .map(([peerId, generation]) => Object.freeze({ peerId, generation }));
    for (const demand of demands) {
      if (this.#pending.get(demand.peerId) === demand.generation) {
        this.#pending.delete(demand.peerId);
      }
      const coveredGeneration = this.#fullCoveragePending.get(demand.peerId);
      if (coveredGeneration !== undefined && demand.generation >= coveredGeneration) {
        this.#fullCoveragePending.delete(demand.peerId);
      }
    }
    this.#remaining -= demands.length;
    return Object.freeze(demands);
  }

  get hasStaged(): boolean { return this.#staged.size > 0; }

  get hasPending(): boolean {
    return this.#pending.size > 0;
  }

  get exhausted(): boolean {
    return this.#overflowed || (this.#remaining === 0 && this.hasPending);
  }

  settleOverflow(): void {
    this.#overflowed = false;
  }
}
