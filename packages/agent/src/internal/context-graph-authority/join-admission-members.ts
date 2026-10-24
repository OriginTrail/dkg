// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';

import type { RegisteredContextGraphAuthority } from '../../registered-context-graph-authority.js';

/** The member-list fields of the graph's own `_meta`. */
interface OwnMemberListFacts {
  readonly allowedAgents: readonly string[];
  readonly participantAgents: readonly string[];
  readonly revokedAgents: readonly string[];
}

/** What a curator's join admission reads of the agent for its member roster. */
interface JoinAdmissionMembersAgent {
  readonly contextGraphMetaProjection: {
    readContextGraphAuthorityFactsRevision(contextGraphId: string): string;
  };
  getMemberRecoveryRosterSource(contextGraphId: string): Promise<string[] | null>;
  getOwnCgMetaFacts(contextGraphId: string): Promise<OwnMemberListFacts>;
  resolveSwmRegisteredAuthority(contextGraphId: string): Promise<RegisteredContextGraphAuthority>;
}

/** The allowed and participant agents of the graph's own `_meta`, revoked ones left out. */
function ownMembers(facts: OwnMemberListFacts): string[] | null {
  if (facts.allowedAgents.length === 0 && facts.participantAgents.length === 0) return null;
  const revoked = new Set(facts.revokedAgents.map((agent) => agent.toLowerCase()));
  const members = new Map<string, string>();
  for (const agent of [...facts.allowedAgents, ...facts.participantAgents]) {
    if (!ethers.isAddress(agent)) continue;
    const key = agent.toLowerCase();
    if (!revoked.has(key) && !members.has(key)) members.set(key, ethers.getAddress(agent));
  }
  return [...members.values()];
}

/**
 * The agents a curator's join admission treats as members already (#3421).
 *
 * Private and unregistered graphs keep the member recovery roster: the
 * finalized chain participants, or the store-backed metadata members. That
 * roster is empty for a public graph registered on chain, whose chain record
 * names no participants, so a repeated request of an admitted member was taken
 * for a new one and waited for the approver again. The members of a registered
 * public graph are the curator's own list: the graph's own `_meta` only, read
 * under the authority-facts fence the unregistered roster uses. The member
 * recovery roster itself is unchanged.
 */
export async function joinAdmissionActiveMembers(
  agentObject: object,
  contextGraphId: string,
): Promise<string[] | null> {
  const agent = agentObject as JoinAdmissionMembersAgent;
  const roster = await agent.getMemberRecoveryRosterSource(contextGraphId);
  if (roster !== null) return roster;
  if ((await agent.resolveSwmRegisteredAuthority(contextGraphId)).kind !== 'public') return null;
  const projection = agent.contextGraphMetaProjection;
  const revision = projection.readContextGraphAuthorityFactsRevision(contextGraphId);
  const members = ownMembers(await agent.getOwnCgMetaFacts(contextGraphId));
  // An authority fact written during the read invalidates it; admission retries.
  return projection.readContextGraphAuthorityFactsRevision(contextGraphId) === revision ? members : null;
}
