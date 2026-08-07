import {
  SYSTEM_RECORD_MAX_RUNTIME_ACCOUNTED_BYTES,
} from '@origintrail-official/dkg-core/system-record-v1';

import {
  isManagedOxigraphOwnershipLeaseV1,
  readManagedOxigraphOwnershipSnapshotV1,
  type ManagedOxigraphOwnershipLeaseV1,
} from './managed-oxigraph-ownership-v1-internal.js';
import {
  createSystemRecordVerifiedReplacementRegistryForRuntimeV1,
  type SystemRecordRuntimeReservationGateV1,
  type SystemRecordVerifiedReplacementRegistryV1,
} from './system-record-verified-replacement-v1-internal.js';

interface SystemRecordRuntimeReservationStateV1 {
  liveOwner: object | null;
  accountedBytes: number;
}

/** One nonqueued process-wide gate shared by every authentic managed endpoint. */
const PROCESS_RESERVATION_STATE: SystemRecordRuntimeReservationStateV1 = {
  liveOwner: null,
  accountedBytes: 0,
};

const PROCESS_RESERVATION_GATE: SystemRecordRuntimeReservationGateV1 = Object.freeze({
  acquire(owner: object, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0
        || PROCESS_RESERVATION_STATE.liveOwner !== null
        || PROCESS_RESERVATION_STATE.accountedBytes + bytes
          > SYSTEM_RECORD_MAX_RUNTIME_ACCOUNTED_BYTES) {
      throw new Error('system-record atomic transient reservation is already live');
    }
    PROCESS_RESERVATION_STATE.liveOwner = owner;
    PROCESS_RESERVATION_STATE.accountedBytes += bytes;
  },
  release(owner: object, bytes: number): void {
    if (PROCESS_RESERVATION_STATE.liveOwner !== owner
        || PROCESS_RESERVATION_STATE.accountedBytes !== bytes) {
      throw new Error('system-record atomic transient accountant state is inconsistent');
    }
    PROCESS_RESERVATION_STATE.liveOwner = null;
    PROCESS_RESERVATION_STATE.accountedBytes = 0;
  },
});

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
