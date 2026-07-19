import type { Rfc64PersistenceV1 } from '../src/rfc64/persistence-v1.js';
import type { Rfc64InventoryV1Foundation } from '../src/rfc64/inventory-v1/index.js';
import { openRfc64ControlObjectStoreForOwnedPersistenceRootV1 } from '../src/rfc64/control-object-store-v1-internal.js';

declare const persistence: Rfc64PersistenceV1;
declare const ownedInventory: Rfc64InventoryV1Foundation;

// The owner exposes operational views, never independently closable resources.
// @ts-expect-error inventory lifecycle belongs exclusively to persistence
persistence.inventory.close();
// @ts-expect-error control-store lifecycle belongs exclusively to persistence
await persistence.controlObjects.close();
// @ts-expect-error the non-owning inventory view cannot mint sibling resources
persistence.inventory.controlObjectStoreOwnership;
// @ts-expect-error startup purge authority is not a shared inventory operation
persistence.inventory.purgeNextStartupStaleCandidateBatch();

// @ts-expect-error public inventory foundations do not expose sibling-resource authority
ownedInventory.controlObjectStoreOwnership;
await openRfc64ControlObjectStoreForOwnedPersistenceRootV1(
  // @ts-expect-error an inventory object is not the package-internal ownership capability
  ownedInventory,
);
// @ts-expect-error a raw filesystem path cannot bypass inventory lease ownership
await openRfc64ControlObjectStoreForOwnedPersistenceRootV1('/tmp/rfc64-sync');
