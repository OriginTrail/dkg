import { concat, equalBytes } from './bytes.js';
import { decodeCanonical, encodeCanonical, type CborValue } from './cbor.js';

export interface WireFrameV1 {
  readonly protocolVersion: bigint;
  readonly messageType: bigint;
  readonly requestId: Uint8Array;
  readonly body: readonly CborValue[];
}

export function encodeUnsignedVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('wire length must be a non-negative safe integer');
  const bytes: number[] = [];
  let remaining = value;
  do {
    const low = remaining % 128;
    remaining = Math.floor(remaining / 128);
    bytes.push(low | (remaining === 0 ? 0 : 0x80));
  } while (remaining !== 0);
  return Uint8Array.from(bytes);
}

export function decodeUnsignedVarint(bytes: Uint8Array): { value: number; byteLength: number } {
  let value = 0;
  let multiplier = 1;
  for (let index = 0; index < Math.min(bytes.length, 8); index += 1) {
    const byte = bytes[index];
    value += (byte & 0x7f) * multiplier;
    if (!Number.isSafeInteger(value)) throw new Error('wire length exceeds the safe integer range');
    if ((byte & 0x80) === 0) {
      if (index > 0 && byte === 0) throw new Error('wire length is not shortest-form');
      return { value, byteLength: index + 1 };
    }
    multiplier *= 128;
  }
  throw new Error(bytes.length < 8 ? 'truncated wire length' : 'wire length is too long');
}

export function encodeWireFrame(frame: WireFrameV1): Uint8Array {
  assertWireFrame(frame);
  const cbor = encodeCanonical([
    frame.protocolVersion,
    frame.messageType,
    frame.requestId,
    frame.body,
  ]);
  return concat(encodeUnsignedVarint(cbor.length), cbor);
}

export function decodeWireFrame(bytes: Uint8Array): WireFrameV1 {
  const prefix = decodeUnsignedVarint(bytes);
  const cbor = bytes.subarray(prefix.byteLength);
  if (cbor.length !== prefix.value) throw new Error(cbor.length < prefix.value ? 'truncated wire frame' : 'trailing wire bytes');
  const decoded = decodeCanonical(cbor);
  if (!Array.isArray(decoded) || decoded.length !== 4) throw new Error('FrameV1 must be an exact four-item tuple');
  const frame: WireFrameV1 = {
    protocolVersion: decoded[0] as bigint,
    messageType: decoded[1] as bigint,
    requestId: decoded[2] as Uint8Array,
    body: decoded[3] as readonly CborValue[],
  };
  assertWireFrame(frame);
  return frame;
}

function assertWireFrame(frame: WireFrameV1): void {
  if (frame.protocolVersion !== 1n) throw new Error('unsupported wire protocol version');
  if (typeof frame.messageType !== 'bigint' || frame.messageType < 0n || frame.messageType > 0xffffn) {
    throw new Error('invalid wire message type');
  }
  if (!(frame.requestId instanceof Uint8Array) || frame.requestId.length !== 16) throw new Error('invalid wire request ID');
  if (!Array.isArray(frame.body)) throw new Error('invalid wire body');
}

export function wireFramesEqual(left: WireFrameV1, right: WireFrameV1): boolean {
  return left.protocolVersion === right.protocolVersion &&
    left.messageType === right.messageType &&
    equalBytes(left.requestId, right.requestId) &&
    equalBytes(encodeCanonical(left.body), encodeCanonical(right.body));
}
