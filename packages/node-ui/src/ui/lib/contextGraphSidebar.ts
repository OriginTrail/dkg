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
 * Browse/join catalogue. Two strict invariants:
 *
 *  1. ONLY graphs with `accessPolicy === 'public'`. Curated/private graphs and
 *     graphs with unknown policy never enter the Oracle, regardless of how
 *     they ended up in the local list (chain auto-subscribe, manual subscribe,
 *     dev script).
 *
 *  2. ONLY graphs the daemon has actually interacted with (`subscribed` OR
 *     `synced`). Without this filter the Oracle becomes a dumping ground for
 *     every CG the node has ever heard about via gossip — on a long-running
 *     testnet node that's hundreds of stale `*-smoke`, `*-test`, etc. entries
 *     whose curators are long gone. The filter narrows to entries where the
 *     daemon either holds an active subscription (so future gossip lands)
 *     or has at least one successful catchup on file (so the CG is known
 *     to actually exist on a reachable peer).
 *
 *     The Join Project modal does NOT compensate for an Oracle miss: it
 *     now requires a curator-supplied invite (cgId + curator peer id) so
 *     `/request-join` has somewhere to forward the signed delegation.
 *     Bare-cgId paste is rejected client-side (see `validateInvite`).
 *     A user who wants to join a public CG that hasn't surfaced here yet
 *     either waits for it to gossip from a subscribed peer, or asks the
 *     creator for an invite.
 *
 *  Older daemons that don't populate `synced` continue to work — `subscribed`
 *  alone gates the result, and brand-new nodes with no subscriptions just see
 *  an empty Oracle (rather than wading through historical noise from peers).
 */
export function belongsInContextOracleSidebar(cg: ContextGraph, identity: AgentSidebarIdentity | null): boolean {
  if (belongsInMyProjectsSidebar(cg, identity)) return false;
  if (normalizeAccessPolicy(cg.accessPolicy) !== 'public') return false;
  return cg.subscribed === true || cg.synced === true;
}
