/**
 * Sidebar bucketing for context graphs using daemon list fields:
 * `subscribed`, `curator` (wallet DID), `accessPolicy`, and `creator` (peer DID fallback).
 *
 * No localStorage — identity and published policy only.
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

/** This node/agent is materially involved as participant (sync subscription) or curator (wallet DID). */
export function belongsInMyProjectsSidebar(cg: ContextGraph, identity: AgentSidebarIdentity | null): boolean {
  if (cg.subscribed === true) return true;
  if (!identity?.agentDid?.trim()) return false;
  if (cg.curator?.trim()) {
    if (canonicalAgentDid(cg.curator) === canonicalAgentDid(identity.agentDid)) return true;
  }
  const cr = cg.creator?.trim();
  if (cr && identity.peerId) {
    const peerCreator = canonicalAgentDid(`did:dkg:agent:${identity.peerId}`);
    if (canonicalAgentDid(cr) === peerCreator) return true;
  }
  return false;
}

/**
 * Browse/join catalogue: explicitly non-private discovery entries this node does not actively sync,
 * excluding projects already classified under "mine".
 */
export function belongsInContextOracleSidebar(cg: ContextGraph, identity: AgentSidebarIdentity | null): boolean {
  if (belongsInMyProjectsSidebar(cg, identity)) return false;
  const ap = normalizeAccessPolicy(cg.accessPolicy);
  if (ap === 'private') return false;
  return true;
}
