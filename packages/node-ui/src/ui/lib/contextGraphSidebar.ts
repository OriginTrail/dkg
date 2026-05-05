/**
 * Sidebar bucketing for context graphs using daemon list fields:
 * `callerInvolved` (agent-scoped curator/participant), `accessPolicy`, and legacy fallbacks.
 *
 * Node-level `subscribed` is not "my project" — subscription is sync plumbing, not membership.
 */

import type { ContextGraph } from '../stores/projects.js';

export interface AgentSidebarIdentity {
  agentDid: string;
  /** Node libp2p peer id — matches `DKG_CREATOR` when curator is not yet listed. */
  peerId?: string;
}

function normalizeAccessPolicy(raw?: string): 'public' | 'private' | 'unknown' {
  if (!raw?.trim()) return 'unknown';
  const t = raw.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (t === 'private') return 'private';
  if (t === 'public') return 'public';
  return 'unknown';
}

/**
 * Canonical `did:dkg:agent:…` for comparison.
 * Ethereum addresses normalise to lowercase; non-EVM suffix is case-preserving.
 */
export function canonicalAgentDid(did: string): string {
  let t = did.trim().replace(/^["']|["']$/g, '');
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
  const PREFIX = 'did:dkg:agent:';
  if (t.length >= PREFIX.length && t.slice(0, PREFIX.length).toLowerCase() === PREFIX.toLowerCase()) {
    const rest = t.slice(PREFIX.length);
    const evm = /^(0x[a-fA-F0-9]{40})$/i.exec(rest);
    if (evm) return `${PREFIX}${evm[1].toLowerCase()}`;
    return `${PREFIX}${rest}`;
  }
  return t.toLowerCase();
}

/** Bearer agent is curator or explicitly allowlisted participant (`callerInvolved` from daemon). */
export function belongsInMyProjectsSidebar(cg: ContextGraph, identity: AgentSidebarIdentity | null): boolean {
  if (cg.callerInvolved === true) return true;
  if (cg.callerInvolved === false) return false;
  // Older daemons without `callerInvolved`: curator match only (no subscribed / creator heuristic).
  if (!identity?.agentDid?.trim()) return false;
  if (cg.curator?.trim() && canonicalAgentDid(cg.curator) === canonicalAgentDid(identity.agentDid)) {
    return true;
  }
  return false;
}

/**
 * Browse/join catalogue. Strict invariant: ONLY graphs with `accessPolicy === 'public'`.
 * Curated/private graphs and graphs with unknown policy never enter the Oracle, regardless
 * of how they ended up in the local list (chain auto-subscribe, manual subscribe, dev script).
 */
export function belongsInContextOracleSidebar(cg: ContextGraph, identity: AgentSidebarIdentity | null): boolean {
  if (belongsInMyProjectsSidebar(cg, identity)) return false;
  return normalizeAccessPolicy(cg.accessPolicy) === 'public';
}
