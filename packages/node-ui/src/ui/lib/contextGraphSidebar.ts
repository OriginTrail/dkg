/**
 * Sidebar bucketing for context graphs using daemon list fields:
 * `callerInvolved` (agent-scoped curator/participant), `accessPolicy`, and legacy fallbacks.
 *
 * Node-level `subscribed` is not "my project" — subscription is sync plumbing, not membership.
 */

import { canonicalContextGraphAgentDid, contextGraphBelongsToAgent } from '@origintrail-official/dkg-core/dist/context-graph-membership.js';

import type { ContextGraph } from '../stores/projects.js';

export interface AgentSidebarIdentity {
  agentDid: string;
  /** Node libp2p peer id — matches `DKG_CREATOR` when curator is not yet listed. */
  peerId?: string;
}

/**
 * Narrow the full agent identity to the fields the sidebar predicates need.
 * Structural param (not `api.AgentIdentity`) so this shared lib stays
 * decoupled from the api layer; both panels pass an object that satisfies it.
 */
export function toSidebarIdentity(a: { agentDid: string; peerId?: string }): AgentSidebarIdentity {
  return { agentDid: a.agentDid, peerId: a.peerId };
}

export function normalizeAccessPolicy(raw?: string): 'public' | 'private' | 'unknown' {
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
export const canonicalAgentDid = canonicalContextGraphAgentDid;

/** Bearer agent is curator or explicitly allowlisted participant. */
export function belongsInMyProjectsSidebar(cg: ContextGraph, identity: AgentSidebarIdentity | null): boolean {
  return contextGraphBelongsToAgent(cg, identity?.agentDid);
}

/**
 * Projects offered by the chat composer's project picker: the agent's
 * "My projects" *membership* set (same predicate as the sidebar), with
 * one coherence rule — if `activeProjectId` is set but isn't a member
 * project, it is still surfaced (prepended) so the picker shows the
 * true active target instead of silently falling back to the
 * placeholder. The local "hidden from sidebar" dismissal is
 * deliberately NOT applied here.
 */
export function computeSelectableProjects(
  available: ContextGraph[],
  identity: AgentSidebarIdentity | null,
  activeProjectId: string | null,
): ContextGraph[] {
  const mine = available.filter((cg) => belongsInMyProjectsSidebar(cg, identity));
  if (activeProjectId && !mine.some((cg) => cg.id === activeProjectId)) {
    const active = available.find((cg) => cg.id === activeProjectId);
    if (active) return [active, ...mine];
  }
  return mine;
}

/**
 * Browse/join catalogue. Two strict invariants:
 *
 *  1. ONLY graphs with `accessPolicy === 'public'`. Curated/private graphs and
 *     graphs with unknown policy never appear there, regardless of how
 *     they ended up in the local list (chain auto-subscribe, manual subscribe,
 *     dev script).
 *
 *  2. Discovery is catalogue state, not membership. An explicitly-public
 *     graph belongs here before subscription or catch-up so users can browse
 *     it and opt in without asking a curator for an unnecessary invitation.
 */
export function belongsInPublicSidebar(cg: ContextGraph, identity: AgentSidebarIdentity | null): boolean {
  if (belongsInMyProjectsSidebar(cg, identity)) return false;
  if (normalizeAccessPolicy(cg.accessPolicy) !== 'public') return false;
  return true;
}

export type PublicEntryKind = 'catalogue' | 'project';

/** Passive discoveries need explicit Browse/Subscribe actions, not project-row semantics. */
export function classifyPublicEntry(cg: ContextGraph): PublicEntryKind {
  return cg.subscribed === true || cg.synced === true ? 'project' : 'catalogue';
}

/** A graph the agent is only browsing from the catalogue: not involved, not
 *  subscribed, not synced. Viewing it must not make it the chat and
 *  attachment target (sidebar Browse clears the target). Daemons that don't
 *  report `callerInvolved` aren't classified, so their graphs stay working. */
export function isPassiveCatalogueGraph(cg: ContextGraph): boolean {
  return cg.callerInvolved === false && classifyPublicEntry(cg) === 'catalogue';
}
