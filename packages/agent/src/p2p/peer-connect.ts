import type { DiscoveryClient } from '../discovery.js';
import {
  parseMultiaddrConnectTarget,
  type MultiaddrConnectTarget,
} from './multiaddr-peer-target.js';

interface Libp2pLike {
  getConnections(): Array<{ remotePeer: { toString(): string } }>;
  dial(peer: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  peerStore: {
    merge(peer: unknown, update: { multiaddrs: unknown[] }): Promise<void>;
  };
}

const CONNECT_WAIT_TIMEOUT_MS = 5000;
const CONNECT_WAIT_INTERVAL_MS = 100;
const DEBUG_SYNC_TRACE = process.env.DKG_DEBUG_SYNC_PROGRESS === '1' || process.env.DKG_DEBUG_SYNC === '1';

function dialWithOptionalSignal(
  libp2p: Libp2pLike,
  target: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return signal
    ? libp2p.dial(target, { signal })
    : libp2p.dial(target);
}

async function waitForPeerConnection(
  libp2p: Libp2pLike,
  peerId: string,
  timeoutMs = CONNECT_WAIT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) return false;
    const connected = libp2p.getConnections().some((conn) => conn.remotePeer.toString() === peerId);
    if (connected) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, CONNECT_WAIT_INTERVAL_MS));
  }
  return false;
}

export async function connectToMultiaddr(
  libp2p: Libp2pLike,
  connectTarget: MultiaddrConnectTarget,
  log?: (message: string) => void,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const debugLog = DEBUG_SYNC_TRACE ? log : undefined;
  const { multiaddr } = await import('@multiformats/multiaddr');
  const { multiaddress } = connectTarget;

  if (connectTarget.kind === 'direct') {
    debugLog?.(`Dialing direct invite multiaddr: ${multiaddress}`);
    const directTargetPeerId = connectTarget.targetPeerId;
    await dialWithOptionalSignal(
      libp2p,
      multiaddr(multiaddress),
      options?.signal,
    );
    if (directTargetPeerId) {
      const connected = await waitForPeerConnection(
        libp2p,
        directTargetPeerId,
        CONNECT_WAIT_TIMEOUT_MS,
        options?.signal,
      );
      debugLog?.(`Direct invite connection ${connected ? 'confirmed' : 'not observed before timeout'} for peer ${directTargetPeerId}`);
      if (!connected) {
        throw new Error(`Direct target peer ${directTargetPeerId} not observed before timeout`);
      }
    }
    return;
  }

  const { relayMultiaddress, targetPeerId } = connectTarget;

  debugLog?.(`Dialing relay from circuit invite: relay=${relayMultiaddress} targetPeer=${targetPeerId}`);
  await dialWithOptionalSignal(
    libp2p,
    multiaddr(relayMultiaddress),
    options?.signal,
  );

  const { peerIdFromString } = await import('@libp2p/peer-id');
  const targetPid = peerIdFromString(targetPeerId);
  debugLog?.(`Merging circuit target multiaddr into peerStore: targetPeer=${targetPeerId}`);
  await libp2p.peerStore.merge(targetPid, { multiaddrs: [multiaddr(multiaddress)] });
  debugLog?.(`Dialing final circuit target peer: ${targetPeerId}`);
  await dialWithOptionalSignal(libp2p, targetPid, options?.signal);
  const connected = await waitForPeerConnection(
    libp2p,
    targetPeerId,
    CONNECT_WAIT_TIMEOUT_MS,
    options?.signal,
  );
  debugLog?.(`Circuit target connection ${connected ? 'confirmed' : 'not observed before timeout'} for peer ${targetPeerId}`);
  if (!connected) {
    throw new Error(`Circuit target peer ${targetPeerId} not observed before timeout`);
  }
}

export async function ensurePeerConnected(
  libp2p: Libp2pLike,
  discovery: DiscoveryClient,
  peerId: string,
  options: {
    signal?: AbortSignal;
    resolvedAddresses?: readonly string[];
  } = {},
): Promise<void> {
  if (options.signal?.aborted) {
    throw new DOMException('Peer connection aborted', 'AbortError');
  }
  const existingConnections = libp2p.getConnections()
    .filter((conn) => conn.remotePeer.toString() === peerId);
  if (existingConnections.length > 0) {
    return;
  }

  try {
    const { peerIdFromString } = await import('@libp2p/peer-id');
    const pid = peerIdFromString(peerId);

    try {
      await libp2p.dial(pid, { signal: options.signal });
      return;
    } catch {
      if (options.signal?.aborted) {
        throw new DOMException('Peer connection aborted', 'AbortError');
      }

      // Current callers can pass the ordered output from PeerResolver. Walk
      // those circuits explicitly so libp2p cannot collapse several relay
      // candidates onto one stale peerStore route.
      if (options.resolvedAddresses !== undefined) {
        for (const address of options.resolvedAddresses) {
          if (!address.includes('/p2p-circuit')) continue;
          try {
            const target = parseMultiaddrConnectTarget(address);
            if (target.kind !== 'circuit' || target.targetPeerId !== peerId) continue;
            await connectToMultiaddr(libp2p, target, undefined, {
              signal: options.signal,
            });
            return;
          } catch (error) {
            if (options.signal?.aborted) throw error;
          }
        }
        return;
      }

      // Backward-compatible fallback for direct helper callers that do not
      // yet supply PeerResolver output.
      const agent = await discovery.findAgentByPeerId(peerId, { signal: options.signal });
      if (options.signal?.aborted) {
        throw new DOMException('Peer connection aborted', 'AbortError');
      }
      if (!agent?.relayAddress) return;

      const { multiaddr } = await import('@multiformats/multiaddr');
      const circuitAddr = multiaddr(`${agent.relayAddress}/p2p-circuit/p2p/${peerId}`);
      await libp2p.peerStore.merge(pid, { multiaddrs: [circuitAddr] });
      await libp2p.dial(pid, { signal: options.signal });
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // Non-fatal — peer may be unreachable.
  }
}

export async function primeCatchupConnections(
  libp2p: Libp2pLike,
  discovery: DiscoveryClient,
  selfPeerId: string,
  afterDialAdmissionProbe: (peerId: string) => void | Promise<void> = () => undefined,
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
        await afterDialAdmissionProbe(agent.peerId);
      } catch {
        // Non-fatal — peer may be unreachable.
      }
    }
  } catch {
    // Discovery unavailable or dial failures are non-fatal.
  }
}
