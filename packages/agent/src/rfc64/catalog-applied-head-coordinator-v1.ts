// SPDX-License-Identifier: Apache-2.0

import {
  createOperationContext,
  readVerifiedCatalogSealBindingV1,
  type AuthorCatalogScopeV1,
  type Digest32V1,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';

import { mapWithConcurrency } from '../map-with-concurrency.js';
import type { AcceptedRfc64CatalogAccessSnapshotV1 } from './catalog-access-policy-v1.js';
import type {
  Rfc64PublicCatalogNativeAppliedHeadLifecycleV1,
  Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1,
  Rfc64PublicCatalogNativeCommittedHeadTokenV1,
  Rfc64PublicCatalogNativePrimaryPrecommitHandlerV1,
  Rfc64PublicCatalogNativePrecommitTransactionV1,
} from './public-catalog-native-receiver-v1.js';
import type {
  Rfc64FinalizedVmAgentPrecommitHandlerV1,
  Rfc64FinalizedVmAgentPrecommitTransactionV1,
} from './finalized-vm-agent-precommit-v1.js';
import {
  reconcileFinalizedSwmTwinFromCatalogProjection,
  type FinalizedSwmTwinReconciliationOutcome,
  type FinalizedSwmTwinRetirement,
} from '../sync/requester/finalized-swm-twin-reconciliation.js';

const POST_HEAD_TWIN_RECONCILIATION_CONCURRENCY_V1 = 4;

/**
 * Explicit per-KA proof of the only safe finalized-twin lifecycle:
 * verified VM post-read, VM transaction commit, durable applied-head token,
 * then SWM retirement.
 */
export interface Rfc64FinalizedSwmRetirementLifecycleReceiptV1 {
  readonly kind: 'rfc64-finalized-swm-retirement-lifecycle-receipt-v1';
  readonly catalogHeadDigest: Digest32V1;
  readonly inventoryDigest: Digest32V1;
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly vmGraphIri: string;
  readonly vmPostReadDigest: Digest32V1;
  readonly vmMaterializationStatus: 'materialized' | 'existing';
  readonly committedHead: Readonly<Rfc64PublicCatalogNativeCommittedHeadTokenV1>;
  readonly swmReconciliationOutcome: FinalizedSwmTwinReconciliationOutcome;
}

export interface Rfc64CatalogAppliedHeadCoordinatorOptionsV1 {
  readonly acceptedPolicySnapshotForCatalogScope:
    (scope: Readonly<AuthorCatalogScopeV1>) => AcceptedRfc64CatalogAccessSnapshotV1;
  readonly finalizedPolicyPrecommit: Rfc64PublicCatalogNativePrimaryPrecommitHandlerV1;
  readonly finalizedVmPrecommit: Rfc64FinalizedVmAgentPrecommitHandlerV1;
  readonly store: TripleStore;
  readonly writeLocks: Map<string, Promise<void>>;
  readonly retire: (retirement: FinalizedSwmTwinRetirement, ctx: OperationContext) => Promise<void>;
  readonly recordRetirementLifecycleReceipt?: (
    receipt: Readonly<Rfc64FinalizedSwmRetirementLifecycleReceiptV1>,
  ) => void;
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
    let finalizedVmTransaction: Rfc64FinalizedVmAgentPrecommitTransactionV1 | null = null;
    if (
      accepted.policy.accessPolicy === 1
      && accepted.policy.source.kind === 'finalized-chain'
    ) {
      finalizedVmTransaction = await options.finalizedVmPrecommit(plan, signal) ?? null;
      if (finalizedVmTransaction === null) {
        throw new Error(
          'finalized VM precommit did not provide transactional materialization receipts',
        );
      }
      primaryTransaction = finalizedVmTransaction;
    } else {
      primaryTransaction = await options.finalizedPolicyPrecommit(plan, signal);
    }
    const retirementAuthorized = accepted.policy.accessPolicy === 1
      && accepted.policy.source.kind === 'finalized-chain';
    let catalogProjectionEvidence: readonly ReturnType<
      typeof catalogProjectionEvidenceForRow
    >[] = [];
    let materializationReceipts: ReturnType<typeof exactMaterializationReceiptsByUal> =
      new Map();
    if (finalizedVmTransaction !== null) {
      try {
        catalogProjectionEvidence = plan.rows.map((row) =>
          catalogProjectionEvidenceForRow(plan, row));
        materializationReceipts = exactMaterializationReceiptsByUal(
          finalizedVmTransaction,
          plan,
        );
      } catch (cause) {
        try {
          await finalizedVmTransaction.rollback(cause);
        } catch (rollbackCause) {
          throw new AggregateError(
            [cause, rollbackCause],
            'finalized VM receipt validation and rollback both failed',
          );
        }
        throw cause;
      }
    }
    let vmTransactionCommitted = false;
    let transaction: Rfc64PublicCatalogNativePrecommitTransactionV1 | null =
      primaryTransaction ?? null;
    if (retirementAuthorized && primaryTransaction !== undefined) {
      transaction = Object.freeze({
        commit: async () => {
          await primaryTransaction.commit();
          vmTransactionCommitted = true;
        },
        rollback: (cause?: unknown) => primaryTransaction.rollback(cause),
      });
    }
    return Object.freeze({
      kind: 'rfc64-public-catalog-native-applied-head-lifecycle-v1',
      transaction,
      afterAppliedHead: retirementAuthorized ? async (committedHead) => {
        if (!vmTransactionCommitted) {
          throw new Error(
            'refusing finalized SWM retirement before the VM transaction commit',
          );
        }
        assertExactCommittedHeadTokenV1(committedHead, plan);
        const ctx = createOperationContext('sync');
        const receipts = await mapWithConcurrency(
          catalogProjectionEvidence,
          POST_HEAD_TWIN_RECONCILIATION_CONCURRENCY_V1,
          async (evidence) => {
            const materialization = materializationReceipts.get(evidence.kaUal);
            if (materialization === undefined) {
              throw new Error(
                `finalized VM materialization receipt is missing for ${evidence.kaUal}`,
              );
            }
            const swmReconciliationOutcome = await reconcileFinalizedSwmTwinFromCatalogProjection({
              store: options.store,
              writeLocks: options.writeLocks,
              evidence,
              retire: (retirement) => options.retire(retirement, ctx),
            });
            const receipt = Object.freeze({
              kind: 'rfc64-finalized-swm-retirement-lifecycle-receipt-v1',
              catalogHeadDigest: plan.catalogHeadDigest,
              inventoryDigest: plan.inventoryDigest,
              contextGraphId: plan.catalogScope.contextGraphId,
              ...(plan.catalogScope.subGraphName === null
                ? {}
                : { subGraphName: plan.catalogScope.subGraphName }),
              kaUal: evidence.kaUal,
              assertionVersion: evidence.assertionVersion,
              vmGraphIri: materialization.vmGraphIri,
              vmPostReadDigest: materialization.postReadDigest,
              vmMaterializationStatus: materialization.status,
              committedHead: Object.freeze({ ...committedHead }),
              swmReconciliationOutcome,
            }) satisfies Rfc64FinalizedSwmRetirementLifecycleReceiptV1;
            options.recordRetirementLifecycleReceipt?.(receipt);
            return receipt;
          },
        );
        const retired = receipts.filter(
          ({ swmReconciliationOutcome }) => swmReconciliationOutcome === 'retired',
        ).length;
        if (retired > 0) {
          options.logInfo?.(
            ctx,
            `Retired ${retired} byte-identical finalized SWM catalog twin(s) after applied-head commit`,
          );
        }
      } : null,
    } satisfies Rfc64PublicCatalogNativeAppliedHeadLifecycleV1);
  });
}

