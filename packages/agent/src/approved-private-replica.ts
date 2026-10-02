// SPDX-License-Identifier: Apache-2.0

import { buildAuthoritativePrivateMetaAskQuery } from './context-graph-private-meta-proof.js';
import type { DKGAgent } from './dkg-agent.js';

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/u;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

export interface ApprovedPrivateReplicaAuthority {
  readonly approvedAgentAddress: string;
  readonly ownerAddress: string;
  readonly requestGeneration: string;
  readonly curatorPeerId: string;
  readonly memberAddresses: readonly string[];
  /**
   * Source-qualified graph peer gate proved with this replica authority.
   * Current producers always set this; optionality preserves the public
   * authority shape accepted from older callers.
   */
  readonly allowedPeers?: readonly string[];
}

/**
 * Resolve the current authority proved by a durable approved private join.
 *
 * This proves who approved the local replica and returns only the fresh,
 * source-qualified private roster. Callers must independently establish exact
 * finalized chain-name absence before treating the graph as unregistered.
 */
export async function resolveApprovedPrivateReplicaAuthority(
  agent: DKGAgent,
  contextGraphId: string,
  approvedAgentAddress: string | undefined,
  approvalStillHolds: () => boolean,
  metadataStillCurrent: () => boolean,
  signal?: AbortSignal,
): Promise<ApprovedPrivateReplicaAuthority | null> {
  const approved = approvedAgentAddress?.toLowerCase();
  const hasLocalAgent = () => agent.listLocalAgents().some(
    ({ agentAddress }) => agentAddress.toLowerCase() === approved,
  );
  if (!approved || !hasLocalAgent()) return null;
  // Own-meta reads and the proof ASK are separate store operations. Fence the
  // projection revision so a root/member/delegation mutation between them
  // cannot authorize from a mixed generation.
  const state = await agent.readRequesterJoinRequestState(contextGraphId, approved);
  if (
    state?.status !== 'approved'
    || !state.curatorPeerId
    || state.curatorAuthorityEra !== '0'
    || !state.curatorAgentAddress
    || !EVM_ADDRESS.test(state.curatorAgentAddress)
    || state.curatorAgentAddress === ZERO_ADDRESS
  ) return null;

  const ownerAddress = state.curatorAgentAddress;
  const meta = await agent.getOwnCgMetaFacts(contextGraphId, { signal });
  const owners = new Set(meta.curators.map((did) => did
    .replace(/^did:dkg:agent:/u, '').toLowerCase()));
  const creators = new Set(meta.creators);
  if (
    meta.accessPolicy?.trim().toLowerCase() !== 'private'
    || owners.size !== 1
    || !owners.has(ownerAddress)
    || creators.size !== 1
    || !creators.has(`did:dkg:agent:${state.curatorPeerId}`)
    // Agent membership and the graph-level peer gate are conjunctive. The
    // member's delegation proves that this peer may act for the agent; it does
    // not override an explicit curator-maintained receiver allowlist.
    || (meta.allowedPeers.length > 0 && !meta.allowedPeers.includes(agent.peerId))
    || meta.onChainId !== undefined
    || await agent.readLocalContextGraphRegistrationStatus(contextGraphId) !== 'unregistered'
  ) return null;

  // Bind the same current membership and active delegation proof used by
  // private metadata bootstrap to this physical receiver's peer identity.
  const proof = await agent.store.query(buildAuthoritativePrivateMetaAskQuery(
    contextGraphId,
    { approvedAgentAddress: approved, expectedDelegateePeerId: agent.peerId },
  ), { signal, source: 'agent.contextGraph.approvedPrivateReplica' });
  signal?.throwIfAborted();
  if (proof.type !== 'boolean' || !proof.value) return null;

  // Approval and requester state are local mutable authority. Re-read their
  // complete generation binding after every metadata/store await so a
  // rejection, replacement request, or local-agent removal cannot race into a
  // successful result based on a stale snapshot.
  if (await agent.readLocalContextGraphRegistrationStatus(contextGraphId) !== 'unregistered') {
    return null;
  }
  const current = await agent.readRequesterJoinRequestState(contextGraphId, approved);
  if (
    !approvalStillHolds()
    || !hasLocalAgent()
    || current?.status !== 'approved'
    || current.requestGeneration !== state.requestGeneration
    || current.curatorPeerId !== state.curatorPeerId
    || current.curatorAgentAddress !== ownerAddress
    || current.curatorAuthorityEra !== '0'
    || !metadataStillCurrent()
  ) return null;

  return Object.freeze({
    approvedAgentAddress: approved,
    ownerAddress,
    requestGeneration: state.requestGeneration,
    curatorPeerId: state.curatorPeerId,
    // This proof authorizes this receiver's approved local participant. It is
    // neither a generic owner policy nor a replacement encryption roster.
    memberAddresses: Object.freeze([approved]),
    // Preserve the graph's own peer restriction with the proof. Consumers
    // must not re-read the merged metadata projection, where source identity
    // has already been discarded.
    allowedPeers: Object.freeze([...meta.allowedPeers]),
  });
}
