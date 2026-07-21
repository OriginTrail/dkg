import { validateProtocolTuple } from './codec.js';
import type { CborProtocolValue, ProtocolTuple } from './schema.js';
import { WalWireError } from './wire-error.js';
import { decodeLengthPrefixedFrame, encodeLengthPrefixedFrame } from './wire-framing.js';
import {
  WAL_WIRE_DETAIL_CODE,
  WAL_WIRE_ERROR_CODE,
  WAL_WIRE_LIMITS_V1,
  walWireMethod,
  type WalWireFamily,
  type WalWireLimits,
  type WalWireMethodSpec,
} from './wire-types.js';

export interface DecodedWalRequest {
  readonly requestId: Uint8Array;
  readonly messageType: number;
  readonly method: WalWireMethodSpec;
  readonly context: ProtocolTuple<'RequestContextV1'>;
  readonly body: readonly CborProtocolValue[];
}

export type DecodedWalResponse =
  | { readonly ok: true; readonly requestId: Uint8Array; readonly messageType: number; readonly body: readonly CborProtocolValue[] }
  | { readonly ok: false; readonly requestId: Uint8Array; readonly error: ProtocolTuple<'ErrorV1'> };

function safeMessageType(value: bigint): number {
  return Number(value);
}

function schemaError(error: unknown, requestId?: Uint8Array): WalWireError {
  return new WalWireError(
    WAL_WIRE_ERROR_CODE.NON_CANONICAL,
    String(error),
    WAL_WIRE_DETAIL_CODE.BODY_SCHEMA,
    null,
    requestId,
  );
}

export function validateWalRequestBody(
  method: WalWireMethodSpec,
  body: readonly CborProtocolValue[],
  limits: WalWireLimits,
  requestId?: Uint8Array,
): void {
  try {
    validateProtocolTuple(method.requestSchema, body);
  } catch (error) {
    throw schemaError(error, requestId);
  }
  if (method.name === 'GET_RECONCILIATION_SYMBOLS') {
    const [,, first, count] = body as ProtocolTuple<'GetReconciliationSymbolsV1'>;
    if (count < 1n || count > BigInt(limits.maximumSymbolsPerResponse)) {
      throw new WalWireError(WAL_WIRE_ERROR_CODE.RESOURCE_LIMIT, 'symbol count exceeds the negotiated response window', null, null, requestId);
    }
    if (first + count > BigInt(WAL_WIRE_LIMITS_V1.maximumSymbolsPerAttempt)) {
      throw new WalWireError(WAL_WIRE_ERROR_CODE.RESOURCE_LIMIT, 'symbol window exceeds the version-1 attempt limit', null, null, requestId);
    }
  } else if (method.name === 'GET_OBJECT_IDS') {
    const limit = (body as ProtocolTuple<'GetObjectIdsV1'>)[2];
    if (limit < 1n || limit > BigInt(limits.maximumFallbackIdsPerPage)) {
      throw new WalWireError(WAL_WIRE_ERROR_CODE.RESOURCE_LIMIT, 'fallback page limit is outside the negotiated range', null, null, requestId);
    }
  } else if (method.name === 'GET_OBJECT_RANGE') {
    const [, offset, maximumLength] = body as ProtocolTuple<'GetWalObjectRangeV1'>;
    if (maximumLength < 1n || maximumLength > BigInt(limits.maximumObjectRangeBytes)) {
      throw new WalWireError(WAL_WIRE_ERROR_CODE.INVALID_RANGE, 'object range length is outside the negotiated range', null, null, requestId);
    }
    if (offset > limits.maximumWalObjectBytes) {
      throw new WalWireError(WAL_WIRE_ERROR_CODE.INVALID_RANGE, 'object range offset exceeds the WAL-object hard cap', null, null, requestId);
    }
  }
}

export function validateWalResponseBody(
  method: WalWireMethodSpec,
  body: readonly CborProtocolValue[],
  requestId?: Uint8Array,
): void {
  try {
    validateProtocolTuple(method.responseSchema, body);
  } catch (error) {
    throw schemaError(error, requestId);
  }
}

