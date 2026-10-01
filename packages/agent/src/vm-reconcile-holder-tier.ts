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
/** Peers one identity may contribute: a wrong binding cannot crowd out the rest. */
export const VM_HOLDER_TIER_PEERS_PER_IDENTITY = 2;
/** Core-role phonebook rows one resolution reads (freshest first). */
export const VM_HOLDER_TIER_MAX_PROFILES = 256;
/** Distinct wallets one resolution may resolve to an identity on chain. */
export const VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS = 128;
export const VM_HOLDER_TIER_LOOKUP_CONCURRENCY = 8;
/** Reuse window for a resolved holder set (also one graph's refresh cadence). */
export const VM_HOLDER_TIER_RESOLUTION_TTL_MS = 5 * 60_000;
/** Spacing between attempts after an unavailable read, so an outage is not hammered. */
export const VM_HOLDER_TIER_FAILURE_RETRY_MS = 60_000;
/**
 * Wall-clock bound of one resolution (sharding table + phonebook + lookups).
 * A graph's recovery pass waits on it, so it stays short: a hung read costs one
 * bounded stall per failure spacing, never an open-ended one.
 */
export const VM_HOLDER_TIER_RESOLUTION_TIMEOUT_MS = 10_000;
/** Bound of the public-policy read that gates a graph's holder tier. */
export const VM_HOLDER_TIER_POLICY_TIMEOUT_MS = 5_000;
/** How long a wallet's identity answer is reused. */
export const VM_HOLDER_TIER_IDENTITY_TTL_MS = 10 * 60_000;
/** A wallet with no identity is re-read sooner: a registration must show quickly. */
export const VM_HOLDER_TIER_NEGATIVE_IDENTITY_TTL_MS = 60_000;
export const VM_HOLDER_TIER_CACHE_MAX_ENTRIES = 1_024;
/** A previous holder set survives an unavailable read for at most this long. */
export const VM_HOLDER_TIER_STALE_MAX_MS = 30 * 60_000;

