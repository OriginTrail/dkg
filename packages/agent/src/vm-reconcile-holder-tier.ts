// SPDX-License-Identifier: Apache-2.0

/**
 * VM exact-recovery HOLDER TIER (Phase 1 of the unconnected-holders plan).
 *
 * Problem: an Edge that subscribes to a public Context Graph asks only the
 * curators the phonebook resolves plus the peers it happens to be connected
 * to. A ShardingTable Core that holds the graph's Verifiable-Memory data but is
 * not connected is never dialed, because no chain fact maps a sharding-table
 * identity to a libp2p peer (the profile `nodeId` is a random 32-byte token).
 *
 * This module turns three independent facts into dial candidates:
 *
 *   1. the on-chain ShardingTable membership (`ShardingTable.getShardingTable()`),
 *      the set of identities that should host public data;
 *   2. an OBSERVED phonebook profile binding a peer id to an operational wallet
 *      (`dkg:peerId` next to `dkg:agentAddress`) — an UNSIGNED routing hint;
 *   3. the on-chain wallet-to-identity binding (`getIdentityIdForAddress`), which
 *      is what makes a hint's `agentAddress` a verified bound wallet: without
 *      it the profile is just text anyone can publish.
 *
 * Trust boundary: the mapping identity -> peer is a hint that only decides WHO
 * IS DIALED. It never decides what is accepted. Everything a hinted peer
 * serves goes through the same exact-fetch verification and the same on-chain
 * merkle-root check as any other provider (`reconcileChainOrdinal`), so a wrong
 * or hostile peer costs one bounded dial and can never inject data.
 *
 * Failure policy is closed for routing: a chain or phonebook read that is
 * missing, throws or times out yields NO holders, and the roster stays exactly
 * what it was (curators, then connected peers).
 */

import { ethers } from 'ethers';
import { mapWithConcurrency } from './map-with-concurrency.js';
import { rememberBounded } from './bounded-map.js';

/** Hinted peers one graph's roster may add, at most. */
export const VM_HOLDER_TIER_MAX_PEERS = 32;
/**
 * Peers one identity may contribute, so that one identity's peers (real or
 * claimed) never take a slot of another identity. What a profile can still do
 * is claim a real member wallet with peer ids that rank above the genuine ones
 * (a later `lastSeen`, or a smaller peer id at an equal one): they then take
 * that identity's slots until peers are bound to wallets by signature.
 */
export const VM_HOLDER_TIER_PEERS_PER_IDENTITY = 2;
/**
 * Distinct peers the phonebook walk carries per ShardingTable identity, each
 * under the one verified row that claims it and ranks best (a peer that several
 * rows claim, such as under different casings of one wallet, holds ONE of these
 * slots). The selection only ever uses the best
 * {@link VM_HOLDER_TIER_PEERS_PER_IDENTITY} of them, ranked by `lastSeen` (latest
 * first) and then peer id; carrying twice that lets an identity fall back to its
 * next-best peer, without waiting for the walk to come round again, when one of
 * the two disappears. When an identity holds more, the peer the selection would
 * rank last is dropped, so rows that claim one wallet can never displace the
 * peers of another identity. The carried set is therefore at most (ShardingTable
 * identities) x this many bindings, however many rows claim a wallet, and needs
 * no global cap of its own: only bindings of identities that are in the table are
 * carried, and the table is the chain's.
 */
export const VM_HOLDER_TIER_CARRY_PEERS_PER_IDENTITY = 4;
/** Core-role phonebook rows per page of one resolution. */
export const VM_HOLDER_TIER_PROFILE_PAGE_SIZE = 256;
/** Pages one resolution reads at most: rows read = pages x page size, however many the phonebook holds. */
export const VM_HOLDER_TIER_MAX_PROFILE_PAGES = 4;
/**
 * Wallets one resolution may resolve to an identity ON CHAIN. Answers already
 * remembered do not count: the bound is on RPCs, so junk rows read again while
 * their answer is still remembered cost nothing. (The remembered answers are
 * bounded too, see {@link VM_HOLDER_TIER_IDENTITY_CACHE_MAX_ENTRIES}: a wallet
 * whose answer was pushed out costs one lookup of this allowance.)
 */
export const VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS = 256;
export const VM_HOLDER_TIER_LOOKUP_CONCURRENCY = 8;
/**
 * Share of the resolution deadline a resolution aims to have finished its reads
 * in. It starts a further phonebook page or chain lookup only when the slowest of
 * that kind it has seen so far still leaves time to end inside it; what is not
 * read is left for the next resolution, which resumes the walk there (the first
 * page and one batch of {@link VM_HOLDER_TIER_LOOKUP_CONCURRENCY} lookups always
 * run). A slow chain or store therefore shortens a resolution instead of timing
 * it out: a read abandoned at its deadline commits nothing, so without this a
 * chain that needs longer than the deadline for
 * {@link VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS} answers, or a store that needs
 * longer for a window of pages, would keep the walk still at any cadence. What
 * is left is a read that itself outlasts the deadline, or one that runs far
 * slower than the slowest so far.
 */
export const VM_HOLDER_TIER_READ_BUDGET_SHARE = 0.8;
/** Reuse window for a resolved holder set (also one graph's refresh cadence). */
export const VM_HOLDER_TIER_RESOLUTION_TTL_MS = 5 * 60_000;
/**
 * Spacing between attempts after an unavailable read, so an outage is not
 * hammered, and after a resolution cut short by the lookup bound, so the next
 * one continues past the wallets just rejected.
 */
export const VM_HOLDER_TIER_FAILURE_RETRY_MS = 60_000;
/**
 * Wall-clock bound of one resolution (sharding table + phonebook + lookups).
 * A graph's recovery pass waits on it, so it stays short: a hung read costs one
 * bounded stall per failure spacing, never an open-ended one. (A caller that
 * arrives after an invalidation while a read is running waits for that read too,
 * so its worst case is two bounds.)
 */
export const VM_HOLDER_TIER_RESOLUTION_TIMEOUT_MS = 10_000;
/** Bound of the public-policy read that gates a graph's holder tier. */
export const VM_HOLDER_TIER_POLICY_TIMEOUT_MS = 5_000;
/** How long a wallet's identity answer is reused. */
export const VM_HOLDER_TIER_IDENTITY_TTL_MS = 10 * 60_000;
/**
 * A wallet with no identity is re-read sooner than one with an identity, but
 * not sooner than a resolution is reused, so a pass of the walk that wraps
 * within this time does not pay for the same junk twice. The walk's progress
 * does not depend on it (a wallet examined once is not read again until the
 * walk wraps). A Core wallet that registers after its row was examined is
 * recognised when the walk next reaches the row with this answer expired: up to
 * this long plus the time the walk needs to come back to it (one pass).
 */