export function encodeWalRequestFrame(
  family: WalWireFamily,
  requestType: number,
  requestId: Uint8Array,
  context: ProtocolTuple<'RequestContextV1'>,
  body: readonly CborProtocolValue[],
  limits: WalWireLimits = WAL_WIRE_LIMITS_V1,
): Uint8Array {
  const method = walWireMethod(family, requestType);
  if (!method) {
    throw new WalWireError(WAL_WIRE_ERROR_CODE.NON_CANONICAL, 'unknown request method', WAL_WIRE_DETAIL_CODE.UNKNOWN_METHOD, null, requestId);
  }
  try {
    validateProtocolTuple('RequestContextV1', context);
  } catch (error) {
    throw schemaError(error, requestId);
  }
  validateWalRequestBody(method, body, limits, requestId);
  const authenticated: ProtocolTuple<'AuthenticatedRequestV1'> = [context, body];
  return encodeLengthPrefixedFrame([1n, BigInt(requestType), requestId, authenticated], limits.maximumFrameBytes);
}

export function decodeWalRequestFrame(
  family: WalWireFamily,
  bytes: Uint8Array,
  limits: WalWireLimits = WAL_WIRE_LIMITS_V1,
): DecodedWalRequest {
  const frame = decodeLengthPrefixedFrame(bytes, limits);
  const requestId = frame[2];
  const messageType = safeMessageType(frame[1]);
  const method = walWireMethod(family, messageType);
  if (!method) {
    throw new WalWireError(WAL_WIRE_ERROR_CODE.NON_CANONICAL, 'message type is not a request in this protocol family', WAL_WIRE_DETAIL_CODE.UNKNOWN_METHOD, null, requestId);
  }
  try {
    validateProtocolTuple('AuthenticatedRequestV1', frame[3]);
  } catch (error) {
    throw schemaError(error, requestId);
  }
  const authenticated = frame[3] as ProtocolTuple<'AuthenticatedRequestV1'>;
  return {
    requestId,
    messageType,
    method,
    context: authenticated[0],
    body: authenticated[1],
  };
}

export function encodeWalResponseFrame(
  method: WalWireMethodSpec,
  requestId: Uint8Array,
  body: readonly CborProtocolValue[],
  maximumFrameBytes: number = WAL_WIRE_LIMITS_V1.maximumFrameBytes,
): Uint8Array {
  validateWalResponseBody(method, body, requestId);
  return encodeLengthPrefixedFrame([1n, BigInt(method.responseType), requestId, body], maximumFrameBytes);
}

export function encodeWalErrorFrame(
  requestId: Uint8Array,
  error: ProtocolTuple<'ErrorV1'>,
  maximumFrameBytes: number = WAL_WIRE_LIMITS_V1.maximumFrameBytes,
): Uint8Array {
  validateProtocolTuple('ErrorV1', error);
  return encodeLengthPrefixedFrame([1n, 255n, requestId, error], maximumFrameBytes);
}

export function decodeWalResponseFrame(
  family: WalWireFamily,
  requestType: number,
  expectedRequestId: Uint8Array,
  bytes: Uint8Array,
  limits: WalWireLimits = WAL_WIRE_LIMITS_V1,
): DecodedWalResponse {
  const method = walWireMethod(family, requestType);
  if (!method) throw new WalWireError(WAL_WIRE_ERROR_CODE.NON_CANONICAL, 'unknown request method', WAL_WIRE_DETAIL_CODE.UNKNOWN_METHOD);
  const frame = decodeLengthPrefixedFrame(bytes, limits);
  const requestId = frame[2];
  if (!wireBytesEqual(requestId, expectedRequestId)) {
    throw new WalWireError(WAL_WIRE_ERROR_CODE.NON_CANONICAL, 'response requestId does not match the request', WAL_WIRE_DETAIL_CODE.RESPONSE_BINDING, null, requestId);
  }
  const messageType = safeMessageType(frame[1]);
  if (messageType === 255) {
    try {
      validateProtocolTuple('ErrorV1', frame[3]);
    } catch (error) {
      throw schemaError(error, requestId);
    }
    return { ok: false, requestId, error: frame[3] as ProtocolTuple<'ErrorV1'> };
  }
  if (messageType !== method.responseType) {
    throw new WalWireError(WAL_WIRE_ERROR_CODE.NON_CANONICAL, 'unexpected response message type', WAL_WIRE_DETAIL_CODE.RESPONSE_BINDING, null, requestId);
  }
  validateWalResponseBody(method, frame[3], requestId);
  return { ok: true, requestId, messageType, body: frame[3] };
}

export function wireBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export function compareWireBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}
