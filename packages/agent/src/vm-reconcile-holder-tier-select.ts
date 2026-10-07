// SPDX-License-Identifier: Apache-2.0

/**
 * The holder tier's stateless rules, which only ever look at one row or one set
 * of verified bindings: which wallet and peer id a profile row may carry, how a
 * self-declared `lastSeen` is read, how verified peers of one identity rank, which
 * peers a set of verified bindings selects for a roster, and a row's place in the
 * walk order. Every order is by code unit, never by locale, so every node ranks
 * identically.
 */

import { ethers } from 'ethers';
import {
  VM_HOLDER_TIER_MAX_PEERS,
  VM_HOLDER_TIER_MAX_PEER_ID_LENGTH,
  VM_HOLDER_TIER_PEERS_PER_IDENTITY,
} from './vm-reconcile-holder-tier-types.js';

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
export function plausiblePeerId(value: unknown): value is string {
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
export function lastSeenMs(value: string | undefined, wallClockNow: number): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || parsed > wallClockNow + LAST_SEEN_FUTURE_SKEW_MS) return 0;
  return parsed;
}

/**
 * How two verified peers of ONE identity rank: the better sorts first (the later
 * `lastSeen`, then the smaller peer id). The selection takes the best of them and
 * the carry drops the worst, so both use this one order.
 */
export function compareHolderPeers(
  left: { readonly peerId: string; readonly lastSeen: number },
  right: { readonly peerId: string; readonly lastSeen: number },
): number {
  return right.lastSeen - left.lastSeen || compareCodeUnits(left.peerId, right.peerId);
}

/** The peers a set of verified per-identity peers selects, and how many identities it spans. */
export function selectHolderPeers(
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

/** A row's place in the walk order (the order the phonebook pages come in). */
export function compareRowKeys(
  left: { readonly agentAddress: string; readonly peerId: string },
  right: { readonly agentAddress: string; readonly peerId: string },
): number {
  return compareCodeUnits(left.agentAddress, right.agentAddress)
    || compareCodeUnits(left.peerId, right.peerId);
}
