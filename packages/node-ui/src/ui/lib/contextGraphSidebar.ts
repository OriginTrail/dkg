/**
 * Sidebar bucketing for context graphs — uses daemon `creator` (agent DID)
 * from GET /api/paranet/list, plus optional local overrides.
 */

import type { ContextGraph } from '../stores/projects.js';

export interface AgentSidebarIdentity {
  agentDid: string;
  /** Node libp2p peer id — daemon stores `DKG_CREATOR` as `did:dkg:agent:${peerId}`. */
  peerId?: string;
}

/**
 * Canonical `did:dkg:agent:…` for comparison.
 * Ethereum addresses normalise to lowercase; peer-id suffix is case-preserving (Base58/CID).
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

/** True when list `creator` is from another node/agent than the sidebar identity (same machine can share one peer DID on all locally created CGs). */
export function creatorIsAnotherAgent(cg: ContextGraph, identity: AgentSidebarIdentity): boolean {
  const cr = cg.creator?.trim();
  if (!cr) return false;
  const cNorm = canonicalAgentDid(cr);

  const walletNorm = canonicalAgentDid(identity.agentDid);
  if (cNorm === walletNorm) return false;

  if (identity.peerId) {
    const peerNorm = canonicalAgentDid(`did:dkg:agent:${identity.peerId}`);
    if (cNorm === peerNorm) return false;
  }

  return true;
}

/**
 * Projects listed under Context Oracle: another agent's creator, manual
 * "sent to oracle", not undone by force-my override.
 */
export function belongsInContextOracle(
  cg: ContextGraph,
  identity: AgentSidebarIdentity | null,
  manualOracleIds: Set<string>,
  forceMyIds: Set<string>,
): boolean {
  if (forceMyIds.has(cg.id)) return false;
  if (manualOracleIds.has(cg.id)) return true;
  if (!identity) return false;
  return creatorIsAnotherAgent(cg, identity);
}
