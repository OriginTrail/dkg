import { describe, expect, it } from 'vitest';
import {
  canonicalizeSwmAuthorInventoryRowsBytesV1,
  parseCanonicalSwmAuthorInventoryRowsV1,
  type SwmAuthorInventoryRowV1,
} from '@origintrail-official/dkg-core';
import {
  decodeStoredSwmAuthorInventoryRowV1,
  type SqlRowV1,
} from '../src/rfc64/inventory-v1/swm-author-inventory-sql-codec.js';

const row = Object.freeze({
  assertionCoordinate: 'audit-synthetic-v1', assertionVersion: '1',
  kaUal: `did:dkg:gnosis:100/0x${'33'.repeat(20)}/1`,
  shareOperationId: 'synthetic-share', projectionDigest: `0x${'11'.repeat(32)}`,
  publicTripleCount: '33', privateTripleCount: '0', sealDigest: `0x${'22'.repeat(32)}`,
  sharedAt: '1700000000000', expiresAt: null,
}) as SwmAuthorInventoryRowV1;

function u64(value: string): Uint8Array {
  const blob = Buffer.alloc(8); blob.writeBigUInt64BE(BigInt(value)); return blob;
}
function stored(value: SwmAuthorInventoryRowV1): SqlRowV1 {
  return {
    assertion_coordinate: value.assertionCoordinate,
    assertion_version_u64be: u64(value.assertionVersion), ka_ual: value.kaUal,
    share_operation_id: value.shareOperationId,
    projection_digest: Buffer.from(value.projectionDigest.slice(2), 'hex'),
    public_triple_count_u64be: u64(value.publicTripleCount),
    private_triple_count_u64be: u64(value.privateTripleCount),
    seal_digest: Buffer.from(value.sealDigest.slice(2), 'hex'),
    shared_at_u64be: u64(value.sharedAt),
    expires_at_u64be: value.expiresAt === null ? null : u64(value.expiresAt),
  };
}

function outcome<T>(operation: () => T) {
  try { return { kind: 'accepted', value: operation() }; }
  catch (error) {
    const failure = error as Error & { code?: string };
    return { kind: 'rejected', name: failure.name, code: failure.code, message: failure.message };
  }
}

describe('SWM author inventory typed SQL decoding', () => {
  it.each(['synthetic-share', 'quoted-"-backslash-\\', 'é-🙂', 'x'.repeat(256)])(
    'preserves the canonical wire model and owned immutable values for %s', operation => {
      const input = { ...row, shareOperationId: operation } as SwmAuthorInventoryRowV1;
      const sql = stored(input);
      const decoded = decodeStoredSwmAuthorInventoryRowV1(sql);
      const bytes = canonicalizeSwmAuthorInventoryRowsBytesV1([input]);
      expect(decoded).toEqual(parseCanonicalSwmAuthorInventoryRowsV1(bytes)[0]);
      expect(canonicalizeSwmAuthorInventoryRowsBytesV1([decoded])).toEqual(bytes);
      expect(Object.isFrozen(decoded)).toBe(true);
      (sql.projection_digest as Uint8Array).fill(0);
      sql.share_operation_id = 'later-sql-value';
      expect(decoded).toEqual(input);
    },
  );

  it('matches canonical validation for every ASCII operation character, including JSON escapes', () => {
    for (let unit = 0; unit < 128; unit++) {
      const input = { ...row, shareOperationId: `left-${String.fromCharCode(unit)}-right` } as SwmAuthorInventoryRowV1;
      const expected = outcome(() => parseCanonicalSwmAuthorInventoryRowsV1(
        canonicalizeSwmAuthorInventoryRowsBytesV1([input]),
      )[0]);
      const actual = outcome(() => decodeStoredSwmAuthorInventoryRowV1(stored(input)));
      expect(actual, `ASCII code unit ${unit}`).toEqual(expected);
    }
  });

  it.each(['\ud800', '\udc00', '😀\ud800', '\udc00😀', 'é-🙂', 'e\u0301', 'a'.repeat(4097)])(
    'preserves the full canonical acceptance and error contract for Unicode and oversized input %s', operation => {
      const input = { ...row, shareOperationId: operation } as SwmAuthorInventoryRowV1;
      const expected = outcome(() => parseCanonicalSwmAuthorInventoryRowsV1(
        canonicalizeSwmAuthorInventoryRowsBytesV1([input]),
      )[0]);
      expect(outcome(() => decodeStoredSwmAuthorInventoryRowV1(stored(input)))).toEqual(expected);
    },
  );

  it.each([
    ['share_operation_id', '\ud800'], ['share_operation_id', '\udc00'],
    ['share_operation_id', 'e\u0301'], ['share_operation_id', '\u0000'],
    ['share_operation_id', 'x'.repeat(257)], ['share_operation_id', '🙂'.repeat(65)],
    ['assertion_coordinate', ''], ['ka_ual', 'did:dkg:gnosis:100/no-author/01'],
    ['assertion_version_u64be', new Uint8Array(8)],
    ['public_triple_count_u64be', new Uint8Array(7)],
    ['private_triple_count_u64be', new Uint16Array(4)],
    ['projection_digest', new Uint8Array(31)], ['seal_digest', 'not-a-blob'],
    ['shared_at_u64be', null], ['expires_at_u64be', u64('1700000000000')],
    ['assertion_coordinate', null], ['share_operation_id', 123],
  ])('rejects corrupt %s without trusting a previously decoded row', (column, value) => {
    const sql = stored(row);
    expect(decodeStoredSwmAuthorInventoryRowV1(sql)).toEqual(row);
    sql[column as string] = value;
    expect(() => decodeStoredSwmAuthorInventoryRowV1(sql)).toThrow();
  });

  it('retains exact unsigned scalar extrema and expiry values', () => {
    const input = { ...row, assertionVersion: '18446744073709551615',
      sharedAt: '1700000000000', expiresAt: '1700000000001',
    } as SwmAuthorInventoryRowV1;
    expect(decodeStoredSwmAuthorInventoryRowV1(stored(input))).toEqual(input);
  });
});
