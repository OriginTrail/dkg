// SPDX-License-Identifier: Apache-2.0

import type {
  Rfc64FinalizedSwmRetirementLifecycleReceiptV1,
} from './catalog-applied-head-coordinator-v1.js';
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
  receipts: readonly Readonly<Rfc64FinalizedSwmRetirementLifecycleReceiptV1>[],
): Rfc64CatalogSynchronizationEvidenceV1 {
  return Object.freeze({
    ...evidence,
    finalizedSwmRetirementLifecycleReceipts: Object.freeze(receipts.map((receipt) =>
      Object.freeze({
        ...receipt,
        committedHead: Object.freeze({ ...receipt.committedHead }),
      }))),
  });
}
