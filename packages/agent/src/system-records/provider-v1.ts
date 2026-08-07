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

export interface SystemRecordProviderRepositoryV1 {
  resolve(
    request: SystemRecordRequestHeaderV1,
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

interface ProviderResponseSenderV1 {
  sendSuccess(frame: Uint8Array): Promise<SystemRecordProviderServeOutcomeV1>;
  sendError(
    requestId: string,
    status: Exclude<SystemRecordResponseStatusV1, 'ok' | 'busy'>,
  ): Promise<SystemRecordProviderServeOutcomeV1>;
  release(): void;
}

interface CreateProviderResponseSenderOptionsV1 {
  readonly exchange: SystemRecordProviderExchangeV1;
  readonly signal: AbortSignal;
  readonly frameAdmission: SystemRecordProviderFrameAdmissionV1;
  readonly tokenBucket: SystemRecordProviderTokenBucketV1;
  readonly reset: (
    reason: SystemRecordProviderResetReasonV1,
  ) => SystemRecordProviderServeOutcomeV1;
  readonly onServed: () => void;
  readonly abortedReason: () => 'closed' | 'deadline' | 'invalid-frame';
  readonly initialReservationBytes?: number;
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
          const responder = createProviderResponseSenderV1({
            exchange,
            signal: controller.signal,
            frameAdmission: options.frameAdmission,
            tokenBucket: bucket,
            reset: (reason) => reset(exchange, reason),
            onServed: () => { served += 1; },
            abortedReason,
          })!;
          try {
            return await responder.sendError(request.requestId, 'unsupported');
          } finally {
            responder.release();
          }
        }

        const successFrameCapacity = maximumSuccessFrameBytes(request);
        const responder = createProviderResponseSenderV1({
          exchange,
          signal: controller.signal,
          frameAdmission: options.frameAdmission,
          tokenBucket: bucket,
          reset: (reason) => reset(exchange, reason),
          onServed: () => { served += 1; },
          abortedReason,
          initialReservationBytes: successFrameCapacity,
        });
        if (responder === null) return reset(exchange, 'memory-capacity');
        try {
          let artifact: SystemRecordProviderArtifactV1 | null;
          try {
            artifact = await raceAbort(
              options.repository.resolve(request, controller.signal),
              controller.signal,
            );
          } catch (error) {
            if (controller.signal.aborted) return reset(exchange, abortedReason());
            return await responder.sendError(request.requestId, 'internal');
          }
          if (artifact === null) return await responder.sendError(request.requestId, 'not-found');
          if (!(artifact.canonicalBytes instanceof Uint8Array)
            || artifact.canonicalBytes.byteLength < 1
            || artifact.canonicalBytes.byteLength > SYSTEM_RECORD_OBJECT_CAPS_V1[artifact.objectKind]
            || artifact.objectKind !== expectedObjectKind(request)
            || (request.operation !== 'get-root' && artifact.objectDigest !== request.objectDigest)) {
            return await responder.sendError(request.requestId, 'internal');
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
            return await responder.sendError(request.requestId, 'internal');
          }
          return await responder.sendSuccess(response);
        } finally {
          responder.release();
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

function createProviderResponseSenderV1(
  options: CreateProviderResponseSenderOptionsV1 & { readonly initialReservationBytes: number },
): ProviderResponseSenderV1 | null;
function createProviderResponseSenderV1(
  options: CreateProviderResponseSenderOptionsV1 & { readonly initialReservationBytes?: undefined },
): ProviderResponseSenderV1;
function createProviderResponseSenderV1(
  options: CreateProviderResponseSenderOptionsV1,
): ProviderResponseSenderV1 | null {
  let reservation = options.initialReservationBytes === undefined
    ? null
    : options.frameAdmission.tryReserve(options.initialReservationBytes);
  if (options.initialReservationBytes !== undefined && reservation === null) return null;
  let released = false;

  const sendFrame = async (
    frame: Uint8Array,
    admitted = takeReservation(),
  ): Promise<SystemRecordProviderServeOutcomeV1> => {
    const frameReservation = admitted ?? options.frameAdmission.tryReserve(frame.byteLength);
    if (frameReservation === null) return options.reset('memory-capacity');
    let responseTokens: ReturnType<SystemRecordProviderTokenBucketV1['tryReserveResponse']> = null;
    try {
      frameReservation.shrinkTo(frame.byteLength);
      responseTokens = options.tokenBucket.tryReserveResponse(frame.byteLength);
      if (responseTokens === null) return options.reset('response-rate');
      try {
        await raceAbort(
          options.exchange.writeResponseFrame(frame, options.signal),
          options.signal,
        );
      } catch {
        return options.reset(options.signal.aborted ? options.abortedReason() : 'write-failed');
      }
      responseTokens.commit();
      options.onServed();
      return 'served';
    } finally {
      responseTokens?.release();
      frameReservation.release();
    }
  };

  const takeReservation = () => {
    const current = reservation;
    reservation = null;
    return current;
  };

  return Object.freeze({
    sendSuccess(frame: Uint8Array) {
      return sendFrame(frame);
    },
    sendError(
      requestId: string,
      status: Exclude<SystemRecordResponseStatusV1, 'ok' | 'busy'>,
    ) {
      takeReservation()?.release();
      const errorCode = status === 'not-found'
        ? 'not_found'
        : status === 'invalid-request'
          ? 'invalid_request'
          : status;
      const response = encodeSystemRecordResponseFrameV1({
        wireVersion: SYSTEM_RECORD_WIRE_VERSION_V1,
        requestId,
        status,
        payloadBytes: '0',
        errorCode,
      }, EMPTY);
      return sendFrame(response, null);
    },
    release() {
      if (released) return;
      released = true;
      takeReservation()?.release();
    },
  });
}

function expectedObjectKind(request: SystemRecordRequestHeaderV1): SystemRecordObjectKindV1 {
  return request.operation === 'get-root' ? 'root-descriptor' : request.objectKind;
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
