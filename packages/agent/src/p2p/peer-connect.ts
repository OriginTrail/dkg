import type { DiscoveryClient } from '../discovery.js';

interface Libp2pLike {
  getConnections(): Array<{ remotePeer: { toString(): string } }>;
  dial(peer: unknown): Promise<unknown>;
  peerStore: {
    merge(peer: unknown, update: { multiaddrs: unknown[] }): Promise<void>;
  };
}

export async function ensurePeerConnected(
  libp2p: Libp2pLike,
  discovery: DiscoveryClient,
  peerId: string,
): Promise<void> {
  const existingConnections = libp2p.getConnections()
    .filter((conn) => conn.remotePeer.toString() === peerId);
  if (existingConnections.length > 0) {
    return;
  }

  try {
    const { peerIdFromString } = await import('@libp2p/peer-id');
    const pid = peerIdFromString(peerId);

    try {
      await libp2p.dial(pid);
      return;
    } catch {
      const agent = await discovery.findAgentByPeerId(peerId);
      if (!agent?.relayAddress) return;

      const { multiaddr } = await import('@multiformats/multiaddr');
      const circuitAddr = multiaddr(`${agent.relayAddress}/p2p-circuit/p2p/${peerId}`);
      await libp2p.peerStore.merge(pid, { multiaddrs: [circuitAddr] });
      await libp2p.dial(pid);
    }
  } catch {
    // Non-fatal — peer may be unreachable.
  }
}

export async function primeCatchupConnections(
  libp2p: Libp2pLike,
  discovery: DiscoveryClient,
  selfPeerId: string,
): Promise<void> {
  try {
    const agents = await discovery.findAgents();
    const { peerIdFromString } = await import('@libp2p/peer-id');
    const { multiaddr } = await import('@multiformats/multiaddr');
    for (const agent of agents) {
      if (agent.peerId === selfPeerId) continue;
      const existingConns = libp2p.getConnections()
        .filter((conn) => conn.remotePeer.toString() === agent.peerId);
      if (existingConns.length > 0) continue;
      if (!agent.relayAddress) continue;

      try {
        const circuitAddr = multiaddr(`${agent.relayAddress}/p2p-circuit/p2p/${agent.peerId}`);
        const pid = peerIdFromString(agent.peerId);
        await libp2p.peerStore.merge(pid, { multiaddrs: [circuitAddr] });
        await libp2p.dial(pid);
      } catch {
        // Non-fatal — peer may be unreachable.
      }
    }
  } catch {
    // Discovery unavailable or dial failures are non-fatal.
  }
}
