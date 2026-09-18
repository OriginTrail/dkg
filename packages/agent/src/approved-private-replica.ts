// SPDX-License-Identifier: Apache-2.0

import { buildAuthoritativePrivateMetaAskQuery } from './context-graph-private-meta-proof.js';
import type { DKGAgent } from './dkg-agent.js';

/**
 * Authenticated private join provenance, not a participant-list shortcut.
 * This proves who approved the local replica; callers must independently
 * establish chain absence before using it as unregistered authority.
 */
export async function resolveApprovedPrivateReplicaOwner(
  agent: DKGAgent,
  contextGraphId: string,
  approved: string | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!approved || !agent.getWorkspaceSigningAgentForAddress(approved)) return null;
  const state = await agent.readRequesterJoinRequestState(contextGraphId, approved);
  if (
    state?.status !== 'approved'
    || !state.curatorPeerId
    || state.curatorAuthorityEra !== '0'
    || !state.curatorAgentAddress
    || !/^0x[0-9a-f]{40}$/u.test(state.curatorAgentAddress)
  ) return null;
  const meta = await agent.getOwnCgMetaFacts(contextGraphId, { signal });
  const owners = new Set(meta.curators.map((did) => did
    .replace(/^did:dkg:agent:/u, '').toLowerCase()));
  if (
    meta.accessPolicy?.trim().toLowerCase() !== 'private'
    || owners.size !== 1
    || !owners.has(state.curatorAgentAddress)
    || !meta.creators.includes(`did:dkg:agent:${state.curatorPeerId}`)
    || meta.onChainId !== undefined
    || await agent.readLocalContextGraphRegistrationStatus(contextGraphId) !== 'unregistered'
  ) return null;
  // Use the same root + current membership + active delegation proof as
  // metadata bootstrap. Bind it to this physical receiver's peer identity.
  const proof = await agent.store.query(buildAuthoritativePrivateMetaAskQuery(
    contextGraphId,
    { approvedAgentAddress: approved, expectedDelegateePeerId: agent.peerId },
  ), { signal, source: 'agent.contextGraph.approvedPrivateReplica' });
  signal?.throwIfAborted();
  return proof.type === 'boolean' && proof.value ? state.curatorAgentAddress : null;
}
