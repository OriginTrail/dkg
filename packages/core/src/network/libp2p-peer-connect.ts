import { peerIdFromString } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import { multiaddr, type Component, type Multiaddr } from '@multiformats/multiaddr';
import { isPublicLikeAddress } from './address-policy.js';
import type { Address, NodeIdentity, PeerConnectOpts } from './network.js';
import { PeerConnectionUnresolvedError } from './network.js';
import { canonicalPeerIdString, type CanonicalPeerId } from './peer-id.js';
import type { ConfiguredRelayTarget } from './relay-target.js';

export interface Libp2pConnectHost {
  getConnections(): Array<{ remotePeer: { toString(): string } }>;
  dial(target: PeerId | Multiaddr, options?: { signal?: AbortSignal }): Promise<unknown>;
  peerStore: {
    merge(peer: PeerId, update: { multiaddrs: Multiaddr[] }): Promise<unknown>;
  };
}

export type Libp2pConnectCandidate =
  | { kind: 'direct'; address: string; targetPeerId?: CanonicalPeerId }
  | { kind: 'circuit'; address: string; relayAddress: string; targetPeerId: CanonicalPeerId };

export class Libp2pConnectCandidateParseError extends Error {
  constructor(message: string, readonly rawTarget?: string) {
    super(message);
    this.name = 'Libp2pConnectCandidateParseError';
  }
}

const DEFAULT_CANDIDATE_TIMEOUT_MS = 5_000;
const CONNECTION_OBSERVATION_INTERVAL_MS = 100;
const MAX_CONFIGURED_RELAY_FALLBACKS = 4;

export interface Libp2pPeerConnectOpts extends PeerConnectOpts {
  /** Canonical relay targets owned by the libp2p transport. */
  configuredRelayTargets?: readonly ConfiguredRelayTarget[];
}

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

function canonicalCandidatePeerId(rawTarget: string): CanonicalPeerId {
  try {
    return canonicalPeerIdString(rawTarget);
  } catch (error) {
    throw new Libp2pConnectCandidateParseError(
      error instanceof Error ? error.message : String(error),
      rawTarget,
    );
  }
}

/**
 * Apply libp2p-specific route policy at the transport boundary. Resolver
 * addresses are treated as opaque until they reach this planner: malformed,
 * wrong-target, and private direct candidates are dropped here. When no public
 * direct route survives, append at most four circuits through the operator's
 * configured relays while preserving the resolver and relay order.
 */
function planLibp2pPeerConnectionCandidates(
  peerId: NodeIdentity,
  resolvedAddresses: readonly Address[],
  configuredRelayTargets: readonly ConfiguredRelayTarget[] = [],
): Libp2pConnectCandidate[] {
  const canonicalPeerId = peerIdFromString(peerId).toString();
  const planned: Libp2pConnectCandidate[] = [];
  const seen = new Set<string>();
  let hasPublicDirect = false;

  const appendCandidate = (rawAddress: Address): Libp2pConnectCandidate | undefined => {
    try {
      const candidate = parseLibp2pConnectCandidate(rawAddress);
      if (
        candidate.targetPeerId !== undefined
        && candidate.targetPeerId !== canonicalPeerId
      ) return undefined;
      if (candidate.kind === 'direct' && !isPublicLikeAddress(candidate.address)) {
        return undefined;
      }
      if (!seen.has(candidate.address)) {
        seen.add(candidate.address);
        planned.push(candidate);
      }
      return candidate;
    } catch {
      return undefined;
    }
  };

  for (const address of resolvedAddresses) {
    const candidate = appendCandidate(address);
    if (candidate?.kind === 'direct') hasPublicDirect = true;
  }

  if (hasPublicDirect) return planned;

  let fallbackCount = 0;
  for (const target of configuredRelayTargets) {
    if (fallbackCount >= MAX_CONFIGURED_RELAY_FALLBACKS) break;
    if (target.peerId === canonicalPeerId) continue;
    const relay = target.addresses.find(
      (address) => !address.includes('/p2p-circuit') && isPublicLikeAddress(address),
    )?.replace(/\/+$/, '');
    if (!relay) continue;
    const circuit = `${relay}/p2p-circuit/p2p/${canonicalPeerId}`;
    const before = planned.length;
    const candidate = appendCandidate(circuit);
    if (candidate?.kind === 'circuit' && planned.length > before) fallbackCount += 1;
  }

  return planned;
}

/** Public address projection retained for callers that only need route planning. */
export function planLibp2pPeerConnectionAddresses(
  peerId: NodeIdentity,
  resolvedAddresses: readonly Address[],
  configuredRelayTargets: readonly ConfiguredRelayTarget[] = [],
): Address[] {
  return planLibp2pPeerConnectionCandidates(
    peerId,
    resolvedAddresses,
    configuredRelayTargets,
  ).map((candidate) => candidate.address);
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
 * Canonical libp2p implementation of PeerConnectionNetwork.connectPeer(). Resolver output is
 * attempted in order, with private direct addresses ignored, before one final
 * peer-id fallback. Candidate-local timeouts never masquerade as caller aborts.
 */
export async function connectLibp2pPeer(
  host: Libp2pConnectHost,
  peerId: NodeIdentity,
  resolvedAddresses: readonly Address[],
  options: Libp2pPeerConnectOpts = {},
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

  const candidates = planLibp2pPeerConnectionCandidates(
    canonicalPeerId,
    resolvedAddresses,
    options.configuredRelayTargets,
  );

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
    if (error instanceof Error && error.name === 'NoValidAddressesError') {
      if (lastCandidateError !== undefined) throw lastCandidateError;
      throw new PeerConnectionUnresolvedError(error.message, error);
    }
    if (error instanceof Error && lastCandidateError !== undefined && error.cause === undefined) {
      error.cause = lastCandidateError;
    }
    throw error;
  }
}
