import {
  findCorePeerIds,
  type CoreMembershipEvidence,
  type CorePeerDirectoryEntry,
} from '../../p2p/core-peer-discovery.js';
import type { RandomSamplingPeerPreparation } from './random-sampling-exact-repair.js';

/** Curator resolution surface the proof-time source consumes, narrowed to peer IDs. */
export interface RandomSamplingCuratorResolution {
  readonly peerIds: readonly string[];
}

/**
 * Typed candidate resolution. Every source is kept separately so the same value
 * both drives the traversal (`candidatePeerIds`) and certifies *why* a peer was
 * eligible, without a caller re-deriving either from the other.
 */
export interface RandomSamplingCandidateLedger {
  readonly localContextGraphId: string;
  readonly curatorPeerIds: readonly string[];
  readonly observedPeerIds: readonly string[];
  readonly preferredPeerId: string | null;
  readonly connectedPeerIds: readonly string[];
  readonly corePeerIds: readonly string[];
  /** De-duplicated union in source priority order, with this node removed. */
  readonly candidatePeerIds: readonly string[];
}

/**
 * Narrow ports for the proof-time Random Sampling peer source. Each one is a
 * single capability the agent already owns (graph curators, the Agent Registry,
 * chain membership, admission, connection readiness), so the policy below is
 * testable without a lifecycle instance.
 *
 * There is deliberately no Core membership-policy port: this module represents
 * proof-time discovery only, where chain membership is an invariant rather than
 * a caller's choice. The legacy fail-open `warm-compatible` mode stays with the
 * warm-core path that owns it.
 */
export interface RandomSamplingPeerSourcePorts {
  readonly selfPeerId: string;
  /** Bound on both the curator roster and the discovered Core roster. */
  readonly maxRosterPeerIds: number;
  readonly coreEligibilityConcurrency: number;
  /**
   * Wall-clock ceiling on the whole Core fallback lane — registry query plus
   * every authentication and membership read. See
   * {@link RANDOM_SAMPLING_CORE_DISCOVERY_BUDGET_MS}.
   */
  readonly coreDiscoveryBudgetMs: number;
  /** False once the owning agent has stopped, independently of the signal. */
  isStarted(): boolean;
  resolveCuratorPeerIds(
    localContextGraphId: string,
    options: {
      readonly maxPeerIds: number;
      readonly signal: AbortSignal;
      readonly isCurrent: () => boolean;
    },
  ): Promise<RandomSamplingCuratorResolution>;
  findCoreAgents(options: {
    readonly signal?: AbortSignal;
    readonly limit: number;
    readonly nodeRole: 'core';
  }): Promise<readonly CorePeerDirectoryEntry[]>;
  /** Proves the directory wallet signed a binding to this exact libp2p peer. */
  authenticateCorePeerAddress(
    agent: CorePeerDirectoryEntry,
    signal?: AbortSignal,
  ): Promise<boolean>;
  classifyCoreMembership(
    agent: CorePeerDirectoryEntry,
    signal?: AbortSignal,
  ): Promise<CoreMembershipEvidence>;
  observedCandidatePeerIds(localContextGraphId: string): readonly string[];
  preferredPeerId(localContextGraphId: string): string | undefined;
  connectedPeerIds(): readonly string[];
  ensurePeerAdmitted(peerId: string, signal: AbortSignal): Promise<boolean>;
  ensurePeerConnected(peerId: string, signal: AbortSignal): Promise<void>;
  hasSyncProtocol(peerId: string, signal: AbortSignal): Promise<boolean>;
  logInfo(message: string): void;
}

/**
 * Ceiling on the optional Core fallback lane, one sixth of the 90 s challenge
 * deadline `startRandomSamplingExactRepair` applies by default.
 *
 * Core discovery is a fallback: it widens the roster, it never decides whether
 * the repair can succeed. A stale directory row whose authentication never
 * settles must therefore not be able to spend the deadline that the already
 * known graph-specific providers need, so the lane is abandoned at this bound
 * and the repair proceeds with whatever it has.
 */
export const RANDOM_SAMPLING_CORE_DISCOVERY_BUDGET_MS = 15_000;

