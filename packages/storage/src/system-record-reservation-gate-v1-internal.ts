import {
  SYSTEM_RECORD_MAX_RUNTIME_ACCOUNTED_BYTES,
} from '@origintrail-official/dkg-core/system-record-v1';

export interface SystemRecordRuntimeReservationGateV1 {
  acquire(owner: object, bytes: number): void;
  release(owner: object, bytes: number): void;
}

/** One exact, nonqueued reservation with no partial-release state. */
export function createSystemRecordNonQueuedReservationGateV1(): SystemRecordRuntimeReservationGateV1 {
  let liveOwner: object | null = null;
  let accountedBytes = 0;
  return Object.freeze({
    acquire(owner: object, bytes: number): void {
      if (!Number.isSafeInteger(bytes) || bytes <= 0
          || liveOwner !== null
          || accountedBytes + bytes > SYSTEM_RECORD_MAX_RUNTIME_ACCOUNTED_BYTES) {
        throw new Error('system-record atomic transient reservation is already live');
      }
      liveOwner = owner;
      accountedBytes += bytes;
    },
    release(owner: object, bytes: number): void {
      if (liveOwner !== owner || accountedBytes !== bytes) {
        throw new Error('system-record atomic transient accountant state is inconsistent');
      }
      liveOwner = null;
      accountedBytes = 0;
    },
  });
}
