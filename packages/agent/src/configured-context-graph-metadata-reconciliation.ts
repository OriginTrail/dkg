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
import {
  repairChainAttestedPublicMetaProjection,
  type ActivePublicContextGraphChainProof,
  type ChainAttestedPublicMetaRepairResult,
} from './context-graph-public-meta-repair.js';

export type PublicMetaRepairDiagnostic =
  | ChainAttestedPublicMetaRepairResult
  | { readonly outcome: 'repair-failed'; readonly detail: string };

export type ConfiguredContextGraphMetadataReconciliationResult =
  | { readonly outcome: 'authoritative'; readonly repair: PublicMetaRepairDiagnostic }
  | {
      readonly outcome: 'pending';
      readonly reason: 'conflicting-policy' | 'missing-metadata';
      readonly repair: PublicMetaRepairDiagnostic;
    };

export interface ConfirmConfiguredContextGraphMetadataInput {
  readonly rejectUnregisteredPlaceholder?: boolean;
  /** Exact proof already obtained by this reconciliation; absence permits one fresh lookup. */
  readonly activePublicChainProof?: ActivePublicContextGraphChainProof;
}

export interface ConfiguredContextGraphMetadataConfirmationDependencies {
  readonly chain: ChainAdapter;
  readonly isContextGraphPublicOnChain: (contextGraphId: string) => Promise<boolean>;
  readonly isPrivateContextGraph: (contextGraphId: string) => Promise<boolean>;
  readonly localApprovedAgentByContextGraph: ReadonlyMap<string, string>;
  readonly peerId: string;
  readonly store: TripleStore;
  readonly subscriptions: ReadonlyMap<string, Readonly<{ pendingMeta?: boolean }>>;
}

export interface ConfiguredContextGraphMetadataReconciliationDependencies {
  readonly store: TripleStore;
  readonly resolveActivePublicChainProof: (
    contextGraphId: string,
  ) => Promise<ActivePublicContextGraphChainProof>;
  readonly isLocallyCurated: (contextGraphId: string) => Promise<boolean>;
  readonly confirmMetadata: (
    contextGraphId: string,
    input: ConfirmConfiguredContextGraphMetadataInput,
  ) => Promise<boolean>;
}

/** Repair and confirm one configured graph with one reusable chain-proof union. */
export async function reconcileConfiguredContextGraphMetadataV1(
  dependencies: ConfiguredContextGraphMetadataReconciliationDependencies,
  contextGraphIdInput: string,
): Promise<ConfiguredContextGraphMetadataReconciliationResult> {
  const contextGraphId = contextGraphIdInput.trim();
  if (!contextGraphId) {
    return {
      outcome: 'pending',
      reason: 'missing-metadata',
      repair: { outcome: 'repair-failed', detail: 'Context graph id is empty' },
    };
  }

  let repair: PublicMetaRepairDiagnostic;
  let activePublicChainProof: ActivePublicContextGraphChainProof | undefined;
  try {
    const repaired = await repairChainAttestedPublicMetaProjection(
      dependencies.store,
      contextGraphId,
      async () => {
        try {
          return await dependencies.resolveActivePublicChainProof(contextGraphId);
        } catch (error) {
          return {
            state: 'unknown',
            reason: 'rpc-failure',
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      },
    );
    if (repaired.chainProof.state !== 'not-requested') {
      activePublicChainProof = repaired.chainProof;
    }
    repair = repaired;
  } catch (error) {
    repair = {
      outcome: 'repair-failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (repair.outcome === 'conflicting-policy') {
    return { outcome: 'pending', reason: 'conflicting-policy', repair };
  }

  const locallyCurated = await dependencies.isLocallyCurated(contextGraphId)
    .catch(() => false);
  const hasConfirmedMeta = await dependencies.confirmMetadata(contextGraphId, {
    rejectUnregisteredPlaceholder: !locallyCurated,
    ...(activePublicChainProof === undefined ? {} : { activePublicChainProof }),
  }).catch(() => false);
  return hasConfirmedMeta
    ? { outcome: 'authoritative', repair }
    : { outcome: 'pending', reason: 'missing-metadata', repair };
}

/** Store confirmation with an explicit, non-forgeable-at-public-method prior-proof input. */
export async function confirmConfiguredContextGraphMetadataV1(
  dependencies: ConfiguredContextGraphMetadataConfirmationDependencies,
  contextGraphId: string,
  input: ConfirmConfiguredContextGraphMetadataInput = {},
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
  const hasResolvedActivePublicChainProof = priorChainProof !== undefined;
  let hasActivePublicOnChainProof = priorChainProof !== undefined
    ? priorChainProof.state === 'public'
    : undefined;
  if (
    hasUnregisteredPlaceholder
    && input.rejectUnregisteredPlaceholder === true
    && !hasResolvedActivePublicChainProof
  ) {
    hasActivePublicOnChainProof = await dependencies.isContextGraphPublicOnChain(contextGraphId)
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
    hasActivePublicOnChainProof = await dependencies.isContextGraphPublicOnChain(contextGraphId)
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
