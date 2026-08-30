import { peerIdFromString } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import { multiaddr, type Component, type Multiaddr } from '@multiformats/multiaddr';
import { isPublicLikeAddress } from './address-policy.js';
import type { Address, NodeIdentity, PeerConnectOpts } from './network.js';

interface Libp2pConnectHost {
  getConnections(): Array<{ remotePeer: { toString(): string } }>;
  dial(target: PeerId | Multiaddr, options?: { signal?: AbortSignal }): Promise<unknown>;
  peerStore: {
    merge(peer: PeerId, update: { multiaddrs: Multiaddr[] }): Promise<unknown>;
  };
}

type ConnectCandidate =
  | { kind: 'direct'; address: string; targetPeerId?: string }
  | { kind: 'circuit'; address: string; relayAddress: string; targetPeerId: string };

const DEFAULT_CANDIDATE_TIMEOUT_MS = 5_000;
const CONNECTION_OBSERVATION_INTERVAL_MS = 100;

function targetPeerId(components: readonly Component[], start = 0): string | undefined {
  return components
    .slice(start)
    .filter((component) => component.name === 'p2p' && component.value)
    .map((component) => component.value!.trim())
    .filter(Boolean)
    .at(-1);
}

function parseCandidate(raw: string): ConnectCandidate {
  const parsed = multiaddr(raw);
  const components = parsed.getComponents();
  const circuitIndex = components.findIndex((component) => component.name === 'p2p-circuit');
  if (circuitIndex === -1) {
    const rawTarget = targetPeerId(components);
    return rawTarget
      ? {
        kind: 'direct',
        address: parsed.toString(),
        targetPeerId: peerIdFromString(rawTarget).toString(),
      }
      : { kind: 'direct', address: parsed.toString() };
  }

  const rawTarget = targetPeerId(components, circuitIndex + 1);
  if (!rawTarget) throw new Error('Circuit multiaddr missing target peer id');
  return {
    kind: 'circuit',
    address: parsed.toString(),
    relayAddress: multiaddr(components.slice(0, circuitIndex)).toString(),
    targetPeerId: peerIdFromString(rawTarget).toString(),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Peer connection aborted', 'AbortError');
}

async function observeConnection(
  host: Libp2pConnectHost,
  peerId: NodeIdentity,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    if (host.getConnections().some((connection) => connection.remotePeer.toString() === peerId)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, CONNECTION_OBSERVATION_INTERVAL_MS));
  }
  throw new DOMException('Peer connection candidate timed out', 'AbortError');
}

async function dialCandidate(
  host: Libp2pConnectHost,
  candidate: ConnectCandidate,
  signal: AbortSignal,
  log?: (message: string) => void,
): Promise<void> {
  if (candidate.kind === 'direct') {
    log?.(`Dialing resolved direct address: ${candidate.address}`);
    await host.dial(multiaddr(candidate.address), { signal });
    if (candidate.targetPeerId) await observeConnection(host, candidate.targetPeerId, signal);
    return;
  }

  log?.(`Preconnecting resolved relay: ${candidate.relayAddress}`);
  await host.dial(multiaddr(candidate.relayAddress), { signal });
  const target = peerIdFromString(candidate.targetPeerId);
  await host.peerStore.merge(target, { multiaddrs: [multiaddr(candidate.address)] });
  log?.(`Dialing resolved circuit: ${candidate.address}`);
  await host.dial(multiaddr(candidate.address), { signal });
  await observeConnection(host, candidate.targetPeerId, signal);
}

/**
 * Canonical libp2p implementation of Network.connectPeer(). Resolver output is
 * attempted in order, with private direct addresses ignored, before one final
 * peer-id fallback. Candidate-local timeouts never masquerade as caller aborts.
 */
export async function connectLibp2pPeer(
  host: Libp2pConnectHost,
  peerId: NodeIdentity,
  resolvedAddresses: readonly Address[],
  options: PeerConnectOpts = {},
): Promise<void> {
  throwIfAborted(options.signal);
  if (host.getConnections().some((connection) => connection.remotePeer.toString() === peerId)) {
    return;
  }

  const candidates: ConnectCandidate[] = [];
  for (const address of resolvedAddresses) {
    try {
      const candidate = parseCandidate(address);
      if (candidate.targetPeerId !== undefined && candidate.targetPeerId !== peerId) continue;
      if (candidate.kind === 'direct' && !isPublicLikeAddress(candidate.address)) continue;
      candidates.push(candidate);
    } catch {
      // Resolver output is best-effort. Continue with the remaining ordered
      // candidates and the final peer-id fallback.
    }
  }

  let lastCandidateError: unknown;
  for (const candidate of candidates) {
    throwIfAborted(options.signal);
    const candidateSignal = AbortSignal.timeout(
      options.candidateTimeoutMs ?? DEFAULT_CANDIDATE_TIMEOUT_MS,
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, candidateSignal])
      : candidateSignal;
    try {
      await dialCandidate(host, candidate, signal, options.log);
      return;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastCandidateError = error;
    }
  }

  throwIfAborted(options.signal);
  try {
    await host.dial(peerIdFromString(peerId), options.signal ? { signal: options.signal } : undefined);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof Error && lastCandidateError !== undefined && error.cause === undefined) {
      error.cause = lastCandidateError;
    }
    throw error;
  }
}
