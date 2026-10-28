import { CatalogReplayPeerWorkV1, CatalogReplayChunkV1 } from './catalog-replay-peer-work-v1.js';
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
  readonly #pending = new Map<string, CatalogReplayPeerWorkV1>();
  readonly #staged = new Map<string, number>();
  #chunk: CatalogReplayChunkV1 | null = null;
  constructor(readonly allocateGeneration: () => number) {}
  #remaining = RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1;
  #overflowed = false;

  beginRun(): CatalogReplayChunkV1 {
    this.#remaining = RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1;
    return this.#chunk = new CatalogReplayChunkV1();
  }
  failPending(error: unknown): void {
    for (const [peer, record] of this.#pending) {
      record.settle({ error });
      // Cancellation releases this execution's subscribers, but unconsumed
      // generations remain available to an explicit later recovery command.
      this.#pending.set(peer, new CatalogReplayPeerWorkV1(peer, record.generation));
    }
  }
  /** Retire queued subscribers without releasing transports consumed by the running chunk. */
  retire(): void {
    for (const record of this.#pending.values()) record.settle({ error: new Error('Catalog replay policy owner retired') });
    this.#pending.clear(); this.#staged.clear();
  }
  #replacePending(record: CatalogReplayPeerWorkV1): void {
    const prior = this.#pending.get(record.peerId);
    if (prior && prior !== record) prior.settle({ error: new Error('Replay generation superseded') });
    this.#pending.set(record.peerId, record);
  }

  reserve(peerId: string): Rfc64CatalogReplayPeerReservationV1 | null {
    const owned = new Set([...this.#pending.keys(), ...this.#staged.keys()]);
    if (!owned.has(peerId) && owned.size >= RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1) {
      this.#overflowed = true;
      return null;
    }
    const generation = this.allocateGeneration();
    this.#staged.set(peerId, generation);
    let released = false;
    return Object.freeze({
      peerId, generation,
      admit: () => {
        if (released || this.#staged.get(peerId) !== generation) return;
        this.#staged.delete(peerId);
        this.#replacePending(new CatalogReplayPeerWorkV1(peerId, generation));
      },
      release: () => {
        if (released) return;
        released = true;
        if (this.#staged.get(peerId) === generation) this.#staged.delete(peerId);
        if (this.#pending.get(peerId)?.generation === generation) this.discard(peerId);

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
    this.#replacePending(new CatalogReplayPeerWorkV1(peerId, this.allocateGeneration()));
    return true;
  }

  /** Queue ownership only: recovery captures these generations for its own pass. */
  generation(peerId: string): Readonly<Rfc64CatalogReplayPeerDemandV1 & { staged: boolean }> | null {
    const staged = this.#staged.get(peerId);
    const generation = staged ?? this.#pending.get(peerId)?.generation;
    return generation === undefined ? null : Object.freeze({ peerId, generation, staged: staged !== undefined });
  }

  /** Forget a queued demand for a peer that can no longer be replayed from. */
  discard(peerId: string): void {
    this.#pending.get(peerId)?.settle({ error: new Error('Replay generation retired before execution') });
    this.#pending.delete(peerId);
  }

  /** Seed the admitted generation once. The graph owner advances pending work
   * through a fresh bounded run when the current run spends its peer budget. */
  seedDemand(demand: Rfc64CatalogReplayPeerDemandV1, signal?: AbortSignal): CatalogReplayPeerWorkV1 {
    const running = [...(this.#chunk?.records ?? [])].find(record => record.peerId === demand.peerId && record.generation === demand.generation);
    if (running) return running;
    let record = this.#pending.get(demand.peerId);
    if (record === undefined || record.generation !== demand.generation) {
      record = new CatalogReplayPeerWorkV1(demand.peerId, demand.generation);
      if ((this.#pending.get(demand.peerId)?.generation ?? 0) > demand.generation) {
        record.settle({ error: new Error('Replay generation superseded') });
        return record;
      }
      this.#replacePending(record);
    }
    record.continuation ??= { signal };
    return record;
  }

  drain(): readonly Rfc64CatalogReplayPeerDemandV1[] {
    const records = [...this.#pending.values()].slice(0, this.#remaining);
    for (const record of records) {
      this.#pending.delete(record.peerId);
      this.#chunk!.take(record);
    }
    this.#remaining -= records.length;
    return records;
  }

  /** Explicit connection execution owns another chunk independently of subscribers. */
  get pendingContinuation(): Readonly<{ signal?: AbortSignal }> | null {
    return [...this.#pending.values()].find(entry => entry.continuation !== null)?.continuation ?? null;
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
