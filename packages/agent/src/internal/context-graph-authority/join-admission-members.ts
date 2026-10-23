// SPDX-License-Identifier: Apache-2.0

import type { RegisteredContextGraphAuthority } from '../../registered-context-graph-authority.js';

/** What a curator's join admission reads of the agent for its member roster. */
interface JoinAdmissionMembersAgent {
  readonly contextGraphMetaProjection: {
    readContextGraphAuthorityFactsRevision(contextGraphId: string): string;
  };
  getMemberRecoveryRosterSource(contextGraphId: string): Promise<string[] | null>;
  getLocalMetadataMemberRecoveryGate(contextGraphId: string): Promise<string[] | null>;
  resolveSwmRegisteredAuthority(contextGraphId: string): Promise<RegisteredContextGraphAuthority>;
}

/**
 * The agents a curator's join admission treats as members already (#3421).
 *
 * Private and unregistered graphs keep the member recovery roster: the
 * finalized chain participants, or the store-backed metadata members. That
 * roster is empty for a public graph registered on chain, whose chain record
 * names no participants, so a repeated request of an admitted member was taken
 * for a new one and waited for the approver again. The members of a registered
 * public graph are the curator's own allowlist: its metadata members, read
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
  const members = await agent.getLocalMetadataMemberRecoveryGate(contextGraphId);
  // An authority fact written during the read invalidates it; admission retries.
  return projection.readContextGraphAuthorityFactsRevision(contextGraphId) === revision ? members : null;
}
