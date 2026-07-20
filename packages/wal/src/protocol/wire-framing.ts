import { decodeCanonicalCbor, encodeCanonicalCbor } from './canonical-cbor.js';
import { validateProtocolTuple } from './codec.js';
import type { CborProtocolValue, ProtocolTuple } from './schema.js';
import { WalWireError } from './wire-error.js';
import {
  WAL_WIRE_DETAIL_CODE,
  WAL_WIRE_ERROR_CODE,
  WAL_WIRE_LIMITS_V1,
  type WalWireLimits,
} from './wire-types.js';

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

export function encodeUnsignedVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WalWireError(WAL_WIRE_ERROR_CODE.RESOURCE_LIMIT, 'frame length must be a non-negative safe integer');
  }
  const output: number[] = [];
  let remaining = value;
  do {
    const next = remaining % 128;
    remaining = Math.floor(remaining / 128);
    output.push(next | (remaining > 0 ? 0x80 : 0));
  } while (remaining > 0);
  return Uint8Array.from(output);
}

export function decodeUnsignedVarint(bytes: Uint8Array): { value: number; byteLength: number } {
  let value = 0;
  let multiplier = 1;
  for (let index = 0; index < Math.min(bytes.length, 8); index += 1) {
    const byte = bytes[index];
    value += (byte & 0x7f) * multiplier;
    if (!Number.isSafeInteger(value)) {
      throw new WalWireError(WAL_WIRE_ERROR_CODE.RESOURCE_LIMIT, 'frame length exceeds the safe integer range');
    }
    if ((byte & 0x80) === 0) {
      if (index > 0 && byte === 0) {
        throw new WalWireError(
          WAL_WIRE_ERROR_CODE.NON_CANONICAL,
          'unsigned-varint length is not shortest-form',
          WAL_WIRE_DETAIL_CODE.MALFORMED_FRAME,
        );
      }
      return { value, byteLength: index + 1 };
    }
    multiplier *= 128;
  }
  throw new WalWireError(
    WAL_WIRE_ERROR_CODE.NON_CANONICAL,
    bytes.length < 8 ? 'truncated unsigned-varint length' : 'unsigned-varint length is too long',
    WAL_WIRE_DETAIL_CODE.MALFORMED_FRAME,
  );
}

function assertOuterFrame(value: CborProtocolValue): asserts value is ProtocolTuple<'FrameV1'> {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new WalWireError(WAL_WIRE_ERROR_CODE.NON_CANONICAL, 'FrameV1 must be an exact four-item tuple', WAL_WIRE_DETAIL_CODE.MALFORMED_FRAME);
  }
  const [version, messageType, requestId, body] = value;
  if (typeof version !== 'bigint' || version < 0n || version > 0xffffn) {
    throw new WalWireError(WAL_WIRE_ERROR_CODE.NON_CANONICAL, 'invalid protocol version field', WAL_WIRE_DETAIL_CODE.MALFORMED_FRAME);
  }
  if (version !== 1n) {
    throw new WalWireError(
      WAL_WIRE_ERROR_CODE.UNSUPPORTED_VERSION,
      'unsupported WAL wire protocol version',
      null,
      null,
      requestId instanceof Uint8Array && requestId.length === 16 ? requestId : undefined,
    );
  }
  if (typeof messageType !== 'bigint' || !(requestId instanceof Uint8Array) || !Array.isArray(body)) {
    throw new WalWireError(WAL_WIRE_ERROR_CODE.NON_CANONICAL, 'invalid FrameV1 field type', WAL_WIRE_DETAIL_CODE.MALFORMED_FRAME);
  }
  try {
    validateProtocolTuple('FrameV1', value);
  } catch (error) {
    throw new WalWireError(
      WAL_WIRE_ERROR_CODE.NON_CANONICAL,
      String(error),
      WAL_WIRE_DETAIL_CODE.MALFORMED_FRAME,
      null,
      requestId.length === 16 ? requestId : undefined,
    );
  }
}

export function encodeLengthPrefixedFrame(
  frame: ProtocolTuple<'FrameV1'>,
  maximumFrameBytes: number = WAL_WIRE_LIMITS_V1.maximumFrameBytes,
): Uint8Array {
  validateProtocolTuple('FrameV1', frame);
  const encoded = encodeCanonicalCbor(frame);
  if (encoded.length > maximumFrameBytes) {
    throw new WalWireError(WAL_WIRE_ERROR_CODE.RESOURCE_LIMIT, 'encoded WAL frame exceeds the negotiated limit');
  }
  return concat(encodeUnsignedVarint(encoded.length), encoded);
}

export function decodeLengthPrefixedFrame(
  bytes: Uint8Array,
  limits: Pick<WalWireLimits, 'maximumFrameBytes' | 'maximumCborArrayLength' | 'maximumCborDepth'> = WAL_WIRE_LIMITS_V1,
): ProtocolTuple<'FrameV1'> {
  const prefix = decodeUnsignedVarint(bytes);
  if (prefix.value > limits.maximumFrameBytes) {
    throw new WalWireError(WAL_WIRE_ERROR_CODE.RESOURCE_LIMIT, 'declared WAL frame exceeds the negotiated limit');
  }
  const actualLength = bytes.length - prefix.byteLength;
  if (actualLength !== prefix.value) {
    throw new WalWireError(
      WAL_WIRE_ERROR_CODE.NON_CANONICAL,
      actualLength < prefix.value ? 'truncated WAL frame' : 'trailing bytes after WAL frame',
      WAL_WIRE_DETAIL_CODE.LENGTH_MISMATCH,
    );
  }
  let value: CborProtocolValue;
  try {
    value = decodeCanonicalCbor(bytes.subarray(prefix.byteLength), {
      maxArrayLength: limits.maximumCborArrayLength,
      maxByteStringLength: limits.maximumFrameBytes,
      maxTextStringBytes: limits.maximumFrameBytes,
      maxDepth: limits.maximumCborDepth,
    });
  } catch (error) {
    throw new WalWireError(
      WAL_WIRE_ERROR_CODE.NON_CANONICAL,
      String(error),
      WAL_WIRE_DETAIL_CODE.MALFORMED_FRAME,
    );
  }
  assertOuterFrame(value);
  return value;
}