export const VM_HOLDER_TIER_NEGATIVE_IDENTITY_TTL_MS = VM_HOLDER_TIER_RESOLUTION_TTL_MS;
/**
 * Wallet answers remembered, oldest evicted first. A flood of junk wallets can
 * push a genuine wallet's answer out, which costs that wallet one lookup when
 * the walk reaches its row again (at most one per pass of the walk, out of the
 * 256 a resolution may spend) and hides nothing: what the walk examines does not
 * depend on what this cache holds.
 */
export const VM_HOLDER_TIER_IDENTITY_CACHE_MAX_ENTRIES = 1_024;
/** A previous holder set survives an unavailable read for at most this long. */
export const VM_HOLDER_TIER_STALE_MAX_MS = 30 * 60_000;
/**
 * How long a binding verified in one window of the phonebook walk is kept while
 * the walk reads elsewhere. It is dropped sooner when its window is read again
 * without it, when its identity leaves the ShardingTable, or when its identity
 * holds {@link VM_HOLDER_TIER_CARRY_PEERS_PER_IDENTITY} better ranked peers.
 * A pass of the walk that takes longer than this (about N / 256 resolutions for
 * N distinct junk wallets, or R / 256 for R rows once the tier is satisfied;
 * about 7,680 of either at the default sweep) lets a binding expire before the
 * walk verifies it again.
 */
export const VM_HOLDER_TIER_CARRY_TTL_MS = 60 * 60_000;
/** A libp2p peer id is far shorter; anything longer is junk that is never worth a lookup. */
export const VM_HOLDER_TIER_MAX_PEER_ID_LENGTH = 128;

/** One observed core-role phonebook binding. Unsigned; see the module header. */
export interface HolderProfileHint {
  readonly peerId: string;
  /** Empty or absent for a profile that names no operational wallet. */
  readonly agentAddress?: string;
  /** ISO-8601 `dkg:lastSeen`; only orders peers within one identity. */
  readonly lastSeen?: string;
}

/** Where the next phonebook page starts: strictly after this row. */
export interface HolderProfileCursor {
  readonly agentAddress: string;
  readonly peerId: string;
}

export interface HolderProfilePageRequest {
  readonly limit: number;
  readonly after?: HolderProfileCursor;
  readonly signal?: AbortSignal;
}

export interface HolderProfilePage {
  /** At most `limit` rows, in a fixed order the profiles' own claims do not choose. */
  readonly hints: readonly HolderProfileHint[];
  /** Cursor of the next page; null when the phonebook holds no further core row. */
  readonly next: HolderProfileCursor | null;
}

export interface VmHolderHintDeps {
  /**
   * Identity ids of `ShardingTable.getShardingTable()`. Resolves `undefined`
   * when the chain adapter cannot answer (method absent); rejects on a failed
   * read.
   */
  listShardingTableIdentityIds(signal?: AbortSignal): Promise<readonly bigint[] | undefined>;
  /**
   * The identity an operational wallet is registered under. `0n` when there is
   * none; `undefined` when the chain adapter cannot answer.
   */
  getIdentityIdForAddress(address: string): Promise<bigint | undefined>;
  /**
   * One page of core-role phonebook rows. The order is fixed by the rows'
   * wallet and peer id, never by a freshness claim: nothing a profile says
   * about itself moves it ahead of another.
   */
  listCoreProfileHints(request: HolderProfilePageRequest): Promise<HolderProfilePage>;
  /** This node's own peer id; never a candidate. */
  selfPeerId(): string;
  /** Monotonic clock for cache expiry (milliseconds, any origin). */
  now?(): number;
  /** Epoch milliseconds; bounds how far in the future a `lastSeen` claim counts. */
  wallClockNow?(): number;
}

export type VmHolderHintUnavailableReason =
  | 'chain-cannot-answer'
  | 'sharding-table-read-failed'
  | 'phonebook-read-failed'
  | 'identity-read-failed'
  | 'policy-unknown'
  | 'timeout'
  /** The resolver was reset (the controller closed) while this read was still queued: it never started. */
  | 'reset';

/**
 * Why a resolution stopped reading:
 * - `exhausted`: it read every core row the phonebook holds;
 * - `satisfied`: the verified peers fill the cap, or every ShardingTable
 *   identity already has its allowance, so this resolution reads no further. The
 *   walk does not start over and does not end: the next resolution resumes after
 *   the rows this one examined, so what is carried behind a flood of junk is
 *   verified again before it expires (see {@link VmHolderHintStats.rowsLeft}),
 *   and the rows it reads later can still change the set (a better ranked peer of
 *   an identity replaces one of its carried peers);
 * - `page-bound`: the page bound, or the time budget for reading further pages,
 *   was reached with rows unread. The next resolution reads the following
 *   window, so this one is retried on the failure spacing;
 * - `lookup-bound`: rows were left unexamined because the lookups this
 *   resolution may spend (their number, and the time budget for starting them)
 *   were spent. Everything before the first such row was examined, so the next
 *   resolution resumes at that row, on the failure spacing as well.
 */
export type VmHolderScanStop = 'exhausted' | 'satisfied' | 'page-bound' | 'lookup-bound';

export interface VmHolderHintStats {
  /** Phonebook rows read. */
  readonly profiles: number;
  /** Rows dropped because no valid operational wallet was bound. */
  readonly unbound: number;
  /** Rows whose wallet has no identity in the ShardingTable. */
  readonly unmatched: number;
  /** ShardingTable identities that ended up with at least one hinted peer. */
  readonly identities: number;
  /** Phonebook pages read. */
  readonly pages: number;
  /** Wallets resolved on chain (remembered answers not counted). */
  readonly lookups: number;
  readonly stopped: VmHolderScanStop;
  /**
   * Rows of the phonebook this resolution neither read nor examined: the walk
   * has not reached the end, so the next resolution resumes where this one
   * stopped. A `satisfied` resolution with rows left is re-run on the failure
   * spacing, like one cut short by a bound, instead of after the full resolution
   * TTL: that is what lets a pass over a phonebook flooded with junk end within
   * {@link VM_HOLDER_TIER_CARRY_TTL_MS} (see {@link VmHolderScanState} for how
   * long a pass may take). It is not a rate limit by itself: the failure spacing
   * is counted from the end of the read, and a graph's sweep, not the spacing,
   * decides when the next read starts, so a node runs from about one resolution
   * every two minutes (one graph) to at most about one a minute.
   */
  readonly rowsLeft: boolean;
}

export type VmHolderHintResolution =
  | {
    readonly kind: 'resolved';
    /** Canonically sorted, duplicate-free, never containing this node. */
    readonly peerIds: readonly string[];
    readonly stats: VmHolderHintStats;
  }
  | { readonly kind: 'unavailable'; readonly reason: VmHolderHintUnavailableReason };

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * A wallet that can be looked up on chain, or undefined. Only a well-formed
 * 20-byte hex address qualifies: an empty, missing or malformed
 * `agentAddress` is an unsigned profile with nothing to verify, and the zero
 * address is nobody's operational wallet.
 */