function catalogProjectionEvidenceForRow(
  plan: Parameters<Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1>[0],
  row: Parameters<Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1>[0]['rows'][number],
) {
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
}

function assertExactCommittedHeadTokenV1(
  committedHead: Readonly<Rfc64PublicCatalogNativeCommittedHeadTokenV1>,
  plan: Parameters<Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1>[0],
): void {
  if (
    committedHead?.kind !== 'rfc64-public-catalog-native-committed-head-token-v1'
    || committedHead.catalogHeadDigest !== plan.catalogHeadDigest
    || committedHead.inventoryDigest !== plan.inventoryDigest
  ) {
    throw new Error(
      'refusing finalized SWM retirement without the exact durable applied-head token',
    );
  }
}

function exactMaterializationReceiptsByUal(
  transaction: Readonly<Rfc64FinalizedVmAgentPrecommitTransactionV1>,
  plan: Parameters<Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1>[0],
) {
  if (transaction.kind !== 'rfc64-finalized-vm-agent-precommit-transaction-v1') {
    throw new TypeError('finalized VM precommit returned an unrecognized transaction');
  }
  if (transaction.materializationReceipts.length !== plan.rows.length) {
    throw new Error('finalized VM materialization receipts do not cover the exact catalog set');
  }
  const receipts = new Map<string, Rfc64FinalizedVmAgentPrecommitTransactionV1[
    'materializationReceipts'
  ][number]>();
  for (const receipt of transaction.materializationReceipts) {
    if (receipts.has(receipt.ual)) {
      throw new Error(`finalized VM materialization receipt duplicates ${receipt.ual}`);
    }
    receipts.set(receipt.ual, receipt);
  }
  for (const row of plan.rows) {
    const binding = readVerifiedCatalogSealBindingV1(row.sealBinding);
    const receipt = receipts.get(binding.seal.kaUal);
    if (
      receipt === undefined
      || receipt.kaId !== binding.kaId
      || receipt.tripleCount !== binding.seal.publicTripleCount
    ) {
      throw new Error(
        `finalized VM materialization receipt differs from catalog row ${binding.seal.kaUal}`,
      );
    }
  }
  return receipts;
}
