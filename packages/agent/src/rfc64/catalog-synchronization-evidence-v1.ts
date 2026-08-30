// SPDX-License-Identifier: Apache-2.0

import type {
  Rfc64CatalogAppliedHeadEvidenceV1,
  Rfc64FinalizedSwmRetirementLifecycleReceiptV1,
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
      readonly Readonly<Rfc64FinalizedSwmRetirementLifecycleReceiptV1>[];
  }
>;

export function snapshotRfc64CatalogSynchronizationEvidenceV1(
  evidence: Readonly<Rfc64PublicCatalogNativeSynchronizationEvidenceV1<
    Rfc64CatalogAppliedHeadEvidenceV1
  >>,
  previous?: Readonly<Rfc64CatalogSynchronizationEvidenceV1>,
): Rfc64CatalogSynchronizationEvidenceV1 {
  const extension = evidence.postAppliedHeadExtension;
  if (extension !== undefined && extension.kind !== 'rfc64-catalog-applied-head-evidence-v1') {
    throw new TypeError('RFC-64 catalog synchronization post-head evidence is invalid');
  }
  const receipts = extension?.finalizedSwmRetirementLifecycleReceipts ?? [];
  const { postAppliedHeadExtension: _postAppliedHeadExtension, ...baseEvidence } = evidence;
  if (
    previous !== undefined
    && (
      previous.catalogHeadDigest !== evidence.catalogHeadDigest
      || previous.inventoryDigest !== evidence.inventoryDigest
    )
  ) {
    throw new TypeError('RFC-64 prior synchronization evidence belongs to a different head');
  }
  const previousByUal = new Map(
    (previous?.finalizedSwmRetirementLifecycleReceipts ?? [])
      .map((receipt) => [receipt.kaUal, receipt] as const),
  );
  const seenUals = new Set<string>();
  for (const receipt of receipts) {
    if (
      receipt.committedHead.catalogHeadDigest !== evidence.catalogHeadDigest
      || receipt.committedHead.inventoryDigest !== evidence.inventoryDigest
    ) {
      throw new TypeError(
        'RFC-64 lifecycle receipt differs from its synchronization evidence head',
      );
    }
    if (seenUals.has(receipt.kaUal)) {
      throw new TypeError(`RFC-64 synchronization evidence duplicates receipt ${receipt.kaUal}`);
    }
    seenUals.add(receipt.kaUal);
  }
  return Object.freeze({
    ...baseEvidence,
    finalizedSwmRetirementLifecycleReceipts: Object.freeze(receipts.map((receipt) => {
      const prior = previousByUal.get(receipt.kaUal);
      const retained = prior?.vmMaterializationStatus === 'materialized'
        && receipt.vmMaterializationStatus === 'existing'
        ? prior
        : receipt;
      return Object.freeze({
        ...retained,
        committedHead: Object.freeze({ ...retained.committedHead }),
      });
    })),
  });
}