/** One observed core-role phonebook binding. Unsigned; see the module header. */
export interface HolderProfileHint {
  readonly peerId: string;
  /** Empty or absent for a profile that names no operational wallet. */
  readonly agentAddress?: string;
  /** ISO-8601 `dkg:lastSeen`; only orders peers within one identity. */
  readonly lastSeen?: string;
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
  /** Core-role phonebook rows, freshest first, at most `limit`. */
  listCoreProfileHints(
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly HolderProfileHint[]>;
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
  | 'timeout';

export interface VmHolderHintStats {
  /** Phonebook rows read. */
  readonly profiles: number;
  /** Rows dropped because no valid operational wallet was bound. */
  readonly unbound: number;
  /** Rows whose wallet has no identity in the ShardingTable. */
  readonly unmatched: number;
  /** ShardingTable identities that ended up with at least one hinted peer. */
  readonly identities: number;
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
 * `agentAddress` is an unsigned profile with nothing to verify.
 */
export function normalizeHolderProfileWallet(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!EVM_ADDRESS.test(trimmed)) return undefined;
  // An all-lowercase address carries no checksum to violate, so this cannot
  // throw: a wrong mixed-case checksum in the profile is keyed by its bytes.
  return ethers.getAddress(trimmed.toLowerCase());
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

/**
 * One resolution. Pure over its dependencies and the identity cache: no timers
 * and no state of its own, so the whole policy is unit-testable.
 */
export async function resolveHolderPeerHints(
  deps: VmHolderHintDeps,
  identityCache: VmHolderIdentityCache,
  signal?: AbortSignal,
): Promise<VmHolderHintResolution> {
  const now = deps.now ?? Date.now;
  signal?.throwIfAborted();

  let tableIdentityIds: readonly bigint[] | undefined;
  try {
    tableIdentityIds = await deps.listShardingTableIdentityIds(signal);
  } catch {
    signal?.throwIfAborted();
    return { kind: 'unavailable', reason: 'sharding-table-read-failed' };
  }
  signal?.throwIfAborted();
  if (tableIdentityIds === undefined) {
    return { kind: 'unavailable', reason: 'chain-cannot-answer' };
  }
  const tableMembers = new Set(tableIdentityIds.filter((id) => id > 0n));

  let rows: readonly HolderProfileHint[];
  try {
    rows = await deps.listCoreProfileHints(VM_HOLDER_TIER_MAX_PROFILES, signal);
  } catch {
    signal?.throwIfAborted();
    return { kind: 'unavailable', reason: 'phonebook-read-failed' };
  }
  signal?.throwIfAborted();

  const self = deps.selfPeerId();
  const wallClockNow = (deps.wallClockNow ?? Date.now)();
  let unbound = 0;
  const bound: Array<{ peerId: string; wallet: string; lastSeen: number }> = [];
  for (const row of rows) {
    if (typeof row.peerId !== 'string' || row.peerId.length === 0 || row.peerId === self) continue;
    const wallet = normalizeHolderProfileWallet(row.agentAddress);
    if (wallet === undefined) {
      unbound += 1;
      continue;
    }
    bound.push({ peerId: row.peerId, wallet, lastSeen: lastSeenMs(row.lastSeen, wallClockNow) });
  }

  // Nothing can be a holder without a sharding table: skip the wallet reads.
  const distinctWallets = tableMembers.size === 0
    ? []
    : [...new Set(bound.map((row) => row.wallet))].slice(0, VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS);
  const identityByWallet = new Map<string, bigint>();
  let lookupFailed = false;
  try {
    await mapWithConcurrency(distinctWallets, VM_HOLDER_TIER_LOOKUP_CONCURRENCY, async (wallet) => {
      // One failed read voids the whole answer: stop issuing the rest.
      if (lookupFailed) return;
      signal?.throwIfAborted();
      const cached = identityCache.get(wallet);
      if (cached !== undefined && cached.expiresAt > now()) {
        identityByWallet.set(wallet, cached.identityId);
        return;
      }
      let identityId: bigint | undefined;
      try {
        identityId = await deps.getIdentityIdForAddress(wallet);
      } catch (error) {
        lookupFailed = true;
        throw error;
      }
      // An adapter that cannot answer makes the whole gate unverifiable.
      if (identityId === undefined) {
        lookupFailed = true;
        throw new UnverifiableIdentityError();
      }
      rememberBounded(identityCache, wallet, {
        identityId,
        expiresAt: now() + (identityId > 0n
          ? VM_HOLDER_TIER_IDENTITY_TTL_MS
          : VM_HOLDER_TIER_NEGATIVE_IDENTITY_TTL_MS),
      }, VM_HOLDER_TIER_CACHE_MAX_ENTRIES);
      identityByWallet.set(wallet, identityId);
    });
  } catch (error) {
    signal?.throwIfAborted();
    return {
      kind: 'unavailable',
      reason: error instanceof UnverifiableIdentityError
        ? 'chain-cannot-answer'
        : 'identity-read-failed',
    };
  }
  signal?.throwIfAborted();

  const peersByIdentity = new Map<bigint, Array<{ peerId: string; lastSeen: number }>>();
  let unmatched = 0;
  for (const row of bound) {
    const identityId = identityByWallet.get(row.wallet);
    if (identityId === undefined || identityId <= 0n || !tableMembers.has(identityId)) {
      unmatched += 1;
      continue;
    }
    const peers = peersByIdentity.get(identityId) ?? [];
    if (!peers.some((peer) => peer.peerId === row.peerId)) {
      peers.push({ peerId: row.peerId, lastSeen: row.lastSeen });
    }
    peersByIdentity.set(identityId, peers);
  }

  // Deterministic selection: identities in id order, each contributing its
  // freshest peers, round-robin so the cap is spread across identities rather
  // than spent on the lowest ids.
  const identityIds = [...peersByIdentity.keys()].sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  const ranked = new Map(identityIds.map((identityId) => [
    identityId,
    [...peersByIdentity.get(identityId)!]
      .sort((left, right) => right.lastSeen - left.lastSeen
        || compareCodeUnits(left.peerId, right.peerId))
      .slice(0, VM_HOLDER_TIER_PEERS_PER_IDENTITY)
      .map((peer) => peer.peerId),
  ]));
  const selected = new Set<string>();
  for (let round = 0; round < VM_HOLDER_TIER_PEERS_PER_IDENTITY; round += 1) {
    for (const identityId of identityIds) {
      if (selected.size >= VM_HOLDER_TIER_MAX_PEERS) break;
      const peerId = ranked.get(identityId)![round];
      if (peerId !== undefined) selected.add(peerId);
    }
  }
  return {
    kind: 'resolved',
    peerIds: [...selected].sort(compareCodeUnits),
    stats: {
      profiles: rows.length,
      unbound,
      unmatched,
      identities: identityIds.length,
    },
  };
}

class UnverifiableIdentityError extends Error {
  constructor() {
    super('The chain adapter cannot resolve a wallet to an identity');
    this.name = 'UnverifiableIdentityError';
  }
}

export interface VmHolderHintResolverOptions {
  readonly resolutionTtlMs?: number;
  readonly failureRetryMs?: number;
  readonly resolutionTimeoutMs?: number;
}

/**
 * Shared per node. Amortizes the chain and phonebook reads across every graph
 * (the resolution does not depend on the graph in the single-shard sharding
 * table), coalesces concurrent callers into one read and remembers a failure
 * briefly. Each graph copies the answer into its own state at its own recovery
 * pass, so a refresh here never changes another graph's roster mid-pass.
 */
export class VmHolderHintResolver {
  readonly #deps: VmHolderHintDeps;
  readonly #identityCache: VmHolderIdentityCache = new Map();
  readonly #resolutionTtlMs: number;
  readonly #failureRetryMs: number;
  readonly #resolutionTimeoutMs: number;
  #cached: { readonly resolution: VmHolderHintResolution; readonly expiresAt: number } | undefined;
  #inFlight: Promise<VmHolderHintResolution> | undefined;
  #generation = 0;

  constructor(deps: VmHolderHintDeps, options: VmHolderHintResolverOptions = {}) {
    this.#deps = deps;
    this.#resolutionTtlMs = options.resolutionTtlMs ?? VM_HOLDER_TIER_RESOLUTION_TTL_MS;
    this.#failureRetryMs = options.failureRetryMs ?? VM_HOLDER_TIER_FAILURE_RETRY_MS;
    this.#resolutionTimeoutMs = options.resolutionTimeoutMs ?? VM_HOLDER_TIER_RESOLUTION_TIMEOUT_MS;
  }

  /**
   * The current resolution: cached while fresh, otherwise one shared read.
   * Never rejects; a caller's own abort rejects only that caller's wait.
   */
  async resolve(signal?: AbortSignal): Promise<VmHolderHintResolution> {
    const now = (this.#deps.now ?? Date.now)();
    const cached = this.#cached;
    if (cached !== undefined && now < cached.expiresAt) return cached.resolution;
    if (this.#inFlight === undefined) {
      const generation = this.#generation;
      const inFlight = this.#read(generation).finally(() => {
        if (this.#inFlight === inFlight) this.#inFlight = undefined;
      });
      this.#inFlight = inFlight;
    }
    return waitFor(this.#inFlight, signal);
  }

  /** Forget the cached answer, e.g. after the phonebook gained profiles. */
  invalidate(): void {
    this.#generation += 1;
    this.#cached = undefined;
  }

  async #read(generation: number): Promise<VmHolderHintResolution> {
    const timeout = AbortSignal.timeout(this.#resolutionTimeoutMs);
    let resolution: VmHolderHintResolution;
    try {
      resolution = await resolveHolderPeerHints(this.#deps, this.#identityCache, timeout);
    } catch {
      resolution = { kind: 'unavailable', reason: 'timeout' };
    }
    if (generation === this.#generation) {
      const now = (this.#deps.now ?? Date.now)();
      this.#cached = {
        resolution,
        expiresAt: now + (resolution.kind === 'resolved'
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
 * - resolved: replace the entry (an empty set is a real, cacheable answer);
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
      nextCheckAt: now + VM_HOLDER_TIER_RESOLUTION_TTL_MS,
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
