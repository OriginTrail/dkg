import type { Rfc64FinalizedSwmRetirementLifecycleReceiptV2 } from '../src/rfc64/finalized-swm-retirement-lifecycle-receipt-v1.js';
import type {
  FinalizedSwmTwinDescriptorReconciliationOutcome,
  FinalizedSwmTwinReconciliationOutcome,
  reconcileFinalizedSwmTwin,
  reconcileFinalizedSwmTwinFromCatalogProjection,
  reconcileFinalizedSwmTwinFromDescriptor,
} from '../src/sync/requester/finalized-swm-twin-reconciliation.js';

// Only the descriptor path reports a head left in part over a retired graph.
const residue: FinalizedSwmTwinDescriptorReconciliationOutcome = 'retired-head-residue';
// @ts-expect-error The shared outcomes never carry it.
const shared: FinalizedSwmTwinReconciliationOutcome = 'retired-head-residue';
// @ts-expect-error Nor does a catalog lifecycle receipt.
const receipt: Rfc64FinalizedSwmRetirementLifecycleReceiptV2['swmReconciliationOutcome'] = 'retired-head-residue';
void residue; void shared; void receipt;

declare const vmOutcome: Awaited<ReturnType<typeof reconcileFinalizedSwmTwin>>;
declare const catalogOutcome: Awaited<ReturnType<typeof reconcileFinalizedSwmTwinFromCatalogProjection>>;
declare const descriptorOutcome: Awaited<ReturnType<typeof reconcileFinalizedSwmTwinFromDescriptor>>;
// The VM and catalog arrivals return the shared outcomes.
const vm: FinalizedSwmTwinReconciliationOutcome = vmOutcome;
const catalog: FinalizedSwmTwinReconciliationOutcome = catalogOutcome;
// @ts-expect-error The descriptor path's outcomes are wider than the shared ones.
const descriptor: FinalizedSwmTwinReconciliationOutcome = descriptorOutcome;
void vm; void catalog; void descriptor;
