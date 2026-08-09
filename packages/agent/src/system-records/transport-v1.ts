// SPDX-License-Identifier: Apache-2.0

import {
  SYSTEM_RECORD_MAX_FRAME_BYTES,
  SYSTEM_RECORD_PROVIDER_REQUEST_TOKEN_CAPACITY,
  SYSTEM_RECORD_PROVIDER_REQUEST_TOKEN_REFILL_PER_MINUTE,
  SYSTEM_RECORD_PROVIDER_RESPONSE_TOKEN_CAPACITY,
  SYSTEM_RECORD_PROVIDER_RESPONSE_TOKEN_REFILL_PER_MINUTE,
} from '@origintrail-official/dkg-core/system-record-v1';

export interface SystemRecordProviderTokenBucketSnapshotV1 {
  readonly requestTokens: number;
  readonly responseTokens: number;
}

export interface SystemRecordProviderResponseTokenReservationV1 {
  commit(): void;
  release(): void;
}

export interface SystemRecordProviderTokenBucketV1 {
  tryTakeRequest(): boolean;
  tryReserveResponse(bytes: number): SystemRecordProviderResponseTokenReservationV1 | null;
  snapshot(): SystemRecordProviderTokenBucketSnapshotV1;
}

export interface SystemRecordProviderTokenBucketOptionsV1 {
  readonly now?: () => number;
  readonly requestCapacity?: number;
  readonly requestRefillPerMinute?: number;
  readonly responseCapacity?: number;
  readonly responseRefillPerMinute?: number;
}

/** Request-driven dual token bucket. It owns no timer, waiter, peer map, or queue. */
export function createSystemRecordProviderTokenBucketV1(
  options: SystemRecordProviderTokenBucketOptionsV1 = {},
): SystemRecordProviderTokenBucketV1 {
  const now = options.now ?? (() => performance.now());
  const requestCapacity = positiveFinite(
    options.requestCapacity ?? SYSTEM_RECORD_PROVIDER_REQUEST_TOKEN_CAPACITY,
    'requestCapacity',
  );
  upperBound(requestCapacity, SYSTEM_RECORD_PROVIDER_REQUEST_TOKEN_CAPACITY, 'requestCapacity');
  const requestRefillPerMinute = positiveFinite(
    options.requestRefillPerMinute ?? SYSTEM_RECORD_PROVIDER_REQUEST_TOKEN_REFILL_PER_MINUTE,
    'requestRefillPerMinute',
  );
  upperBound(
    requestRefillPerMinute,
    SYSTEM_RECORD_PROVIDER_REQUEST_TOKEN_REFILL_PER_MINUTE,
    'requestRefillPerMinute',
  );
  const responseCapacity = positiveInteger(
    options.responseCapacity ?? SYSTEM_RECORD_PROVIDER_RESPONSE_TOKEN_CAPACITY,
    'responseCapacity',
  );
  upperBound(responseCapacity, SYSTEM_RECORD_PROVIDER_RESPONSE_TOKEN_CAPACITY, 'responseCapacity');
  const responseRefillPerMinute = positiveFinite(
    options.responseRefillPerMinute ?? SYSTEM_RECORD_PROVIDER_RESPONSE_TOKEN_REFILL_PER_MINUTE,
    'responseRefillPerMinute',
  );
  upperBound(
    responseRefillPerMinute,
    SYSTEM_RECORD_PROVIDER_RESPONSE_TOKEN_REFILL_PER_MINUTE,
    'responseRefillPerMinute',
  );
  let requestTokens = requestCapacity;
  let responseTokens = responseCapacity;
  let observedAt = finiteNow(now());

  const refill = () => {
    const current = finiteNow(now());
    if (current <= observedAt) return;
    const elapsedMinutes = (current - observedAt) / 60_000;
    requestTokens = Math.min(
      requestCapacity,
      requestTokens + elapsedMinutes * requestRefillPerMinute,
    );
    responseTokens = Math.min(
      responseCapacity,
      responseTokens + elapsedMinutes * responseRefillPerMinute,
    );
    observedAt = current;
  };

  return Object.freeze({
    tryTakeRequest(): boolean {
      refill();
      if (requestTokens < 1) return false;
      requestTokens -= 1;
      return true;
    },
    tryReserveResponse(bytes: number): SystemRecordProviderResponseTokenReservationV1 | null {
      const charged = positiveInteger(bytes, 'response bytes');
      if (charged > SYSTEM_RECORD_MAX_FRAME_BYTES || charged > responseCapacity) return null;
      refill();
      if (responseTokens < charged) return null;
      responseTokens -= charged;
      let state: 'reserved' | 'committed' | 'released' = 'reserved';
      return Object.freeze({
        commit(): void {
          if (state !== 'reserved') throw new Error('response token reservation is not live');
          state = 'committed';
        },
        release(): void {
          if (state === 'released') return;
          if (state === 'committed') return;
          responseTokens = Math.min(responseCapacity, responseTokens + charged);
          state = 'released';
        },
      });
    },
    snapshot(): SystemRecordProviderTokenBucketSnapshotV1 {
      refill();
      return Object.freeze({ requestTokens, responseTokens });
    },
  });
}

export interface SystemRecordProviderPermitV1 {
  release(): void;
}

export interface SystemRecordProviderPermitGateV1 {
  tryAcquire(): SystemRecordProviderPermitV1 | null;
  readonly active: 0 | 1;
}

/** One nonqueued provider permit. Absence is an immediate reset, never a waiter. */
export function createSystemRecordProviderPermitGateV1(): SystemRecordProviderPermitGateV1 {
  let held = false;
  return Object.freeze({
    tryAcquire(): SystemRecordProviderPermitV1 | null {
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

export interface SystemRecordProviderFrameReservationV1 {
  /** Return unused capacity while preserving the exact retained frame bytes. */
  shrinkTo(bytes: number): void;
  release(): void;
}

/**
 * Supplied by the one lifecycle-owned runtime accountant. This module never
 * constructs a private accountant or queues for capacity.
 */
export interface SystemRecordProviderFrameAdmissionV1 {
  tryReserve(bytes: number): SystemRecordProviderFrameReservationV1 | null;
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

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be positive and finite`);
  }
  return value;
}

function finiteNow(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('provider monotonic clock returned an invalid value');
  }
  return value;
}

function upperBound(value: number, maximum: number, label: string): void {
  if (value > maximum) {
    throw new TypeError(`${label} must not exceed the frozen V1 limit ${maximum}`);
  }
}
