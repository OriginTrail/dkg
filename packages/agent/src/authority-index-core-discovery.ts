// SPDX-License-Identifier: Apache-2.0

import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import {
  AUTHORITY_INDEX_SNAPSHOT_MAX_TRUSTED_PEERS,
  type AuthorityIndexSnapshotPeer,
} from './authority-index-snapshot-config.js';
import { selectWarmCoreCandidates, type WarmCoreAgent } from './p2p/warm-core-connections.js';

const DEFAULT_VERDICT_TTL_MS = 300_000;

export interface OnChainCorePeerResolverDeps {
  readonly selfPeerId: string;
  /** Phonebook rows; the same lookup warm core connections rank. */
  readonly findAgents: () => Promise<ReadonlyArray<WarmCoreAgent>>;
  /** Network-file relays as `/p2p/<peerId>` multiaddrs; transport already trusts them. */
  readonly networkRelays: readonly string[];
  readonly isConnected: (peerId: string) => boolean;
  readonly getIdentityIdForAddress?: (address: string) => Promise<bigint>;
  readonly isShardingTableMember?: (identityId: bigint) => Promise<boolean>;
  /** Phonebook cores not seen within this window are ignored. */
  readonly staleThresholdMs: number;
  readonly now?: () => number;
  /** How long an on-chain membership verdict is reused per operational address. */
  readonly verdictTtlMs?: number;
}

export interface OnChainCorePeerResolver {
  resolve(signal: AbortSignal): Promise<AuthorityIndexSnapshotPeer[]>;
}

function relayPeerId(raw: string): string | undefined {
  try {
    const last = multiaddr(raw).getComponents().at(-1);
    return last?.name === 'p2p' && last.value ? peerIdFromString(last.value).toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runtime trust set for the edge default: network relays first, then
 * phonebook cores whose operational address is a ShardingTable member on
 * chain. Fails closed, so a core the chain cannot vouch for is never asked,
 * and lists a discovered core only over its live authenticated connection,
 * so the transport never dials a phonebook address.
 */
export function createOnChainCorePeerResolver(
  deps: OnChainCorePeerResolverDeps,
): OnChainCorePeerResolver {
  const now = deps.now ?? Date.now;
  const verdictTtlMs = deps.verdictTtlMs ?? DEFAULT_VERDICT_TTL_MS;
  const verdicts = new Map<string, { readonly member: boolean; readonly expiresAt: number }>();
  const relays = deps.networkRelays.flatMap((raw) => {
    const peerId = relayPeerId(raw);
    return peerId === undefined ? [] : [Object.freeze({ peerId, multiaddr: raw })];
  });

  const verifyMembership = async (address: string): Promise<boolean> => {
    const { getIdentityIdForAddress, isShardingTableMember } = deps;
    if (getIdentityIdForAddress === undefined || isShardingTableMember === undefined) return false;
    const key = address.toLowerCase();
    const at = now();
    const cached = verdicts.get(key);
    if (cached !== undefined && cached.expiresAt > at) return cached.member;
    let member: boolean;
    try {
      const identityId = await getIdentityIdForAddress(address);
      member = identityId !== 0n && await isShardingTableMember(identityId);
    } catch {
      // A failed RPC is no verdict: deny this walk and ask again next time.
      return false;
    }
    verdicts.set(key, { member, expiresAt: at + verdictTtlMs });
    return member;
  };

  return Object.freeze({
    async resolve(signal: AbortSignal): Promise<AuthorityIndexSnapshotPeer[]> {
      signal.throwIfAborted();
      const peers: AuthorityIndexSnapshotPeer[] = [];
      const seen = new Set<string>();
      const admit = (peer: AuthorityIndexSnapshotPeer): void => {
        if (seen.has(peer.peerId) || peers.length >= AUTHORITY_INDEX_SNAPSHOT_MAX_TRUSTED_PEERS) return;
        seen.add(peer.peerId);
        peers.push(peer);
      };
      const connectedRelays = relays.filter((relay) => deps.isConnected(relay.peerId));
      for (const relay of connectedRelays) admit(relay);
      for (const relay of relays) admit(relay);
      const agents = await deps.findAgents();
      signal.throwIfAborted();
      const candidates = selectWarmCoreCandidates(Array.from(agents), deps.selfPeerId, {
        nowMs: now(),
        staleThresholdMs: deps.staleThresholdMs,
      });
      for (const core of candidates) {
        if (peers.length >= AUTHORITY_INDEX_SNAPSHOT_MAX_TRUSTED_PEERS) break;
        // Without a live connection there is nothing authenticated to send on.
        if (seen.has(core.peerId) || !deps.isConnected(core.peerId)) continue;
        // Fail closed: without an operational address the chain cannot vouch.
        const trusted = core.agentAddress ? await verifyMembership(core.agentAddress) : false;
        signal.throwIfAborted();
        if (trusted) admit({ peerId: core.peerId });
      }
      return peers;
    },
  });
}
