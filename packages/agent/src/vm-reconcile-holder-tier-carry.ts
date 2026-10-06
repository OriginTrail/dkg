// SPDX-License-Identifier: Apache-2.0

/**
 * What the phonebook walk keeps between resolutions: the bindings the chain
 * vouched for in earlier windows (at most
 * {@link VM_HOLDER_TIER_CARRY_PEERS_PER_IDENTITY} distinct peers per
 * ShardingTable identity, one binding per peer) and the walk state that holds
 * them together with the cursor. {@link VmHolderScanState} states what the
 * carry guarantees and what it does not.
 */

import {
  VM_HOLDER_TIER_CARRY_PEERS_PER_IDENTITY,
  type HolderProfileCursor,
} from './vm-reconcile-holder-tier-types.js';
import {
  compareHolderPeers,
  compareRowKeys,
} from './vm-reconcile-holder-tier-select.js';

/** A binding the chain vouched for in an earlier window of the walk over the phonebook. */
export interface CarriedHolderBinding {
  /** As stored in the row: with `peerId`, the row's place in the fixed walk order. */
  readonly agentAddress: string;
  readonly peerId: string;
  readonly identityId: bigint;
  readonly lastSeen: number;
  readonly verifiedAt: number;
}

/**
 * Where the walk over the phonebook stands between resolutions. A phonebook
 * larger than one resolution's page bound is read in successive windows, and
 * what each window verified is carried until it is read again, so a holder
 * behind junk is reached, and stays in the set while the walk is elsewhere, for
 * as long as the carry keeps it (below, and on {@link CarriedBindings}).
 *
 * What this guarantees, and what it does not. Take a phonebook that does not
 * change while the walk reaches a holder, with N distinct junk wallets (each
 * needing a chain lookup) in R junk rows ahead of it.
 *
 * - Reached: within about max(ceil(N / 256), ceil(R / 1024)) + 1 completed
 *   resolutions at any spacing while the tier is not satisfied (a resolution
 *   examines up to 1,024 rows and asks about up to 256 new wallets), and within
 *   about ceil(R / 256) + 1 once it is, because a satisfied resolution stops
 *   after the page that satisfied it: the walk then moves 256 rows a resolution.
 * - Kept: the holder stays while every pass of the walk takes less than
 *   {@link VM_HOLDER_TIER_CARRY_TTL_MS} (and its row stays in the phonebook, and
 *   no better ranked claims take its identity's slots, see below). At the default sweep with one graph a
 *   resolution runs about every two minutes (30 an hour; more graphs make it
 *   more frequent, up to about 60 an hour at the hard bound, and raise the
 *   limit), so a pass may span about 7,680 distinct junk wallets, or about 7,680
 *   rows once the tier is satisfied (rows that share wallets are read faster
 *   while it is not: up to about 30,720).
 * - Not guaranteed: junk that arrives ahead of the cursor faster than a
 *   resolution examines it keeps the walk from ever getting there, and a pass
 *   longer than the carry lifetime lets the binding expire between passes, so
 *   the holder is missing from the set until its row is verified again.
 *
 * The carry holds at most {@link VM_HOLDER_TIER_CARRY_PEERS_PER_IDENTITY}
 * distinct peers per identity (one binding each), so rows that claim one
 * identity's wallet cannot displace another identity's.
 */
export interface VmHolderScanState {
  /** The next resolution reads strictly after this row; undefined: from the first row. */
  readonly cursor: HolderProfileCursor | undefined;
  readonly carried: ReadonlyMap<string, CarriedHolderBinding>;
}

/**
 * Whether the binding `left` ranks below `right`: the order the selection ranks
 * the peers of one identity in (see {@link compareHolderPeers}), and for two rows
 * that claim the same peer, the one that sorts later in the walk order.
 */
function ranksBelow(left: CarriedHolderBinding, right: CarriedHolderBinding): boolean {
  return (compareHolderPeers(left, right) || compareRowKeys(left, right)) > 0;
}

/**
 * The bindings a window carries: for each ShardingTable identity at most
 * {@link VM_HOLDER_TIER_CARRY_PEERS_PER_IDENTITY} DISTINCT peers, each under the
 * one row that claims it and ranks best.
 *
 * Rows are keyed as the walk sees them (the wallet as the profile wrote it, then
 * the peer id), and one wallet has many casings that are different rows, far
 * apart in the walk order but one wallet to the chain. The bound counts peers, as
 * the selection does, so a peer claimed under several casings holds one slot:
 * among the rows that claim the same peer for the same identity, the one that
 * ranks best is carried (the later `lastSeen`, then the row that sorts first), so
 * the carried set does not depend on which rows a window happened to read
 * together. A peer beyond the bound evicts the one of ITS OWN identity that the
 * selection would rank last (see {@link compareHolderPeers}), never one of another
 * identity.
 */
