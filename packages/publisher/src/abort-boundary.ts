/**
 * Re-export of the shared lazy abort boundary (moved to @origintrail-official/dkg-core, PR
 * #2373 r6 3882186074) so publisher-internal call sites keep their import path. Still
 * deliberately not exported from the publisher barrel.
 */
export { resolveWithinAbort } from '@origintrail-official/dkg-core';
