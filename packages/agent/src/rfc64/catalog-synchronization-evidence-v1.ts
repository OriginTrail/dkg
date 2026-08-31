// SPDX-License-Identifier: Apache-2.0

import type {
  Rfc64CatalogAppliedHeadEvidenceV1,
  Rfc64FinalizedSwmRetirementLifecycleReceiptV2,
} from './finalized-swm-retirement-lifecycle-receipt-v1.js';
import type {
  Rfc64PublicCatalogNativeSynchronizationEvidenceV1,
} from './public-catalog-native-receiver-v1.js';

/**
 * Canonical process-local receiver evidence. The native synchronization proof
 * owns any finalized VM-before-SWM lifecycle receipts produced by that same
 * transition; there is no second agent-wide history registry. Evidence is
 * cleared when the catalog service closes and is never used as durable truth.
 */
type Rfc64NativeSynchronizationEvidenceWithoutExtensionV1 =
  Rfc64PublicCatalogNativeSynchronizationEvidenceV1<
    Rfc64CatalogAppliedHeadEvidenceV1
  > extends infer TEvidence
    ? TEvidence extends unknown
      ? Omit<TEvidence, 'postAppliedHeadExtension'>
      : never
    : never;

export type Rfc64CatalogSynchronizationEvidenceV1 = Readonly<
  Rfc64NativeSynchronizationEvidenceWithoutExtensionV1 & {
    readonly finalizedSwmRetirementLifecycleReceipts:
      readonly Readonly<Rfc64FinalizedSwmRetirementLifecycleReceiptV2>[];
  }
>;

export function snapshotRfc64CatalogSynchronizationEvidenceV1(
  evidence: Readonly<Rfc64PublicCatalogNativeSynchronizationEvidenceV1<
    Rfc64CatalogAppliedHeadEvidenceV1
  >>,
): Rfc64CatalogSynchronizationEvidenceV1 {
  const extension = evidence.postAppliedHeadExtension;
  if (extension !== undefined && extension.kind !== 'rfc64-catalog-applied-head-evidence-v1') {
    throw new TypeError('RFC-64 catalog synchronization post-head evidence is invalid');
  }
  const receipts = extension?.finalizedSwmRetirementLifecycleReceipts ?? [];
  const { postAppliedHeadExtension: _postAppliedHeadExtension, ...baseEvidence } = evidence;
  if (
    extension !== undefined
    && (
      extension.committedHead.catalogHeadDigest !== evidence.catalogHeadDigest
      || extension.committedHead.inventoryDigest !== evidence.inventoryDigest
    )
  ) {
    throw new TypeError(
      'RFC-64 applied-head evidence differs from its synchronization evidence head',
    );
  }
  const seenUals = new Set<string>();
  for (const receipt of receipts) {
    if (seenUals.has(receipt.kaUal)) {
      throw new TypeError(`RFC-64 synchronization evidence duplicates receipt ${receipt.kaUal}`);
    }
    seenUals.add(receipt.kaUal);
  }
  return Object.freeze({
    ...baseEvidence,
    finalizedSwmRetirementLifecycleReceipts: Object.freeze(receipts.map((receipt) =>
      Object.freeze({ ...receipt }))),
  });
}

/**
 * Accumulate only the two monotonic facts proved by a benign exact-head replay.
 * Every per-run field otherwise comes from the current observation so a newly
 * detected integrity failure can never be hidden by older success evidence.
 */
export function reduceRfc64CatalogSynchronizationEvidenceReplayV1(
  previous: Readonly<Rfc64CatalogSynchronizationEvidenceV1>,
  current: Readonly<Rfc64CatalogSynchronizationEvidenceV1>,
): Rfc64CatalogSynchronizationEvidenceV1 {
  if (
    previous.catalogHeadDigest !== current.catalogHeadDigest
    || previous.inventoryDigest !== current.inventoryDigest
  ) {
    throw new TypeError('RFC-64 prior synchronization evidence belongs to a different head');
  }
  const previousByUal = new Map(
    previous.finalizedSwmRetirementLifecycleReceipts
      .map((receipt) => [receipt.kaUal, receipt] as const),
  );
  return Object.freeze({
    ...current,
    finalizedSwmRetirementLifecycleReceipts: Object.freeze(
      current.finalizedSwmRetirementLifecycleReceipts.map((receipt) => {
        const prior = previousByUal.get(receipt.kaUal);
        if (!isBenignExactHeadLifecycleReplayV1(prior, receipt)) return receipt;
        return Object.freeze({
          ...receipt,
          vmMaterializationStatus: 'materialized' as const,
          swmReconciliationOutcome: 'retired' as const,
        });
      }),
    ),
  });
}

function isBenignExactHeadLifecycleReplayV1(
  previous: Readonly<Rfc64FinalizedSwmRetirementLifecycleReceiptV2> | undefined,
  current: Readonly<Rfc64FinalizedSwmRetirementLifecycleReceiptV2>,
): boolean {
  return previous?.vmMaterializationStatus === 'materialized'
    && previous.swmReconciliationOutcome === 'retired'
    && current.vmMaterializationStatus === 'existing'
    && current.swmReconciliationOutcome === 'already-retired-finalized'
    && previous.kind === current.kind
    && previous.contextGraphId === current.contextGraphId
    && previous.subGraphName === current.subGraphName
    && previous.kaUal === current.kaUal
    && previous.assertionVersion === current.assertionVersion
    && previous.vmGraphIri === current.vmGraphIri
    && previous.vmPostReadDigest === current.vmPostReadDigest;
}
