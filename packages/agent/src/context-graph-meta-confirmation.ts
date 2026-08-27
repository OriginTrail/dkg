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

export interface ConfirmContextGraphMetadataInput {
  readonly rejectUnregisteredPlaceholder?: boolean;
  /** Exact proof already obtained by the caller; absence permits one strict lookup. */
  readonly activePublicChainProof?: ActivePublicContextGraphChainProof;
}

export interface ContextGraphMetadataConfirmationDependencies {
  readonly chain: ChainAdapter;
  readonly resolveActivePublicChainProof: (
    contextGraphId: string,
  ) => Promise<ActivePublicContextGraphChainProof>;
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
  const priorChainProof = input.activePublicChainProof;
  let hasActivePublicOnChainProof = priorChainProof === undefined
    ? undefined
    : priorChainProof.state === 'public';
  if (
    hasUnregisteredPlaceholder
    && input.rejectUnregisteredPlaceholder === true
    && priorChainProof === undefined
  ) {
    hasActivePublicOnChainProof = await dependencies
      .resolveActivePublicChainProof(contextGraphId)
      .then((proof) => proof.state === 'public')
      .catch(() => false);
  }

  const approvedAgentAddress = dependencies.localApprovedAgentByContextGraph.get(contextGraphId);
  let expectedDelegateeOpKey: string | undefined;
  if (approvedAgentAddress) {
    try {
      expectedDelegateeOpKey = await inferAdapterPublisherAddress(dependencies.chain);
    } catch {
      // The libp2p peer binding remains sufficient when no op-key is exposed.
    }
  }
  const authoritativeDefinitionResult = await dependencies.store.query(
    buildAuthoritativePrivateMetaAskQuery(
      contextGraphId,
      approvedAgentAddress
        ? {
            approvedAgentAddress,
            expectedDelegateePeerId: dependencies.peerId,
            expectedDelegateeOpKey,
          }
        : undefined,
    ),
    { source: 'agent.contextGraph.confirmedMeta.privateDefinition' },
  );
  if (
    authoritativeDefinitionResult.type === 'boolean'
    && authoritativeDefinitionResult.value === true
  ) {
    return true;
  }

  const authoritativePublicDefinitionResult = await dependencies.store.query(
    buildAuthoritativePublicMetaAskQuery(contextGraphId),
    { source: 'agent.contextGraph.confirmedMeta.publicDefinition' },
  );
  if (
    authoritativePublicDefinitionResult.type === 'boolean'
    && authoritativePublicDefinitionResult.value === true
    && (
      !hasUnregisteredPlaceholder
      || input.rejectUnregisteredPlaceholder !== true
      || hasActivePublicOnChainProof === true
    )
  ) {
    return true;
  }

  if (hasActivePublicOnChainProof === undefined) {
    hasActivePublicOnChainProof = await dependencies.resolveActivePublicChainProof(contextGraphId)
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
