import { describe, expect, it } from 'vitest';
import {
  compareCanonicalCbor,
  decodeCanonicalCbor,
  encodeCanonicalCbor,
} from '../../src/protocol/canonical-cbor.js';

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'hex'));
}

describe('RFC 8949 deterministic CBOR profile', () => {
  it.each([
    [0n, '00'],
    [23n, '17'],
    [24n, '1818'],
    [255n, '18ff'],
    [256n, '190100'],
    [65_535n, '19ffff'],
    [65_536n, '1a00010000'],
    [4_294_967_295n, '1affffffff'],
    [4_294_967_296n, '1b0000000100000000'],
    [0xffff_ffff_ffff_ffffn, '1bffffffffffffffff'],
    [-1n, '20'],
    [-24n, '37'],
    [-25n, '3818'],
    [-256n, '38ff'],
    [-257n, '390100'],
    [-65_536n, '39ffff'],
    [-65_537n, '3a00010000'],
    [-4_294_967_297n, '3b0000000100000000'],
    [-0x1_0000_0000_0000_0000n, '3bffffffffffffffff'],
  ])('encodes integer $0 with its shortest representation', (value, encoded) => {
    expect(hex(encodeCanonicalCbor(value))).toBe(encoded);
    expect(decodeCanonicalCbor(bytes(encoded))).toBe(value);
  });

  it('encodes only definite arrays, byte strings, NFC text, booleans, and null', () => {
    const value = [null, false, true, 'é', Uint8Array.of(1, 2, 3), [1n]] as const;
    const encoded = encodeCanonicalCbor(value);
    expect(hex(encoded)).toBe('86f6f4f562c3a9430102038101');
    expect(decodeCanonicalCbor(encoded)).toEqual(value);

    expect(hex(encodeCanonicalCbor(new Uint8Array(24)))).toMatch(/^5818/);
    expect(hex(encodeCanonicalCbor(new Uint8Array(256)))).toMatch(/^590100/);
    expect(hex(encodeCanonicalCbor(new Uint8Array(65_536)))).toMatch(/^5a00010000/);
    expect(hex(encodeCanonicalCbor(Array.from({ length: 24 }, () => 0n)))).toMatch(/^9818/);
  });

  it.each([
    [1, 'WAL_CBOR_UNSUPPORTED_VALUE'],
    [undefined, 'WAL_CBOR_UNSUPPORTED_VALUE'],
    [{ key: 1n }, 'WAL_CBOR_UNSUPPORTED_VALUE'],
    [0x1_0000_0000_0000_0000n, 'WAL_CBOR_INTEGER_RANGE'],
    [-0x1_0000_0000_0000_0001n, 'WAL_CBOR_INTEGER_RANGE'],
    ['e\u0301', 'WAL_CBOR_NON_NFC'],
  ])('rejects unsupported encoder value %# with a stable code', (value, code) => {
    expect(() => encodeCanonicalCbor(value as never)).toThrow(expect.objectContaining({ code }));
  });

  it.each([
    ['', 'WAL_CBOR_TRUNCATED'],
    ['430102', 'WAL_CBOR_TRUNCATED'],
    ['5f', 'WAL_CBOR_INDEFINITE_LENGTH'],
    ['1c', 'WAL_CBOR_RESERVED_ARGUMENT'],
    ['1817', 'WAL_CBOR_NON_SHORTEST'],
    ['1900ff', 'WAL_CBOR_NON_SHORTEST'],
    ['1a0000ffff', 'WAL_CBOR_NON_SHORTEST'],
    ['1b00000000ffffffff', 'WAL_CBOR_NON_SHORTEST'],
    ['9b0020000000000000', 'WAL_CBOR_LENGTH_RANGE'],
    ['9affffffff', 'WAL_CBOR_TRUNCATED'],
    ['61ff', 'WAL_CBOR_INVALID_UTF8'],
    ['6365cc81', 'WAL_CBOR_NON_NFC'],
    ['a0', 'WAL_CBOR_MAP_FORBIDDEN'],
    ['c000', 'WAL_CBOR_TAG_FORBIDDEN'],
    ['f90000', 'WAL_CBOR_SIMPLE_FORBIDDEN'],
    ['f7', 'WAL_CBOR_SIMPLE_FORBIDDEN'],
    ['0000', 'WAL_CBOR_TRAILING_BYTES'],
  ])('rejects non-profile bytes $0', (encoded, code) => {
    expect(() => decodeCanonicalCbor(bytes(encoded))).toThrow(expect.objectContaining({ code }));
  });

  it('rejects non-byte decoder inputs', () => {
    expect(() => decodeCanonicalCbor('00' as never)).toThrow(
      expect.objectContaining({ code: 'WAL_CBOR_UNSUPPORTED_VALUE' }),
    );
  });

  it('compares values lexicographically by canonical bytes', () => {
    expect(compareCanonicalCbor(1n, 2n)).toBeLessThan(0);
    expect(compareCanonicalCbor(2n, 1n)).toBeGreaterThan(0);
    expect(compareCanonicalCbor(Uint8Array.of(1), Uint8Array.of(1))).toBe(0);
    expect(compareCanonicalCbor(Uint8Array.of(1), Uint8Array.of(1, 0))).toBeLessThan(0);
  });
});
