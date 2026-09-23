import type { DiscoveryClient } from '../discovery.js';
import {
  connectLibp2pCandidate,
  type Libp2pConnectCandidate,
  type PeerResolver,
} from '@origintrail-official/dkg-core';

interface Libp2pLike {
  getConnections(): Array<{ remotePeer: { toString(): string } }>;
  dial(peer: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  peerStore: {
    merge(peer: unknown, update: { multiaddrs: unknown[] }): Promise<void>;
  };
}

const CONNECT_WAIT_TIMEOUT_MS = 5000;
const DEBUG_SYNC_TRACE = process.env.DKG_DEBUG_SYNC_PROGRESS === '1' || process.env.DKG_DEBUG_SYNC === '1';

export async function connectToMultiaddr(
  libp2p: Libp2pLike,
  connectTarget: Libp2pConnectCandidate,
  log?: (message: string) => void,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const debugLog = DEBUG_SYNC_TRACE ? log : undefined;
  try {
    await connectLibp2pCandidate(libp2p, connectTarget, {
      expectedPeerId: connectTarget.targetPeerId,
      signal: options?.signal,
      timeoutMs: CONNECT_WAIT_TIMEOUT_MS,
      log: debugLog,
    });
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    if (error instanceof DOMException && error.name === 'AbortError' && connectTarget.targetPeerId) {
      const label = connectTarget.kind === 'direct' ? 'Direct target' : 'Circuit target';
      throw new Error(
        `${label} peer ${connectTarget.targetPeerId} not observed before timeout`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function ensurePeerConnected(
  peerResolver: Pick<PeerResolver, 'connect'>,
  peerId: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (options.signal?.aborted) {
    throw new DOMException('Peer connection aborted', 'AbortError');
  }
  try {
    await peerResolver.connect(peerId, options);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // Non-fatal — peer may be unreachable.
  }
}

export interface PrimeCatchupConnectionsOptions {
  /**
   * New dials one walk may attempt. Omitted keeps the unbounded walk over the
   * whole phonebook. When set, core-role profiles come first and the rest
   * follow in peer-id order, so a capped walk is deterministic; peers that are
   * connected, are this node, or advertise no relay do not count.
   */
  readonly maxDials?: number;
}

export async function primeCatchupConnections(
  libp2p: Libp2pLike,
  discovery: DiscoveryClient,
  selfPeerId: string,
  afterDialAdmissionProbe: (peerId: string) => void | Promise<void> = () => undefined,
  options: PrimeCatchupConnectionsOptions = {},
): Promise<void> {
  try {
    const discovered = await discovery.findAgents();
    const maxDials = options.maxDials;
    const agents = maxDials === undefined
      ? discovered
      : [...discovered].sort((left, right) => (
        Number(right.nodeRole === 'core') - Number(left.nodeRole === 'core')
        || (left.peerId < right.peerId ? -1 : left.peerId > right.peerId ? 1 : 0)
      ));
    const { peerIdFromString } = await import('@libp2p/peer-id');
    const { multiaddr } = await import('@multiformats/multiaddr');
    let dials = 0;
    for (const agent of agents) {
      if (maxDials !== undefined && dials >= maxDials) break;
      if (agent.peerId === selfPeerId) continue;
      const existingConns = libp2p.getConnections()
        .filter((conn) => conn.remotePeer.toString() === agent.peerId);
      if (existingConns.length > 0) continue;
      if (!agent.relayAddress) continue;
      dials += 1;

      try {
        const circuitAddr = multiaddr(`${agent.relayAddress}/p2p-circuit/p2p/${agent.peerId}`);
        const pid = peerIdFromString(agent.peerId);
        await libp2p.peerStore.merge(pid, { multiaddrs: [circuitAddr] });
        await libp2p.dial(pid);
        await afterDialAdmissionProbe(agent.peerId);
      } catch {
        // Non-fatal — peer may be unreachable.
      }
    }
  } catch {
    // Discovery unavailable or dial failures are non-fatal.
  }
}
