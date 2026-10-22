import type { TripleStore } from '@origintrail-official/dkg-storage';
import { assertKaSlotOwnershipAvailable, withAssertionAllocation, type AssertionAllocationCoordinates } from '../../src/assertion-ka-slot-ownership.js';
import type { AssertionPhysicalIdentity } from '../../src/assertion-reservation.js';

declare const store: TripleStore;
declare const coordinates: AssertionAllocationCoordinates;
declare const physicalIdentity: AssertionPhysicalIdentity;
void assertKaSlotOwnershipAvailable(store, coordinates, physicalIdentity);
void withAssertionAllocation(store, coordinates, physicalIdentity, async () => 'created');
// @ts-expect-error Lifecycle ownership cannot implicitly select the physical KA.
void assertKaSlotOwnershipAvailable(store, coordinates);
// @ts-expect-error Allocation requires a physical identity before its mutation.
void withAssertionAllocation(store, coordinates, async () => 'created');
// @ts-expect-error A lifecycle coordinate is not a physical identity.
void withAssertionAllocation(store, coordinates, coordinates, async () => 'created');
