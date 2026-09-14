import { resolveWithinAbort } from '@origintrail-official/dkg-core';
import { mapWithConcurrency } from '../map-with-concurrency.js';

/** Minimal Agent Registry profile needed to discover a dialable Core. */
export interface CorePeerDirectoryEntry {
  peerId: string;
  nodeRole?: string;
  agentAddress?: string;
  lastSeen?: string;
}

/** Chain evidence is kept explicit so callers cannot hide fail-open semantics in booleans. */
export type CoreMembershipEvidence =
  | 'member'
  | 'non-member'
  /** The adapter or legacy directory profile cannot supply membership evidence. */
  | 'unavailable'
  /** A configured membership read failed, so its result is unknown. */
  | 'indeterminate';

/** Named policies for the two deliberately different Core consumers. */
export type CoreMembershipPolicy = 'warm-compatible' | 'proof-required';

export function acceptsCoreMembership(
  evidence: CoreMembershipEvidence,
  policy: CoreMembershipPolicy,
): boolean {
  if (evidence === 'member') return true;
  return policy === 'warm-compatible' && evidence === 'unavailable';
}

/** Select every de-duplicated Core except this node, preserving input order. */
export function selectCoreAgents(
  agents: readonly CorePeerDirectoryEntry[],
  selfPeerId: string,
): CorePeerDirectoryEntry[] {
  const seen = new Set<string>();
  const out: CorePeerDirectoryEntry[] = [];
  for (const agent of agents) {
    if (agent.nodeRole !== 'core') continue;
    if (!agent.peerId || agent.peerId === selfPeerId) continue;
    if (seen.has(agent.peerId)) continue;
    seen.add(agent.peerId);
    out.push(agent);
  }
  return out;
}

/**
 * Discover a deterministic, bounded Core peer roster. Membership classification
 * and the unknown-evidence policy are required, so a proof caller cannot
 * accidentally accept a self-declared profile by omitting a nullable gate.
 */
export async function findCorePeerIds(options: {
  findAgents: (
    options: { signal?: AbortSignal; limit: number; nodeRole: 'core' },
  ) => Promise<readonly CorePeerDirectoryEntry[]>;
  selfPeerId: string;
  maxCandidates: number;
  eligibilityConcurrency: number;
  signal?: AbortSignal;
  classifyMembership: (
    agent: CorePeerDirectoryEntry,
    signal?: AbortSignal,
  ) => Promise<CoreMembershipEvidence>;
  /** Proves the directory wallet signed a binding to this exact libp2p peer. */
  authenticatePeerAddress: (
    agent: CorePeerDirectoryEntry,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  membershipPolicy: CoreMembershipPolicy;
  /**
   * Called for each Core the moment it has passed BOTH authentication and the
   * membership policy, in completion order. A caller that bounds this
   * discovery with its own deadline uses it to keep the peers already proven
   * when a later candidate never settles; the returned roster is unchanged.
   */
  onEligible?: (peerId: string) => void;
}): Promise<string[]> {
  if (!Number.isInteger(options.maxCandidates) || options.maxCandidates <= 0) {
    throw new TypeError('Core discovery maxCandidates must be a positive integer');
  }
  if (!Number.isInteger(options.eligibilityConcurrency)
    || options.eligibilityConcurrency <= 0) {
    throw new TypeError('Core discovery eligibilityConcurrency must be a positive integer');
  }
  const abortReason = () => options.signal?.reason
    ?? new DOMException('Core discovery aborted', 'AbortError');
  const awaitWithAbort = async <T>(start: (signal?: AbortSignal) => Promise<T>): Promise<T> => {
    const value = await resolveWithinAbort(start, options.signal);
    if (value === null) throw abortReason();
    return value;
  };
  const agents = await awaitWithAbort((signal) => options.findAgents({
    nodeRole: 'core',
    signal,
    limit: options.maxCandidates,
  }));
  const cores = selectCoreAgents(agents, options.selfPeerId);
  const classified = await mapWithConcurrency(
    cores.slice(0, options.maxCandidates),
    options.eligibilityConcurrency,
    async (agent) => {
      const authenticated = await awaitWithAbort((signal) =>
        options.authenticatePeerAddress(agent, signal));
      if (!authenticated) return { agent, authenticated: false as const };
      const evidence = await awaitWithAbort((signal) => options.classifyMembership(agent, signal));
      if (acceptsCoreMembership(evidence, options.membershipPolicy)) {
        options.onEligible?.(agent.peerId);
      }
      return { agent, authenticated: true as const, evidence };
    },
  );
  const eligible = classified
    .filter((candidate) => candidate.authenticated
      && acceptsCoreMembership(candidate.evidence, options.membershipPolicy))
    .map(({ agent }) => agent);
  if (options.signal?.aborted) {
    throw abortReason();
  }
  return eligible.map(({ peerId }) => peerId).sort();
}
