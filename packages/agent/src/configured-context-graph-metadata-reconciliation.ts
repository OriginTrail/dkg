// SPDX-License-Identifier: Apache-2.0

import type { TripleStore } from '@origintrail-official/dkg-storage';

import type { ConfirmContextGraphMetadataInput } from
  './context-graph-meta-confirmation.js';
import {
  repairChainAttestedPublicMetaProjection,
  type ChainAttestedPublicMetaRepairResult,
} from './context-graph-public-meta-repair.js';
import type { ActivePublicContextGraphChainProof } from
  './active-public-context-graph-chain-proof.js';

type PublicMetaRepairDiagnostic = ChainAttestedPublicMetaRepairResult;

export type ConfiguredContextGraphMetadataReconciliationDiagnostic =
  | { readonly kind: 'public-metadata-projection-completed' }
  | { readonly kind: 'public-metadata-repair-failed'; readonly detail: string }
  | {
      readonly kind: 'public-chain-proof-unavailable';
      readonly reason: 'unprovable' | 'rpc-failure';
      readonly detail?: string;
    };

export type ConfiguredContextGraphMetadataReconciliationResult =
  | {
      readonly outcome: 'authoritative';
      readonly diagnostic?: ConfiguredContextGraphMetadataReconciliationDiagnostic;
    }
  | {
      readonly outcome: 'pending';
      readonly reason: 'conflicting-policy';
      readonly diagnostic?: never;
    }
  | {
      readonly outcome: 'pending';
      readonly reason: 'missing-metadata';
      readonly diagnostic?: ConfiguredContextGraphMetadataReconciliationDiagnostic;
    };

function reconciliationDiagnostic(
  repair: PublicMetaRepairDiagnostic,
): ConfiguredContextGraphMetadataReconciliationDiagnostic | undefined {
  if (repair.outcome === 'projection-complete') {
    return { kind: 'public-metadata-projection-completed' };
  }
  if (repair.outcome === 'repair-failed') {
    return { kind: 'public-metadata-repair-failed', detail: repair.detail };
  }
  if (
    repair.outcome === 'not-chain-attested'
    && repair.chainProof.state === 'unknown'
  ) {
    return {
      kind: 'public-chain-proof-unavailable',
      reason: repair.chainProof.reason,
      ...(repair.chainProof.detail === undefined ? {} : { detail: repair.chainProof.detail }),
    };
  }
  return undefined;
}

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
      diagnostic: {
        kind: 'public-metadata-repair-failed',
        detail: 'Context graph id is empty',
      },
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
      failureStage: 'pre-mutation',
      chainProof: { state: 'not-requested' },
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (repair.outcome === 'conflicting-policy') {
    return { outcome: 'pending', reason: 'conflicting-policy' };
  }

  if (
    repair.outcome === 'repair-failed'
    && repair.failureStage === 'mutation-or-durability'
  ) {
    return {
      outcome: 'pending',
      reason: 'missing-metadata',
      diagnostic: reconciliationDiagnostic(repair),
    };
  }

  const locallyCurated = await dependencies.isLocallyCurated(contextGraphId)
    .catch(() => false);
  const hasConfirmedMeta = await dependencies.confirmMetadata(contextGraphId, {
    rejectUnregisteredPlaceholder: !locallyCurated,
    ...(activePublicChainProof === undefined ? {} : { activePublicChainProof }),
  }).catch(() => false);
  const diagnostic = reconciliationDiagnostic(repair);
  return hasConfirmedMeta
    ? {
        outcome: 'authoritative',
        ...(diagnostic === undefined ? {} : { diagnostic }),
      }
    : {
        outcome: 'pending',
        reason: 'missing-metadata',
        ...(diagnostic === undefined ? {} : { diagnostic }),
      };
}
