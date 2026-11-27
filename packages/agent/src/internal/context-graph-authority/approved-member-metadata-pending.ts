// SPDX-License-Identifier: Apache-2.0

/**
 * A join the curator approved whose member list has not reached this node yet
 * (#3421).
 *
 * After a curator approves a join it tells the member, and the member fetches
 * the graph's metadata from the curator: the allowlist that names the member
 * and lets it sign shared-memory writes. A curator that is reachable only over
 * short-lived connections can need many attempts to serve it. Until the
 * graph's own metadata names the member, the node treats the approval as
 * pending, not as absent (once it names the member, a delegation that needs
 * renewing is the curator's to renew, and a join request goes to it):
 *  - a write is refused with a retryable authority wait instead of "no allowed
 *    signing key", so the share is tried again instead of being lost;
 *  - a new join request of the same agent to the same curator is answered
 *    from the approval the node holds, without asking the curator to approve
 *    the member again, and it asks the metadata recovery for an attempt soon;
 *  - the context-graph listing shows `joinState: 'approved-metadata-pending'`.
 * A complete snapshot from the curator that no longer lists the member ends
 * the pending state: its approval is pending again, so the next join request
 * reaches the curator.
 */

import {
  contextGraphDataGraphUri,
  createOperationContext,
  DKG_ONTOLOGY,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';

import { hasAuthoritativePrivateMetaDefinition } from '../../context-graph-private-meta-proof.js';
import { hasAuthoritativePublicMetaDefinition } from '../../context-graph-public-meta-proof.js';
import { stripLiteral } from '../../dkg-agent-utils.js';
import { nudgeJoinApprovalMetadataRecovery } from '../../join-approval-metadata-refetch.js';
import type { ApprovedMemberAcceptance } from './approved-member-acceptance.js';
import { createContextGraphAuthorityError } from './context-graph-authority.js';

/** The listing's join state of a caller whose approval waits for its member list. */
export const APPROVED_METADATA_PENDING_JOIN_STATE = 'approved-metadata-pending' as const;

/** What the pending state reads and changes of the agent. */
interface ApprovedMemberMetadataAgent {
  readonly localApprovedAgentByCG: Map<string, string>;
  readonly localAgents: ReadonlyMap<string, { readonly agentAddress: string; readonly privateKey?: string }>;
  readonly subscribedContextGraphs: ReadonlyMap<string, { readonly subscribed?: boolean }>;
  readonly log: {
    info(ctx: OperationContext, message: string): void;
    warn(ctx: OperationContext, message: string): void;
  };
  readRequesterJoinRequestState(contextGraphId: string, agentAddress: string): Promise<{
    readonly requestGeneration: string;
    readonly status: string;
    readonly curatorPeerId?: string;
  } | null>;
  restoreRequesterJoinDecisionAfterFailedApply(
    contextGraphId: string,
    agentAddress: string,
    requestGeneration: string,
    appliedStatus: 'approved',
    curatorPeerId: string,
  ): Promise<boolean>;
  getOwnCgMetaFacts(contextGraphId: string): Promise<{
    readonly allowedAgents: readonly string[];
    readonly participantAgents: readonly string[];
    readonly revokedAgents: readonly string[];
  }>;
  resolveApprovedMemberAcceptance(contextGraphId: string): Promise<ApprovedMemberAcceptance | undefined>;
  hasConfirmedApprovedMemberMetaState(
    contextGraphId: string,
    acceptance: ApprovedMemberAcceptance,
  ): Promise<boolean>;
  invalidateListContextGraphsCache(): void;
}

/** A local agent's approval whose member list is pending. */
export interface ApprovedMemberMetadataPending {
  /** The approved local agent, lower-cased. */
  readonly agentAddress: string;
  readonly requestGeneration: string;
  /** The curator the approval came from, when the request recorded it. */
  readonly curatorPeerId?: string;
}

/**
 * Whether the local metadata proves this node's approved member of
 * `contextGraphId`, judged with the acceptance a join attempt uses. Without an
 * approval binding nothing is pending, which counts as confirmed.
 */
export async function isApprovedMemberMetadataConfirmed(
  agentObject: object,
  contextGraphId: string,
): Promise<boolean> {
  const agent = agentObject as ApprovedMemberMetadataAgent;
  const acceptance = await agent.resolveApprovedMemberAcceptance(contextGraphId);
  return acceptance === undefined
    || await agent.hasConfirmedApprovedMemberMetaState(contextGraphId, acceptance);
}

/**
 * Whether the graph's own metadata names `agentAddress` in its member list, as
 * allowed, participant or revoked: the curator's list has arrived, whatever
 * state the member's delegation in it is in.
 */
async function ownMetadataNamesMember(
  agent: ApprovedMemberMetadataAgent,
  contextGraphId: string,
  agentAddress: string,
): Promise<boolean> {
  const facts = await agent.getOwnCgMetaFacts(contextGraphId);
  return [facts.allowedAgents, facts.participantAgents, facts.revokedAgents]
    .some((agents) => agents.some((listed) => listed.toLowerCase() === agentAddress));
}

/**
 * The approval of `contextGraphId` that waits for its member list: the node's
 * approved agent (`agentAddress`, when given, must be that agent), a durable
 * approval of its request, and the graph's own metadata that does not name the
 * member yet. `undefined` otherwise. A read that fails rejects.
 */
export async function readApprovedMemberMetadataPending(
  agentObject: object,
  contextGraphId: string,
  agentAddress?: string,
): Promise<ApprovedMemberMetadataPending | undefined> {
  const agent = agentObject as ApprovedMemberMetadataAgent;
  const approved = agent.localApprovedAgentByCG.get(contextGraphId);
  if (approved === undefined) return undefined;
  if (agentAddress !== undefined && agentAddress.toLowerCase() !== approved) return undefined;
  const request = await agent.readRequesterJoinRequestState(contextGraphId, approved);
  if (request?.status !== 'approved') return undefined;
  if (await ownMetadataNamesMember(agent, contextGraphId, approved)) return undefined;
  return {
    agentAddress: approved,
    requestGeneration: request.requestGeneration,
    ...(request.curatorPeerId === undefined ? {} : { curatorPeerId: request.curatorPeerId }),
  };
}

/**
 * The refusal of a write whose signer is not on the graph's signing roster.
 * While the approval of a local agent that holds its key waits for its member
 * list, it is a retryable authority wait (`approved-member-metadata-pending`),
 * so the write is tried again instead of lost; otherwise, and when a read
 * here fails, it is the plain refusal it always was.
 */
export async function refuseUnlistedWorkspaceSigner(
  agentObject: object,
  contextGraphId: string,
): Promise<Error> {
  const message =
    `Cannot gossip SWM write for agent-gated context graph "${contextGraphId}": no local allowed signing agent key`;
  const agent = agentObject as ApprovedMemberMetadataAgent;
  const pending = await readApprovedMemberMetadataPending(agent, contextGraphId).catch(() => undefined);
  const holdsKey = pending !== undefined && [...agent.localAgents.values()].some((record) => (
    Boolean(record.privateKey) && record.agentAddress.toLowerCase() === pending.agentAddress
  ));
  if (!holdsKey) return new Error(message);
  return createContextGraphAuthorityError(
    `${message} yet: agent ${pending.agentAddress} is approved and the curator's member list has not arrived`,
    { reason: 'approved-member-metadata-pending' },
  );
}

/** A join request answered from the approval the node holds, shaped as a forward result. */
export interface HeldJoinApprovalAnswer {
  readonly delivered: 0;
  readonly errors: string[];
  readonly alreadyMember: true;
  readonly approvedMetadataPending: true;
}

/**
 * Answer a new join request of `agentAddress` to `curatorPeerId` from the
 * approval the node already holds from that curator while its member list is
 * pending. No request is sent, so the curator is not asked to approve the
 * member again, and the metadata recovery is asked for an attempt soon.
 * `undefined` when the request must go to the curator: no such approval, an
 * approval from another curator, a graph the node does not subscribe to, or a
 * read that failed.
 */
export async function answerJoinFromHeldApproval(
  agentObject: object,
  contextGraphId: string,
  agentAddress: string,
  curatorPeerId: string,
): Promise<HeldJoinApprovalAnswer | undefined> {
  const agent = agentObject as ApprovedMemberMetadataAgent;
  if (agent.subscribedContextGraphs.get(contextGraphId)?.subscribed !== true) return undefined;
  const pending = await readApprovedMemberMetadataPending(agent, contextGraphId, agentAddress)
    .catch(() => undefined);
  if (pending === undefined || pending.curatorPeerId !== curatorPeerId) return undefined;
  nudgeJoinApprovalMetadataRecovery(agent, contextGraphId, curatorPeerId);
  agent.log.info(
    createOperationContext('system'),
    `Join request for "${contextGraphId}" from ${agentAddress} not sent: curator ${curatorPeerId.slice(-8)} `
      + 'approved it already; fetching the graph\'s member list from the curator again',
  );
  return { delivered: 0, errors: [], alreadyMember: true, approvedMetadataPending: true };
}

/**
 * A listing row with the caller's join state: `approved-metadata-pending`
 * while the caller's approval waits for its member list. Only a row that does
 * not involve the caller is read; a read that fails leaves the row unchanged.
 */
export async function withCallerJoinState<Row extends { readonly id: string; readonly callerInvolved?: boolean }>(
  agentObject: object,
  row: Row,
  callerAgentAddress: string,
): Promise<Row & { joinState?: typeof APPROVED_METADATA_PENDING_JOIN_STATE }> {
  if (row.callerInvolved !== false) return row;
  const pending = await readApprovedMemberMetadataPending(agentObject, row.id, callerAgentAddress)
    .catch(() => undefined);
  return pending === undefined ? row : { ...row, joinState: APPROVED_METADATA_PENDING_JOIN_STATE };
}

/**
 * Whether a complete metadata snapshot leaves the approved member out: it
 * holds the definition the acceptance admits, and it names no `allowedAgent`
 * row for the member or revokes it. Only the allowlist row counts, so a
 * delegation whose times the two nodes' clocks disagree on is not taken for a
 * removal.
 */
export function curatorSnapshotOmitsApprovedMember(
  contextGraphId: string,
  quads: readonly Quad[],
  acceptance: ApprovedMemberAcceptance,
): boolean {
  const holdsDefinition = acceptance.admittedDefinition === 'public'
    ? hasAuthoritativePublicMetaDefinition(contextGraphId, quads)
    : hasAuthoritativePrivateMetaDefinition(contextGraphId, quads);
  if (!holdsDefinition) return false;
  const root = contextGraphDataGraphUri(contextGraphId);
  const member = acceptance.proof.approvedAgentAddress.toLowerCase();
  const namesMember = (predicate: string) => quads.some((quad) => (
    quad.subject === root
    && quad.predicate === predicate
    && stripLiteral(quad.object).trim().toLowerCase() === member
  ));
  return !namesMember(DKG_ONTOLOGY.DKG_ALLOWED_AGENT) || namesMember(DKG_ONTOLOGY.DKG_REVOKED_AGENT);
}

/**
 * Watch one fetch of the curator's snapshot for an approved member. Called
 * before the fetch, it reads which approval the fetch serves; the function it
 * returns takes the complete snapshot and, when that snapshot leaves the member
 * out, makes that approval pending again and drops the approval binding, which
 * ends the metadata recovery. An approval that arrives during the fetch is
 * newer than the snapshot and stays. `undefined` when no approval of this
 * curator is held, or when it cannot be read.
 */
export async function watchCuratorSnapshotForApprovedMember(
  agentObject: object,
  contextGraphId: string,
  curatorPeerId: string,
  acceptance: ApprovedMemberAcceptance,
): Promise<((quads: readonly Quad[]) => Promise<void>) | undefined> {
  const agent = agentObject as ApprovedMemberMetadataAgent;
  const member = acceptance.proof.approvedAgentAddress.toLowerCase();
  let request: Awaited<ReturnType<ApprovedMemberMetadataAgent['readRequesterJoinRequestState']>>;
  try {
    request = await agent.readRequesterJoinRequestState(contextGraphId, member);
  } catch {
    return undefined;
  }
  if (request?.status !== 'approved' || request.curatorPeerId !== curatorPeerId) return undefined;
  const { requestGeneration } = request;
  return async (quads) => {
    if (!curatorSnapshotOmitsApprovedMember(contextGraphId, quads, acceptance)) return;
    const ctx = createOperationContext('sync');
    try {
      // Only the approval this fetch serves, of this curator, goes back to pending:
      // a newer one, or another curator's approval of the same request, stays.
      if (!(await agent.restoreRequesterJoinDecisionAfterFailedApply(
        contextGraphId,
        member,
        requestGeneration,
        'approved',
        curatorPeerId,
      ))) return;
      if ((await agent.readRequesterJoinRequestState(contextGraphId, member))?.status === 'approved') return;
      if (agent.localApprovedAgentByCG.get(contextGraphId) === member) {
        agent.localApprovedAgentByCG.delete(contextGraphId);
      }
      agent.invalidateListContextGraphsCache();
      agent.log.warn(
        ctx,
        `Curator ${curatorPeerId.slice(-8)} no longer lists ${member} as a member of "${contextGraphId}"; `
          + 'its join approval is pending again, and the next join request goes to the curator',
      );
    } catch (error) {
      agent.log.warn(
        ctx,
        `Could not end the join approval of ${member} for "${contextGraphId}" that curator `
          + `${curatorPeerId.slice(-8)} no longer lists: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}
