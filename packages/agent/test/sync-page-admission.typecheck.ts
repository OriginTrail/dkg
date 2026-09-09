import { fetchSyncPages } from '@origintrail-official/dkg-agent/dist/sync/requester/page-fetch.js';

// The published direct-page entry point derives admission from the deadline
// when a typed caller does not supply a private-job capability.
declare const directRequest: Omit<Parameters<typeof fetchSyncPages>[0], 'workAdmission'>;
void fetchSyncPages(directRequest);
