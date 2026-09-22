// SPDX-License-Identifier: Apache-2.0

import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { DKGNode } from '@origintrail-official/dkg-core';
import type { AuthorityIndexSnapshotClientOptions } from './authority-index-snapshot-client.js';
import {
  AUTHORITY_INDEX_SNAPSHOT_MAX_TRUSTED_PEERS,
  type AuthorityIndexSnapshotPeer,
} from './authority-index-snapshot-config.js';
import type { DiscoveryClient } from './discovery.js';
import { AGENT_PROFILE_STALE_THRESHOLD_MS } from './dkg-agent-constants.js';
import {
  probeShardingTableGate,
  type ShardingTableGateOutcome,
  type ShardingTableGateReads,
} from './p2p/sharding-table-gate.js';
import { selectWarmCoreCandidates, type WarmCoreAgent } from './p2p/warm-core-connections.js';

const DEFAULT_VERDICT_TTL_MS = 300_000;

export interface OnChainCorePeerResolverDeps extends ShardingTableGateReads {
  readonly selfPeerId: string;
  /** Phonebook rows; the same lookup warm core connections rank. */
  readonly findAgents: () => Promise<ReadonlyArray<WarmCoreAgent>>;
  /**
   * The network file's relays as `/p2p/<peerId>` multiaddrs: the only entries
   * trusted without a chain verdict. Never the daemon's connectivity relays,
   * which an operator may extend with peers the network never vouched for.
   */
  readonly networkRelays: readonly string[];
  readonly isConnected: (peerId: string) => boolean;
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

/** First operational address the phonebook attributes to each peer identity. */
function phonebookAddresses(agents: ReadonlyArray<WarmCoreAgent>): ReadonlyMap<string, string> {
  const addresses = new Map<string, string>();
  for (const agent of agents) {
    if (agent.agentAddress && !addresses.has(agent.peerId)) addresses.set(agent.peerId, agent.agentAddress);
  }
  return addresses;
}

/**
 * Runtime trust set for the edge default: network relays first, then
 * phonebook cores whose operational address is a ShardingTable member on
 * chain. Cores fail closed, so a core the chain cannot vouch for is never
 * asked, and are listed only over their live authenticated connection, so the
 * transport never dials a phonebook address. Relays carry the network file's
 * trust and are dropped only when the chain positively denies the operational
 * address the phonebook attributes to them.
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

  const verifyMembership = async (address: string): Promise<ShardingTableGateOutcome> => {
    const key = address.toLowerCase();
    const at = now();
    const cached = verdicts.get(key);
    if (cached !== undefined && cached.expiresAt > at) return cached.member ? 'member' : 'non-member';
    const outcome = await probeShardingTableGate(deps, address);
    // Only a chain verdict is worth remembering: an unbound gate or a failed
    // RPC decides nothing, so the next walk asks again.
    if (outcome === 'member' || outcome === 'non-member') {
      verdicts.set(key, { member: outcome === 'member', expiresAt: at + verdictTtlMs });
    }
    return outcome;
  };

  return Object.freeze({
    async resolve(signal: AbortSignal): Promise<AuthorityIndexSnapshotPeer[]> {
      signal.throwIfAborted();
      const agents = await deps.findAgents();
      signal.throwIfAborted();
      const peers: AuthorityIndexSnapshotPeer[] = [];
      const seen = new Set<string>();
      const admit = (peer: AuthorityIndexSnapshotPeer): void => {
        if (seen.has(peer.peerId) || peers.length >= AUTHORITY_INDEX_SNAPSHOT_MAX_TRUSTED_PEERS) return;
        seen.add(peer.peerId);
        peers.push(peer);
      };
      const addresses = phonebookAddresses(agents);
      const trustedRelays: AuthorityIndexSnapshotPeer[] = [];
      for (const relay of relays) {
        const address = addresses.get(relay.peerId);
        // Network-file trust stands unless the chain positively denies the
        // address the phonebook attributes to this relay: no profile, no
        // address, an unbound gate or a failed read all leave it in place.
        const outcome = address === undefined ? 'unavailable' : await verifyMembership(address);
        signal.throwIfAborted();
        if (outcome !== 'non-member') trustedRelays.push(relay);
      }
      for (const relay of trustedRelays) if (deps.isConnected(relay.peerId)) admit(relay);
      for (const relay of trustedRelays) admit(relay);
      const candidates = selectWarmCoreCandidates(Array.from(agents), deps.selfPeerId, {
        nowMs: now(),
        staleThresholdMs: deps.staleThresholdMs,
      });
      for (const core of candidates) {
        if (peers.length >= AUTHORITY_INDEX_SNAPSHOT_MAX_TRUSTED_PEERS) break;
        // Without a live connection there is nothing authenticated to send on.
        if (seen.has(core.peerId) || !deps.isConnected(core.peerId)) continue;
        // Fail closed: without an operational address the chain cannot vouch,
        // and neither an unbound gate nor a failed read is a verdict.
        const outcome = core.agentAddress ? await verifyMembership(core.agentAddress) : 'unavailable';
        signal.throwIfAborted();
        if (outcome === 'member') admit({ peerId: core.peerId });
      }
      return peers;
    },
  });
}

/**
 * What the running agent lends core discovery. Read again on every walk so
 * the `started` gate stays live; the other members are the agent's own
 * immutable collaborators.
 */
export interface AgentCorePeerResolverHost {
  readonly started: boolean;
  readonly node: DKGNode;
  readonly discovery: Pick<DiscoveryClient, 'findAgents'>;
  readonly chain: Pick<ChainAdapter, 'getIdentityIdForAddress' | 'isShardingTableMember'>;
  /** The network file's relay multiaddrs; see `DKGAgentConfig.networkRelays`. */
  readonly networkRelays: readonly string[];
}

/**
 * The snapshot client's peer resolver for a discovered trust set. Chain,
 * libp2p identity and the phonebook exist only once the agent runs, so the
 * on-chain resolver (and its verdict memo) is built on the first walk after
 * start and reused for the agent's lifetime; before that, nothing is trusted.
 */
export function createAgentCorePeerResolver(
  getHost: () => AgentCorePeerResolverHost | undefined,
): NonNullable<AuthorityIndexSnapshotClientOptions['resolvePeers']> {
  let resolver: OnChainCorePeerResolver | undefined;
  return async (signal) => {
    const host = getHost();
    if (host === undefined || !host.started) return [];
    resolver ??= createOnChainCorePeerResolver({
      selfPeerId: host.node.libp2p.peerId.toString(),
      findAgents: async () => (await host.discovery.findAgents()).map((agent) => ({
        peerId: agent.peerId,
        nodeRole: agent.nodeRole,
        agentAddress: agent.agentAddress,
        lastSeen: agent.lastSeen,
      })),
      networkRelays: host.networkRelays,
      isConnected: (peerId) => {
        try {
          return host.node.libp2p.getConnections(peerIdFromString(peerId)).length > 0;
        } catch {
          return false;
        }
      },
      getIdentityIdForAddress: host.chain.getIdentityIdForAddress?.bind(host.chain),
      isShardingTableMember: host.chain.isShardingTableMember?.bind(host.chain),
      staleThresholdMs: AGENT_PROFILE_STALE_THRESHOLD_MS,
    });
    return resolver.resolve(signal);
  };
}
