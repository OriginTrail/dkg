import type { SwmInventoryWriteOutcome } from '../src/internal/swm-inventory-write.js';
const success: SwmInventoryWriteOutcome = { status: 'applied', attempts: 1, headObjectDigest: 'digest', kaUal: 'did:dkg:asset' };
const dormant: SwmInventoryWriteOutcome = { status: 'dormant', attempts: 0, headObjectDigest: null, kaUal: null, dormantReason: 'inactive-lane' };
// @ts-expect-error Applied writes must carry their committed head and asset identity.
const invalidSuccess: SwmInventoryWriteOutcome = { status: 'applied', attempts: 1, headObjectDigest: null, kaUal: null };
// @ts-expect-error Every dormant outcome must state why the write did not run.
const missingReason: SwmInventoryWriteOutcome = { status: 'dormant', attempts: 0, headObjectDigest: null, kaUal: null };
void [success, dormant, invalidSuccess, missingReason];