/** The lifecycle stopped between discovery and selection; surface it as an abort. */
function noLongerCurrentError(localContextGraphId: string): Error {
  const error = new Error(
    `Random Sampling provider discovery for ${localContextGraphId} is no longer current`,
  );
  error.name = 'AbortError';
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Discover the broad Core fallback roster under its own deadline.
 *
 * The budget is the lane's only exit other than success: an authentication or
 * membership read that never settles is abandoned when it expires, so this
 * fallback can never hold back the graph-specific providers resolved beside it.
 * Cancellation of the repair itself is re-thrown, never degraded to an empty
 * roster, and wallet-binding plus chain-membership remain required for every
 * peer that does make it through.
 */
async function discoverBoundedCoreRoster(
  ports: RandomSamplingPeerSourcePorts,
  localContextGraphId: string,
  signal: AbortSignal,
): Promise<readonly string[]> {
  const budget = new AbortController();
  const budgetTimer = setTimeout(() => budget.abort(), ports.coreDiscoveryBudgetMs);
  try {
    return await findCorePeerIds({
      findAgents: (options) => ports.findCoreAgents(options),
      selfPeerId: ports.selfPeerId,
      maxCandidates: ports.maxRosterPeerIds,
      eligibilityConcurrency: ports.coreEligibilityConcurrency,
      signal: AbortSignal.any([signal, budget.signal]),
      authenticatePeerAddress: (agent, candidateSignal) =>
        ports.authenticateCorePeerAddress(agent, candidateSignal),
      // The broad proof-time fallback must be chain-scoped. Profiles without an
      // operational address or a positive membership read do not consume the
      // challenge deadline merely by claiming a Core role in the local Agent
      // Registry graph.
      classifyMembership: (agent, candidateSignal) =>
        ports.classifyCoreMembership(agent, candidateSignal),
      membershipPolicy: 'proof-required',
    });
  } catch (error: unknown) {
    if (signal.aborted) throw signal.reason ?? error;
    ports.logInfo(budget.signal.aborted
      ? 'Random Sampling Core-roster discovery exceeded its '
        + `${ports.coreDiscoveryBudgetMs}ms budget for ${localContextGraphId}; `
        + 'continuing with graph-specific providers'
      : `Random Sampling Core-roster discovery failed for ${localContextGraphId}: `
        + errorMessage(error));
    return [];
  } finally {
    clearTimeout(budgetTimer);
  }
}

/**
 * Resolve the proof-time candidate roster.
 *
 * Graph-specific curator discovery and the broad Agent Registry Core roster are
 * independent, so they run concurrently; either may fail without losing the
 * other, and the Core lane carries its own budget so it can never outlast them.
 * Cancellation is never swallowed — an aborted signal re-throws its own reason
 * instead of degrading to an empty source.
 */
export async function resolveRandomSamplingCandidatePeers(
  ports: RandomSamplingPeerSourcePorts,
  localContextGraphId: string,
  signal: AbortSignal,
): Promise<RandomSamplingCandidateLedger> {
  const isCurrent = () => ports.isStarted() && !signal.aborted;
  const [curatorResolution, corePeerIds] = await Promise.all([
    ports.resolveCuratorPeerIds(localContextGraphId, {
      maxPeerIds: ports.maxRosterPeerIds,
      signal,
      isCurrent,
    }).catch((error: unknown) => {
      if (signal.aborted) throw signal.reason ?? error;
      return { peerIds: [] as readonly string[] };
    }),
    discoverBoundedCoreRoster(ports, localContextGraphId, signal),
  ]);
  if (!isCurrent()) {
    throw signal.reason ?? noLongerCurrentError(localContextGraphId);
  }
  const observedPeerIds = ports.observedCandidatePeerIds(localContextGraphId);
  const connectedPeerIds = ports.connectedPeerIds();
  const preferredPeerId = ports.preferredPeerId(localContextGraphId);
  // Graph-specific providers stay ahead of the broad Core fallback roster.
  const candidatePeerIds = [...new Set([
    ...curatorResolution.peerIds,
    ...observedPeerIds,
    preferredPeerId,
    ...connectedPeerIds,
    ...corePeerIds,
  ].filter((peerId): peerId is string => Boolean(
    peerId && peerId !== ports.selfPeerId,
  )))];
  return {
    localContextGraphId,
    curatorPeerIds: curatorResolution.peerIds,
    observedPeerIds,
    preferredPeerId: preferredPeerId ?? null,
    connectedPeerIds,
    corePeerIds,
    candidatePeerIds,
  };
}

/**
 * Admission, connection and sync-protocol readiness for one candidate.
 * A declined admission and a missing sync protocol are expected peer outcomes,
 * so they are reported as skips rather than as traversal failures.
 */
export async function prepareRandomSamplingPeer(
  ports: RandomSamplingPeerSourcePorts,
  peerId: string,
  signal: AbortSignal,
): Promise<RandomSamplingPeerPreparation> {
  if (!(await ports.ensurePeerAdmitted(peerId, signal))) {
    return { kind: 'skipped', reason: 'not-admitted' };
  }
  await ports.ensurePeerConnected(peerId, signal);
  if (!(await ports.hasSyncProtocol(peerId, signal))) {
    return { kind: 'skipped', reason: 'sync-protocol-unavailable' };
  }
  return { kind: 'ready' };
}

/** Diagnostic-only ledger line; it names sources, never private content. */
export function renderRandomSamplingCandidateLedger(
  ledger: RandomSamplingCandidateLedger,
): string {
  return `[rs.tick.kc-repair-candidates] ${JSON.stringify(ledger)}`;
}

export interface RandomSamplingPeerSource {
  resolveCandidatePeerIds(
    localContextGraphId: string,
    signal: AbortSignal,
  ): Promise<readonly string[]>;
  preparePeer(peerId: string, signal: AbortSignal): Promise<RandomSamplingPeerPreparation>;
}

/**
 * Bind the peer-source policy to one agent's ports. The result plugs straight
 * into the exact-repair dependencies, so the lifecycle only supplies ports.
 */
export function createRandomSamplingPeerSource(
  ports: RandomSamplingPeerSourcePorts,
): RandomSamplingPeerSource {
  return {
    resolveCandidatePeerIds: async (localContextGraphId, signal) => {
      const ledger = await resolveRandomSamplingCandidatePeers(
        ports,
        localContextGraphId,
        signal,
      );
      // This diagnostic-only ledger lets a managed black-box fixture prove why
      // a later Core was eligible without exposing any private content.
      ports.logInfo(renderRandomSamplingCandidateLedger(ledger));
      return ledger.candidatePeerIds;
    },
    preparePeer: (peerId, signal) => prepareRandomSamplingPeer(ports, peerId, signal),
  };
}
