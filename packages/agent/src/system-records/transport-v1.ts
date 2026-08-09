// SPDX-License-Identifier: Apache-2.0

import {
  SYSTEM_RECORD_MAX_FRAME_BYTES,
  SYSTEM_RECORD_PROVIDER_REQUEST_TOKEN_CAPACITY,
  SYSTEM_RECORD_PROVIDER_REQUEST_TOKEN_REFILL_PER_MINUTE,
  SYSTEM_RECORD_PROVIDER_RESPONSE_TOKEN_CAPACITY,
  SYSTEM_RECORD_PROVIDER_RESPONSE_TOKEN_REFILL_PER_MINUTE,
} from '@origintrail-official/dkg-core/system-record-v1';

import {
  createSystemRecordPermitGateV1,
  raceSystemRecordAbortV1,
  type SystemRecordByteAdmissionV1,
  type SystemRecordByteReservationV1,
  type SystemRecordPermitGateV1,
  type SystemRecordPermitV1,
} from './resource-admission-v1-internal.js';

export {
  createSystemRecordPermitGateV1,
  raceSystemRecordAbortV1,
};
export type {
  SystemRecordByteAdmissionV1,
  SystemRecordByteReservationV1,
  SystemRecordPermitAdmissionV1,
  SystemRecordPermitGateV1,
  SystemRecordPermitV1,
} from './resource-admission-v1-internal.js';

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

export type SystemRecordProviderPermitV1 = SystemRecordPermitV1;
export type SystemRecordProviderPermitGateV1 = SystemRecordPermitGateV1;

/** Compatibility facade for the canonical nonqueued System Record permit gate. */
export function createSystemRecordProviderPermitGateV1(): SystemRecordProviderPermitGateV1 {
  return createSystemRecordPermitGateV1();
}

export type SystemRecordProviderFrameReservationV1 = SystemRecordByteReservationV1;
export type SystemRecordProviderFrameAdmissionV1 = SystemRecordByteAdmissionV1;

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
