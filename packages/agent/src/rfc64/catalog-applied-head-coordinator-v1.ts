// SPDX-License-Identifier: Apache-2.0

import {
  createOperationContext,
  readVerifiedCatalogSealBindingV1,
  type AuthorCatalogScopeV1,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';

import { mapWithConcurrencySettled } from '../map-with-concurrency.js';
import type { AcceptedRfc64CatalogAccessSnapshotV1 } from './catalog-access-policy-v1.js';
import type {
  Rfc64PublicCatalogNativeAppliedHeadLifecycleV1,
  Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1,
  Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1,
  Rfc64PublicCatalogNativeCommittedHeadTokenV1,
  Rfc64PublicCatalogNativePrimaryPrecommitHandlerV1,
  Rfc64PublicCatalogNativePrecommitTransactionV1,
} from './public-catalog-native-receiver-v1.js';
import type {
  Rfc64FinalizedVmAgentPrecommitHandlerV1,
  Rfc64FinalizedVmAgentPrecommitTransactionV1,
} from './finalized-vm-agent-precommit-v1.js';
import type {
  Rfc64CatalogAppliedHeadEvidenceV1,
  Rfc64FinalizedSwmRetirementLifecycleReceiptV1,
} from './catalog-applied-head-evidence-v1.js';
import {
  reconcileFinalizedSwmTwinFromCatalogProjection,
  type FinalizedSwmTwinRetirement,
} from '../sync/requester/finalized-swm-twin-reconciliation.js';

const POST_HEAD_TWIN_RECONCILIATION_CONCURRENCY_V1 = 4;

export type {
  Rfc64FinalizedSwmRetirementLifecycleReceiptV1,
} from './catalog-applied-head-evidence-v1.js';

export interface Rfc64CatalogAppliedHeadCoordinatorOptionsV1 {
  readonly acceptedPolicySnapshotForCatalogScope:
    (scope: Readonly<AuthorCatalogScopeV1>) => AcceptedRfc64CatalogAccessSnapshotV1;
  readonly finalizedPolicyPrecommit: Rfc64PublicCatalogNativePrimaryPrecommitHandlerV1;
  readonly finalizedVmPrecommit: Rfc64FinalizedVmAgentPrecommitHandlerV1;
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
): Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1<
  Rfc64CatalogAppliedHeadEvidenceV1
> {
  return Object.freeze(async (plan, signal) => {
    const accepted = options.acceptedPolicySnapshotForCatalogScope(plan.catalogScope);
    if (
      accepted.policy.accessPolicy === 1
      && accepted.policy.source.kind === 'finalized-chain'
    ) {
      return createFinalizedVmAppliedHeadLifecycleV1(options, plan, signal);
    }
    const transaction = await options.finalizedPolicyPrecommit(plan, signal);
    return Object.freeze({
      kind: 'rfc64-public-catalog-native-applied-head-lifecycle-v1',
      transaction: transaction ?? null,
      afterAppliedHead: null,
    } satisfies Rfc64PublicCatalogNativeAppliedHeadLifecycleV1<
      Rfc64CatalogAppliedHeadEvidenceV1
    >);
  });
}

async function createFinalizedVmAppliedHeadLifecycleV1(
  options: Rfc64CatalogAppliedHeadCoordinatorOptionsV1,
  plan: Readonly<Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1>,
  signal: AbortSignal,
): Promise<Rfc64PublicCatalogNativeAppliedHeadLifecycleV1<
  Rfc64CatalogAppliedHeadEvidenceV1
>> {
  const finalizedVmTransaction = await options.finalizedVmPrecommit(plan, signal);
  let catalogProjectionEvidence: readonly ReturnType<
    typeof catalogProjectionEvidenceForRow
  >[];
  let materializationReceipts: ReturnType<typeof exactMaterializationReceiptsByUal>;
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

  let vmTransactionCommitted = false;
  const transaction: Rfc64PublicCatalogNativePrecommitTransactionV1 = Object.freeze({
    commit: async () => {
      await finalizedVmTransaction.commit();
      vmTransactionCommitted = true;
    },
    rollback: (cause?: unknown) => finalizedVmTransaction.rollback(cause),
  });
  return Object.freeze({
    kind: 'rfc64-public-catalog-native-applied-head-lifecycle-v1',
    transaction,
    afterAppliedHead: async (committedHead) => {
      if (!vmTransactionCommitted) {
        throw new Error(
          'refusing finalized SWM retirement before the VM transaction commit',
        );
      }
      assertExactCommittedHeadTokenV1(committedHead, plan);
      const ctx = createOperationContext('sync');
      const receipts = await mapWithConcurrencyAndDrainV1(
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
          return Object.freeze({
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
      return Object.freeze({
        kind: 'rfc64-catalog-applied-head-evidence-v1',
        finalizedSwmRetirementLifecycleReceipts: Object.freeze(receipts),
      } satisfies Rfc64CatalogAppliedHeadEvidenceV1);
    },
  } satisfies Rfc64PublicCatalogNativeAppliedHeadLifecycleV1<
    Rfc64CatalogAppliedHeadEvidenceV1
  >);
}

async function mapWithConcurrencyAndDrainV1<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const settled = await mapWithConcurrencySettled(items, limit, fn);
  const failures = settled.filter(
    (outcome): outcome is Readonly<{ readonly status: 'rejected'; readonly reason: unknown }> =>
      outcome.status === 'rejected',
  );
  if (failures.length === 1) throw failures[0]!.reason;
  if (failures.length > 1) {
    throw new AggregateError(
      failures.map(({ reason }) => reason),
      'multiple finalized SWM reconciliations failed',
    );
  }
  return settled.map((outcome) => {
    if (outcome.status !== 'fulfilled') {
      throw new Error('unreachable rejected finalized SWM reconciliation');
    }
    return outcome.value;
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
