// SPDX-License-Identifier: Apache-2.0

import type { TripleStore } from '@origintrail-official/dkg-storage';

import type { ConfirmContextGraphMetadataInput } from
  './context-graph-meta-confirmation.js';
import {
  repairChainAttestedPublicMetaProjection,
  type ActivePublicContextGraphChainProof,
  type ChainAttestedPublicMetaRepairResult,
} from './context-graph-public-meta-repair.js';

export type PublicMetaRepairDiagnostic =
  | ChainAttestedPublicMetaRepairResult
  | { readonly outcome: 'repair-failed'; readonly detail: string };

type ConflictingPublicMetaRepairDiagnostic = Extract<
  PublicMetaRepairDiagnostic,
  { readonly outcome: 'conflicting-policy' }
>;

type NonConflictingPublicMetaRepairDiagnostic = Exclude<
  PublicMetaRepairDiagnostic,
  { readonly outcome: 'conflicting-policy' }
>;

export type ConfiguredContextGraphMetadataReconciliationResult =
  | { readonly outcome: 'authoritative'; readonly repair: NonConflictingPublicMetaRepairDiagnostic }
  | {
      readonly outcome: 'pending';
      readonly reason: 'conflicting-policy';
      readonly repair: ConflictingPublicMetaRepairDiagnostic;
    }
  | {
      readonly outcome: 'pending';
      readonly reason: 'missing-metadata';
      readonly repair: NonConflictingPublicMetaRepairDiagnostic;
    };

export interface ConfiguredContextGraphMetadataReconciliationDependencies {
  readonly store: TripleStore;
  readonly resolveActivePublicChainProof: (
    contextGraphId: string,
  ) => Promise<ActivePublicContextGraphChainProof>;
  readonly isLocallyCurated: (contextGraphId: string) => Promise<boolean>;
  readonly confirmMetadata: (
    contextGraphId: string,
    input: ConfirmContextGraphMetadataInput,
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
