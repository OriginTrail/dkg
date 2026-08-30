import type { DiscoveryClient } from '../discovery.js';
import { isPublicLikeAddress } from '@origintrail-official/dkg-core';
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
const RESOLVED_CANDIDATE_TIMEOUT_MS = 5000;
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
        if (options?.signal?.aborted) {
          throw new DOMException('Peer connection aborted', 'AbortError');
        }
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
  debugLog?.(`Dialing explicit circuit target: ${multiaddress}`);
  await dialWithOptionalSignal(libp2p, multiaddr(multiaddress), options?.signal);
  const connected = await waitForPeerConnection(
    libp2p,
    targetPeerId,
    CONNECT_WAIT_TIMEOUT_MS,
    options?.signal,
  );
  debugLog?.(`Circuit target connection ${connected ? 'confirmed' : 'not observed before timeout'} for peer ${targetPeerId}`);
  if (!connected) {
    if (options?.signal?.aborted) {
      throw new DOMException('Peer connection aborted', 'AbortError');
    }
    throw new Error(`Circuit target peer ${targetPeerId} not observed before timeout`);
  }
}

export interface ResolvedPeerDialOptions {
  /** One deadline shared by all candidate attempts and the peer-id fallback. */
  signal?: AbortSignal;
  /** Per-candidate cap so one stale circuit cannot starve later routes. */
  candidateTimeoutMs?: number;
}

/**
 * Dial one resolver result in its declared order. Public direct addresses and
 * target-specific circuits are attempted explicitly; a peer-id dial is the
 * final compatibility fallback after every usable candidate is exhausted.
 */
export async function dialResolvedPeer(
  libp2p: Libp2pLike,
  peerId: string,
  resolvedAddresses: readonly string[],
  log?: (message: string) => void,
  options: ResolvedPeerDialOptions = {},
): Promise<void> {
  const assertNotAborted = () => {
    if (options.signal?.aborted) {
      throw new DOMException('Peer connection aborted', 'AbortError');
    }
  };
  assertNotAborted();

  const candidates: MultiaddrConnectTarget[] = [];
  for (const address of resolvedAddresses) {
    try {
      const target = parseMultiaddrConnectTarget(address);
      if (target.targetPeerId !== undefined && target.targetPeerId !== peerId) continue;
      if (target.kind === 'direct' && !isPublicLikeAddress(target.multiaddress)) continue;
      candidates.push(target);
    } catch {
      // Resolver output is best-effort. A malformed candidate must not prevent
      // the remaining ordered routes or the final peer-id fallback.
    }
  }

  let lastCandidateError: unknown;
  for (const candidate of candidates) {
    assertNotAborted();
    const timeoutSignal = AbortSignal.timeout(
      options.candidateTimeoutMs ?? RESOLVED_CANDIDATE_TIMEOUT_MS,
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    try {
      await connectToMultiaddr(libp2p, candidate, log, { signal });
      return;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastCandidateError = error;
    }
  }

  assertNotAborted();
  const { peerIdFromString } = await import('@libp2p/peer-id');
  try {
    await dialWithOptionalSignal(libp2p, peerIdFromString(peerId), options.signal);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw lastCandidateError ?? error;
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

    if (options.resolvedAddresses !== undefined) {
      await dialResolvedPeer(
        libp2p,
        peerId,
        options.resolvedAddresses,
        undefined,
        { signal: options.signal },
      );
      return;
    }

    try {
      await libp2p.dial(pid, { signal: options.signal });
      return;
    } catch {
      if (options.signal?.aborted) {
        throw new DOMException('Peer connection aborted', 'AbortError');
      }

      // Backward-compatible fallback for direct helper callers that do not
      // yet supply PeerResolver output.
      const agent = await discovery.findAgentByPeerId(peerId, { signal: options.signal });
      if (options.signal?.aborted) {
        throw new DOMException('Peer connection aborted', 'AbortError');
      }
      if (!agent?.relayAddress) return;

      const circuitAddress = `${agent.relayAddress}/p2p-circuit/p2p/${peerId}`;
      await dialResolvedPeer(libp2p, peerId, [circuitAddress], undefined, {
        signal: options.signal,
      });
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
