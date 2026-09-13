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
    options: { signal?: AbortSignal; limit: number },
  ) => Promise<readonly CorePeerDirectoryEntry[]>;
  selfPeerId: string;
  maxCandidates: number;
  eligibilityConcurrency: number;
  signal?: AbortSignal;
  classifyMembership: (
    agent: CorePeerDirectoryEntry,
    signal?: AbortSignal,
  ) => Promise<CoreMembershipEvidence>;
  membershipPolicy: CoreMembershipPolicy;
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
  const awaitWithAbort = async <T>(start: () => Promise<T>): Promise<T> => {
    const signal = options.signal;
    if (signal?.aborted) throw abortReason();
    const pending = start();
    if (!signal) return pending;
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const onAbort = () => {
        cleanup();
        reject(abortReason());
      };
      pending.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
      signal.addEventListener('abort', onAbort, { once: true });
      // Covers an injected operation that synchronously aborts before it
      // returns its promise and before the listener above can be installed.
      if (signal.aborted) onAbort();
    });
  };
  const agents = await awaitWithAbort(() => options.findAgents({
    signal: options.signal,
    limit: options.maxCandidates,
  }));
  const cores = selectCoreAgents(agents, options.selfPeerId);
  const classified = await mapWithConcurrency(
    cores.slice(0, options.maxCandidates),
    options.eligibilityConcurrency,
    async (agent) => ({
      agent,
      evidence: await awaitWithAbort(() => options.classifyMembership(agent, options.signal)),
    }),
  );
  const eligible = classified
    .filter(({ evidence }) => acceptsCoreMembership(evidence, options.membershipPolicy))
    .map(({ agent }) => agent);
  if (options.signal?.aborted) {
    throw abortReason();
  }
  return eligible.map(({ peerId }) => peerId).sort();
}
