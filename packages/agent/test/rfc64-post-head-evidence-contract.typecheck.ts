import type { Rfc64CatalogAppliedHeadEvidenceV1 } from
  '../src/rfc64/finalized-swm-retirement-lifecycle-receipt-v1.js';
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

declare const agentEvidence: Rfc64CatalogSynchronizationEvidenceV1;
// @ts-expect-error Agent-facing evidence consumes and omits the neutral receiver extension field.
void agentEvidence.postAppliedHeadExtension;
