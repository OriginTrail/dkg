import type { Rfc64PersistenceV1 } from '../src/rfc64/persistence-v1.js';

declare const persistence: Rfc64PersistenceV1;

// The owner exposes operational views, never independently closable resources.
// @ts-expect-error inventory lifecycle belongs exclusively to persistence
persistence.inventory.close();
// @ts-expect-error control-store lifecycle belongs exclusively to persistence
await persistence.controlObjects.close();
