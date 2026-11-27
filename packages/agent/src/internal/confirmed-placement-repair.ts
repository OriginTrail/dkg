import type { ConfirmedCatalogObligationCompletionV1 } from '../dkg-agent-rfc64-swm-catalog-projection.js';
import type { Rfc64FinalizedPrivatePlacementRepairStoreV1, Rfc64FinalizedPrivatePlacementRepairV1 } from '../rfc64/finalized-private-placement-repair-store-v1.js';
import { rfc64SwmInventoryAssetKeyV1, rfc64SwmInventoryShadowRuntimeV1 } from '../rfc64/swm-inventory-shadow-runtime-v1.js';

/** Retire the durable placement owner only after its exact coverage/placement proof. */
export async function repairConfirmedPlacement(
  owner: object, repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
  store: Rfc64FinalizedPrivatePlacementRepairStoreV1, publish: () => Promise<ConfirmedCatalogObligationCompletionV1>,
): Promise<'repaired' | 'already-complete'> {
  const key = rfc64SwmInventoryAssetKeyV1({ contextGraphId: repair.contextGraphId,
    authorAddress: repair.authorAddress, assertionCoordinate: repair.assertionCoordinate });
  return rfc64SwmInventoryShadowRuntimeV1(owner).runExclusive(key, async () => {
    const applied = await publish();
    await store.delete(repair);
    return applied.action === 'private-placement' && applied.status === 'applied' ? 'repaired' : 'already-complete';
  });
}
