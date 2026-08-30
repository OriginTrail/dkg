import { peerIdFromString } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import { multiaddr, type Component, type Multiaddr } from '@multiformats/multiaddr';
import { isPublicLikeAddress } from './address-policy.js';
import type { Address, NodeIdentity, PeerConnectOpts } from './network.js';

export interface Libp2pConnectHost {
  getConnections(): Array<{ remotePeer: { toString(): string } }>;
  dial(target: PeerId | Multiaddr, options?: { signal?: AbortSignal }): Promise<unknown>;
  peerStore: {
    merge(peer: PeerId, update: { multiaddrs: Multiaddr[] }): Promise<unknown>;
  };
}

export type Libp2pConnectCandidate =
  | { kind: 'direct'; address: string; targetPeerId?: string }
  | { kind: 'circuit'; address: string; relayAddress: string; targetPeerId: string };

export class Libp2pConnectCandidateParseError extends Error {
  constructor(message: string, readonly rawTarget?: string) {
    super(message);
    this.name = 'Libp2pConnectCandidateParseError';
  }
}

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

export function parseLibp2pConnectCandidate(raw: string): Libp2pConnectCandidate {
  const parsed = multiaddr(raw);
  const components = parsed.getComponents();
  const circuitIndex = components.findIndex((component) => component.name === 'p2p-circuit');
  if (circuitIndex === -1) {
    const rawTarget = targetPeerId(components);
    return rawTarget
      ? {
        kind: 'direct',
        address: parsed.toString(),
        targetPeerId: canonicalCandidatePeerId(rawTarget),
      }
      : { kind: 'direct', address: parsed.toString() };
  }

  const rawTarget = targetPeerId(components, circuitIndex + 1);
  if (!rawTarget) {
    throw new Libp2pConnectCandidateParseError(
      'Circuit multiaddr missing target peer id',
      '<missing>',
    );
  }
  return {
    kind: 'circuit',
    address: parsed.toString(),
    relayAddress: multiaddr(components.slice(0, circuitIndex)).toString(),
    targetPeerId: canonicalCandidatePeerId(rawTarget),
  };
}

function canonicalCandidatePeerId(rawTarget: string): string {
  try {
    return peerIdFromString(rawTarget).toString();
  } catch (error) {
    throw new Libp2pConnectCandidateParseError(
      error instanceof Error ? error.message : String(error),
      rawTarget,
    );
  }
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
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, CONNECTION_OBSERVATION_INTERVAL_MS);
      function done(): void {
        signal.removeEventListener('abort', aborted);
        resolve();
      }
      function aborted(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        reject(new DOMException('Peer connection candidate timed out', 'AbortError'));
      }
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }
  throw new DOMException('Peer connection candidate timed out', 'AbortError');
}

export async function connectLibp2pCandidate(
  host: Libp2pConnectHost,
  candidate: Libp2pConnectCandidate,
  options: {
    expectedPeerId?: NodeIdentity;
    signal?: AbortSignal;
    timeoutMs?: number;
    log?: (message: string) => void;
  } = {},
): Promise<void> {
  throwIfAborted(options.signal);
  const expectedPeerId = options.expectedPeerId === undefined
    ? candidate.targetPeerId
    : peerIdFromString(options.expectedPeerId).toString();
  if (
    expectedPeerId !== undefined &&
    candidate.targetPeerId !== undefined &&
    candidate.targetPeerId !== expectedPeerId
  ) {
    throw new Error(
      `Connection candidate targets ${candidate.targetPeerId}, not ${expectedPeerId}`,
    );
  }
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => timeoutController.abort(
      new DOMException('Peer connection candidate timed out', 'TimeoutError'),
    ),
    options.timeoutMs ?? DEFAULT_CANDIDATE_TIMEOUT_MS,
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    if (candidate.kind === 'direct') {
      options.log?.(`Dialing direct address: ${candidate.address}`);
      await host.dial(multiaddr(candidate.address), { signal });
      if (expectedPeerId) await observeConnection(host, expectedPeerId, signal);
      return;
    }

    options.log?.(`Preconnecting relay: ${candidate.relayAddress}`);
    await host.dial(multiaddr(candidate.relayAddress), { signal });
    const target = peerIdFromString(candidate.targetPeerId);
    await host.peerStore.merge(target, { multiaddrs: [multiaddr(candidate.address)] });
    options.log?.(`Dialing circuit: ${candidate.address}`);
    await host.dial(multiaddr(candidate.address), { signal });
    await observeConnection(host, expectedPeerId!, signal);
  } finally {
    clearTimeout(timeout);
  }
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
  const canonicalPeerId = peerIdFromString(peerId).toString();
  if (
    host.getConnections().some(
      (connection) => connection.remotePeer.toString() === canonicalPeerId,
    )
  ) {
    return;
  }

  const candidates: Libp2pConnectCandidate[] = [];
  for (const address of resolvedAddresses) {
    try {
      const candidate = parseLibp2pConnectCandidate(address);
      if (
        candidate.targetPeerId !== undefined &&
        candidate.targetPeerId !== canonicalPeerId
      ) continue;
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
    try {
      await connectLibp2pCandidate(host, candidate, {
        expectedPeerId: canonicalPeerId,
        signal: options.signal,
        timeoutMs: options.candidateTimeoutMs,
        log: options.log,
      });
      return;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastCandidateError = error;
    }
  }

  throwIfAborted(options.signal);
  try {
    await host.dial(
      peerIdFromString(canonicalPeerId),
      options.signal ? { signal: options.signal } : undefined,
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof Error && lastCandidateError !== undefined && error.cause === undefined) {
      error.cause = lastCandidateError;
    }
    throw error;
  }
}
