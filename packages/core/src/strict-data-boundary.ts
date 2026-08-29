/**
 * Deliberate cross-package boundary for accessor-safe exact-field snapshots.
 *
 * Keep low-level wire-shape helpers private to core. Packages that validate a
 * closed public request may depend on this one stable operation instead of the
 * internal sync-wire implementation or the broad core package root.
 */
export { snapshotExactDataRecord } from './sync-wire-objects.js';
