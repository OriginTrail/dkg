import type { AgentIdentity } from '../../../api.js';
import { canonicalAgentDid, normalizeAccessPolicy } from '../../../lib/contextGraphSidebar.js';

type OverviewRoleState = {
  label: string;
  title: string;
  tone: 'curator' | 'participant' | 'viewer' | 'unknown';
  /** Step on the role ladder (strongest → weakest). Drives the pill's
   *  weight and glyph; `tone` stays the coarse semantic group. */
  rank: OverviewRoleRank;
};
export type OverviewRoleRank = 'curator' | 'joined' | 'subscriber' | 'viewer' | 'not-joined' | 'unknown';
export type OverviewAgentStatus = 'loading' | 'ok' | 'error';
export type OverviewParticipantsStatus = 'loading' | 'ok' | 'error';
export type OverviewAgentIdentity = Pick<AgentIdentity, 'agentDid'> & Partial<Pick<AgentIdentity, 'agentAddress'>>;

export function overviewRoleState(
  cg: any,
  currentAgent: OverviewAgentIdentity | null,
  currentAgentStatus: OverviewAgentStatus,
  participants: string[],
  participantsStatus: OverviewParticipantsStatus,
): OverviewRoleState {
  const curator = typeof cg?.curator === 'string' ? cg.curator.trim() : '';
  // Codex review issue P — match the address-or-did predicate
  // `curatorStatusForOverview` uses (bug G), so the role pill and
  // the join-requests gate can't disagree on older daemons that
  // only surface `agentAddress`. `canonicalAgentDid` already
  // normalises bare EVM addresses to the prefixed DID form, so
  // any-of-the-two-matches resolves correctly.
  const agentIds = new Set(
    [currentAgent?.agentDid, currentAgent?.agentAddress]
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map(canonicalAgentDid),
  );
  const hasIdentity = agentIds.size > 0;
  if (curator && hasIdentity && agentIds.has(canonicalAgentDid(curator))) {
    return {
      label: 'Curator',
      title: 'This agent is the curator for this context graph.',
      tone: 'curator',
      rank: 'curator',
    };
  }
  if (cg?.callerInvolved === true) {
    if (curator && !hasIdentity && currentAgentStatus === 'loading') {
      return {
        label: 'Role checking',
        title: 'This agent is involved in this context graph; curator status is still loading.',
        tone: 'unknown',
        rank: 'unknown',
      };
    }
    if (curator && !hasIdentity && currentAgentStatus === 'error') {
      return {
        label: 'Role unknown',
        title: 'This agent is involved in this context graph, but curator status could not be confirmed.',
        tone: 'unknown',
        rank: 'unknown',
      };
    }
    return {
      label: 'Joined',
      title: 'This agent is involved in this context graph; curator status is shown only when identity metadata confirms it.',
      tone: 'participant',
      rank: 'joined',
    };
  }
  if (cg?.callerInvolved === false) {
    if (normalizeAccessPolicy(cg?.accessPolicy) === 'public') {
      return {
        label: cg.subscribed === true ? 'Public subscriber' : 'Public viewer',
        title: cg.subscribed === true
          ? 'This node subscribes to this public context graph. This agent is not listed as a curator or participant; public access is separate from membership.'
          : 'This context graph is public. This agent can browse it without being listed as a curator or participant; subscribe from Public context graphs to follow updates.',
        tone: 'viewer',
        rank: cg.subscribed === true ? 'subscriber' : 'viewer',
      };
    }
    return {
      label: 'Not joined',
      title: 'This agent is not listed as curator or participant for this context graph.',
      tone: 'viewer',
      rank: 'not-joined',
    };
  }
  const isListedParticipant = participantsStatus === 'ok' && participants
    .map(participant => participant.trim())
    .filter(Boolean)
    .some(participant => agentIds.has(canonicalAgentDid(participant)));
  if (isListedParticipant) {
    return {
      label: 'Joined',
      title: 'This agent is listed as a participant for this context graph.',
      tone: 'participant',
      rank: 'joined',
    };
  }
  return {
    label: 'Role unknown',
    title: 'The node did not provide enough role metadata for this context graph.',
    tone: 'unknown',
    rank: 'unknown',
  };
}

