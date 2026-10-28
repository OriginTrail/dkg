import { CatalogReplayPeerWorkV1, CatalogReplayPeerDemandHandleV1, CatalogReplayChunkV1 } from './catalog-replay-peer-work-v1.js';
// SPDX-License-Identifier: Apache-2.0
import { RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 } from './catalog-peers-v1.js';
import type { Rfc64CatalogReplayPeerDemandV1, Rfc64CatalogReplayPeerDemandHandleV1, Rfc64CatalogReplayPeerReservationV1 } from './catalog-replay-types-v1.js';

/**
 * One owner for reconnect generations, pending-peer deduplication, and the
 * finite amount of peer work a coalesced replay may perform. A peer ID is not
 * itself a completion token: enqueueing the same peer after its earlier demand
 * was drained creates a newer generation that must be replayed or left
 * fail-closed when the run budget is exhausted.
 */
export class Rfc64CatalogReplayPeerWorklistV1 {
  readonly #pending = new Map<string, CatalogReplayPeerDemandHandleV1>();
  readonly #staged = new Map<string, CatalogReplayPeerDemandHandleV1>();
  readonly #handles = new WeakMap<object, CatalogReplayPeerDemandHandleV1>();
  constructor(readonly allocateGeneration: () => number) {}
  #overflowed = false;

  failPending(error: unknown, cancelledSignal?: AbortSignal): void {
    for (const demand of this.#pending.values()) {
      const record = demand.execution;
      // A cancelled run cannot revoke another live connection owner.
      if (cancelledSignal?.aborted && (record.reserved || (record.continuation !== null && record.continuation.signal !== cancelledSignal))) continue;
      record.settle({ error });
      // Cancellation releases this execution's subscribers, but unconsumed
      // generations remain available to an explicit later recovery command.
      demand.retainForRetry();
    }
  }
  /** Retire queued subscribers without releasing transports consumed by the running chunk. */
  retire(): void {
    for (const record of this.#pending.values()) record.execution.settle({ error: new Error('Catalog replay policy owner retired') });
    for (const record of this.#staged.values()) record.execution.settle({ error: new Error('Catalog replay policy owner retired') });
    this.#pending.clear(); this.#staged.clear();
  }
  #replacePending(record: CatalogReplayPeerDemandHandleV1): void {
    const prior = this.#pending.get(record.peerId);
    if (prior && prior !== record) prior.execution.settle({ error: new Error('Replay generation superseded') });
    this.#pending.set(record.peerId, record);
  }

  reserve(peerId: string, owner: Readonly<{ current(): boolean; changed(): void; released(demand: Rfc64CatalogReplayPeerDemandV1): void }>): Rfc64CatalogReplayPeerReservationV1 | null {
    const owned = new Set([...this.#pending.keys(), ...this.#staged.keys()]);
    if (!owned.has(peerId) && owned.size >= RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1) {
      this.#overflowed = true;
      return null;
    }
    const demand = new CatalogReplayPeerDemandHandleV1(peerId, this.allocateGeneration(), true);
    this.#staged.get(peerId)?.execution.settle({ error: new Error('Replay reservation superseded') });
    this.#staged.set(peerId, demand);
    let released = false;
    const reservation = Object.freeze({
      peerId, generation: demand.generation, handle: Object.freeze({}),
      isCurrent: () => !released && owner.current() && this.#staged.get(peerId) === demand,
      admit: () => {
        if (released || !owner.current() || this.#staged.get(peerId) !== demand) return;
        this.#staged.delete(peerId);
        this.#replacePending(demand);
        owner.changed();
      },
      release: () => {
        if (released) return;
        released = true;
        if (this.#staged.get(peerId) === demand) {
          this.#staged.delete(peerId);
          demand.execution.settle({ error: new Error('Replay reservation released') });
        }
        if (this.#pending.get(peerId) === demand) this.discard(peerId);
        owner.released(reservation);
      },
    });
    this.#handles.set(reservation.handle, demand);
    return reservation;
  }

  admitRecovery(reservation: Rfc64CatalogReplayPeerDemandHandleV1): void {
    const demand = this.#handles.get(reservation.handle);
    if (demand && this.#pending.get(demand.peerId) === demand) demand.execution.admitRecovery();
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
    this.#replacePending(new CatalogReplayPeerDemandHandleV1(peerId, this.allocateGeneration()));
    return true;
  }

  /** Queue ownership only: recovery captures these generations for its own pass. */
  generation(peerId: string): Readonly<Rfc64CatalogReplayPeerDemandV1 & { staged: boolean }> | null {
    const staged = this.#staged.get(peerId);
    const generation = staged?.generation ?? this.#pending.get(peerId)?.generation;
    return generation === undefined ? null : Object.freeze({ peerId, generation, staged: staged !== undefined || this.#pending.get(peerId)?.execution.reserved === true });
  }

  /** Forget a queued demand for a peer that can no longer be replayed from. */
  discard(peerId: string): void {
    this.#pending.get(peerId)?.execution.settle({ error: new Error('Replay generation retired before execution') });
    this.#pending.delete(peerId);
  }

  /** Commands carry the exact reservation handle; peer/generation are diagnostic identity only. */
  admitDemand(reservation: Rfc64CatalogReplayPeerDemandHandleV1, signal?: AbortSignal): CatalogReplayPeerWorkV1 {
    const demand = this.#handles.get(reservation.handle);
    if (!demand) throw new Error('Unknown catalog replay demand handle');
    if (this.#staged.get(demand.peerId) === demand) throw new Error('Catalog replay demand is not admitted');
    // Never reconstruct an old demand from identifiers or search a running chunk.
    // Superseded and completed executions keep their own settled result.
    demand.execution.admitExecution(signal);
    return demand.execution;
  }

  drain(chunk: CatalogReplayChunkV1, signal?: AbortSignal): readonly Rfc64CatalogReplayPeerDemandV1[] {
    const records = [...this.#pending.values()].filter(record => record.execution.runnable(signal)).slice(0, chunk.remaining);
    for (const record of records) {
      this.#pending.delete(record.peerId);
      chunk.take(record.execution);
    }
    return records.map(record => record.execution);
  }

  /** Explicit connection execution owns another chunk independently of subscribers. */
  get pendingContinuation(): Readonly<{ signal?: AbortSignal }> | null {
    return [...this.#pending.values()].find(entry => entry.execution.continuation !== null)?.execution.continuation ?? null;
  }

  get hasStaged(): boolean { return this.#staged.size > 0 || [...this.#pending.values()].some(record => record.execution.reserved); }

  get hasOwnedPending(): boolean { return [...this.#pending.values()].some(record => record.execution.owned); }
  hasRunnable(signal?: AbortSignal): boolean { return [...this.#pending.values()].some(record => record.execution.runnable(signal)); }

  get hasPending(): boolean {
    return this.#pending.size > 0;
  }

  exhausted(chunk: CatalogReplayChunkV1): boolean {
    return this.#overflowed || (chunk.remaining === 0 && this.hasPending);
  }

  settleOverflow(): void {
    for (const record of this.#pending.values()) record.execution.retainRecovery();
    this.#overflowed = false;
  }
}
