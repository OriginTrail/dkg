import {
  isManagedOxigraphOwnershipLeaseV1,
  readManagedOxigraphOwnershipSnapshotV1,
  type ManagedOxigraphOwnershipLeaseV1,
} from './internal/managed-oxigraph-ownership-v1.js';
import {
  createSystemRecordVerifiedReplacementRegistryForRuntimeV1,
  type SystemRecordVerifiedReplacementRegistryV1,
} from './system-record-verified-replacement-v1-internal.js';
import { createSystemRecordNonQueuedReservationGateV1 } from './system-record-reservation-gate-v1-internal.js';

/** One nonqueued process-wide gate shared by every authentic managed endpoint. */
const PROCESS_RESERVATION_GATE = createSystemRecordNonQueuedReservationGateV1();

const OWNED_RUNTIMES = new WeakMap<
  ManagedOxigraphOwnershipLeaseV1,
  SystemRecordVerifiedReplacementRegistryV1
>();

/**
 * Resolve the single proof runtime bound to an authentic daemon ownership lease.
 * Persisted options and structural look-alikes cannot mint this authority.
 */
export function resolveOwnedSystemRecordRuntimeV1(
  lease: ManagedOxigraphOwnershipLeaseV1,
): SystemRecordVerifiedReplacementRegistryV1 {
  if (!isManagedOxigraphOwnershipLeaseV1(lease)) {
    throw new Error('system-record runtime requires an authentic managed Oxigraph ownership lease');
  }
  const ownership = readManagedOxigraphOwnershipSnapshotV1(lease);
  if (ownership?.queryEndpoint === undefined || ownership.updateEndpoint === undefined) {
    throw new Error('system-record runtime requires an endpoint-bound managed Oxigraph ownership lease');
  }
  const existing = OWNED_RUNTIMES.get(lease);
  if (existing !== undefined) return existing;

  const runtime = createSystemRecordVerifiedReplacementRegistryForRuntimeV1({
    reservationGate: PROCESS_RESERVATION_GATE,
    assertAvailable: () => {
      const snapshot = readManagedOxigraphOwnershipSnapshotV1(lease);
      if (!snapshot?.ready || snapshot.terminal
          || snapshot.queryEndpoint !== ownership.queryEndpoint
          || snapshot.updateEndpoint !== ownership.updateEndpoint) {
        throw new Error('system-record runtime ownership lease is not ready');
      }
    },
  });
  OWNED_RUNTIMES.set(lease, runtime);
  return runtime;
}
