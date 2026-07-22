import { describe, expect, it } from 'vitest';

import {
  MAX_DECIMAL_U64,
  MAX_DECIMAL_U256,
  assertCanonicalChainId,
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertCanonicalHexBytes,
  assertCanonicalKaId,
  assertCanonicalTimestampMs,
  parseCanonicalDecimalU256,
  parseCanonicalNullableEvmAddressV1,
} from '../src/sync-wire-scalars.js';

describe('RFC-64 sync wire scalar profile', () => {
  it('accepts exact u64 boundaries and rejects noncanonical/out-of-range forms', () => {
    expect(() => assertCanonicalDecimalU64('0')).not.toThrow();
    expect(() => assertCanonicalDecimalU64(MAX_DECIMAL_U64.toString())).not.toThrow();
    for (const value of [
      0,
      '00',
      '+1',
      '-1',
      '1.0',
      '1e3',
      '',
      (MAX_DECIMAL_U64 + 1n).toString(),
    ]) {
      expect(() => assertCanonicalDecimalU64(value), String(value)).toThrow();
    }
  });

  it('uses the full u256 domain for chain IDs', () => {
    expect(parseCanonicalDecimalU256(MAX_DECIMAL_U256.toString())).toBe(MAX_DECIMAL_U256);
    expect(() => assertCanonicalChainId('0')).not.toThrow();
    expect(() => assertCanonicalChainId((MAX_DECIMAL_U256 + 1n).toString())).toThrow(
      /outside the u256 range/,
    );
  });

  it('keeps packed KA identifiers in the full u256 domain rather than u64', () => {
    expect(() => assertCanonicalKaId(MAX_DECIMAL_U256.toString())).not.toThrow();
    expect(() => assertCanonicalKaId((MAX_DECIMAL_U256 + 1n).toString())).toThrow(
      /outside the u256 range/,
    );
    expect(() => assertCanonicalKaId('01')).toThrow(/canonical unsigned decimal u256/);
  });

  it('treats TimestampMsV1 as an exact Unix-millisecond u64', () => {
    expect(() => assertCanonicalTimestampMs('1700000000123')).not.toThrow();
    expect(new Date(Number('1700000000123')).toISOString()).toBe('2023-11-14T22:13:20.123Z');
    expect(() => assertCanonicalTimestampMs('-1')).toThrow();
  });

  it('accepts zero digests structurally and enforces lowercase fixed-width hex', () => {
    expect(() => assertCanonicalDigest(`0x${'00'.repeat(32)}`)).not.toThrow();
    expect(() => assertCanonicalDigest(`0x${'AA'.repeat(32)}`)).toThrow(/lowercase 32-byte/);
    expect(() => assertCanonicalDigest(`0x${'00'.repeat(31)}`)).toThrow(/lowercase 32-byte/);
  });

  it('accepts only lowercase nonzero fixed-width EVM addresses', () => {
    expect(parseCanonicalNullableEvmAddressV1(`0x${'00'.repeat(20)}`)).toBeNull();
    expect(parseCanonicalNullableEvmAddressV1(`0x${'11'.repeat(20)}`)).toBe(
      `0x${'11'.repeat(20)}`,
    );
    expect(() => parseCanonicalNullableEvmAddressV1(`0x${'AA'.repeat(20)}`)).toThrow(
      /lowercase 20-byte/,
    );
    expect(() => assertCanonicalEvmAddress(`0x${'11'.repeat(20)}`)).not.toThrow();
    expect(() => assertCanonicalEvmAddress(`0x${'AA'.repeat(20)}`)).toThrow(
      /lowercase 20-byte/,
    );
    expect(() => assertCanonicalEvmAddress(`0x${'00'.repeat(20)}`)).toThrow(/zero address/);
  });

  it('accepts canonical empty bytes only when the declared range permits zero', () => {
    expect(() => assertCanonicalHexBytes('0x', 'payload', 0, 0)).not.toThrow();
    expect(() => assertCanonicalHexBytes('0x', 'payload', 1, 1)).toThrow(/1 lowercase bytes/);
    expect(() => assertCanonicalHexBytes('0x0', 'payload', 0, 1)).toThrow(/lowercase bytes/);
    expect(() => assertCanonicalHexBytes('0xAA', 'payload', 0, 1)).toThrow(/lowercase bytes/);
  });
});
