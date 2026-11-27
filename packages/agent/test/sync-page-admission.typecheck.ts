import { fetchSyncPages } from '@origintrail-official/dkg-agent/dist/sync/requester/page-fetch.js';
import { sendSyncRequest } from '@origintrail-official/dkg-agent/dist/p2p/sync-transport.js';

// The published direct-page entry point derives admission from the deadline
// when a typed caller does not supply a private-job capability.
declare const directRequest: Omit<Parameters<typeof fetchSyncPages>[0], 'workAdmission'>;
void fetchSyncPages(directRequest);

// The published transport entry point preserves its pre-admission call shape.
declare const legacyTransportRequest: Omit<Parameters<typeof sendSyncRequest>[0], 'workAdmission'>;
void sendSyncRequest(legacyTransportRequest);
