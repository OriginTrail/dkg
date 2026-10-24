// SPDX-License-Identifier: Apache-2.0

import {
  isApprovedMemberDelegationExpiryActive,
  parseApprovedMemberDelegationExpiry,
} from './context-graph-member-proof.js';
import {
  buildAuthoritativePrivateMetaMemberProofQuery,
} from './context-graph-private-meta-proof.js';
import { isCanonicalAuthoritativeContextGraphId } from './context-graph-binding-state.js';
import { stripLiteral } from './dkg-agent-utils.js';
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
  /**
   * Deadline of the delegation this proof rests on, in epoch milliseconds;
   * `null` when that delegation has no expiry. A consumer that awaits further
   * reads before it uses the proof re-checks it with
   * {@link isApprovedPrivateReplicaDelegationActive}. Current producers always
   * set this; optionality preserves the public authority shape.
   */
  readonly delegationExpiresAtMs?: number | null;
}

/**
 * Whether the delegation an earlier proof rested on is still active. No store
 * write marks the moment a delegation expires, so the revision fences cannot
 * see it; an authority without a recorded deadline is not extended.
 */
export function isApprovedPrivateReplicaDelegationActive(
  authority: ApprovedPrivateReplicaAuthority,
  nowMs = Date.now(),
): boolean {
  return authority.delegationExpiresAtMs !== undefined
    && isApprovedMemberDelegationExpiryActive(authority.delegationExpiresAtMs, nowMs);
}

/**
 * Result of the one source-qualified private-member proof.
 *
 * A canonical on-chain id in the exact private definition makes the proof
 * ineligible for unregistered-replica authority, but legacy adapters still
 * need to distinguish that fully proved registered-metadata shape from an
 * invalid bare-name proof. Only the legacy compatibility route consumes the
 * latter result; finalized absence never does.
 */
export type ApprovedPrivateReplicaAuthorityResolution =
  | Readonly<{
      kind: 'unregistered-private-replica';
      authority: ApprovedPrivateReplicaAuthority;
    }>
  | Readonly<{
      kind: 'confirmed-registered-meta';
      onChainId: string;
      authority: ApprovedPrivateReplicaAuthority;
    }>;

/**
 * Hooks for a caller that may run the proof again for the same decision. Both
 * can only take a result away from a run; neither can add one.
 */
export interface ApprovedPrivateReplicaProofRun {
  /**
   * Called with the generation of the approved request the run starts from.
   * `false` ends the run without a proof, which is how every run of one
   * decision is held to the generation the first one read.
   */
  acceptsRequestGeneration(requestGeneration: string): boolean;
  /**
   * Called when a run is discarded for a moved metadata revision and nothing
   * else: every check before that one held.
   */
  metadataMoved(): void;
}

/**
 * Classify the exact own-meta on-chain binding returned by the same proof.
 * `null` means absent; `undefined` means malformed, ambiguous, or a mixed
 * bound/unbound result and therefore fails closed.
 */
function parseRegisteredMetaOnChainId(
  bindings: readonly Readonly<Record<string, string>>[],
): string | null | undefined {
  const values = new Set<string>();
  let sawUnbound = false;
  for (const binding of bindings) {
    const raw = binding['contextGraphOnChainId'];
    if (raw === undefined) {
      sawUnbound = true;
      continue;
    }
    const value = stripLiteral(raw);
    if (!isCanonicalAuthoritativeContextGraphId(value)) return undefined;
    values.add(value);
    if (values.size > 1) return undefined;
  }
  if (values.size === 0) return null;
  if (sawUnbound) return undefined;
  return values.values().next().value;
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
  run?: ApprovedPrivateReplicaProofRun,
): Promise<ApprovedPrivateReplicaAuthorityResolution | null> {
  const approved = approvedAgentAddress?.toLowerCase();
  const hasLocalAgent = () => agent.listLocalAgents().some(
    ({ agentAddress }) => agentAddress.toLowerCase() === approved,
  );
  if (!approved || !hasLocalAgent()) return null;
  // Own-meta reads and the proof query are separate store operations. Fence the
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
  if (run?.acceptsRequestGeneration(state.requestGeneration) === false) return null;

  const ownerAddress = state.curatorAgentAddress;
  const meta = await agent.getOwnCgMetaFacts(contextGraphId, { signal });
  const owners = new Set(meta.curators.map((did) => did
    .replace(/^did:dkg:agent:/u, '').toLowerCase()));
  const creators = new Set(meta.creators);
  const registrationStatus = await agent.readLocalContextGraphRegistrationStatus(contextGraphId);
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
    || registrationStatus === 'pending'
  ) return null;

  // Bind the same current membership and active delegation proof used by
  // private metadata bootstrap to this physical receiver's peer identity.
  const proof = await agent.store.query(buildAuthoritativePrivateMetaMemberProofQuery(
    contextGraphId,
    { approvedAgentAddress: approved, expectedDelegateePeerId: agent.peerId },
  ), { signal, source: 'agent.contextGraph.approvedPrivateReplica' });
  signal?.throwIfAborted();
  if (proof.type !== 'bindings') return null;
  const delegationExpiry = parseApprovedMemberDelegationExpiry(proof.bindings);
  if (delegationExpiry === undefined) return null;
  const registeredMetaOnChainId = parseRegisteredMetaOnChainId(proof.bindings);
  if (registeredMetaOnChainId === undefined) return null;

  // Approval and requester state are local mutable authority. Re-read their
  // complete generation binding after every metadata/store await so a
  // rejection, replacement request, or local-agent removal cannot race into a
  // successful result based on a stale snapshot.
  const currentRegistrationStatus = await agent
    .readLocalContextGraphRegistrationStatus(contextGraphId);
  if (
    currentRegistrationStatus === 'pending'
    || (
      registeredMetaOnChainId === null
      && currentRegistrationStatus !== 'unregistered'
    )
  ) {
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
  ) return null;
  // Checked last, so a run discarded here had every earlier check hold.
  if (!metadataStillCurrent()) {
    run?.metadataMoved();
    return null;
  }

  // The proof query embeds its start time. Recheck the deadline it proved
  // after every await so a delegation cannot expire while the read is in
  // flight and still authorize the replica.
  if (!isApprovedMemberDelegationExpiryActive(delegationExpiry)) return null;

  const authority = Object.freeze({
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
    delegationExpiresAtMs: delegationExpiry,
  });
  if (registeredMetaOnChainId !== null) {
    return Object.freeze({
      kind: 'confirmed-registered-meta',
      onChainId: registeredMetaOnChainId,
      authority,
    });
  }
  return Object.freeze({
    kind: 'unregistered-private-replica',
    authority,
  });
}
