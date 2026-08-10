// SPDX-License-Identifier: Apache-2.0

import {
  SYSTEM_RECORD_MAX_FRAME_BYTES,
  decodeSystemRecordResponseFrameV1,
  verifySystemRecordResponsePayloadV1,
  type SystemRecordDecodedResponseFrameV1,
  type SystemRecordRequestHeaderV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import {
  cloneSystemRecordArtifactV1,
  type SystemRecordArtifactV1,
} from './artifact-v1.js';
import type {
  SystemRecordRequesterAdmissionV1,
  SystemRecordRequesterByteAdmissionV1,
  SystemRecordRequesterByteReservationV1,
  SystemRecordRequesterExchangeV1,
  SystemRecordRequesterResetReasonV1,
} from './requester-api-v1.js';
import {
  systemRecordExactResponseOutcomeV1,
  type SystemRecordRemoteFetchOutcomeV1,
} from './requester-wire-v1-internal.js';
import { raceSystemRecordAbortV1 } from './resource-admission-v1-internal.js';

export interface SystemRecordDecodedTransferV1 {
  readonly decoded: SystemRecordDecodedResponseFrameV1;
  readonly wireBytes: number;
}

export interface SystemRecordRetainedSourceV1 {
  readonly artifact: SystemRecordArtifactV1;
  readonly wireBytes: number;
  release(): void;
}

export type SystemRecordRetainTransferResultV1 =
  | Readonly<{ outcome: 'ok'; retained: SystemRecordRetainedSourceV1 }>
  | Readonly<{
    outcome: SystemRecordRemoteFetchOutcomeV1 | 'busy' | 'capacity';
    wireBytes: number;
  }>;

export async function openSystemRecordRequesterExchangeV1(input: {
  readonly openExchange: (signal: AbortSignal) => Promise<SystemRecordRequesterExchangeV1>;
  readonly signal: AbortSignal;
  readonly resetReason: () => SystemRecordRequesterResetReasonV1;
}): Promise<SystemRecordRequesterExchangeV1> {
  const opening = input.openExchange(input.signal);
  let accepted = false;
  void opening.then((lateExchange) => {
    if (accepted || !input.signal.aborted) return;
    try {
      lateExchange.reset(input.resetReason());
    } catch {
      // A late transport owns no requester resources; reset remains best-effort.
    }
  }, () => undefined);
  const exchange = await raceSystemRecordAbortV1(opening, input.signal);
  accepted = true;
  return exchange;
}

export async function exchangeSystemRecordResponseV1(input: {
  readonly request: SystemRecordRequestHeaderV1;
  readonly requestFrame: Uint8Array;
  readonly exchange: SystemRecordRequesterExchangeV1;
  readonly frameReservation: SystemRecordRequesterByteReservationV1;
  readonly signal: AbortSignal;
}): Promise<SystemRecordDecodedTransferV1> {
  let wireBytes = 0;
  try {
    await raceSystemRecordAbortV1(
      input.exchange.writeRequestFrame(input.requestFrame, input.signal),
      input.signal,
    );
    wireBytes = input.requestFrame.byteLength;
    const responseFrame = await raceSystemRecordAbortV1(
      input.exchange.readResponseFrame(SYSTEM_RECORD_MAX_FRAME_BYTES, input.signal),
      input.signal,
    );
    if (!(responseFrame instanceof Uint8Array)
      || responseFrame.byteLength < 1
      || responseFrame.byteLength > SYSTEM_RECORD_MAX_FRAME_BYTES) {
      throw new InvalidSystemRecordResponseError(wireBytes);
    }
    wireBytes += responseFrame.byteLength;
    input.frameReservation.shrinkTo(responseFrame.byteLength);
    let decoded: SystemRecordDecodedResponseFrameV1;
    try {
      decoded = decodeSystemRecordResponseFrameV1(responseFrame);
    } catch (error) {
      throw new InvalidSystemRecordResponseError(wireBytes, { cause: error });
    }
    return Object.freeze({
      decoded,
      wireBytes,
    });
  } catch (error) {
    if (error instanceof InvalidSystemRecordResponseError) throw error;
    if (wireBytes > 0) {
      throw new SystemRecordRequesterTransferError(wireBytes, { cause: error });
    }
    throw error;
  }
}

export function retainVerifiedSystemRecordResponseV1(input: {
  readonly request: SystemRecordRequestHeaderV1;
  readonly transfer: SystemRecordDecodedTransferV1;
  readonly decodeAdmission: SystemRecordRequesterAdmissionV1;
  readonly byteAdmission: SystemRecordRequesterByteAdmissionV1;
}): SystemRecordRetainTransferResultV1 {
  const { decoded, wireBytes } = input.transfer;
  if (decoded.header.status !== 'ok') {
    try {
      verifySystemRecordResponsePayloadV1(input.request, decoded.header, decoded.payload);
    } catch (error) {
      throw new InvalidSystemRecordResponseError(wireBytes, { cause: error });
    }
    return Object.freeze({
      outcome: systemRecordExactResponseOutcomeV1(decoded.header.status),
      wireBytes,
    });
  }

  const decodePermit = input.decodeAdmission.tryAcquire();
  if (decodePermit === null) return Object.freeze({ outcome: 'busy', wireBytes });
  try {
    try {
      verifySystemRecordResponsePayloadV1(input.request, decoded.header, decoded.payload);
    } catch (error) {
      throw new InvalidSystemRecordResponseError(wireBytes, { cause: error });
    }
    const payloadReservation = input.byteAdmission.tryReserve(decoded.payload.byteLength);
    if (payloadReservation === null) {
      decodePermit.release();
      return Object.freeze({ outcome: 'capacity', wireBytes });
    }
    try {
      const artifact = cloneSystemRecordArtifactV1({
        objectKind: decoded.header.objectKind,
        objectDigest: decoded.header.objectDigest,
        canonicalBytes: decoded.payload,
      });
      let released = false;
      return Object.freeze({
        outcome: 'ok',
        retained: Object.freeze({
          artifact,
          wireBytes,
          release(): void {
            if (released) return;
            released = true;
            payloadReservation.release();
            decodePermit.release();
          },
        }),
      });
    } catch (error) {
      payloadReservation.release();
      throw error;
    }
  } catch (error) {
    decodePermit.release();
    throw error;
  }
}

export class SystemRecordRequesterTransferError extends Error {
  constructor(
    readonly wireBytes: number,
    options?: ErrorOptions,
  ) {
    super('System Record transfer failed', options);
  }
}

export class InvalidSystemRecordResponseError extends SystemRecordRequesterTransferError {
  constructor(wireBytes: number, options?: ErrorOptions) {
    super(wireBytes, options);
    this.message = 'invalid System Record response';
  }
}
