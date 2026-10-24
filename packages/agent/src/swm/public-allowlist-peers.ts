// SPDX-License-Identifier: Apache-2.0

/**
 * The members of a curated public graph as recipients of its shares (#3421).
 *
 * A share into a public graph goes to the graph's GossipSub subscribers and
 * its followers (`shared-memory-followers.ts`), and the subscribers are
 * narrowed: a few unknown peers are probed per share, and a large graph goes
 * gossip-only. A curated public graph also names its members, the agents on
 * its allowlist. A member that reaches this node only through a relay is no
 * subscriber, and a follower only once it asked this node for the graph; the
 * narrowing may leave out one that is a subscriber. Members are the graph's
 * writers and readers, so the peers the local agent registry lists for them
 * and that this node is connected to are sent a share directly, as followers
 * are, outside the narrowing and the cap.
 *
 * Bounds: at most 64 agents of a graph are looked up, one registry read each,
 * at most 8 peers an agent; the peers found are kept for a minute, for at most
 * 256 graphs. Which of them are connected is read at every call.
 */

import type { DKGAgent } from '../dkg-agent.js';
import { memberAgentAddress } from '../internal/local-private-member.js';

export const PUBLIC_ALLOWLIST_PEERS_TTL_MS = 60_000;
const MAX_AGENTS_PER_GRAPH = 64;
const MAX_PEERS_PER_AGENT = 8;
const MAX_GRAPHS = 256;

export interface PublicAllowlistPeerPorts {
  /** The graph's allowlist: its allowed agents and participants, and the revoked ones. */
  allowlist(contextGraphId: string): Promise<{
    readonly allowedAgents: readonly string[];
    readonly participantAgents: readonly string[];
    readonly revokedAgents: readonly string[];
  }>;
  /** The peers the local agent registry lists for an agent address, at most `limit`. */
  peersOfAgent(agentAddress: string, limit: number): Promise<readonly string[]>;
  isConnected(peerId: string): boolean;
  selfPeerId(): string;
  now?(): number;
}

export class PublicAllowlistPeers {
  readonly #ports: PublicAllowlistPeerPorts;
  readonly #now: () => number;
  readonly #byGraph = new Map<string, { readonly at: number; readonly peerIds: Promise<readonly string[]> }>();

  constructor(ports: PublicAllowlistPeerPorts) {
    this.#ports = ports;
    this.#now = ports.now ?? Date.now;
  }

  /** The peers of the graph's allowlisted agents that this node is connected to now. Never throws. */
  async connected(contextGraphId: string): Promise<string[]> {
    const peerIds = await this.#registered(contextGraphId).catch((): readonly string[] => []);
    const self = this.#ports.selfPeerId();
    return peerIds.filter((peerId) => peerId !== self && this.#ports.isConnected(peerId));
  }

  /** The registered peers of the graph's members, looked up at most once a minute. */
  #registered(contextGraphId: string): Promise<readonly string[]> {
    const cached = this.#byGraph.get(contextGraphId);
    if (cached !== undefined && this.#now() - cached.at < PUBLIC_ALLOWLIST_PEERS_TTL_MS) return cached.peerIds;
    const peerIds = this.#lookUp(contextGraphId);
    this.#byGraph.delete(contextGraphId);
    if (this.#byGraph.size >= MAX_GRAPHS) this.#byGraph.delete(this.#byGraph.keys().next().value as string);
    this.#byGraph.set(contextGraphId, { at: this.#now(), peerIds });
    return peerIds;
  }

  async #lookUp(contextGraphId: string): Promise<readonly string[]> {
    const { allowedAgents, participantAgents, revokedAgents } = await this.#ports.allowlist(contextGraphId);
    const revoked = new Set(revokedAgents.map(memberAgentAddress));
    const agents = [...new Set([...allowedAgents, ...participantAgents].map(memberAgentAddress))]
      .filter((address): address is string => address !== undefined && !revoked.has(address))
      .slice(0, MAX_AGENTS_PER_GRAPH);
    const peers = await Promise.all(agents.map((address) => (
      this.#ports.peersOfAgent(address, MAX_PEERS_PER_AGENT).catch((): readonly string[] => [])
    )));
    return [...new Set(peers.flat())];
  }
}

const byAgent = new WeakMap<object, PublicAllowlistPeers>();

/** The agent's members of curated public graphs, created on first use. */
export function publicAllowlistPeersOf(agent: DKGAgent): PublicAllowlistPeers {
  let peers = byAgent.get(agent);
  if (peers === undefined) {
    peers = new PublicAllowlistPeers({
      allowlist: (contextGraphId) => agent.getCgMeta(contextGraphId),
      peersOfAgent: async (agentAddress, limit) => (
        await agent.discovery.findAgentPeerPageByAddress(agentAddress, { limit })
      ).peerIds,
      isConnected: (peerId) => agent.node.libp2p.getPeers().some((peer) => peer.toString() === peerId),
      selfPeerId: () => agent.peerId,
    });
    byAgent.set(agent, peers);
  }
  return peers;
}
