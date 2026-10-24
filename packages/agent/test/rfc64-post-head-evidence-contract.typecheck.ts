import type {
  Rfc64CatalogAppliedHeadEvidenceV1,
  Rfc64FinalizedSwmRetirementLifecycleReceiptV1,
} from
  '../src/rfc64/finalized-swm-retirement-lifecycle-receipt-v1.js';
import type { Digest32V1 } from '@origintrail-official/dkg-core';
import type { Rfc64CatalogSynchronizationEvidenceV1 } from
  '../src/rfc64/catalog-synchronization-evidence-v1.js';
import type {
  Rfc64PublicCatalogNativeAppliedHeadLifecycleV1,
} from '../src/rfc64/public-catalog-native-receiver-v1.js';

const incompatibleLifecycle: Rfc64PublicCatalogNativeAppliedHeadLifecycleV1<
  Rfc64CatalogAppliedHeadEvidenceV1
> = {
  kind: 'rfc64-public-catalog-native-applied-head-lifecycle-v1',
  transaction: null,
  // @ts-expect-error The receiver and lifecycle producer must agree on exact extension evidence.
  afterAppliedHead: async () => ({ kind: 'different-post-head-evidence' }),
};
void incompatibleLifecycle;

declare const digest: Digest32V1;
const legacyReceiptCompatibility: Rfc64FinalizedSwmRetirementLifecycleReceiptV1 = {
  kind: 'rfc64-finalized-swm-retirement-lifecycle-receipt-v1',
  catalogHeadDigest: digest,
  inventoryDigest: digest,
  committedHead: {
    kind: 'rfc64-public-catalog-native-committed-head-token-v1',
    catalogHeadDigest: digest,
    inventoryDigest: digest,
  },
  contextGraphId: 'compatibility',
  kaUal: 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/1',
  assertionVersion: '1',
  vmGraphIri: 'did:dkg:context-graph:compatibility/ka/1/vm',
  vmPostReadDigest: digest,
  vmMaterializationStatus: 'materialized',
  swmReconciliationOutcome: 'retired',
};
void legacyReceiptCompatibility.catalogHeadDigest;
void legacyReceiptCompatibility.inventoryDigest;

declare const agentEvidence: Rfc64CatalogSynchronizationEvidenceV1;
// @ts-expect-error Agent-facing evidence consumes and omits the neutral receiver extension field.
void agentEvidence.postAppliedHeadExtension;
