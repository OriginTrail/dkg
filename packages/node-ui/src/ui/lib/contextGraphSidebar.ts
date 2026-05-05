/**
 * Sidebar bucketing for context graphs — uses daemon `creator` (agent DID)
 * from GET /api/paranet/list, plus optional local overrides.
 */

import type { ContextGraph } from '../stores/projects.js';

export interface AgentSidebarIdentity {
  agentDid: string;
}

/** Canonical form for DID comparison (`did:dkg:agent:0x...` lowercased). */
export function canonicalAgentDid(did: string): string {
  let t = did.trim().replace(/^["']|["']$/g, '');
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
  const m = /^did:dkg:agent:(0x[a-fA-F0-9]{40})$/i.exec(t);
  if (m) return `did:dkg:agent:${m[1].toLowerCase()}`;
  return t.toLowerCase();
}

/** Creator field from list payload is normally an agent DID. */
export function creatorIsAnotherAgent(cg: ContextGraph, identity: AgentSidebarIdentity): boolean {
  const cr = cg.creator?.trim();
  if (!cr) return false;
  return canonicalAgentDid(cr) !== canonicalAgentDid(identity.agentDid);
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
