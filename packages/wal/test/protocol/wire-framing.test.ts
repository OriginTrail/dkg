import { describe, expect, it } from 'vitest';
import {
  decodeCanonicalCbor,
  decodeLengthPrefixedFrame,
  decodeUnsignedVarint,
  encodeCanonicalCbor,
  encodeLengthPrefixedFrame,
  encodeUnsignedVarint,
  WAL_WIRE_ERROR_CODE,
  WAL_WIRE_LIMITS_V1,
} from '../../src/protocol/index.js';
import { requestId } from './wire-fixtures.js';

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function fromHex(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'hex'));
}

describe('WAL v1 unsigned-varint and deterministic-CBOR framing', () => {
  it.each([
    [0, '00'],
    [1, '01'],
    [127, '7f'],
    [128, '8001'],
    [255, 'ff01'],
    [16_384, '808001'],
    [1_048_576, '808040'],
  ])('round-trips canonical unsigned varint %i', (value, encoded) => {
    const bytes = encodeUnsignedVarint(value);
    expect(hex(bytes)).toBe(encoded);
    expect(decodeUnsignedVarint(bytes)).toEqual({ value, byteLength: bytes.length });
  });

  it('rejects invalid, truncated, overlong, non-shortest, and unsafe varints', () => {
    expect(() => encodeUnsignedVarint(-1)).toThrow(expect.objectContaining({ code: WAL_WIRE_ERROR_CODE.RESOURCE_LIMIT }));
    expect(() => encodeUnsignedVarint(1.5)).toThrow();
    expect(() => decodeUnsignedVarint(new Uint8Array())).toThrow(/truncated/);
    expect(() => decodeUnsignedVarint(fromHex('8100'))).toThrow(/shortest/);
    expect(() => decodeUnsignedVarint(fromHex('8080808080808080'))).toThrow(/too long|safe integer/);
    expect(() => decodeUnsignedVarint(fromHex('ffffffffffffff7f'))).toThrow(/safe integer/);
  });

  it('round-trips one exact frame and rejects length ambiguity', () => {
    const frame = [1n, 9n, requestId(1), []] as const;
    const encoded = encodeLengthPrefixedFrame(frame);
    expect(decodeLengthPrefixedFrame(encoded)).toEqual(frame);
    expect(() => decodeLengthPrefixedFrame(encoded.subarray(0, encoded.length - 1))).toThrow(/truncated/);
    expect(() => decodeLengthPrefixedFrame(Uint8Array.from([...encoded, 0]))).toThrow(/trailing/);
    expect(() => decodeLengthPrefixedFrame(Uint8Array.of(0x81, 0x00, 0x80))).toThrow(/shortest/);
    expect(() => encodeLengthPrefixedFrame(frame, 1)).toThrow(/exceeds/);
    expect(() => decodeLengthPrefixedFrame(Uint8Array.of(0x80, 0x80, 0x40), { ...WAL_WIRE_LIMITS_V1, maximumFrameBytes: 16 })).toThrow(/exceeds/);
  });

  it('distinguishes unsupported versions while retaining a valid request ID', () => {
    const id = requestId(2);
    const cbor = encodeCanonicalCbor([2n, 0n, id, []]);
    const framed = Uint8Array.from([...encodeUnsignedVarint(cbor.length), ...cbor]);
    expect(() => decodeLengthPrefixedFrame(framed)).toThrow(expect.objectContaining({
      code: WAL_WIRE_ERROR_CODE.UNSUPPORTED_VERSION,
      requestId: id,
    }));
    const withoutBoundId = encodeCanonicalCbor([2n, 0n, new Uint8Array(15), []]);
    const withoutBoundIdFrame = Uint8Array.from([...encodeUnsignedVarint(withoutBoundId.length), ...withoutBoundId]);
    expect(() => decodeLengthPrefixedFrame(withoutBoundIdFrame)).toThrow(expect.objectContaining({
      code: WAL_WIRE_ERROR_CODE.UNSUPPORTED_VERSION,
      requestId: undefined,
    }));
  });

  it.each([
    [encodeCanonicalCbor([]), /four-item/],
    [encodeCanonicalCbor([-1n, 0n, requestId(1), []]), /version/],
    [encodeCanonicalCbor([1n, 'bad', requestId(1), []]), /field type/],
    [encodeCanonicalCbor([1n, 0n, new Uint8Array(15), []]), /requestId/],
    [fromHex('9f'), /canonical|indefinite/],
  ])('rejects malformed outer frame %#', (cbor, expected) => {
    const framed = Uint8Array.from([...encodeUnsignedVarint(cbor.length), ...cbor]);
    expect(() => decodeLengthPrefixedFrame(framed)).toThrow(expected);
  });

  it('retains a valid request ID when another FrameV1 field fails schema validation', () => {
    const id = requestId(9);
    const cbor = encodeCanonicalCbor([1n, 70_000n, id, []]);
    const framed = Uint8Array.from([...encodeUnsignedVarint(cbor.length), ...cbor]);
    expect(() => decodeLengthPrefixedFrame(framed)).toThrow(expect.objectContaining({ requestId: id }));
  });

  it('applies array, string, and recursion limits before proportional allocation', () => {
    expect(() => decodeCanonicalCbor(fromHex('850000000000'), { maxArrayLength: 4 })).toThrow(/array length/);
    expect(() => decodeCanonicalCbor(fromHex('4400000000'), { maxByteStringLength: 3 })).toThrow(/string length/);
    expect(() => decodeCanonicalCbor(fromHex('6461626364'), { maxTextStringBytes: 3 })).toThrow(/string length/);
    expect(() => decodeCanonicalCbor(fromHex('818100'), { maxDepth: 1 })).toThrow(/nesting/);
    expect(decodeCanonicalCbor(fromHex('818100'), { maxDepth: 2 })).toEqual([[0n]]);
  });
});
