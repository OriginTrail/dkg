// SPDX-License-Identifier: Apache-2.0

import {
  createOperationContext,
  readVerifiedCatalogSealBindingV1,
  type AuthorCatalogScopeV1,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';

import type { AcceptedRfc64CatalogAccessSnapshotV1 } from './catalog-access-policy-v1.js';
import type {
  Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1,
  Rfc64PublicCatalogNativePrecommitTransactionV1,
} from './public-catalog-native-receiver-v1.js';
import {
  reconcileFinalizedSwmTwinFromCatalogProjection,
  type FinalizedSwmTwinRetirement,
} from '../sync/requester/finalized-swm-twin-reconciliation.js';

export interface Rfc64CatalogAppliedHeadCoordinatorOptionsV1 {
  readonly acceptedPolicySnapshotForCatalogScope:
    (scope: Readonly<AuthorCatalogScopeV1>) => AcceptedRfc64CatalogAccessSnapshotV1;
  readonly finalizedPolicyPrecommit: Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1;
  readonly finalizedVmPrecommit: Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1;
  readonly store: TripleStore;
  readonly writeLocks: Map<string, Promise<void>>;
  readonly retire: (retirement: FinalizedSwmTwinRetirement, ctx: OperationContext) => Promise<void>;
  readonly logInfo?: (ctx: OperationContext, message: string) => void;
}

/**
 * The sole owner of post-applied-head SWM retirement. VM precommit owns only
 * materialization/rollback; this coordinator owns the exact catalog evidence,
 * the shared KA lock proof, retirement, witness invalidation and replay.
 */
export function createRfc64CatalogAppliedHeadCoordinatorV1(
  options: Rfc64CatalogAppliedHeadCoordinatorOptionsV1,
): Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1 {
  return Object.freeze(async (plan, signal) => {
    const accepted = options.acceptedPolicySnapshotForCatalogScope(plan.catalogScope);
    let primaryTransaction: void | Rfc64PublicCatalogNativePrecommitTransactionV1;
    if (
      accepted.policy.accessPolicy === 1
      && accepted.policy.source.kind === 'finalized-chain'
    ) {
      primaryTransaction = await options.finalizedVmPrecommit(plan, signal);
    } else {
      primaryTransaction = await options.finalizedPolicyPrecommit(plan, signal);
    }
    if (accepted.policy.accessPolicy !== 1) return primaryTransaction;

    const catalogProjectionEvidence = plan.rows.map((row) => {
      const binding = readVerifiedCatalogSealBindingV1(row.sealBinding);
      const subGraphName = plan.catalogScope.subGraphName ?? undefined;
      return Object.freeze({
        contextGraphId: plan.catalogScope.contextGraphId,
        ...(subGraphName === undefined ? {} : { subGraphName }),
        kaUal: binding.seal.kaUal,
        assertionVersion: binding.seal.assertionVersion,
        publicQuadsDigest: row.publicQuadsDigest,
        publicQuadsCount: Number(binding.seal.publicTripleCount),
        privateTripleCount: Number(binding.seal.privateTripleCount),
        ...(binding.seal.privateMerkleRoot === null
          ? {}
          : { privateMerkleRoot: binding.seal.privateMerkleRoot }),
        expectedMerkleRoot: binding.seal.assertionMerkleRoot,
      });
    });
    return Object.freeze({
      commit: async () => {
        await primaryTransaction?.commit();
        const ctx = createOperationContext('sync');
        let retired = 0;
        for (const evidence of catalogProjectionEvidence) {
          const outcome = await reconcileFinalizedSwmTwinFromCatalogProjection({
            store: options.store,
            writeLocks: options.writeLocks,
            evidence,
            retire: (retirement) => options.retire(retirement, ctx),
          });
          if (outcome === 'retired') retired += 1;
        }
        if (retired > 0) {
          options.logInfo?.(
            ctx,
            `Retired ${retired} byte-identical finalized SWM catalog twin(s) after applied-head commit`,
          );
        }
      },
      rollback: (cause?: unknown) => primaryTransaction?.rollback(cause) ?? Promise.resolve(),
    });
  });
}
