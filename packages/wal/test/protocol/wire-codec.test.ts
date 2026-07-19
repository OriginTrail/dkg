import { describe, expect, it } from 'vitest';
import {
  decodeWalRequestFrame,
  decodeWalResponseFrame,
  encodeLengthPrefixedFrame,
  encodeWalErrorFrame,
  encodeWalRequestFrame,
  encodeWalResponseFrame,
  validateWalRequestBody,
  validateWalResponseBody,
  compareWireBytes,
  wireBytesEqual,
  walWireMethod,
  WAL_WIRE_ERROR_CODE,
  WAL_WIRE_LIMITS_V1,
} from '../../src/protocol/index.js';
import { context, fill, methodFixtures, requestId } from './wire-fixtures.js';

describe('WAL v1 method catalog codec', () => {
  it.each(methodFixtures().map((fixture, index) => ({ ...fixture, index })))('$family method $requestType round-trips byte-exactly', fixture => {
    const id = requestId(fixture.index + 1);
    const request = encodeWalRequestFrame(fixture.family, fixture.requestType, id, context(), fixture.body);
    expect(encodeWalRequestFrame(fixture.family, fixture.requestType, id, context(), fixture.body)).toEqual(request);
    const decodedRequest = decodeWalRequestFrame(fixture.family, request);
    expect(decodedRequest.requestId).toEqual(id);
    expect(decodedRequest.body).toEqual(fixture.body);

    const method = walWireMethod(fixture.family, fixture.requestType)!;
    const response = encodeWalResponseFrame(method, id, fixture.response);
    expect(encodeWalResponseFrame(method, id, fixture.response)).toEqual(response);
    expect(decodeWalResponseFrame(fixture.family, fixture.requestType, id, response)).toEqual({
      ok: true,
      requestId: id,
      messageType: method.responseType,
      body: fixture.response,
    });
  });

  it.each(Object.values(WAL_WIRE_ERROR_CODE))('round-trips stable error code %i', code => {
    const id = requestId(code + 1);
    const frame = encodeWalErrorFrame(id, [BigInt(code), code === 4 ? 50n : null, BigInt(code)]);
    expect(decodeWalResponseFrame('control', 0, id, frame)).toEqual({
      ok: false,
      requestId: id,
      error: [BigInt(code), code === 4 ? 50n : null, BigInt(code)],
    });
  });

  it('rejects unknown directions, wrong response types, request IDs, and body schemas', () => {
    const id = requestId(1);
    expect(() => encodeWalRequestFrame('control', 99, id, context(), [])).toThrow(/unknown request/);
    expect(() => decodeWalRequestFrame('control', encodeLengthPrefixedFrame([1n, 1n, id, [context(), []]]))).toThrow(/not a request/);
    expect(() => decodeWalRequestFrame('control', encodeLengthPrefixedFrame([1n, 70_000n, id, [context(), []]] as never))).toThrow(/65535/);
    expect(() => decodeWalRequestFrame('control', encodeLengthPrefixedFrame([1n, 0n, id, []]))).toThrow(/AuthenticatedRequest/);
    expect(() => encodeWalRequestFrame('control', 2, id, context(), [])).toThrow(/exact 2-item/);
    expect(() => encodeWalRequestFrame('control', 0, id, ['bad'] as never, [])).toThrow(/RequestContextV1/);
    expect(() => validateWalResponseBody(walWireMethod('control', 2)!, [])).toThrow(/exact 13-item/);
    expect(() => decodeWalResponseFrame('control', 99, id, new Uint8Array())).toThrow(/unknown request/);

    const valid = encodeWalResponseFrame(walWireMethod('control', 0)!, id, [[1n], [1n], 1n, 1n, 1n, 1n, 1n, 1n]);
    expect(() => decodeWalResponseFrame('control', 0, requestId(2), valid)).toThrow(/requestId/);
    expect(() => decodeWalResponseFrame('control', 2, id, valid)).toThrow(/unexpected response/);
    const malformedError = encodeLengthPrefixedFrame([1n, 255n, id, []]);
    expect(() => decodeWalResponseFrame('control', 0, id, malformedError)).toThrow(/exact 3-item/);
  });

  it('compares wire byte strings without timing-dependent early equality', () => {
    expect(wireBytesEqual(Uint8Array.of(1), Uint8Array.of(1))).toBe(true);
    expect(wireBytesEqual(Uint8Array.of(1), Uint8Array.of(2))).toBe(false);
    expect(wireBytesEqual(Uint8Array.of(1), Uint8Array.of(1, 0))).toBe(false);
    expect(compareWireBytes(Uint8Array.of(1), Uint8Array.of(2))).toBeLessThan(0);
    expect(compareWireBytes(Uint8Array.of(2), Uint8Array.of(1))).toBeGreaterThan(0);
    expect(compareWireBytes(Uint8Array.of(1), Uint8Array.of(1))).toBe(0);
    expect(compareWireBytes(Uint8Array.of(1), Uint8Array.of(1, 0))).toBeLessThan(0);
  });

  it('enforces request budgets before provider work', () => {
    const symbols = walWireMethod('reconcile', 0)!;
    const ids = walWireMethod('reconcile', 2)!;
    const range = walWireMethod('object', 0)!;
    const head = fill(32, 1);
    const seed = fill(32, 2);
    const object = fill(32, 3);

    for (const count of [0n, 4_097n]) {
      expect(() => validateWalRequestBody(symbols, [head, seed, 0n, count], WAL_WIRE_LIMITS_V1)).toThrow();
    }
    expect(() => validateWalRequestBody(symbols, [head, seed, 4_194_304n, 1n], WAL_WIRE_LIMITS_V1)).toThrow(/attempt limit/);
    for (const limit of [0n, 4_097n]) {
      expect(() => validateWalRequestBody(ids, [head, null, limit], WAL_WIRE_LIMITS_V1)).toThrow();
    }
    for (const length of [0n, 1_048_577n]) {
      expect(() => validateWalRequestBody(range, [object, 0n, length], WAL_WIRE_LIMITS_V1)).toThrow();
    }
    expect(() => validateWalRequestBody(range, [object, 8_589_934_593n, 1n], WAL_WIRE_LIMITS_V1)).toThrow(/hard cap/);
  });

  it('rejects an encoded or declared frame above its negotiated budget', () => {
    const id = requestId(1);
    const tiny = { ...WAL_WIRE_LIMITS_V1, maximumFrameBytes: 128 };
    expect(() => encodeWalRequestFrame('control', 0, id, context(), [], tiny)).toThrow(/exceeds/);
    const large = encodeWalRequestFrame('control', 0, id, context(), []);
    expect(() => decodeWalRequestFrame('control', large, tiny)).toThrow(/exceeds/);
  });
});