export function normalizeHolderProfileWallet(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!EVM_ADDRESS.test(trimmed)) return undefined;
  // An all-lowercase address carries no checksum to violate, so this cannot
  // throw: a wrong mixed-case checksum in the profile is keyed by its bytes.
  const wallet = ethers.getAddress(trimmed.toLowerCase());
  return wallet === ethers.ZeroAddress ? undefined : wallet;
}

/** A peer id worth a place in a roster: non-empty, bounded, no whitespace or control characters. */
function plausiblePeerId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > VM_HOLDER_TIER_MAX_PEER_ID_LENGTH) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || code === 0xa0) return false;
  }
  return true;
}

/** Code-unit order: locale-independent, so every node ranks identically. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A profile's own clock may run ahead a little; further ahead is a claim, not a time. */
const LAST_SEEN_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * Epoch ms of a `lastSeen` claim, 0 when unknown. A timestamp beyond the
 * allowed skew is treated as unknown: it is self-declared, and honouring it
 * would let one profile outrank every honest peer of an identity forever.
 */
function lastSeenMs(value: string | undefined, wallClockNow: number): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || parsed > wallClockNow + LAST_SEEN_FUTURE_SKEW_MS) return 0;
  return parsed;
}

interface CachedIdentity {
  readonly identityId: bigint;
  readonly expiresAt: number;
}

export type VmHolderIdentityCache = Map<string, CachedIdentity>;

/** An expected dependency failure, named at the boundary where it happened. */
class HolderDependencyFailure extends Error {
  constructor(readonly reason: VmHolderHintUnavailableReason, cause?: unknown) {
    super(`Holder tier dependency failed: ${reason}`, { cause });
    this.name = 'HolderDependencyFailure';
  }
}

/** Run a dependency read; its failure becomes a named one, but a caller abort stays an abort. */
async function atBoundary<T>(
  reason: VmHolderHintUnavailableReason,
  signal: AbortSignal | undefined,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    signal?.throwIfAborted();
    throw new HolderDependencyFailure(reason, error);
  }
}

/**
 * How two verified peers of ONE identity rank: the better sorts first (the later
 * `lastSeen`, then the smaller peer id). The selection takes the best of them and
 * the carry drops the worst, so both use this one order.
 */
function compareHolderPeers(
  left: { readonly peerId: string; readonly lastSeen: number },
  right: { readonly peerId: string; readonly lastSeen: number },
): number {
  return right.lastSeen - left.lastSeen || compareCodeUnits(left.peerId, right.peerId);
}

/** The peers a set of verified per-identity peers selects, and how many identities it spans. */
function selectHolderPeers(
  peersByIdentity: ReadonlyMap<bigint, ReadonlyMap<string, number>>,
): { readonly peerIds: string[]; readonly identities: number } {
  // Deterministic selection: identities in id order, each contributing its
  // freshest peers, round-robin so the cap is spread across identities rather
  // than spent on the lowest ids.
  const identityIds = [...peersByIdentity.keys()].sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  const ranked = new Map(identityIds.map((identityId) => [
    identityId,
    [...peersByIdentity.get(identityId)!]
      .map(([peerId, lastSeen]) => ({ peerId, lastSeen }))
      .sort(compareHolderPeers)
      .slice(0, VM_HOLDER_TIER_PEERS_PER_IDENTITY)
      .map(({ peerId }) => peerId),
  ]));
  const selected = new Set<string>();
  for (let round = 0; round < VM_HOLDER_TIER_PEERS_PER_IDENTITY; round += 1) {
    for (const identityId of identityIds) {
      if (selected.size >= VM_HOLDER_TIER_MAX_PEERS) break;
      const peerId = ranked.get(identityId)![round];
      if (peerId !== undefined) selected.add(peerId);
    }
  }
  return { peerIds: [...selected].sort(compareCodeUnits), identities: identityIds.length };
}

/** A binding the chain vouched for in an earlier window of the walk over the phonebook. */
interface CarriedHolderBinding {
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
class CarriedBindings {
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

/** A row's place in the walk order (the order the phonebook pages come in). */
function compareRowKeys(
  left: { readonly agentAddress: string; readonly peerId: string },
  right: { readonly agentAddress: string; readonly peerId: string },
): number {
  return compareCodeUnits(left.agentAddress, right.agentAddress)
    || compareCodeUnits(left.peerId, right.peerId);
}

/**
 * One stateless resolution: a walk that starts at the first row and carries
 * nothing in or out. See {@link resolveHolderScanWindow} for the resolution the
 * resolver runs.
 */
export async function resolveHolderPeerHints(
  deps: VmHolderHintDeps,
  identityCache: VmHolderIdentityCache,
  signal?: AbortSignal,
): Promise<VmHolderHintResolution> {
  return (await resolveHolderScanWindow(deps, identityCache, VM_HOLDER_TIER_FRESH_SCAN, signal)).resolution;
}

/**
 * One resolution: the next window of the walk. Pure over its dependencies, the
 * identity cache and the prior walk state (it returns the next state instead of
 * changing anything, so a read that is abandoned at its deadline commits
 * nothing): no timers and no state of its own, so the whole policy is
 * unit-testable.
 *
 * The phonebook is unsigned, so nothing about a row may decide whether it is
 * read. The rows are walked in a fixed order in bounded pages, each row is
 * checked cheaply first (a well-formed wallet, a plausible peer id, once per
 * wallet), and the caps apply to what the CHAIN then vouches for.
 *
 * The walk moves on with every resolution that completes (a read abandoned at
 * its deadline, or overtaken by an invalidation, moves nothing). A resolution
 * reads at most a window of pages and asks the chain about at most {@link VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS} new
 * wallets, and stops starting reads that its time budget cannot cover; the next
 * one resumes at the first row it did not examine (the row
 * after the window's last page when everything was, or the first row whose
 * wallet was left unasked) and wraps at the end of the phonebook. Where it
 * resumes depends on the rows alone, not on how long a remembered answer lives
 * or how often resolutions run, so each resolution moves the walk a fixed number
 * of rows and wallets at any spacing (a wallet is asked about once per pass). The
 * walk goes on after a satisfied stop as well, from the rows
 * it examined. What windows verified is carried, so a holder stays once found,
 * until one of these ends it: a binding goes when a range that includes its row
 * was examined without it, when its identity leaves the ShardingTable, when its
 * identity holds {@link VM_HOLDER_TIER_CARRY_PEERS_PER_IDENTITY} better ranked
 * peers, or when it outlives {@link VM_HOLDER_TIER_CARRY_TTL_MS}. Rows read past
 * the examined prefix (only for wallets already known) add bindings and do not
 * drop one for being absent from them (a better ranked binding of the same
 * identity can still replace it). See {@link VmHolderScanState} for what this
 * does and does not guarantee.
 *
 * Expected dependency failures become an `unavailable` resolution (the walk
 * state is unchanged); a caller abort and any other error propagate.
 */
export async function resolveHolderScanWindow(
  deps: VmHolderHintDeps,
  identityCache: VmHolderIdentityCache,
  prior: VmHolderScanState,
  signal?: AbortSignal,
  options: VmHolderScanOptions = {},
): Promise<{ readonly resolution: VmHolderHintResolution; readonly next: VmHolderScanState }> {
  try {
    return await scanHolderHints(deps, identityCache, prior, signal, options.readBudgetMs ?? Infinity);
  } catch (error) {
    if (error instanceof HolderDependencyFailure) {
      return { resolution: { kind: 'unavailable', reason: error.reason }, next: prior };
    }
    throw error;
  }
}

/**
 * The per-identity peers the carried bindings make up, with their `lastSeen` (every
 * one is of an identity in the ShardingTable, and each identity carries a peer once).
 */
function peersOfCarried(carried: CarriedBindings): Map<bigint, Map<string, number>> {
  const peersByIdentity = new Map<bigint, Map<string, number>>();
  for (const binding of carried.values()) {
    const peers = peersByIdentity.get(binding.identityId) ?? new Map<string, number>();
    peers.set(binding.peerId, binding.lastSeen);
    peersByIdentity.set(binding.identityId, peers);
  }
  return peersByIdentity;
}

/** Per-resolution knobs of {@link resolveHolderScanWindow}. */
export interface VmHolderScanOptions {
  /**
   * Time, measured on the dependencies' clock from the start of the scan, within
   * which it aims to end its reads: a further page or chain lookup starts only
   * when the slowest of its kind so far still ends inside it (see
   * {@link VM_HOLDER_TIER_READ_BUDGET_SHARE}). Unbounded when absent.
   */
  readonly readBudgetMs?: number;
}

/** A row of a page that has a usable place in the walk order, or undefined. */
function rowCursor(row: HolderProfileHint | undefined): HolderProfileCursor | undefined {
  return row !== undefined
    && typeof row.agentAddress === 'string' && row.agentAddress.length > 0
    && typeof row.peerId === 'string' && row.peerId.length > 0
    ? { agentAddress: row.agentAddress, peerId: row.peerId }
    : undefined;
}

async function scanHolderHints(
  deps: VmHolderHintDeps,
  identityCache: VmHolderIdentityCache,
  prior: VmHolderScanState,
  signal: AbortSignal | undefined,
  readBudgetMs: number,
): Promise<{ readonly resolution: VmHolderHintResolution; readonly next: VmHolderScanState }> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  // Whether a read expected to take `estimateMs` (the slowest of its kind so
  // far) still ends inside the budget.
  const hasTimeFor = (estimateMs: number): boolean => now() - startedAt + estimateMs < readBudgetMs;
  let slowestPageMs = 0;
  let slowestLookupMs = 0;
  signal?.throwIfAborted();

