/**
 * Dormant system-record V1 protocol foundation.
 *
 * Kept off the broad core barrel so legacy/default-disabled node startup does not
 * eagerly load the protocol's cryptographic and canonical-codec dependency graph.
 */
export * from './system-record-limits-v1.js';
export * from './system-record-objects-v1.js';
export * from './agent-profile-projection-schema-v1.js';
export * from './system-record-applied-state-v1.js';
export * from './system-record-inventory-v1.js';
export * from './system-record-wire-v1.js';
export { assertNetworkIdV1, type NetworkIdV1 } from './sync-wire-identifiers.js';
export { assertCanonicalDigest, type Digest32V1 } from './sync-wire-scalars.js';
