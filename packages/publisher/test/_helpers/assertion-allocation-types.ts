import type { TripleStore } from '@origintrail-official/dkg-storage';
import { assertKaSlotOwnershipAvailable, withAssertionAllocation, type AssertionAllocationCoordinates } from '../../src/assertion-ka-slot-ownership.js';
import type { AssertionPhysicalIdentity } from '../../src/assertion-reservation.js';
import { decodeAssertionReservationIdentity, resolveStoredAssertionLifecycleOwner } from '../../src/assertion-reservation.js';
import type { AssertionLifecycleRecord } from '../../src/assertion-lifecycle-record.js';

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

declare const record: AssertionLifecycleRecord;
void decodeAssertionReservationIdentity(record, 'known-peer-owner');
void decodeAssertionReservationIdentity(record, resolveStoredAssertionLifecycleOwner(record,
  { contextGraphId: 'cg', lifecycleUri: 'urn:lifecycle' }));
// @ts-expect-error Stored ownership requires both context graph and lifecycle subject.
void resolveStoredAssertionLifecycleOwner(record, {});
// @ts-expect-error A partial stored-subject context cannot resolve a legacy owner.
void resolveStoredAssertionLifecycleOwner(record, { contextGraphId: 'cg' });
// @ts-expect-error A partial stored-subject context cannot resolve a legacy owner.
void resolveStoredAssertionLifecycleOwner(record, { lifecycleUri: 'urn:lifecycle' });
// @ts-expect-error Identity decoding requires an explicit resolved/unresolved owner.
void decodeAssertionReservationIdentity(record);
// @ts-expect-error Identity decoding does not infer a mode from coordinate fields.
void decodeAssertionReservationIdentity(record, {});