  const tableIdentityIds = await atBoundary(
    'sharding-table-read-failed',
    signal,
    () => deps.listShardingTableIdentityIds(signal),
  );
  signal?.throwIfAborted();
  if (tableIdentityIds === undefined) throw new HolderDependencyFailure('chain-cannot-answer');
  const tableMembers = new Set(tableIdentityIds.filter((id) => id > 0n));

  const self = deps.selfPeerId();
  const wallClockNow = (deps.wallClockNow ?? Date.now)();
  const identityByWallet = new Map<string, bigint>();
  const skippedWallets = new Set<string>();
  const seenRows = new Set<string>();
  // What earlier windows verified, less what has outlived its lifetime or whose
  // identity has left the ShardingTable; this window's own bindings join it as
  // they are verified.
  const carried = new CarriedBindings();
  for (const [key, binding] of prior.carried) {
    if (now() - binding.verifiedAt < VM_HOLDER_TIER_CARRY_TTL_MS && tableMembers.has(binding.identityId)) {
      carried.carry(key, binding);
    }
  }
  let rows = 0;
  let unbound = 0;
  let unmatched = 0;
  let pages = 0;
  let lookups = 0;
  let stopped: VmHolderScanStop = 'exhausted';
  let lastNext: HolderProfileCursor | null = null;
  // The last row before the first row whose wallet was left unasked: everything
  // up to it (from the row this window started after) was examined. Undefined
  // while nothing has been left unasked.
  let examinedThrough: HolderProfileCursor | undefined;

