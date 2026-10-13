import { peerIdFromString } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import { multiaddr, type Component, type Multiaddr } from '@multiformats/multiaddr';
import { isPublicLikeAddress, isUnspecifiedAddress } from './address-policy.js';
import type { Address, NodeIdentity, PeerConnectOpts, PeerRecoveryStageOpts } from './network.js';
import { PeerConnectionUnresolvedError } from './network.js';
import { canonicalPeerIdString, type CanonicalPeerId } from './peer-id.js';
import type { ConfiguredRelayTarget } from './relay-target.js';
import { startRequestAbortLifecycle } from '../request-abort-lifecycle.js';
import { resolveWithinAbort } from '../abort-boundary.js';

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
/**
 * Time for the walk through this node's own relays, in candidate timeouts.
 * The walk used to stop after this many relays. A relay the target holds no
 * reservation on answers in one round trip, so the same time now covers every
 * relay of a long list, while a node that is cut off (each relay runs to its
 * timeout) gives up when it did before.
 */
const RELAY_FALLBACK_BUDGET_IN_CANDIDATE_TIMEOUTS = 4;

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end--;
  return end === value.length ? value : value.slice(0, end);
}

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

export function parseLibp2pConnectCandidate(
  raw: string,
  options: { requireTerminalTargetPeerId?: boolean } = {},
): Libp2pConnectCandidate {
  const parsed = multiaddr(raw);
  const components = parsed.getComponents();
  if (options.requireTerminalTargetPeerId && components.at(-1)?.name !== 'p2p') {
    throw new Libp2pConnectCandidateParseError('Multiaddr must end with a target peer id');
  }
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
 * direct route survives, append a circuit through each of the operator's
 * configured relays, after the resolver's candidates: relays this node is
 * connected to first, then the others, each group in configured order. The
 * target holds reservations on a few of the configured relays only, and which
 * ones is its own choice, so a short prefix of a long relay list can miss all
 * of them. `relayFallbackFrom` is the index of the first appended circuit; the
 * caller bounds the time spent from there on.
 */
function planLibp2pPeerConnectionCandidates(
  peerId: NodeIdentity,
  resolvedAddresses: readonly Address[],
  configuredRelayTargets: readonly ConfiguredRelayTarget[] = [],
  allowResolvedPrivateDirect = false,
  connectedPeerIds: ReadonlySet<string> = new Set(),
): { candidates: Libp2pConnectCandidate[]; relayFallbackFrom: number } {
  const canonicalPeerId = peerIdFromString(peerId).toString();
  const planned: Libp2pConnectCandidate[] = [];
  const seen = new Set<string>();
  let hasPublicDirect = false;

  const appendCandidate = (rawAddress: Address): Libp2pConnectCandidate | undefined => {
    try {
      let candidate = parseLibp2pConnectCandidate(rawAddress);
      if (
        candidate.targetPeerId !== undefined
        && candidate.targetPeerId !== canonicalPeerId
      ) return undefined;
      if (candidate.kind === 'direct' && !isPublicLikeAddress(candidate.address)) {
        if (!allowResolvedPrivateDirect) return undefined;
        // Resolver results are keyed to the requested peer when written to the
        // peer store, but libp2p routing commonly returns targetless private
        // listeners. Bind those listeners before dialing so identity remains
        // explicit without discarding the newly resolved route.
        const boundAddress = candidate.targetPeerId === undefined
          ? `${candidate.address}/p2p/${canonicalPeerId}`
          : candidate.address;
        const bound = parseLibp2pConnectCandidate(boundAddress, {
          requireTerminalTargetPeerId: true,
        });
        if (bound.kind !== 'direct' || bound.targetPeerId !== canonicalPeerId) return undefined;
        if (isUnspecifiedAddress(bound.address)) return undefined;
        candidate = bound;
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
    if (candidate?.kind === 'direct' && isPublicLikeAddress(candidate.address)) {
      hasPublicDirect = true;
    }
  }

  const relayFallbackFrom = planned.length;
  if (hasPublicDirect) return { candidates: planned, relayFallbackFrom };

  const isConnected = (target: ConfiguredRelayTarget): boolean => connectedPeerIds.has(target.peerId);
  for (const target of [
    ...configuredRelayTargets.filter(isConnected),
    ...configuredRelayTargets.filter((relayTarget) => !isConnected(relayTarget)),
  ]) {
    if (target.peerId === canonicalPeerId) continue;
    const rawRelay = target.addresses.find(
      (address) => !address.includes('/p2p-circuit') && isPublicLikeAddress(address),
    );
    const relay = rawRelay === undefined ? undefined : trimTrailingSlashes(rawRelay);
    if (!relay) continue;
    appendCandidate(`${relay}/p2p-circuit/p2p/${canonicalPeerId}`);
  }

  return { candidates: planned, relayFallbackFrom };
}

/** Public address projection retained for callers that only need route planning. */
export function planLibp2pPeerConnectionAddresses(
  peerId: NodeIdentity,
  resolvedAddresses: readonly Address[],
  configuredRelayTargets: readonly ConfiguredRelayTarget[] = [],
  connectedPeerIds?: ReadonlySet<string>,
): Address[] {
  return planLibp2pPeerConnectionCandidates(
    peerId,
    resolvedAddresses,
    configuredRelayTargets,
    false,
    connectedPeerIds,
  ).candidates.map((candidate) => candidate.address);
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

/** Transport-owned recovery dial. The resolver owns stage order and deadlines. */
export async function tryConnectLibp2pRecoveryStage(
  host: Libp2pConnectHost,
  peerId: NodeIdentity,
  stage: PeerRecoveryStageOpts,
): Promise<boolean> {
  throwIfAborted(stage.signal);
  const canonicalPeerId = peerIdFromString(peerId).toString();
  const isConnected = (): boolean => host.getConnections().some(
    (connection) => connection.remotePeer.toString() === canonicalPeerId,
  );
  if (isConnected()) return true;

  if (stage.kind === 'hint') {
    if (!stage.address) return false;
    const candidate = parseLibp2pConnectCandidate(stage.address, {
      requireTerminalTargetPeerId: true,
    });
    // A recovery hint may be private, but must bind to the exact requested peer.
    if (candidate.targetPeerId !== canonicalPeerId) return false;
    await connectLibp2pCandidate(host, candidate, {
      expectedPeerId: canonicalPeerId,
      signal: stage.signal,
      timeoutMs: stage.timeoutMs,
      log: stage.log,
    });
    return isConnected();
  }

  const lifecycle = startRequestAbortLifecycle(stage.timeoutMs, [stage.signal]);
  try {
    await host.dial(peerIdFromString(canonicalPeerId), { signal: lifecycle.signal });
    if (lifecycle.signal.aborted) throw lifecycle.signal.reason;
    throwIfAborted(stage.signal);
    return isConnected();
  } finally {
    lifecycle.release();
  }
}

/**
 * Canonical libp2p implementation of PeerConnectionNetwork.connectPeer(). Resolver output is
 * attempted in order, with private direct addresses normally left in the peer
 * store, before one final peer-id fallback. Recovery can explicitly try newly
 * resolved peer-bound private routes before configured relays. The circuits
 * through this node's own relays share one time budget. Candidate-local
 * timeouts never masquerade as caller aborts.
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

  const { candidates, relayFallbackFrom } = planLibp2pPeerConnectionCandidates(
    canonicalPeerId,
    resolvedAddresses,
    options.configuredRelayTargets,
    options.allowResolvedPrivateDirect,
    new Set(host.getConnections().map((connection) => connection.remotePeer.toString())),
  );

  const candidateTimeoutMs = options.candidateTimeoutMs ?? DEFAULT_CANDIDATE_TIMEOUT_MS;
  let relayFallbackBudgetMs = RELAY_FALLBACK_BUDGET_IN_CANDIDATE_TIMEOUTS * candidateTimeoutMs;
  let lastCandidateError: unknown;
  for (const [index, candidate] of candidates.entries()) {
    throwIfAborted(options.signal);
    const relayFallback = index >= relayFallbackFrom;
    if (relayFallback && relayFallbackBudgetMs <= 0) break;
    const startedAt = Date.now();
    try {
      await connectLibp2pCandidate(host, candidate, {
        expectedPeerId: canonicalPeerId,
        signal: options.signal,
        timeoutMs: relayFallback
          ? Math.min(candidateTimeoutMs, relayFallbackBudgetMs)
          : options.candidateTimeoutMs,
        log: options.log,
      });
      return;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastCandidateError = error;
      if (relayFallback) relayFallbackBudgetMs -= Date.now() - startedAt;
    }
  }

  throwIfAborted(options.signal);
  if (options.skipIdentityFallback) {
    if (lastCandidateError !== undefined) throw lastCandidateError;
    throw new PeerConnectionUnresolvedError();
  }
  // A supplied signal disables libp2p's own dial/DHT timeout. Own a local
  // deadline even for a long-lived caller, and settle our wait if a transport
  // ignores cancellation. A late lookup never authorizes a timed-out request.
  const fallback = startRequestAbortLifecycle(
    options.candidateTimeoutMs ?? DEFAULT_CANDIDATE_TIMEOUT_MS, [options.signal],
  );
  try {
    await resolveWithinAbort(
      signal => host.dial(peerIdFromString(canonicalPeerId), { signal }),
      fallback.signal,
    );
    fallback.signal.throwIfAborted();
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
  } finally {
    fallback.release();
  }
}
