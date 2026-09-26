// SPDX-License-Identifier: Apache-2.0

import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { TripleStore } from '@origintrail-official/dkg-storage';

import { inferAdapterPublisherAddress } from './dkg-agent-helpers.js';
import { buildAuthoritativePrivateMetaAskQuery } from
  './context-graph-private-meta-proof.js';
import { buildAuthoritativePublicMetaAskQuery } from
  './context-graph-public-meta-proof.js';
import type { ActivePublicContextGraphChainProof } from
  './active-public-context-graph-chain-proof.js';
import { isPublicMetaDurabilityPending } from
  './context-graph-public-meta-repair.js';
import type { ApprovedMemberProof } from './context-graph-member-proof.js';

/**
 * What a confirmation is for.
 *
 * - `read` (the default): the local metadata is authoritative for reads. A
 *   public definition confirms on its own, because public reads never depend
 *   on membership; `rejectUnregisteredPlaceholder` additionally demands a
 *   chain proof before a public definition next to a local placeholder counts.
 * - `approved-member`: join bootstrap completion (#2831 review). Only a
 *   definition carrying this node's approved-member proof confirms: the
 *   private definition, or the public one with the same allowlist entry and
 *   delegation. Without a local approval binding nothing confirms.
 */
export type ConfirmContextGraphMetadataInput =
  | {
      readonly purpose?: 'read';
      readonly rejectUnregisteredPlaceholder?: boolean;
    }
  | { readonly purpose: 'approved-member' };

export interface ContextGraphMetadataConfirmationDependencies {
  readonly chain: ChainAdapter;
  readonly resolveActivePublicChainProof: () => Promise<ActivePublicContextGraphChainProof>;
  readonly isPrivateContextGraph: (contextGraphId: string) => Promise<boolean>;
  readonly localApprovedAgentByContextGraph: ReadonlyMap<string, string>;
  readonly peerId: string;
  readonly store: TripleStore;
  readonly subscriptions: ReadonlyMap<string, Readonly<{ pendingMeta?: boolean }>>;
}

/** Canonical authority policy shared by bootstrap, gossip, and shared-memory admission. */
export async function confirmContextGraphMetadataV1(
  dependencies: ContextGraphMetadataConfirmationDependencies,
  contextGraphId: string,
  input: ConfirmContextGraphMetadataInput = {},
): Promise<boolean> {
  if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
    return true;
  }
  if (isPublicMetaDurabilityPending(dependencies.store, contextGraphId)) {
    return false;
  }

  const memberProof = await resolveApprovedMemberProof(dependencies, contextGraphId);
  if (input.purpose === 'approved-member') {
    // A lifecycle race or partial rehydration can drop the binding; the
    // pre-join definition must not then stand in for the member.
    if (memberProof === undefined) return false;
    return await findAuthoritativeDefinition(
      dependencies,
      contextGraphId,
      { privateMemberProof: memberProof, publicMemberProof: memberProof },
      'agent.contextGraph.confirmedMeta.approvedMember',
    ) !== null;
  }

  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
  const unregisteredPlaceholderResult = await dependencies.store.query(
    `ASK WHERE {
      GRAPH <${metaGraph}> {
        <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> "unregistered" .
      }
    }`,
    { source: 'agent.contextGraph.confirmedMeta.unregisteredPlaceholder' },
  );
  const hasUnregisteredPlaceholder = unregisteredPlaceholderResult.type === 'boolean'
    && unregisteredPlaceholderResult.value === true;
  let hasActivePublicOnChainProof: boolean | undefined;
  if (
    hasUnregisteredPlaceholder
    && input.rejectUnregisteredPlaceholder === true
  ) {
    hasActivePublicOnChainProof = await dependencies
      .resolveActivePublicChainProof()
      .then((proof) => proof.state === 'public')
      .catch(() => false);
  }

  const authoritativeDefinition = await findAuthoritativeDefinition(
    dependencies,
    contextGraphId,
    { privateMemberProof: memberProof },
    'agent.contextGraph.confirmedMeta',
  );
  if (authoritativeDefinition === 'private') return true;
  if (
    authoritativeDefinition === 'public'
    && (
      !hasUnregisteredPlaceholder
      || input.rejectUnregisteredPlaceholder !== true
      || hasActivePublicOnChainProof === true
    )
  ) {
    return true;
  }

  if (hasActivePublicOnChainProof === undefined) {
    hasActivePublicOnChainProof = await dependencies.resolveActivePublicChainProof()
      .then((proof) => proof.state === 'public')
      .catch(() => false);
  }
  if (hasActivePublicOnChainProof) return true;

  if (
    hasUnregisteredPlaceholder
    && (
      dependencies.localApprovedAgentByContextGraph.has(contextGraphId)
      || (
        !hasActivePublicOnChainProof
        && (
          input.rejectUnregisteredPlaceholder === true
          || dependencies.subscriptions.get(contextGraphId)?.pendingMeta === true
        )
      )
    )
  ) {
    return false;
  }

  if (await dependencies.isPrivateContextGraph(contextGraphId)) return false;

  const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
  const ontologyResult = await dependencies.store.query(
    `ASK WHERE {
      GRAPH <${ontologyGraph}> {
        <${contextGraphUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
      }
    }`,
    { source: 'agent.contextGraph.confirmedMeta.ontologyDeclaration' },
  );
  return ontologyResult.type === 'boolean' && ontologyResult.value === true;
}

/** This node's approved-member proof for the graph, when it holds an approval. */
async function resolveApprovedMemberProof(
  dependencies: ContextGraphMetadataConfirmationDependencies,
  contextGraphId: string,
): Promise<ApprovedMemberProof | undefined> {
  const approvedAgentAddress = dependencies.localApprovedAgentByContextGraph.get(contextGraphId);
  if (!approvedAgentAddress) return undefined;
  let expectedDelegateeOpKey: string | undefined;
  try {
    expectedDelegateeOpKey = await inferAdapterPublisherAddress(dependencies.chain);
  } catch {
    // The libp2p peer binding remains sufficient when no op-key is exposed.
  }
  return {
    approvedAgentAddress,
    expectedDelegateePeerId: dependencies.peerId,
    expectedDelegateeOpKey,
  };
}

/**
 * The canonical stored-definition proofs, shared by every confirmation
 * purpose: the complete private definition first, then the unambiguous public
 * one, each with the member proof its caller requires. Returns the definition
 * that matched.
 */
async function findAuthoritativeDefinition(
  dependencies: ContextGraphMetadataConfirmationDependencies,
  contextGraphId: string,
  proofs: {
    readonly privateMemberProof?: ApprovedMemberProof;
    readonly publicMemberProof?: ApprovedMemberProof;
  },
  sourcePrefix: string,
): Promise<'private' | 'public' | null> {
  for (const [definition, query] of [
    ['private', buildAuthoritativePrivateMetaAskQuery(contextGraphId, proofs.privateMemberProof)],
    ['public', buildAuthoritativePublicMetaAskQuery(contextGraphId, proofs.publicMemberProof)],
  ] as const) {
    const result = await dependencies.store.query(query, {
      source: `${sourcePrefix}.${definition}Definition`,
    });
    if (result.type === 'boolean' && result.value === true) return definition;
  }
  return null;
}
