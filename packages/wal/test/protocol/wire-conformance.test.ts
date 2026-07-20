import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WAL_WIRE_ERROR_CODE,
  WAL_WIRE_LIMITS_V1,
  WalWireError,
  decodeLengthPrefixedFrame,
  decodeUnsignedVarint,
  decodeWalRequestFrame,
  decodeWalResponseFrame,
  encodeWalErrorFrame,
  encodeWalRequestFrame,
  encodeWalResponseFrame,
  validateWalRequestBody,
  type ProtocolTuple,
  type WalWireFamily,
} from '../../src/protocol/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(await readFile(resolve(here, '../../../../conformance/wal-v1/vectors/protocol-v1.json'), 'utf8'));

function bytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'hex'));
}

function hexadecimal(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

describe('independently generated wire conformance vectors', () => {
  it('decodes and reproduces every catalog method request and response exactly', () => {
    expect(vectors.wire.methods).toHaveLength(11);
    for (const value of vectors.wire.methods) {
      const family = value.family as WalWireFamily;
      const requestId = bytes(value.requestId);
      const request = decodeWalRequestFrame(family, bytes(value.requestFrame));
      const response = decodeWalResponseFrame(family, value.requestType, requestId, bytes(value.responseFrame));
      expect(request.messageType, value.name).toBe(value.requestType);
      expect(response.ok, value.name).toBe(true);
      const invalid = decodeWalRequestFrame(family, bytes(value.invalidRequestFrame));
      expect(() => validateWalRequestBody(invalid.method, invalid.body, WAL_WIRE_LIMITS_V1), value.name).toThrow(WalWireError);
      expect(hexadecimal(encodeWalRequestFrame(family, value.requestType, requestId, request.context, request.body)), value.name)
        .toBe(value.requestFrame);
      if (!response.ok) throw new Error(`expected successful ${value.name} response`);
      expect(hexadecimal(encodeWalResponseFrame(request.method, requestId, response.body)), value.name)
        .toBe(value.responseFrame);
    }
  });

  it('decodes and reproduces every catalog error exactly', () => {
    for (const value of vectors.wire.errors) {
      const requestId = bytes(value.requestId);
      const response = decodeWalResponseFrame('control', 0, requestId, bytes(value.frame));
      expect(response.ok, value.name).toBe(false);
      if (response.ok) throw new Error(`expected ${value.name} error response`);
      expect(Number(response.error[0]), value.name).toBe(value.code);
      expect(hexadecimal(encodeWalErrorFrame(requestId, response.error)), value.name).toBe(value.frame);
      expect(() => decodeWalResponseFrame('control', 0, requestId, bytes(value.invalidFrame)), value.name).toThrow(WalWireError);
    }
  });

  it('accepts exact varint boundaries and rejects every invalid frame with the frozen class', () => {
    expect(vectors.wire.boundaries.map((value: any) => value.prefixLength)).toEqual([1, 2, 3]);
    for (const value of vectors.wire.boundaries) {
      const frame = bytes(value.frame);
      expect(decodeUnsignedVarint(frame)).toEqual({ value: value.cborLength, byteLength: value.prefixLength });
      expect(decodeLengthPrefixedFrame(frame)).toEqual([
        1n,
        9n,
        bytes(value.requestId),
        [new Uint8Array(value.name === 'one-byte-length-prefix' ? 0 : value.name === 'two-byte-length-prefix' ? 128 : 16_384)],
      ] satisfies ProtocolTuple<'FrameV1'>);
    }
    for (const value of vectors.wire.invalid) {
      try {
        decodeLengthPrefixedFrame(bytes(value.frame));
        throw new Error(`accepted invalid frame ${value.name}`);
      } catch (error) {
        expect(error, value.name).toBeInstanceOf(WalWireError);
        expect((error as WalWireError).code, value.name).toBe(WAL_WIRE_ERROR_CODE[value.expected as keyof typeof WAL_WIRE_ERROR_CODE]);
      }
    }
  });
});
