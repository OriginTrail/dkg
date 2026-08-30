// SPDX-License-Identifier: Apache-2.0

import type {
  Rfc64FinalizedSwmRetirementLifecycleReceiptV1,
} from './catalog-applied-head-evidence-v1.js';
import type {
  Rfc64PublicCatalogNativeSynchronizationEvidenceV1,
} from './public-catalog-native-receiver-v1.js';

/**
 * Canonical process-local receiver evidence. The native synchronization proof
 * owns any finalized VM-before-SWM lifecycle receipts produced by that same
 * transition; there is no second agent-wide history registry. Evidence is
 * cleared when the catalog service closes and is never used as durable truth.
 */
export type Rfc64CatalogSynchronizationEvidenceV1 = Readonly<
  Rfc64PublicCatalogNativeSynchronizationEvidenceV1 & {
    readonly finalizedSwmRetirementLifecycleReceipts:
      readonly Readonly<Rfc64FinalizedSwmRetirementLifecycleReceiptV1>[];
  }
>;

export function snapshotRfc64CatalogSynchronizationEvidenceV1(
  evidence: Readonly<Rfc64PublicCatalogNativeSynchronizationEvidenceV1>,
): Rfc64CatalogSynchronizationEvidenceV1 {
  const receipts = evidence.finalizedSwmRetirementLifecycleReceipts ?? [];
  const seenUals = new Set<string>();
  for (const receipt of receipts) {
    if (
      receipt.catalogHeadDigest !== evidence.catalogHeadDigest
      || receipt.inventoryDigest !== evidence.inventoryDigest
      || receipt.committedHead.catalogHeadDigest !== evidence.catalogHeadDigest
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
    ...evidence,
    finalizedSwmRetirementLifecycleReceipts: Object.freeze(receipts.map((receipt) =>
      Object.freeze({
        ...receipt,
        committedHead: Object.freeze({ ...receipt.committedHead }),
      }))),
  });
}
