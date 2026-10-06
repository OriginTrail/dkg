// SPDX-License-Identifier: Apache-2.0

/**
 * One window of the phonebook walk, which is one resolution: read the
 * ShardingTable, read keyset pages of core-role rows after the walk's cursor, ask
 * the chain which ShardingTable identity each new wallet belongs to, carry what
 * the chain vouched for, and return the holder peers with the next walk state.
 * It has no timers and no state of its own: its dependencies, the identity cache
 * and the prior walk state are arguments, and the next state is returned
 * instead of changed, so a read that is abandoned commits nothing.
 */

import { mapWithConcurrency } from './map-with-concurrency.js';
import { rememberBounded } from './bounded-map.js';
import {
  VM_HOLDER_TIER_CARRY_TTL_MS,
  VM_HOLDER_TIER_IDENTITY_CACHE_MAX_ENTRIES,
  VM_HOLDER_TIER_IDENTITY_TTL_MS,
  VM_HOLDER_TIER_LOOKUP_CONCURRENCY,
  VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS,
  VM_HOLDER_TIER_MAX_PEERS,
  VM_HOLDER_TIER_MAX_PROFILE_PAGES,
  VM_HOLDER_TIER_NEGATIVE_IDENTITY_TTL_MS,
  VM_HOLDER_TIER_PEERS_PER_IDENTITY,
  VM_HOLDER_TIER_PROFILE_PAGE_SIZE,
  type HolderProfileCursor,
  type HolderProfileHint,
  type HolderProfilePageRequest,
  type VmHolderHintDeps,
  type VmHolderHintResolution,
  type VmHolderHintUnavailableReason,
  type VmHolderIdentityCache,
  type VmHolderScanStop,
} from './vm-reconcile-holder-tier-types.js';
import {
  compareRowKeys,
  lastSeenMs,
  normalizeHolderProfileWallet,
  plausiblePeerId,
  selectHolderPeers,
} from './vm-reconcile-holder-tier-select.js';
import {
  CarriedBindings,
  VM_HOLDER_TIER_FRESH_SCAN,
  peersOfCarried,
  type VmHolderScanState,
} from './vm-reconcile-holder-tier-carry.js';

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
 * wallet was left unasked) and wraps at the end of the phonebook. How far a
 * resolution gets does not depend on how often resolutions run. A resolution
 * ends at the first of 256 new wallets asked about, four pages read, its time
 * budget, a satisfied tier or the end of the phonebook; a remembered answer saves
 * a lookup, so it can only carry a resolution further than one that finds none,
 * and a wallet is asked about once per pass at most (about, as an evicted or
 * expired answer is asked for again when the walk comes back to the wallet). The
 * walk goes on after a satisfied stop as well, from the rows it examined. What
 * windows verified is carried, so a holder stays once found,
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
