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
 *
 * Layout. This file keeps the module's public surface; the code lives in
 * sibling modules that never import it (so there is no cycle), each of which
 * states what it holds:
 *
 *   - `vm-reconcile-holder-tier-types.ts`: constants and public types;
 *   - `vm-reconcile-holder-tier-select.ts`: stateless rules (wallet and peer id
 *     checks, ranking, which peers a set of bindings selects, row order);
 *   - `vm-reconcile-holder-tier-carry.ts`: the bindings the walk carries between
 *     resolutions, and what that does and does not guarantee;
 *   - `vm-reconcile-holder-tier-walk.ts`: one window of the phonebook walk (a
 *     resolution): pages, wallet lookups, read-time budget;
 *   - `vm-reconcile-holder-tier-resolver.ts`: the shared per-node resolver (one
 *     read at a time, deadline, TTL, invalidation, reset);
 *   - `vm-reconcile-holder-tier-controller.ts`: per-graph entries, the policy
 *     gate and the lifecycle operations the SWM host forwards.
 */

export {
  VM_HOLDER_TIER_MAX_PEERS,
  VM_HOLDER_TIER_PEERS_PER_IDENTITY,
  VM_HOLDER_TIER_CARRY_PEERS_PER_IDENTITY,
  VM_HOLDER_TIER_PROFILE_PAGE_SIZE,
  VM_HOLDER_TIER_MAX_PROFILE_PAGES,
  VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS,
  VM_HOLDER_TIER_LOOKUP_CONCURRENCY,
  VM_HOLDER_TIER_READ_BUDGET_SHARE,
  VM_HOLDER_TIER_RESOLUTION_TTL_MS,
  VM_HOLDER_TIER_FAILURE_RETRY_MS,
  VM_HOLDER_TIER_RESOLUTION_TIMEOUT_MS,
  VM_HOLDER_TIER_POLICY_TIMEOUT_MS,
  VM_HOLDER_TIER_IDENTITY_TTL_MS,
  VM_HOLDER_TIER_NEGATIVE_IDENTITY_TTL_MS,
  VM_HOLDER_TIER_IDENTITY_CACHE_MAX_ENTRIES,
  VM_HOLDER_TIER_STALE_MAX_MS,
  VM_HOLDER_TIER_CARRY_TTL_MS,
  VM_HOLDER_TIER_MAX_PEER_ID_LENGTH,
} from './vm-reconcile-holder-tier-types.js';

export type {
  HolderProfileHint,
  HolderProfileCursor,
  HolderProfilePageRequest,
  HolderProfilePage,
  VmHolderHintDeps,
  VmHolderHintUnavailableReason,
  VmHolderScanStop,
  VmHolderHintStats,
  VmHolderHintResolution,
  VmHolderIdentityCache,
} from './vm-reconcile-holder-tier-types.js';

export {
  normalizeHolderProfileWallet,
} from './vm-reconcile-holder-tier-select.js';

export {
  VM_HOLDER_TIER_FRESH_SCAN,
} from './vm-reconcile-holder-tier-carry.js';
export type {
  CarriedHolderBinding,
  VmHolderScanState,
} from './vm-reconcile-holder-tier-carry.js';

export {
  resolveHolderPeerHints,
  resolveHolderScanWindow,
} from './vm-reconcile-holder-tier-walk.js';
export type {
  VmHolderScanOptions,
} from './vm-reconcile-holder-tier-walk.js';

export {
  VmHolderHintResolver,
  runWithinDeadline,
} from './vm-reconcile-holder-tier-resolver.js';
export type {
  VmHolderHintResolverOptions,
} from './vm-reconcile-holder-tier-resolver.js';

export {
  VmHolderTierController,
  appendVmHolderTier,
  nextVmHolderTierEntry,
  sameVmHolderPeerIds,
} from './vm-reconcile-holder-tier-controller.js';
export type {
  VmHolderGraphPolicy,
  VmHolderTierControllerDeps,
  VmHolderTierEntry,
  VmHolderTierOutcome,
} from './vm-reconcile-holder-tier-controller.js';
