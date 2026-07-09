import type { DiscoveryClient } from '../discovery.js';
import {
  type ParsedMultiaddrPeerTarget,
} from './multiaddr-peer-target.js';

interface Libp2pLike {
  getConnections(): Array<{ remotePeer: { toString(): string } }>;
  dial(peer: unknown): Promise<unknown>;
  peerStore: {
    merge(peer: unknown, update: { multiaddrs: unknown[] }): Promise<void>;
  };
}

const CONNECT_WAIT_TIMEOUT_MS = 5000;
const CONNECT_WAIT_INTERVAL_MS = 100;
const DEBUG_SYNC_TRACE = process.env.DKG_DEBUG_SYNC_PROGRESS === '1' || process.env.DKG_DEBUG_SYNC === '1';

async function waitForPeerConnection(
  libp2p: Libp2pLike,
  peerId: string,
  timeoutMs = CONNECT_WAIT_TIMEOUT_MS,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
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
  connectTarget: ParsedMultiaddrPeerTarget,
  log?: (message: string) => void,
): Promise<void> {
  const debugLog = DEBUG_SYNC_TRACE ? log : undefined;
  const { multiaddr } = await import('@multiformats/multiaddr');
  const { multiaddress, target } = connectTarget;

  if (!multiaddress.includes('/p2p-circuit/p2p/')) {
    debugLog?.(`Dialing direct invite multiaddr: ${multiaddress}`);
    const directTargetPeerId = target?.canonical;
    await libp2p.dial(multiaddr(multiaddress));
    if (directTargetPeerId) {
      const connected = await waitForPeerConnection(libp2p, directTargetPeerId);
      debugLog?.(`Direct invite connection ${connected ? 'confirmed' : 'not observed before timeout'} for peer ${directTargetPeerId}`);
      if (!connected) {
        throw new Error(`Direct target peer ${directTargetPeerId} not observed before timeout`);
      }
    }
    return;
  }

  const circuitIndex = multiaddress.indexOf('/p2p-circuit/p2p/');
  const relayMultiaddr = multiaddress.slice(0, circuitIndex);
  if (!target) throw new Error('Circuit multiaddr missing target peer id');
  const targetPeerId = target.raw;

  debugLog?.(`Dialing relay from circuit invite: relay=${relayMultiaddr} targetPeer=${targetPeerId}`);
  await libp2p.dial(multiaddr(relayMultiaddr));

  const { peerIdFromString } = await import('@libp2p/peer-id');
  const targetPid = peerIdFromString(targetPeerId);
  const canonicalTargetPeerId = target.canonical;
  debugLog?.(`Merging circuit target multiaddr into peerStore: targetPeer=${canonicalTargetPeerId}`);
  await libp2p.peerStore.merge(targetPid, { multiaddrs: [multiaddr(multiaddress)] });
  debugLog?.(`Dialing final circuit target peer: ${canonicalTargetPeerId}`);
  await libp2p.dial(targetPid);
  const connected = await waitForPeerConnection(libp2p, canonicalTargetPeerId);
  debugLog?.(`Circuit target connection ${connected ? 'confirmed' : 'not observed before timeout'} for peer ${canonicalTargetPeerId}`);
  if (!connected) {
    throw new Error(`Circuit target peer ${canonicalTargetPeerId} not observed before timeout`);
  }
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
