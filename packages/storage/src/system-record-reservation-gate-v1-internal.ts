import {
  SYSTEM_RECORD_MAX_RUNTIME_ACCOUNTED_BYTES,
} from '@origintrail-official/dkg-core/system-record-v1';

export interface SystemRecordRuntimeReservationLeaseV1 {
  release(): void;
}

export interface SystemRecordRuntimeReservationGateV1 {
  acquire(bytes: number): SystemRecordRuntimeReservationLeaseV1;
}

/** One exact, nonqueued reservation with no partial-release state. */
export function createSystemRecordNonQueuedReservationGateV1(): SystemRecordRuntimeReservationGateV1 {
  let liveLeaseIdentity: object | null = null;
  let accountedBytes = 0;
  return Object.freeze({
    acquire(bytes: number): SystemRecordRuntimeReservationLeaseV1 {
      if (!Number.isSafeInteger(bytes) || bytes <= 0
          || liveLeaseIdentity !== null
          || accountedBytes + bytes > SYSTEM_RECORD_MAX_RUNTIME_ACCOUNTED_BYTES) {
        throw new Error('system-record atomic transient reservation is already live');
      }
      const leaseIdentity = Object.freeze(Object.create(null) as object);
      liveLeaseIdentity = leaseIdentity;
      accountedBytes += bytes;
      let released = false;
      return Object.freeze({
        release(): void {
          if (released || liveLeaseIdentity !== leaseIdentity) {
            throw new Error('system-record atomic transient reservation was already released');
          }
          released = true;
          liveLeaseIdentity = null;
          accountedBytes = 0;
        },
      });
    },
  });
}