  // Nothing can be a holder without a sharding table: read no rows, no wallets.
  let after: HolderProfileCursor | undefined = prior.cursor;
  while (tableMembers.size > 0) {
    if (pages >= VM_HOLDER_TIER_MAX_PROFILE_PAGES) {
      stopped = 'page-bound';
      break;
    }
    // Out of time for another page (the first always runs): the next resolution
    // takes the rows on from here.
    if (pages > 0 && !hasTimeFor(slowestPageMs)) {
      stopped = 'page-bound';
      break;
    }
    const request: HolderProfilePageRequest = {
      limit: VM_HOLDER_TIER_PROFILE_PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
      ...(signal === undefined ? {} : { signal }),
    };
    const pageStartedAt = now();
    const page = await atBoundary('phonebook-read-failed', signal, async () => {
      const read = await deps.listCoreProfileHints(request);
      // A provider that ignores its page bound has broken its contract.
      if (!Array.isArray(read?.hints) || read.hints.length > request.limit) {
        throw new Error('Phonebook page exceeded its bound');
      }
      return read;
    });
    slowestPageMs = Math.max(slowestPageMs, now() - pageStartedAt);
    signal?.throwIfAborted();
    pages += 1;
    lastNext = page.next;

    // Cheap, chain-free checks first; one entry per row. (Several rows may claim
    // one peer under casings of one wallet: the carry keeps the one that ranks
    // best, wherever the window boundaries fall.)
    const candidates: Array<{
      rowIndex: number;
      peerId: string;
      rawAddress: string;
      wallet: string;
      lastSeen: number;
    }> = [];
    for (const [rowIndex, row] of page.hints.entries()) {
      rows += 1;
      if (!plausiblePeerId(row.peerId) || row.peerId === self) continue;
      const wallet = normalizeHolderProfileWallet(row.agentAddress);
      if (wallet === undefined) {
        unbound += 1;
        continue;
      }
      const rawAddress = row.agentAddress!;
      const rowKey = `${rawAddress}\0${row.peerId}`;
      if (seenRows.has(rowKey)) continue;
      seenRows.add(rowKey);
      candidates.push({
        rowIndex,
        peerId: row.peerId,
        rawAddress,
        wallet,
        lastSeen: lastSeenMs(row.lastSeen, wallClockNow),
      });
    }

    // Answers already remembered are free; the rest spend the lookup bound,
    // one lookup per distinct wallet. Once it is spent, later pages are still
    // read for wallets whose answer is remembered (a holder whose answer is
    // still remembered is reached past the junk before it without a lookup; an
    // answer expires, or is pushed out of the cache by other wallets, and then
    // costs one lookup of the allowance like any other), and the others are
    // skipped.
    const fresh = new Set<string>();
    for (const { wallet } of candidates) {
      if (identityByWallet.has(wallet) || skippedWallets.has(wallet) || fresh.has(wallet)) continue;
      const cached = identityCache.get(wallet);
      if (cached !== undefined && cached.expiresAt > now()) {
        identityByWallet.set(wallet, cached.identityId);
      } else if (lookups + fresh.size < VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS) {
        fresh.add(wallet);
      } else {
        skippedWallets.add(wallet);
      }
    }
    let lookupFailed = false;
    await mapWithConcurrency([...fresh], VM_HOLDER_TIER_LOOKUP_CONCURRENCY, async (wallet) => {
      // One failed read voids the whole answer: stop issuing the rest.
      if (lookupFailed) return;
      signal?.throwIfAborted();
      // Out of time to start a lookup that would end inside the budget (after
      // one batch, so a resolution always makes some progress): leave the
      // wallet, and everything behind it in the walk order, for the next
      // resolution.
      if (lookups >= VM_HOLDER_TIER_LOOKUP_CONCURRENCY && !hasTimeFor(slowestLookupMs)) {
        skippedWallets.add(wallet);
        return;
      }
      lookups += 1;
      const lookupStartedAt = now();
      let identityId: bigint | undefined;
      try {
        identityId = await deps.getIdentityIdForAddress(wallet);
        slowestLookupMs = Math.max(slowestLookupMs, now() - lookupStartedAt);
      } catch (error) {
        lookupFailed = true;
        signal?.throwIfAborted();
        throw new HolderDependencyFailure('identity-read-failed', error);
      }
      // A read that outlived its deadline must not write what it learned: the
      // caller has moved on, and a late answer could replace a newer one.
      signal?.throwIfAborted();
      // An adapter that cannot answer makes the whole gate unverifiable.
      if (identityId === undefined) {
        lookupFailed = true;
        throw new HolderDependencyFailure('chain-cannot-answer');
      }
      rememberBounded(identityCache, wallet, {
        identityId,
        expiresAt: now() + (identityId > 0n
          ? VM_HOLDER_TIER_IDENTITY_TTL_MS
          : VM_HOLDER_TIER_NEGATIVE_IDENTITY_TTL_MS),
      }, VM_HOLDER_TIER_IDENTITY_CACHE_MAX_ENTRIES);
      identityByWallet.set(wallet, identityId);
    });
    signal?.throwIfAborted();

    // The first wallet left unasked (by the count or the time bound) ends the
    // examined prefix: the row just before its first row is where the next
    // window starts. A row that needs no lookup (implausible, this node's own,
    // no wallet, a repeat) is examined already, so only a candidate can end it.
    if (examinedThrough === undefined && skippedWallets.size > 0) {
      const firstLeft = candidates.find((candidate) => skippedWallets.has(candidate.wallet));
      if (firstLeft !== undefined) {
        // The nearest row before it that has a key (every row of the real
        // phonebook has one); else the point this page was read from.
        let before: HolderProfileCursor | undefined;
        for (let index = firstLeft.rowIndex - 1; index >= 0 && before === undefined; index -= 1) {
          before = rowCursor(page.hints[index]);
        }
        examinedThrough = before ?? after ?? prior.cursor;
      }
    }

    for (const candidate of candidates) {
      const identityId = identityByWallet.get(candidate.wallet);
      if (identityId === undefined) continue; // skipped: not examined, not a verdict
      if (identityId <= 0n || !tableMembers.has(identityId)) {
        unmatched += 1;
        continue;
      }
      const key = `${candidate.rawAddress}\0${candidate.peerId}`;
      carried.verify(key, {
        agentAddress: candidate.rawAddress,
        peerId: candidate.peerId,
        identityId,
        lastSeen: candidate.lastSeen,
        verifiedAt: now(),
      });
    }

    // Stop reading once the cap is filled or every ShardingTable identity
    // already has its allowance. The walk goes on from what was examined in the
    // next resolution, and rows it reads later can still change the set (a
    // better ranked peer of an identity replaces one of its carried peers).
    const peersByIdentity = peersOfCarried(carried);
    if (
      selectHolderPeers(peersByIdentity).peerIds.length >= VM_HOLDER_TIER_MAX_PEERS
      || [...tableMembers].every((id) => (peersByIdentity.get(id)?.size ?? 0) >= VM_HOLDER_TIER_PEERS_PER_IDENTITY)
    ) {
      stopped = 'satisfied';
      break;
    }
    if (page.next === null) break;
    after = page.next;
  }
  if (stopped !== 'satisfied' && skippedWallets.size > 0) stopped = 'lookup-bound';

  // Where the next window starts, and which key range this one examined
  // completely (a range examined completely without a carried binding in it no
  // longer has it). Rows read beyond the examined prefix prove nothing about what
  // is missing from them, so they neither move the cursor nor evict a binding.
  // A resolution that left a wallet unasked examined only the rows before it,
  // whatever made it stop (a bound, or a tier already satisfied): the next one
  // resumes at the first row it did not examine. Otherwise everything it read was
  // examined: it resumes after the last page it read, or starts over at the first
  // row when that was the end of the phonebook.
  const examinedPrefixOnly = skippedWallets.size > 0;
  const nextCursor: HolderProfileCursor | undefined = examinedPrefixOnly
    ? examinedThrough ?? prior.cursor
    : lastNext ?? undefined;
  const covered: HolderProfileCursor | 'end' | undefined = examinedPrefixOnly ? examinedThrough : lastNext ?? 'end';
  if (covered !== undefined) {
    for (const [key, binding] of carried.entries()) {
      if (carried.wasVerified(key)) continue;
      if (prior.cursor !== undefined && compareRowKeys(binding, prior.cursor) <= 0) continue;
      if (covered !== 'end' && compareRowKeys(binding, covered) > 0) continue;
      carried.delete(key);
    }
  }
  carried.reinstate();

