// SPDX-License-Identifier: Apache-2.0

import type { Digest32V1 } from '@origintrail-official/dkg-core';

import type { FinalizedSwmTwinReconciliationOutcome } from
  '../sync/requester/finalized-swm-twin-reconciliation.js';
import type { Rfc64PublicCatalogNativeCommittedHeadTokenV1 } from
  './public-catalog-native-receiver-v1.js';

/**
 * Explicit per-KA proof of the only safe finalized-twin lifecycle:
 * verified VM post-read, VM transaction commit, durable applied-head token,
 * then SWM retirement.
 */
export interface Rfc64FinalizedSwmRetirementLifecycleReceiptV1 {
  readonly kind: 'rfc64-finalized-swm-retirement-lifecycle-receipt-v1';
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly vmGraphIri: string;
  readonly vmPostReadDigest: Digest32V1;
  readonly vmMaterializationStatus: 'materialized' | 'existing';
  readonly swmReconciliationOutcome: FinalizedSwmTwinReconciliationOutcome;
}

/** Agent-layer result carried through the receiver's neutral post-head extension. */
export interface Rfc64CatalogAppliedHeadEvidenceV1 {
  readonly kind: 'rfc64-catalog-applied-head-evidence-v1';
  readonly committedHead: Readonly<Rfc64PublicCatalogNativeCommittedHeadTokenV1>;
  readonly finalizedSwmRetirementLifecycleReceipts:
    readonly Readonly<Rfc64FinalizedSwmRetirementLifecycleReceiptV1>[];
}