export class CarriedBindings {
  readonly #bindings = new Map<string, CarriedHolderBinding>();
  readonly #keysByIdentity = new Map<bigint, Set<string>>();
  /** Keys of the bindings this window verified (the others were carried in from earlier windows). */
  readonly #verified = new Set<string>();
  /**
   * Per identity and peer, the best binding this window verified that lost to a
   * better row claiming the same peer: if that row is dropped once the window's
   * examined range is swept (it was not found there), this one, which was found,
   * takes the peer's place.
   */
  readonly #standby = new Map<string, { readonly key: string; readonly binding: CarriedHolderBinding }>();

  entries(): IterableIterator<[string, CarriedHolderBinding]> {
    return this.#bindings.entries();
  }

  values(): IterableIterator<CarriedHolderBinding> {
    return this.#bindings.values();
  }

  /** The carried bindings, for the walk state handed to the next resolution. */
  asMap(): ReadonlyMap<string, CarriedHolderBinding> {
    return this.#bindings;
  }

  /** Take a binding an earlier window verified. */
  carry(key: string, binding: CarriedHolderBinding): void {
    this.#admit(key, binding);
  }

  /** Take a binding this window verified. */
  verify(key: string, binding: CarriedHolderBinding): void {
    this.#verified.add(key);
    if (this.#admit(key, binding)) return;
    const pair = `${binding.identityId}\0${binding.peerId}`;
    const standing = this.#standby.get(pair);
    if (standing === undefined || ranksBelow(standing.binding, binding)) this.#standby.set(pair, { key, binding });
  }

  /** Whether this window verified the binding under `key`. */
  wasVerified(key: string): boolean {
    return this.#verified.has(key);
  }

  /**
   * Call once the window has dropped the carried bindings whose rows it examined
   * without finding them: a peer whose better row was dropped is carried under
   * the row this window found for it.
   */
  reinstate(): void {
    for (const { key, binding } of this.#standby.values()) {
      if (!this.#bindings.has(key) && this.#twinOf(key, binding) === undefined) this.#admit(key, binding);
    }
    this.#standby.clear();
  }

  delete(key: string): void {
    const binding = this.#bindings.get(key);
    if (binding === undefined) return;
    this.#bindings.delete(key);
    const keys = this.#keysByIdentity.get(binding.identityId);
    keys?.delete(key);
    if (keys?.size === 0) this.#keysByIdentity.delete(binding.identityId);
  }

  /** False when the binding lost to a better row that claims the same peer for the same identity. */
  #admit(key: string, binding: CarriedHolderBinding): boolean {
    const previous = this.#bindings.get(key);
    if (previous !== undefined && previous.identityId !== binding.identityId) this.delete(key);
    const twinKey = this.#twinOf(key, binding);
    if (twinKey !== undefined) {
      if (ranksBelow(binding, this.#bindings.get(twinKey)!)) return false;
      this.delete(twinKey);
    }
    this.#bindings.set(key, binding);
    let keys = this.#keysByIdentity.get(binding.identityId);
    if (keys === undefined) {
      keys = new Set();
      this.#keysByIdentity.set(binding.identityId, keys);
    }
    keys.add(key);
    if (keys.size > VM_HOLDER_TIER_CARRY_PEERS_PER_IDENTITY) {
      let worst = key;
      for (const candidate of keys) {
        if (ranksBelow(this.#bindings.get(candidate)!, this.#bindings.get(worst)!)) worst = candidate;
      }
      this.delete(worst);
    }
    return true;
  }

  /** The key of another row that claims the same peer for the same identity, if one is carried. */
  #twinOf(key: string, binding: CarriedHolderBinding): string | undefined {
    for (const other of this.#keysByIdentity.get(binding.identityId) ?? []) {
      if (other !== key && this.#bindings.get(other)!.peerId === binding.peerId) return other;
    }
    return undefined;
  }
}

/** The start of a walk: nothing read, nothing carried. */
export const VM_HOLDER_TIER_FRESH_SCAN: VmHolderScanState = Object.freeze({
  cursor: undefined,
  carried: new Map<string, CarriedHolderBinding>(),
});

/**
 * The per-identity peers the carried bindings make up, with their `lastSeen` (every
 * one is of an identity in the ShardingTable, and each identity carries a peer once).
 */
export function peersOfCarried(carried: CarriedBindings): Map<bigint, Map<string, number>> {
  const peersByIdentity = new Map<bigint, Map<string, number>>();
  for (const binding of carried.values()) {
    const peers = peersByIdentity.get(binding.identityId) ?? new Map<string, number>();
    peers.set(binding.peerId, binding.lastSeen);
    peersByIdentity.set(binding.identityId, peers);
  }
  return peersByIdentity;
}
