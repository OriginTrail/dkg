// SPDX-License-Identifier: Apache-2.0

import {
  assertCanonicalDecimalU64,
} from '@origintrail-official/dkg-core';
import {
  SYSTEM_RECORD_MAX_FRAME_BYTES,
  SYSTEM_RECORD_MAX_HEADER_BYTES,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  SYSTEM_RECORD_PROVIDER_EXCHANGE_TIMEOUT_MS,
  SYSTEM_RECORD_WIRE_VERSION_V1,
  decodeSystemRecordRequestFrameV1,
  decodeSystemRecordResponseFrameV1,
  encodeSystemRecordResponseFrameV1,
  verifySystemRecordResponsePayloadV1,
  type NetworkIdV1,
  type Digest32V1,
  type SystemRecordObjectKindV1,
  type SystemRecordRequestHeaderV1,
  type SystemRecordResponseStatusV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import {
  createSystemRecordProviderPermitGateV1,
  createSystemRecordProviderTokenBucketV1,
  type SystemRecordProviderFrameAdmissionV1,
  type SystemRecordProviderFrameReservationV1,
  type SystemRecordProviderPermitGateV1,
  type SystemRecordProviderTokenBucketV1,
} from './transport-v1.js';

const EMPTY = new Uint8Array();

export interface SystemRecordProviderArtifactV1 {
  readonly objectKind: SystemRecordObjectKindV1;
  readonly objectDigest: Digest32V1;
  readonly canonicalBytes: Uint8Array;
}

export function systemRecordProviderArtifactKeyV1(
  artifact: Pick<SystemRecordProviderArtifactV1, 'objectKind' | 'objectDigest'>,
): string {
  return `${artifact.objectKind}:${artifact.objectDigest}`;
}

export function cloneSystemRecordProviderArtifactV1(
  artifact: SystemRecordProviderArtifactV1,
): SystemRecordProviderArtifactV1 {
  return Object.freeze({
    objectKind: artifact.objectKind,
    objectDigest: artifact.objectDigest,
    canonicalBytes: Uint8Array.from(artifact.canonicalBytes),
  });
}

export type SystemRecordProviderLookupV1 =
  | Readonly<{ type: 'root' }>
  | Readonly<{
    type: 'object';
    objectKind: SystemRecordObjectKindV1;
    objectDigest: Digest32V1;
    rootDescriptorDigest?: Digest32V1;
  }>;

export interface SystemRecordProviderRepositoryV1 {
  resolve(
    lookup: SystemRecordProviderLookupV1,
    signal: AbortSignal,
  ): Promise<SystemRecordProviderArtifactV1 | null>;
}

export interface SystemRecordProviderExchangeV1 {
  readRequestFrame(signal: AbortSignal): Promise<Uint8Array>;
  writeResponseFrame(frame: Uint8Array, signal: AbortSignal): Promise<void>;
  reset(reason: SystemRecordProviderResetReasonV1): void;
}

export type SystemRecordProviderResetReasonV1 =
  | 'request-rate'
  | 'busy'
  | 'deadline'
  | 'invalid-frame'
  | 'memory-capacity'
  | 'response-rate'
  | 'write-failed'
  | 'closed';

export type SystemRecordProviderServeOutcomeV1 =
  | 'served'
  | 'reset-request-rate'
  | 'reset-busy'
  | 'reset-deadline'
  | 'reset-invalid-frame'
  | 'reset-memory-capacity'
  | 'reset-response-rate'
  | 'reset-write-failed'
  | 'reset-closed';

export interface SystemRecordProviderStatsV1 {
  readonly served: number;
  readonly resets: Readonly<Record<SystemRecordProviderResetReasonV1, number>>;
  readonly active: 0 | 1;
  readonly peakActive: 0 | 1;
  readonly queued: 0;
}

export interface CreateSystemRecordProviderOptionsV1 {
  readonly networkId: NetworkIdV1;
  readonly repository: SystemRecordProviderRepositoryV1;
  readonly frameAdmission: SystemRecordProviderFrameAdmissionV1;
  readonly tokenBucket?: SystemRecordProviderTokenBucketV1;
  readonly permitGate?: SystemRecordProviderPermitGateV1;
  readonly timeoutMs?: number;
}

export interface SystemRecordProviderV1 {
  serve(exchange: SystemRecordProviderExchangeV1): Promise<SystemRecordProviderServeOutcomeV1>;
  stats(): SystemRecordProviderStatsV1;
  close(): void;
}

/** Bounded request/response provider. Protocol registration remains lifecycle-owned. */
export function createSystemRecordProviderV1(
  options: CreateSystemRecordProviderOptionsV1,
): SystemRecordProviderV1 {
  const bucket = options.tokenBucket ?? createSystemRecordProviderTokenBucketV1();
  const permits = options.permitGate ?? createSystemRecordProviderPermitGateV1();
  const timeoutMs = positiveTimeout(
    options.timeoutMs ?? SYSTEM_RECORD_PROVIDER_EXCHANGE_TIMEOUT_MS,
  );
  const resetCounts: Record<SystemRecordProviderResetReasonV1, number> = {
    'request-rate': 0,
    busy: 0,
    deadline: 0,
    'invalid-frame': 0,
    'memory-capacity': 0,
    'response-rate': 0,
    'write-failed': 0,
    closed: 0,
  };
  const activeControllers = new Set<AbortController>();
  let served = 0;
  let peakActive: 0 | 1 = 0;
  let closed = false;

  const reset = (
    exchange: SystemRecordProviderExchangeV1,
    reason: SystemRecordProviderResetReasonV1,
  ): SystemRecordProviderServeOutcomeV1 => {
    resetCounts[reason] += 1;
    exchange.reset(reason);
    return `reset-${reason}` as SystemRecordProviderServeOutcomeV1;
  };

  return Object.freeze({
    async serve(exchange: SystemRecordProviderExchangeV1): Promise<SystemRecordProviderServeOutcomeV1> {
      if (closed) return reset(exchange, 'closed');
      if (!bucket.tryTakeRequest()) return reset(exchange, 'request-rate');
      const permit = permits.tryAcquire();
      if (permit === null) return reset(exchange, 'busy');
      peakActive = 1;
      const controller = new AbortController();
      activeControllers.add(controller);
      const timeout = setTimeout(
        () => controller.abort(new Error('system-record provider exchange deadline exceeded')),
        timeoutMs,
      );
      timeout.unref?.();
      try {
        let request: SystemRecordRequestHeaderV1;
        try {
          const requestFrame = await raceAbort(
            exchange.readRequestFrame(controller.signal),
            controller.signal,
          );
          if (!(requestFrame instanceof Uint8Array)
            || requestFrame.byteLength < 6
            || requestFrame.byteLength > 4 + SYSTEM_RECORD_MAX_HEADER_BYTES) {
            return reset(exchange, 'invalid-frame');
          }
          request = decodeSystemRecordRequestFrameV1(requestFrame);
        } catch (error) {
          return reset(exchange, abortedReason());
        }

        if (request.networkId !== options.networkId) {
          const response = encodeProviderErrorResponseV1(request.requestId, 'unsupported');
          const reservation = options.frameAdmission.tryReserve(response.byteLength);
          if (reservation === null) return reset(exchange, 'memory-capacity');
          try {
            return await sendProviderResponseV1(response, reservation);
          } finally {
            reservation.release();
          }
        }

        const successFrameCapacity = maximumSuccessFrameBytes(request);
        const reservation = options.frameAdmission.tryReserve(successFrameCapacity);
        if (reservation === null) return reset(exchange, 'memory-capacity');
        try {
          let artifact: SystemRecordProviderArtifactV1 | null;
          try {
            artifact = await raceAbort(
              options.repository.resolve(repositoryLookupV1(request), controller.signal),
              controller.signal,
            );
          } catch (error) {
            if (controller.signal.aborted) return reset(exchange, abortedReason());
            return await sendProviderResponseV1(
              encodeProviderErrorResponseV1(request.requestId, 'internal'),
              reservation,
            );
          }
          if (artifact === null) {
            return await sendProviderResponseV1(
              encodeProviderErrorResponseV1(request.requestId, 'not-found'),
              reservation,
            );
          }
          if (!(artifact.canonicalBytes instanceof Uint8Array)
            || artifact.canonicalBytes.byteLength < 1
            || artifact.canonicalBytes.byteLength > SYSTEM_RECORD_OBJECT_CAPS_V1[artifact.objectKind]
            || artifact.objectKind !== expectedObjectKind(request)
            || (request.operation !== 'get-root' && artifact.objectDigest !== request.objectDigest)) {
            return await sendProviderResponseV1(
              encodeProviderErrorResponseV1(request.requestId, 'internal'),
              reservation,
            );
          }
          const payloadBytes = artifact.canonicalBytes.byteLength.toString();
          assertCanonicalDecimalU64(payloadBytes, 'system-record response payloadBytes');
          const response = encodeSystemRecordResponseFrameV1({
            wireVersion: SYSTEM_RECORD_WIRE_VERSION_V1,
            requestId: request.requestId,
            status: 'ok',
            objectKind: artifact.objectKind,
            objectDigest: artifact.objectDigest,
            payloadBytes,
          }, artifact.canonicalBytes);
          try {
            const decoded = decodeSystemRecordResponseFrameV1(response);
            verifySystemRecordResponsePayloadV1(request, decoded.header, decoded.payload);
          } catch {
            return await sendProviderResponseV1(
              encodeProviderErrorResponseV1(request.requestId, 'internal'),
              reservation,
            );
          }
          return await sendProviderResponseV1(response, reservation);
        } finally {
          reservation.release();
        }

        async function sendProviderResponseV1(
          response: Uint8Array,
          reservation: SystemRecordProviderFrameReservationV1,
        ): Promise<SystemRecordProviderServeOutcomeV1> {
          let responseTokens: ReturnType<SystemRecordProviderTokenBucketV1['tryReserveResponse']> = null;
          try {
            reservation.shrinkTo(response.byteLength);
            responseTokens = bucket.tryReserveResponse(response.byteLength);
            if (responseTokens === null) return reset(exchange, 'response-rate');
            try {
              await raceAbort(
                exchange.writeResponseFrame(response, controller.signal),
                controller.signal,
              );
            } catch {
              return reset(exchange, controller.signal.aborted ? abortedReason() : 'write-failed');
            }
            responseTokens.commit();
            served += 1;
            return 'served';
          } finally {
            responseTokens?.release();
          }
        }

        function abortedReason(): 'closed' | 'deadline' | 'invalid-frame' {
          if (!controller.signal.aborted) return 'invalid-frame';
          return closed ? 'closed' : 'deadline';
        }
      } finally {
        clearTimeout(timeout);
        activeControllers.delete(controller);
        permit.release();
      }
    },
    stats(): SystemRecordProviderStatsV1 {
      return Object.freeze({
        served,
        resets: Object.freeze({ ...resetCounts }),
        active: permits.active,
        peakActive,
        queued: 0,
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const controller of activeControllers) {
        controller.abort(new Error('system-record provider closed'));
      }
    },
  });
}

function maximumSuccessFrameBytes(request: SystemRecordRequestHeaderV1): number {
  return Math.min(
    SYSTEM_RECORD_MAX_FRAME_BYTES,
    4 + SYSTEM_RECORD_MAX_HEADER_BYTES + SYSTEM_RECORD_OBJECT_CAPS_V1[expectedObjectKind(request)],
  );
}

function encodeProviderErrorResponseV1(
  requestId: string,
  status: Exclude<SystemRecordResponseStatusV1, 'ok' | 'busy'>,
): Uint8Array {
  const errorCode = status === 'not-found'
    ? 'not_found'
    : status === 'invalid-request'
      ? 'invalid_request'
      : status;
  return encodeSystemRecordResponseFrameV1({
    wireVersion: SYSTEM_RECORD_WIRE_VERSION_V1,
    requestId,
    status,
    payloadBytes: '0',
    errorCode,
  }, EMPTY);
}

function expectedObjectKind(request: SystemRecordRequestHeaderV1): SystemRecordObjectKindV1 {
  return request.operation === 'get-root' ? 'root-descriptor' : request.objectKind;
}

function repositoryLookupV1(request: SystemRecordRequestHeaderV1): SystemRecordProviderLookupV1 {
  if (request.operation === 'get-root') return Object.freeze({ type: 'root' });
  return Object.freeze({
    type: 'object',
    objectKind: request.objectKind,
    objectDigest: request.objectDigest,
    ...(request.operation === 'get-inventory-object'
      ? { rootDescriptorDigest: request.rootDescriptorDigest }
      : {}),
  });
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1
    || value > SYSTEM_RECORD_PROVIDER_EXCHANGE_TIMEOUT_MS) {
    throw new TypeError(
      `provider timeout must be in 1..${SYSTEM_RECORD_PROVIDER_EXCHANGE_TIMEOUT_MS}ms`,
    );
  }
  return value;
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
