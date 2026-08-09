/**
 * The daemon's ONE doorway to the storage package's internal ownership
 * authority (#2165).
 *
 * `@origintrail-official/dkg-storage/internal/managed-oxigraph-ownership-v1`
 * is a documented internal entry point, not semver-covered public API. That
 * makes importing it an exceptional cross-package dependency, and exceptions
 * should be auditable in one place rather than scattered until they read as
 * ordinary architecture: every daemon module imports this bridge, so when the
 * storage-side authority moves or narrows, exactly one file knows.
 *
 * Re-export ONLY what the daemon actually uses — this bridge is an audit
 * surface, not a convenience barrel.
 */
export {
  attachManagedOxigraphLeaseV1,
  createManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphOwnershipLeaseV1,
  type ManagedOxigraphOwnershipSnapshotV1,
  type ManagedOxigraphSupervisorHandoffV1,
} from '@origintrail-official/dkg-storage/internal/managed-oxigraph-ownership-v1';
