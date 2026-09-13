/** Minimal Agent Registry profile needed to discover a dialable Core. */
export interface CorePeerDirectoryEntry {
  peerId: string;
  nodeRole?: string;
  agentAddress?: string;
  lastSeen?: string;
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
 * Discover a deterministic Core peer roster. Proof-critical callers supply
 * `isEligibleCore` so a self-declared profile cannot enter the fallback roster
 * without a current ShardingTable membership proof.
 */
export async function findCorePeerIds(options: {
  findAgents: (
    options?: { signal?: AbortSignal },
  ) => Promise<readonly CorePeerDirectoryEntry[]>;
  selfPeerId: string;
  signal?: AbortSignal;
  isEligibleCore?: (agent: CorePeerDirectoryEntry) => Promise<boolean>;
}): Promise<string[]> {
  const agents = await options.findAgents({ signal: options.signal });
  const cores = selectCoreAgents(agents, options.selfPeerId);
  const eligible = options.isEligibleCore
    ? (await Promise.all(cores.map(async (agent) => ({
        agent,
        eligible: await options.isEligibleCore!(agent),
      })))).filter(({ eligible: accepted }) => accepted).map(({ agent }) => agent)
    : cores;
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException('Core discovery aborted', 'AbortError');
  }
  return eligible.map(({ peerId }) => peerId).sort();
}
