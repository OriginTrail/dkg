// SPDX-License-Identifier: Apache-2.0

/**
 * Constants and public types of the VM exact-recovery holder tier (see
 * `vm-reconcile-holder-tier.ts` for what the tier is and how its modules fit
 * together): the bounds of the phonebook walk, of a resolution and of the
 * caches; the shape of a phonebook row, page and cursor; the dependencies a
 * resolution reads; and what a resolution reports. No behavior lives here.
 */

/** Hinted peers one graph's roster may add, at most. */
export const VM_HOLDER_TIER_MAX_PEERS = 32;
/**
 * Peers one identity may contribute. The carry bounds each identity on its own,
 * so no claim displaces another identity's peers from it; the selection spreads
 * the {@link VM_HOLDER_TIER_MAX_PEERS} cap over the identities in id order (each
 * one's best peer first, then each one's second), so with more than 16
 * identities in the table a claim that gives a low-numbered identity a second
 * peer can take the cap slot of a higher-numbered identity's second peer. What a
 * profile can also do is claim a real member wallet with peer ids that rank above
 * the genuine ones (a later `lastSeen`, or a smaller peer id at an equal one):
 * they then take that identity's slots until peers are bound to wallets by
 * signature.
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
 * rank last is dropped, so rows that claim one wallet cannot displace the peers
 * of another identity from the carry. The carried set is therefore at most
 * (ShardingTable identities) x this many bindings, no matter how many rows claim
 * a wallet, and needs no global cap of its own: only bindings of identities that
 * are in the table are carried, and the table is the chain's.
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
 * within this time does not pay for the same junk twice. It only decides whether
 * a lookup is saved: a remembered answer never makes the walk skip a row, and the
 * walk does not wait for an answer to expire to move on. A Core wallet that
 * registers after its row was examined is
 * recognised when the walk next reaches the row with this answer expired: up to
 * this long plus the time the walk needs to come back to it (one pass).
 */
export const VM_HOLDER_TIER_NEGATIVE_IDENTITY_TTL_MS = VM_HOLDER_TIER_RESOLUTION_TTL_MS;
/**
 * Wallet answers remembered, oldest evicted first. A flood of junk wallets can
 * push a genuine wallet's answer out, which costs that wallet one lookup when
 * the walk reaches its row again (about one per pass of the walk, out of the
 * 256 a resolution may spend) and hides nothing: a lookup the cache could not
 * save is one of those 256, so it can end a window a few rows sooner, and no row
 * is skipped for it.
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
  /** At most `limit` rows, in the rows' own key order (wallet, then peer id), which a publisher chooses. */
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
   * One page of core-role phonebook rows. The order is the rows' own key,
   * wallet then peer id, so a publisher chooses where its rows sort; what it
   * cannot do is move one ahead of another by a freshness claim.
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

interface CachedIdentity {
  readonly identityId: bigint;
  readonly expiresAt: number;
}

export type VmHolderIdentityCache = Map<string, CachedIdentity>;
