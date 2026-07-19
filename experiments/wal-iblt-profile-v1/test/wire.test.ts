import { describe, expect, it } from 'vitest';
import {
  I64_MAX,
  I64_MIN,
  SymbolWireError,
  decodeReconciliationSymbolV1,
  emptySymbol,
  encodeReconciliationSymbolV1
} from '../src/index.js';

function roundTrip(symbolIndex: number, count: bigint): void {
  const symbol = { ...emptySymbol(symbolIndex), count };
  expect(decodeReconciliationSymbolV1(encodeReconciliationSymbolV1(symbol))).toEqual(symbol);
}

describe('canonical CBOR reconciliation symbol tuple', () => {
  it('round-trips every unsigned integer width boundary', () => {
    for (const symbolIndex of [0, 23, 24, 255, 256, 65_535, 65_536, 0xffff_ffff, 0x1_0000_0000, Number.MAX_SAFE_INTEGER]) {
      roundTrip(symbolIndex, 0n);
    }
  });

  it('round-trips signed count width boundaries', () => {
    for (const count of [
      I64_MIN,
      -4_294_967_297n,
      -4_294_967_296n,
      -65_537n,
      -65_536n,
      -257n,
      -256n,
      -25n,
      -24n,
      -1n,
      0n,
      23n,
      24n,
      255n,
      256n,
      65_535n,
      65_536n,
      4_294_967_295n,
      4_294_967_296n,
      I64_MAX
    ]) roundTrip(7, count);
  });

  it('uses the exact four-item tuple and fixed bytes32 headers', () => {
    const encoded = encodeReconciliationSymbolV1(emptySymbol(0));
    expect(encoded[0]).toBe(0x84);
    expect(encoded[1]).toBe(0x00);
    expect(encoded[2]).toBe(0x00);
    expect(encoded[3]).toBe(0x58);
    expect(encoded[4]).toBe(0x20);
    expect(encoded[37]).toBe(0x58);
    expect(encoded[38]).toBe(0x20);
    expect(encoded).toHaveLength(71);
  });

  it('rejects malformed, non-canonical, truncated, and trailing encodings', () => {
    const valid = encodeReconciliationSymbolV1(emptySymbol(0));
    const cases: Array<[Uint8Array, string]> = [
      [new Uint8Array(), 'MALFORMED_CBOR'],
      [Uint8Array.of(0x83), 'MALFORMED_CBOR'],
      [Uint8Array.of(0x84, 0x9f), 'MALFORMED_CBOR'],
      [Uint8Array.of(0x84, 0x18, 0x00), 'NON_CANONICAL_CBOR'],
      [Uint8Array.of(0x84, 0x19, 0x00, 0xff), 'NON_CANONICAL_CBOR'],
      [Uint8Array.of(0x84, 0x1a, 0x00, 0x00, 0xff, 0xff), 'NON_CANONICAL_CBOR'],
      [Uint8Array.of(0x84, 0x1b, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff), 'NON_CANONICAL_CBOR'],
      [Uint8Array.of(0x84, 0x1f), 'MALFORMED_CBOR'],
      [Uint8Array.of(0x84, 0x40), 'MALFORMED_CBOR'],
      [Uint8Array.of(0x84, 0x00, 0x40), 'MALFORMED_CBOR'],
      [Uint8Array.of(0x84, 0x00, 0x00, 0x00), 'MALFORMED_CBOR'],
      [Uint8Array.of(0x84, 0x00, 0x00, 0x57), 'MALFORMED_CBOR'],
      [Uint8Array.of(0x84, 0x00, 0x00, 0x58, 0x20), 'MALFORMED_CBOR'],
      [Uint8Array.of(...valid, 0), 'TRAILING_BYTES']
    ];
    for (const [bytes, code] of cases) {
      try {
        decodeReconciliationSymbolV1(bytes);
        expect.fail('fixture unexpectedly decoded');
      } catch (error) {
        expect(error).toBeInstanceOf(SymbolWireError);
        expect((error as SymbolWireError).code).toBe(code);
      }
    }
  });

  it('rejects symbol index and count values outside implementation bounds', () => {
    const tooLargeIndex = Uint8Array.of(
      0x84, 0x1b, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x58, 0x20, ...new Uint8Array(32), 0x58, 0x20, ...new Uint8Array(32)
    );
    expect(() => decodeReconciliationSymbolV1(tooLargeIndex)).toThrowError(/symbolIndex/);
    const tooLargeCount = Uint8Array.of(
      0x84, 0x00, 0x1b, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x58, 0x20, ...new Uint8Array(32), 0x58, 0x20, ...new Uint8Array(32)
    );
    expect(() => decodeReconciliationSymbolV1(tooLargeCount)).toThrowError(/signed-i64/);
  });
});
