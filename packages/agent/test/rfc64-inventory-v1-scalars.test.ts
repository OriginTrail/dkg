import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import type {
  DecimalU64V1,
  DecimalU256V1,
  Digest32V1,
  EvmAddressV1,
} from '@origintrail-official/dkg-core';

import {
  InventoryV1ScalarError,
  assertSqlBlobWidthV1,
  decimalU64ToSqlBlobV1,
  decimalU256ToSqlBlobV1,
  digest32ToSqlBlobV1,
  evmAddressToSqlBlobV1,
  nullableIdentifierToSqlTextV1,
  sqlBlobToDecimalU64V1,
  sqlBlobToDecimalU256V1,
  sqlBlobToDigest32V1,
  sqlBlobToEvmAddressV1,
  sqlBlobsEqualV1,
} from '../src/rfc64/inventory-v1/index.js';

const u64 = (value: string) => value as DecimalU64V1;
const u256 = (value: string) => value as DecimalU256V1;
const digest = (value: string) => value as Digest32V1;
const address = (value: string) => value as EvmAddressV1;
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');

describe('RFC-64 inventory v1 SQL scalar codecs', () => {
  it.each([
    ['0', '0000000000000000'],
    ['1', '0000000000000001'],
    ['262144', '0000000000040000'],
    ['4096', '0000000000001000'],
    ['18446744073709551615', 'ffffffffffffffff'],
  ])('encodes u64 %s as the exact eight-byte big-endian BLOB', (value, expected) => {
    const encoded = decimalU64ToSqlBlobV1(u64(value));
    expect(hex(encoded)).toBe(expected);
    expect(sqlBlobToDecimalU64V1(encoded)).toBe(value);
  });

  it.each([
    ['1', `${'00'.repeat(31)}01`],
    ['18446744073709551616', '0000000000000000000000000000000000000000000000010000000000000000'],
    [
      '57896044618658097711785492504343953926634992332820282019728792003956564819968',
      `80${'00'.repeat(31)}`,
    ],
    [
      '115792089237316195423570985008687907853269984665640564039457584007913129639935',
      'ff'.repeat(32),
    ],
  ])('encodes u256 %s as the exact 32-byte big-endian BLOB', (value, expected) => {
    const encoded = decimalU256ToSqlBlobV1(u256(value));
    expect(hex(encoded)).toBe(expected);
    expect(sqlBlobToDecimalU256V1(encoded)).toBe(value);
  });

  it('sorts fixed-width u256 BLOBs in SQLite unsigned mathematical order', () => {
    const values = [
      '0',
      '1',
      '9',
      '10',
      '18446744073709551615',
      '18446744073709551616',
      '57896044618658097711785492504343953926634992332820282019728792003956564819968',
      '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    ];
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`CREATE TABLE values_v1 (value BLOB PRIMARY KEY) WITHOUT ROWID, STRICT`);
      const insert = database.prepare('INSERT INTO values_v1 (value) VALUES (?)');
      for (const value of [...values].reverse()) insert.run(decimalU256ToSqlBlobV1(u256(value)));
      const rows = database.prepare('SELECT value FROM values_v1 ORDER BY value').all();
      expect(rows.map((row) => sqlBlobToDecimalU256V1(row.value))).toEqual(values);
    } finally {
      database.close();
    }
  });

  it('round-trips exact digest and nonzero EVM-address bytes', () => {
    const root = digest(`0x${'ab'.repeat(32)}`);
    const author = address(`0x${'33'.repeat(20)}`);
    expect(hex(digest32ToSqlBlobV1(root))).toBe('ab'.repeat(32));
    expect(sqlBlobToDigest32V1(Buffer.from('ab'.repeat(32), 'hex'))).toBe(root);
    expect(hex(evmAddressToSqlBlobV1(author))).toBe('33'.repeat(20));
    expect(sqlBlobToEvmAddressV1(Buffer.from('33'.repeat(20), 'hex'))).toBe(author);
  });

  it('rejects noncanonical decimals, widths, typed views, digests, and addresses', () => {
    expect(() => decimalU64ToSqlBlobV1(u64('01'))).toThrow();
    expect(() => decimalU64ToSqlBlobV1(u64('18446744073709551616'))).toThrow();
    expect(() => decimalU256ToSqlBlobV1(u256('-1'))).toThrow();
    expect(() => sqlBlobToDecimalU64V1(new Uint8Array(7))).toThrow(InventoryV1ScalarError);
    expect(() => sqlBlobToDecimalU256V1(new Uint16Array(16))).toThrow(InventoryV1ScalarError);
    expect(() => assertSqlBlobWidthV1(new DataView(new ArrayBuffer(8)), 8, 'u64')).toThrow(
      InventoryV1ScalarError,
    );
    expect(() => digest32ToSqlBlobV1(digest(`0x${'AB'.repeat(32)}`))).toThrow();
    expect(() => evmAddressToSqlBlobV1(address(`0x${'00'.repeat(20)}`))).toThrow(
      InventoryV1ScalarError,
    );
    expect(() => sqlBlobToEvmAddressV1(new Uint8Array(20))).toThrow(InventoryV1ScalarError);
  });

  it('copies accepted BLOB views and compares byte values without coercion', () => {
    const source = Buffer.from('01020304', 'hex');
    const copy = assertSqlBlobWidthV1(source, 4, 'fixture');
    source[0] = 0xff;
    expect(hex(copy)).toBe('01020304');
    expect(sqlBlobsEqualV1(copy, Buffer.from('01020304', 'hex'))).toBe(true);
    expect(sqlBlobsEqualV1(copy, Buffer.from('01020305', 'hex'))).toBe(false);
    expect(sqlBlobsEqualV1(copy, new Uint16Array(2))).toBe(false);
  });

  it('maps root identifiers only to SQL NULL and requires pre-normalized text', () => {
    const assertIdentifier = (candidate: unknown) => {
      if (typeof candidate !== 'string' || candidate.length === 0) throw new Error('invalid identifier');
    };
    expect(nullableIdentifierToSqlTextV1(null, assertIdentifier)).toBeNull();
    expect(nullableIdentifierToSqlTextV1('rootless', assertIdentifier)).toBe('rootless');
    expect(() => nullableIdentifierToSqlTextV1('', assertIdentifier)).toThrow('invalid identifier');
    expect(() => nullableIdentifierToSqlTextV1('e\u0301', assertIdentifier)).toThrow(
      InventoryV1ScalarError,
    );
  });
});
