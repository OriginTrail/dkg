// SPDX-License-Identifier: Apache-2.0

export interface SystemRecordPermitV1 {
  release(): void;
}

export interface SystemRecordPermitAdmissionV1 {
  tryAcquire(): SystemRecordPermitV1 | null;
}

export interface SystemRecordPermitGateV1 extends SystemRecordPermitAdmissionV1 {
  readonly active: 0 | 1;
}

/** One nonqueued permit. Absence is an immediate refusal, never a waiter. */
export function createSystemRecordPermitGateV1(): SystemRecordPermitGateV1 {
  let held = false;
  return Object.freeze({
    tryAcquire(): SystemRecordPermitV1 | null {
      if (held) return null;
      held = true;
      let released = false;
      return Object.freeze({
        release(): void {
          if (released) return;
          released = true;
          held = false;
        },
      });
    },
    get active(): 0 | 1 {
      return held ? 1 : 0;
    },
  });
}

export interface SystemRecordByteReservationV1 {
  /** Return unused capacity while preserving the exact retained bytes. */
  shrinkTo(bytes: number): void;
  release(): void;
}

/** Supplied by the one lifecycle-owned runtime accountant; it never queues. */
export interface SystemRecordByteAdmissionV1 {
  tryReserve(bytes: number): SystemRecordByteReservationV1 | null;
}

/** Shared abort race for bounded System Record requester/provider exchanges. */
export function raceSystemRecordAbortV1<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