  const selection = selectHolderPeers(peersOfCarried(carried));
  return {
    resolution: {
      kind: 'resolved',
      peerIds: selection.peerIds,
      stats: {
        profiles: rows,
        unbound,
        unmatched,
        identities: selection.identities,
        pages,
        lookups,
        stopped,
        rowsLeft: examinedPrefixOnly || lastNext !== null,
      },
    },
    next: { cursor: nextCursor, carried: carried.asMap() },
  };
}

export interface VmHolderHintResolverOptions {
  readonly resolutionTtlMs?: number;
  readonly failureRetryMs?: number;
  readonly resolutionTimeoutMs?: number;
}

/**
 * Run `work` and settle within `timeoutMs` no matter what it does. `work` gets
 * a signal that aborts at the deadline so cooperative dependencies stop early,
 * but the bound does not rely on them: the chain adapter's RPC calls take no
 * signal, and a stalled one would otherwise leave the caller waiting forever.
 *
 * Only the deadline is reported as `deadline`. A rejection of `work` before it
 * (an abort the caller wired in, or a defect) propagates. The abandoned
 * promise stays observed, so it cannot become an unhandled rejection when it
 * settles later, and nothing it does afterwards reaches the caller.
 */
export async function runWithinDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<{ readonly kind: 'settled'; readonly value: T } | { readonly kind: 'deadline' }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ readonly kind: 'deadline' }>((resolve) => {
    timer = setTimeout(() => {
      // Settle the race first: whatever the abort sets off in `work` queues
      // behind this, so the deadline is what the caller sees.
      resolve({ kind: 'deadline' });
      controller.abort(new Error(`Holder tier read exceeded its ${timeoutMs} ms deadline`));
    }, timeoutMs);
    // A pending deadline must never keep the process alive.
    (timer as { unref?: () => void }).unref?.();
  });
  const settled = (async () => ({ kind: 'settled' as const, value: await work(controller.signal) }))();
  settled.catch(() => undefined);
  try {
    return await Promise.race([settled, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A resolution that left rows unread or unexamined, whether a bound stopped it or
 * the tier was already satisfied: the next one continues the walk, so it is worth
 * running soon. (A satisfied tier keeps walking because what it carries behind a
 * flood of junk is verified only when the walk comes round again, and must be
 * before the carry expires.)
 */
function cutShort(resolution: VmHolderHintResolution): boolean {
  if (resolution.kind !== 'resolved') return false;
  const { stopped, rowsLeft } = resolution.stats;
  return stopped === 'lookup-bound' || stopped === 'page-bound' || (stopped === 'satisfied' && rowsLeft);
}

/**
 * A shared read. It runs under one generation, or, while it waits behind an older
 * read, under none yet: it takes the generation current when it starts.
 */
interface InFlightRead {
  generation: number | undefined;
  /** {@link VmHolderHintResolver.reset} calls before it was queued: a reset after that cancels it. */
  readonly resets: number;
  readonly promise: Promise<VmHolderHintResolution>;
  /** Settles, never rejects, once the read has settled. */
  readonly settled: Promise<void>;
}

/**
 * Shared per node. Amortizes the chain and phonebook reads across every graph
 * (the resolution does not depend on the graph in the single-shard sharding
 * table), coalesces concurrent callers into one read and remembers a failure
 * briefly. Each graph copies the answer into its own state at its own recovery
 * pass, so a refresh here never changes another graph's roster mid-pass.
 *
 * At most one read runs at a time. A caller after {@link invalidate} never joins
 * a read that started before it, and does not start one beside it either: it
 * waits behind the older read (which ends within the resolution timeout) and
 * shares the one read that then starts, however many invalidations arrive
 * meanwhile. The chain therefore sees one read's lookups, not one per arrival.
 */
export class VmHolderHintResolver {
  readonly #deps: VmHolderHintDeps;
  readonly #identityCache: VmHolderIdentityCache = new Map();
  readonly #resolutionTtlMs: number;
  readonly #failureRetryMs: number;
  readonly #resolutionTimeoutMs: number;
  #cached: { readonly resolution: VmHolderHintResolution; readonly expiresAt: number } | undefined;
  /** The newest read: running, or queued behind an older one that is still running. */
  #inFlight: InFlightRead | undefined;
  #generation = 0;
  /** Bumped by {@link reset}: a read still queued behind an older one when it lands never starts. */
  #resets = 0;
  /**
   * The walk over the phonebook between resolutions. Only a read that started
   * after the latest {@link invalidate} or {@link reset} (the same
   * {@link #scanEpoch}) may move it: an older one may have read the phonebook
   * before what invalidated it.
   */
  #scan: VmHolderScanState = VM_HOLDER_TIER_FRESH_SCAN;
  #scanEpoch = 0;

  constructor(deps: VmHolderHintDeps, options: VmHolderHintResolverOptions = {}) {
    this.#deps = deps;
    this.#resolutionTtlMs = options.resolutionTtlMs ?? VM_HOLDER_TIER_RESOLUTION_TTL_MS;
    this.#failureRetryMs = options.failureRetryMs ?? VM_HOLDER_TIER_FAILURE_RETRY_MS;
    this.#resolutionTimeoutMs = options.resolutionTimeoutMs ?? VM_HOLDER_TIER_RESOLUTION_TIMEOUT_MS;
  }

  /**
   * Bumped by every {@link invalidate}. A caller that keeps what it learned
   * compares it before and after `resolve` to notice an invalidation that
   * landed mid-read: the answer it holds may predate what invalidated it.
   */
  get generation(): number {
    return this.#generation;
  }

  /**
   * The current resolution: cached while fresh, otherwise one shared read that
   * settles within the resolution timeout even when a dependency ignores its
   * abort signal. A caller after {@link invalidate} never joins a read that
   * started before it. Rejects only for this caller's own abort (which does
   * not cancel the shared read) or for a defect; an unavailable dependency is
   * an `unavailable` resolution, not a rejection.
   */
  async resolve(signal?: AbortSignal): Promise<VmHolderHintResolution> {
    const now = (this.#deps.now ?? Date.now)();
    const cached = this.#cached;
    if (cached !== undefined && now < cached.expiresAt) return cached.resolution;
    const newest = this.#inFlight;
    // A queued read has no generation yet and will start after every
    // invalidation so far, so it serves this caller, unless a reset has
    // cancelled it (then it will never read); a running one serves a caller only
    // if it started under the current generation.
    const serving = newest !== undefined
      && (newest.generation === undefined
        ? newest.resets === this.#resets
        : newest.generation === this.#generation);
    const inFlight = serving ? newest : this.#begin(newest);
    return waitFor(inFlight.promise, signal);
  }

  /**
   * Forget the cached answer, e.g. after the phonebook gained profiles. The walk
   * over the phonebook keeps its place, except that a read still running cannot
   * move it: what it read may predate the arrival, and the next read must
   * cover those rows again. (Invalidations arriving faster than a read ends
   * therefore hold the walk still; they come from phonebook fetches, which are
   * spaced by minutes.)
   *
   * The next read is fresh, but it resumes where the walk stands, so a profile
   * that arrives or changes in rows the walk has already passed is read only when
   * the walk wraps: up to one pass later (about 24 minutes with 3,000 junk wallets
   * at the default sweep), not at the next read.
   */
  invalidate(): void {
    this.#generation += 1;
    this.#scanEpoch += 1;
    this.#cached = undefined;
  }

  /**
   * Forget everything: the cached answer and the walk, which starts over from the
   * first row. A read still running is left to end within its deadline, but one
   * that is queued behind it never starts (no chain or phonebook read, nothing
   * remembered): its callers are told `reset`, and a caller after the reset gets
   * a read of its own behind the running one.
   */
  reset(): void {
    this.invalidate();
    this.#resets += 1;
    this.#scan = VM_HOLDER_TIER_FRESH_SCAN;
  }

  /**
   * Start a read for the current generation now, or, when `running` is an older
   * generation's read that has not ended, right after it has.
   */
  #begin(running: InFlightRead | undefined): InFlightRead {
    const read = {} as { -readonly [K in keyof InFlightRead]: InFlightRead[K] };
    read.generation = undefined;
    const resets = this.#resets;
    read.resets = resets;
    read.promise = (async (): Promise<VmHolderHintResolution> => {
      if (running !== undefined) await running.settled;
      // A reset (shutdown) that landed while this read waited cancels it: nothing
      // may be read or remembered on behalf of a resolver that was reset.
      if (resets !== this.#resets) return { kind: 'unavailable', reason: 'reset' };
      read.generation = this.#generation;
      return this.#read(read.generation);
    })();
    read.settled = read.promise.then(() => undefined, () => undefined);
    this.#inFlight = read;
    // Only the read that owns the slot frees it: an older read ending while a
    // newer one is queued or running must not clear the newer one.
    void read.settled.then(() => {
      if (this.#inFlight === read) this.#inFlight = undefined;
    });
    return read;
  }

  async #read(generation: number): Promise<VmHolderHintResolution> {
    const scan = this.#scan;
    const epoch = this.#scanEpoch;
    const outcome = await runWithinDeadline(
      (signal) => resolveHolderScanWindow(this.#deps, this.#identityCache, scan, signal, {
        readBudgetMs: Math.floor(this.#resolutionTimeoutMs * VM_HOLDER_TIER_READ_BUDGET_SHARE),
      }),
      this.#resolutionTimeoutMs,
    );
    let resolution: VmHolderHintResolution = { kind: 'unavailable', reason: 'timeout' };
    if (outcome.kind === 'settled') {
      resolution = outcome.value.resolution;
      // Only a read that finished in time moves the walk on, and only if no
      // invalidation or reset has landed since it started.
      if (epoch === this.#scanEpoch) this.#scan = outcome.value.next;
    }
    if (generation === this.#generation) {
      const now = (this.#deps.now ?? Date.now)();
      this.#cached = {
        resolution,
        expiresAt: now + (resolution.kind === 'resolved' && !cutShort(resolution)
          ? this.#resolutionTtlMs
          : this.#failureRetryMs),
      };
    }
    return resolution;
  }
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * One graph's remembered holder set: what its roster reads synchronously.
 * `peerIds` is empty for a graph that is not public or has no hinted holder.
 */
export interface VmHolderTierEntry {
  readonly peerIds: readonly string[];
  /** When `peerIds` was last resolved from the chain and phonebook. */
  readonly resolvedAt: number;
  /** Earliest time the next refresh may read again. */
  readonly nextCheckAt: number;
}

/** What one refresh learned about a graph's holder tier. */
export type VmHolderTierOutcome =
  | VmHolderHintResolution
  | { readonly kind: 'not-public' };

/**
 * Decide a graph's next entry from a refresh outcome.
 *
 * - resolved: replace the entry (an empty set is a real, cacheable answer); one
 *   cut short by the lookup bound is re-read on the failure spacing instead;
 * - not-public: an empty set, re-checked at the normal cadence;
 * - unavailable: keep a previous non-empty set for a bounded time so a chain
 *   blip does not remove and re-add holders, which would restart the proof
 *   cycle of every target on the graph; otherwise none. Either way the next
 *   read waits the shorter failure spacing.
 */
export function nextVmHolderTierEntry(
  previous: VmHolderTierEntry | undefined,
  outcome: VmHolderTierOutcome,
  now: number,
): VmHolderTierEntry {
  if (outcome.kind === 'resolved') {
    return {
      peerIds: outcome.peerIds,
      resolvedAt: now,
      nextCheckAt: now + (cutShort(outcome)
        ? VM_HOLDER_TIER_FAILURE_RETRY_MS
        : VM_HOLDER_TIER_RESOLUTION_TTL_MS),
    };
  }
  if (outcome.kind === 'not-public') {
    return { peerIds: [], resolvedAt: now, nextCheckAt: now + VM_HOLDER_TIER_RESOLUTION_TTL_MS };
  }
  const nextCheckAt = now + VM_HOLDER_TIER_FAILURE_RETRY_MS;
  if (
    previous !== undefined
    && previous.peerIds.length > 0
    && now - previous.resolvedAt < VM_HOLDER_TIER_STALE_MAX_MS
  ) {
    // Staleness is measured from the last resolution that actually read the
    // chain, so an outage cannot keep a set alive indefinitely.
    return { ...previous, nextCheckAt };
  }
  return { peerIds: [], resolvedAt: now, nextCheckAt };
}

/** Same members, ignoring order. */
export function sameVmHolderPeerIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const members = new Set(left);
  return right.every((peerId) => members.has(peerId));
}

/**
 * Append the holder tier behind an already-composed roster (curators, then
 * connected peers). The existing tiers keep their members, order and caps
 * byte for byte: hinted peers only ever fill capacity those tiers left free,
 * are deduplicated against them and never include this node.
 */
export function appendVmHolderTier(
  roster: readonly string[],
  holderPeerIds: readonly string[],
  selfPeerId: string,
  maxRoster: number,
): string[] {
  const budget = Math.max(0, maxRoster - roster.length);
  if (budget === 0 || holderPeerIds.length === 0) return [...roster];
  const taken = new Set(roster);
  const holders: string[] = [];
  for (const peerId of holderPeerIds) {
    if (holders.length >= budget) break;
    if (peerId === selfPeerId || taken.has(peerId)) continue;
    taken.add(peerId);
    holders.push(peerId);
  }
  return [...roster, ...holders];
}

/** The graph's public-policy fact: whether hint-derived peers may be asked about it. */
export type VmHolderGraphPolicy = 'public' | 'not-public' | 'unknown';

export interface VmHolderTierControllerDeps {
  /** Whether the tier is on for this agent right now; asked again on every refresh. */
  enabled(): boolean;
  /**
   * The graph's public-policy fact. Read inside the policy deadline: a read that
   * rejects, returns anything else or outlives the deadline is `unknown`.
   */
  readPolicy(localCgId: string, signal: AbortSignal): Promise<VmHolderGraphPolicy>;
  /**
   * What every resolution reads. Its `now` also clocks the per-graph entries, so
   * one clock decides every cadence.
   */
  readonly hints: VmHolderHintDeps;
  /** One operator-visible line (info level). */
  log(message: string): void;
  readonly resolver?: VmHolderHintResolverOptions;
  readonly policyTimeoutMs?: number;
}

/**
 * Owns the holder tier's whole state and lifecycle for one node: the shared
 * resolver (the hints cache) and every graph's remembered entry. The SWM host
 * asks it to refresh a graph, reads a graph's peers, and forwards the lifecycle
 * events (a phonebook arrival, a graph's state being removed, a bound on the
 * per-graph state, shutdown) to the operation that keeps BOTH caches in step:
 *
 * | operation          | graph entries               | shared hints (answer, walk, carried) |
 * | ------------------ | --------------------------- | ------------------------------------ |
 * | `refresh`          | writes this graph's entry   | reads / fills / advances the walk    |
 * | `invalidateHints`  | drops the affected graphs'  | answer forgotten, walk kept: rows behind it are read when it wraps (a read still running can no longer move it) |
 * | `deleteGraph`      | drops this graph's          | kept (graph-independent)             |
 * | `prune`            | drops the oldest over a bound | kept                               |
 * | `close`            | drops all                   | all forgotten, the walk starts over  |
 *
 * The state model is explicit: every expected failure of a dependency is an
 * outcome (`unavailable`) at the boundary where it happens, so an entry only
 * ever moves through {@link nextVmHolderTierEntry}. A caller abort writes
 * nothing; anything else is a defect and rejects.
 */
export class VmHolderTierController {
  readonly #deps: VmHolderTierControllerDeps;
  /** Insertion order is recency: a refreshed graph moves to the end, `prune` evicts from the front. */
  readonly #entries = new Map<string, VmHolderTierEntry>();
  #resolver: VmHolderHintResolver | undefined;

  constructor(deps: VmHolderTierControllerDeps) {
    this.#deps = deps;
  }

  /** The graph's hinted holders: what its roster reads synchronously. Empty until a refresh says otherwise. */
  peerIdsFor(localCgId: string): readonly string[] {
    return this.#entries.get(localCgId)?.peerIds ?? [];
  }

  /** The graph's remembered entry: when it was resolved and when it is next due. */
  entryFor(localCgId: string): VmHolderTierEntry | undefined {
    return this.#entries.get(localCgId);
  }

  /**
   * Refresh one graph's entry when it is due. Advisory and bounded: reads at
   * most one shared resolution per TTL and writes only this graph's entry, so
   * no other graph's roster moves. A private graph gets an empty tier
   * (hint-derived peers are never asked about it).
   */
  async refresh(
    localCgId: string,
    options: { signal?: AbortSignal; isCurrent: () => boolean },
  ): Promise<void> {
    const { signal, isCurrent } = options;
    const now = this.#deps.hints.now ?? Date.now;
    if (!this.#deps.enabled()) {
      this.#entries.delete(localCgId);
      return;
    }
    const previous = this.#entries.get(localCgId);
    if (previous !== undefined && now() < previous.nextCheckAt) return;

    const policy = await this.#readPolicy(localCgId, signal);
    if (policy === 'caller-aborted' || !isCurrent()) return;

    let outcome: VmHolderTierOutcome;
    if (policy === 'public') {
      const resolver = this.#resolverForUse();
      const hintGeneration = resolver.generation;
      try {
        outcome = await resolver.resolve(signal);
      } catch (error) {
        // `resolve` reports its dependency failures as outcomes and rejects only
        // for this caller's own abort; anything else is a defect and surfaces.
        if (signal?.aborted === true) return;
        throw error;
      }
      // The hints were invalidated while this read was in flight: what it read
      // may predate the profile that invalidated them, and that arrival already
      // dropped this graph's entry and asked for a recovery. Remembering the
      // older answer would hide the new holder for a full period, so the next
      // pass asks for a new resolution instead (which resumes where the walk
      // stands: a row the walk has already passed is read when it wraps).
      if (resolver.generation !== hintGeneration) return;
    } else {
      outcome = policy === 'not-public'
        ? { kind: 'not-public' }
        : { kind: 'unavailable', reason: 'policy-unknown' };
    }
    if (!isCurrent()) return;

    const next = nextVmHolderTierEntry(previous, outcome, now());
    this.#entries.delete(localCgId);
    this.#entries.set(localCgId, next);
    if (outcome.kind === 'resolved' && !sameVmHolderPeerIds(previous?.peerIds ?? [], next.peerIds)) {
      const { stats } = outcome;
      this.#deps.log(
        `VM exact fetch holder tier for "${localCgId}": ${next.peerIds.length} hinted `
          + `ShardingTable holder(s) [peers=${next.peerIds.map((peerId) => peerId.slice(-8)).join(',')}] `
          + `across ${stats.identities} identit${stats.identities === 1 ? 'y' : 'ies'} `
          + `(profiles=${stats.profiles} unbound=${stats.unbound} `
          + `unmatched=${stats.unmatched} pages=${stats.pages} `
          + `lookups=${stats.lookups} stop=${stats.stopped}); `
          + 'routing hints only, data is still verified against on-chain roots',
      );
    }
  }

  /**
   * The phonebook gained profiles: the shared resolution is stale for every
   * graph, and the listed graphs (the ones with a recovery to re-run) forget
   * their entries, so the first of them to run again asks for a new resolution.
   * That resolution resumes where the walk stands (see
   * {@link VmHolderHintResolver.invalidate}): a profile that arrives or changes in
   * rows the walk has already passed is read when the walk wraps, up to one pass
   * later.
   */
  invalidateHints(affectedGraphs: readonly string[]): void {
    this.#resolver?.invalidate();
    for (const localCgId of affectedGraphs) this.#entries.delete(localCgId);
  }

  /** A graph's recovery state is being removed. The shared hints do not depend on it and stay. */
  deleteGraph(localCgId: string): void {
    this.#entries.delete(localCgId);
  }

  /** Keep at most `maxEntries` graphs, dropping the least recently refreshed. The shared hints stay. */
  prune(maxEntries: number): void {
    while (this.#entries.size > maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  /** Shutdown: forget every graph's entry and the shared resolution together. */
  close(): void {
    this.#entries.clear();
    this.#resolver?.reset();
  }

  #resolverForUse(): VmHolderHintResolver {
    this.#resolver ??= new VmHolderHintResolver(this.#deps.hints, this.#deps.resolver);
    return this.#resolver;
  }

  /**
   * The graph's public-policy fact, read at the boundary where it can fail:
   * a read that rejects, answers something else or outlives its bound (even one
   * that ignores its signal) is `unknown`. Only the caller's own abort is
   * reported apart, because it is not a fact about the graph.
   */
  async #readPolicy(
    localCgId: string,
    signal: AbortSignal | undefined,
  ): Promise<VmHolderGraphPolicy | 'caller-aborted'> {
    try {
      const read = await runWithinDeadline(
        (policySignal) => this.#deps.readPolicy(
          localCgId,
          signal === undefined ? policySignal : AbortSignal.any([signal, policySignal]),
        ),
        this.#deps.policyTimeoutMs ?? VM_HOLDER_TIER_POLICY_TIMEOUT_MS,
      );
      return read.kind === 'settled' && (read.value === 'public' || read.value === 'not-public')
        ? read.value
        : 'unknown';
    } catch {
      return signal?.aborted === true ? 'caller-aborted' : 'unknown';
    }
  }
}
