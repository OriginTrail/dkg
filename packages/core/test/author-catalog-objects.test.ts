import { describe, expect, it } from 'vitest';

import {
  AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  MAX_AUTHOR_CATALOG_BUCKET_PAYLOAD_BYTES_V1,
  assertAuthorCatalogBucketScopeBindingV1,
  assertAuthorCatalogBucketV1,
  assertAuthorCatalogHeadScopeBindingV1,
  assertAuthorCatalogHeadV1,
  assertSignedAuthorCatalogBucketEnvelopeV1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  assertUnsignedAuthorCatalogBucketEnvelopeV1,
  assertUnsignedAuthorCatalogHeadEnvelopeV1,
  canonicalizeAuthorCatalogBucketPayloadV1,
  canonicalizeAuthorCatalogHeadPayloadV1,
  canonicalizeSignedAuthorCatalogBucketEnvelopeBytesV1,
  canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1,
  canonicalizeUnsignedAuthorCatalogBucketEnvelopeBytesV1,
  canonicalizeUnsignedAuthorCatalogHeadEnvelopeBytesV1,
  computeAuthorCatalogBucketObjectDigestV1,
  computeAuthorCatalogDirectoryHeightV1,
  computeAuthorCatalogHeadObjectDigestV1,
  deriveAuthorCatalogScopeFromHeadV1,
  parseCanonicalAuthorCatalogBucketPayloadV1,
  parseCanonicalAuthorCatalogHeadPayloadV1,
  parseCanonicalSignedAuthorCatalogBucketEnvelopeV1,
  parseCanonicalSignedAuthorCatalogHeadEnvelopeV1,
  parseCanonicalUnsignedAuthorCatalogBucketEnvelopeV1,
  parseCanonicalUnsignedAuthorCatalogHeadEnvelopeV1,
  type AuthorCatalogBucketV1,
  type AuthorCatalogHeadV1,
} from '../src/author-catalog-objects.js';
import {
  assertAuthorCatalogRowV1,
  assertAuthorCatalogScopeV1,
  computeAuthorCatalogKeyDigestV1,
  computeAuthorCatalogRowDigestV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
} from '../src/author-catalog-codec.js';
import {
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from '../src/sync-control-object.js';

const SCOPE_DIGEST =
  '0x7b18d141cbb6af4e7fdabe2e4d7d0b9512b042eb079b89a4797d3a0a7f1d4537';
const DIRECTORY_ROOT_DIGEST =
  '0x0163c048997ddaeb984d10a06f98064739a95546cf71d142c0d0a3de19f65f52';
const HEAD_DIGEST =
  '0x1c5e2fffa5c62a3d4c00e879c31e9b36e9d4c419b41ad124e30a23f082635af6';
const BUCKET_DIGEST =
  '0xddedcd25a1fd2afb797f146b04fec735fd3b341d2f10293a1db9fd915e701866';
const AUTHOR_BOUND_KA_ID =
  '23158417847463239084714197001737581570653996933112267175388663934063917137921';
const AUTHOR = '0x3333333333333333333333333333333333333333';
const ISSUER = '0x5555555555555555555555555555555555555555';
const EIP191_SIGNATURE = `0x${'77'.repeat(65)}`;

const SCOPE_CANONICAL =
  '{"authorAddress":"0x3333333333333333333333333333333333333333","bucketCount":"1","contextGraphId":"0x1111111111111111111111111111111111111111/catalog-fixture","era":"0","governanceChainId":"20430","governanceContractAddress":"0x2222222222222222222222222222222222222222","networkId":"otp:20430","ownershipTransitionDigest":null,"subGraphName":null}';
const ROW_CANONICAL =
  '{"assertionCoordinate":"fixture","assertionVersion":"1","kaId":"23158417847463239084714197001737581570653996933112267175388663934063917137921","projectionDigest":"0x0000000000000000000000000000000000000000000000000000000000000000","projectionId":"cg-shared-v1","sealDigest":"0x4444444444444444444444444444444444444444444444444444444444444444","transfer":{"blobDigest":"0x1111111111111111111111111111111111111111111111111111111111111111","byteLength":"16","chunkCount":"1","chunkSize":"262144","chunkTreeRoot":"0x2222222222222222222222222222222222222222222222222222222222222222","codec":"dkg-ka-bundle-v1","projectionDigest":"0x0000000000000000000000000000000000000000000000000000000000000000","projectionId":"cg-shared-v1"}}';
const BUCKET_CANONICAL =
  `{"bucketCount":"1","bucketId":"0","catalogScopeDigest":"${SCOPE_DIGEST}","era":"0","rows":[${ROW_CANONICAL}]}`;
const BUCKET_UNSIGNED_CANONICAL =
  `{"issuer":"${ISSUER}","objectType":"AuthorCatalogBucketV1","payload":${BUCKET_CANONICAL},"signatureEvidence":{"kind":"none"},"signatureSuite":"eip191-personal-sign-digest-v1"}`;

const HEAD_CANONICAL =
  '{"authorAddress":"0x3333333333333333333333333333333333333333","bucketCount":"1","catalogIssuerDelegationDigest":"0x6666666666666666666666666666666666666666666666666666666666666666","contextGraphId":"0x1111111111111111111111111111111111111111/catalog-fixture","directoryHeight":"0","directoryRootDigest":"0x0163c048997ddaeb984d10a06f98064739a95546cf71d142c0d0a3de19f65f52","era":"0","governanceChainId":"20430","governanceContractAddress":"0x2222222222222222222222222222222222222222","issuedAt":"1700000000123","networkId":"otp:20430","ownershipTransitionDigest":null,"previousHeadDigest":null,"subGraphName":null,"totalRows":"0","version":"0"}';
const HEAD_UNSIGNED_CANONICAL =
  `{"issuer":"${ISSUER}","objectType":"AuthorCatalogHeadV1","payload":${HEAD_CANONICAL},"signatureEvidence":{"kind":"none"},"signatureSuite":"eip191-personal-sign-digest-v1"}`;

const VALID_SCOPE = validatedScope(JSON.parse(SCOPE_CANONICAL));
const VALID_ROW = validatedRow(JSON.parse(ROW_CANONICAL));
const VALID_BUCKET = validatedBucket(JSON.parse(BUCKET_CANONICAL));
const VALID_HEAD = validatedHead(JSON.parse(HEAD_CANONICAL));
const BUCKET_UNSIGNED = JSON.parse(BUCKET_UNSIGNED_CANONICAL) as UnsignedControlEnvelopeV1;
const HEAD_UNSIGNED = JSON.parse(HEAD_UNSIGNED_CANONICAL) as UnsignedControlEnvelopeV1;
const BUCKET_SIGNED = {
  ...BUCKET_UNSIGNED,
  objectDigest: BUCKET_DIGEST,
  signature: EIP191_SIGNATURE,
} as SignedControlEnvelopeV1;
const HEAD_SIGNED = {
  ...HEAD_UNSIGNED,
  objectDigest: HEAD_DIGEST,
  signature: EIP191_SIGNATURE,
} as SignedControlEnvelopeV1;

describe('AuthorCatalogBucketV1 structural codec', () => {
  it('pins the exact author-bound SQL-1 payload, envelope, key, row, and object vectors', () => {
    expect(canonicalizeAuthorCatalogBucketPayloadV1(VALID_BUCKET)).toBe(BUCKET_CANONICAL);
    expect(new TextEncoder().encode(BUCKET_CANONICAL).byteLength).toBe(868);
    expect(computeAuthorCatalogKeyDigestV1(VALID_ROW.kaId)).toBe(
      '0x5f49f03c5a2480a80ee4b7dadff8b7c8e18a69358bfdf64a1420dddf513de2e5',
    );
    expect(computeAuthorCatalogRowDigestV1(SCOPE_DIGEST, VALID_ROW)).toBe(
      '0x893392ecdfbf47fac3eb3290bc6f69b9472952439b9233555c523ed8e28f3179',
    );
    expect(new TextDecoder().decode(
      canonicalizeUnsignedAuthorCatalogBucketEnvelopeBytesV1(BUCKET_UNSIGNED),
    )).toBe(BUCKET_UNSIGNED_CANONICAL);
    expect(new TextEncoder().encode(BUCKET_UNSIGNED_CANONICAL).byteLength).toBe(1057);
    expect(computeAuthorCatalogBucketObjectDigestV1(BUCKET_UNSIGNED)).toBe(BUCKET_DIGEST);
    expect(parseCanonicalAuthorCatalogBucketPayloadV1(BUCKET_CANONICAL)).toEqual(
      VALID_BUCKET,
    );
    expect(parseCanonicalUnsignedAuthorCatalogBucketEnvelopeV1(BUCKET_UNSIGNED_CANONICAL))
      .toEqual(BUCKET_UNSIGNED);
  });

  it('validates the exact contextual scope and high-160 author binding', () => {
    expect(() => assertAuthorCatalogBucketScopeBindingV1(VALID_BUCKET, VALID_SCOPE))
      .not.toThrow();
    const unboundRow = validatedRow({ ...VALID_ROW, kaId: '1' });
    const unboundBucket = validatedBucket({ ...VALID_BUCKET, rows: [unboundRow] });
    expect(() => assertAuthorCatalogBucketScopeBindingV1(unboundBucket, VALID_SCOPE))
      .toThrow(/catalog-packed-author-mismatch/);
    expect(() => assertAuthorCatalogBucketScopeBindingV1(
      { ...VALID_BUCKET, catalogScopeDigest: `0x${'99'.repeat(32)}` },
      VALID_SCOPE,
    )).toThrow(/catalog-object-scope-mismatch/);
    expect(() => assertAuthorCatalogBucketScopeBindingV1(
      { ...VALID_BUCKET, era: '1' },
      VALID_SCOPE,
    )).toThrow(/catalog-object-scope-mismatch/);
  });

  it('requires strictly numeric row order and rejects duplicate KA/key/coordinate', () => {
    const second = rowForNumber(2n, 'fixture-2');
    const ordered = { ...VALID_BUCKET, rows: [VALID_ROW, second] };
    expect(() => assertAuthorCatalogBucketV1(ordered)).not.toThrow();
    expect(() => assertAuthorCatalogBucketV1({
      ...VALID_BUCKET,
      rows: [second, VALID_ROW],
    })).toThrow(/catalog-object-row-order/);
    expect(() => assertAuthorCatalogBucketV1({
      ...VALID_BUCKET,
      rows: [VALID_ROW, VALID_ROW],
    })).toThrow(/catalog-object-duplicate/);
    expect(() => assertAuthorCatalogBucketV1({
      ...VALID_BUCKET,
      rows: [VALID_ROW, { ...second, assertionCoordinate: VALID_ROW.assertionCoordinate }],
    })).toThrow(/catalog-object-duplicate/);
  });

  it('requires every row to map to the signed bucket and bucketId to be in range', () => {
    expect(() => assertAuthorCatalogBucketV1({
      ...VALID_BUCKET,
      bucketCount: '2',
      bucketId: '1',
    })).toThrow(/catalog-object-bucket-mapping/);
    expect(() => assertAuthorCatalogBucketV1({
      ...VALID_BUCKET,
      bucketCount: '1',
      bucketId: '1',
    })).toThrow(/catalog-object-bucket-mapping/);
  });

  it('rejects empty, sparse, subclassed, accessor, symbol, and custom-property arrays', () => {
    expect(() => assertAuthorCatalogBucketV1({ ...VALID_BUCKET, rows: [] })).toThrow(
      /catalog-object-array/,
    );
    expect(() => assertAuthorCatalogBucketV1({
      ...VALID_BUCKET,
      rows: new Array(1),
    })).toThrow(/catalog-object-array/);

    class Rows extends Array<AuthorCatalogRowV1> {}
    const subclassed = new Rows(VALID_ROW);
    expect(() => assertAuthorCatalogBucketV1({ ...VALID_BUCKET, rows: subclassed }))
      .toThrow(/catalog-object-array/);

    const accessor = [VALID_ROW];
    Object.defineProperty(accessor, '0', { enumerable: true, get: () => VALID_ROW });
    expect(() => assertAuthorCatalogBucketV1({ ...VALID_BUCKET, rows: accessor }))
      .toThrow(/catalog-object-array/);

    const withSymbol = [VALID_ROW] as Array<AuthorCatalogRowV1> & Record<PropertyKey, unknown>;
    withSymbol[Symbol('hidden')] = true;
    expect(() => assertAuthorCatalogBucketV1({ ...VALID_BUCKET, rows: withSymbol }))
      .toThrow(/catalog-object-array/);

    const withCustom = [VALID_ROW] as Array<AuthorCatalogRowV1> & { extra?: boolean };
    withCustom.extra = true;
    expect(() => assertAuthorCatalogBucketV1({ ...VALID_BUCKET, rows: withCustom }))
      .toThrow(/catalog-object-array/);
  });

  it('never consumes a poisoned inherited rows iterator', () => {
    const rows = [VALID_ROW];
    const originalIterator = Array.prototype[Symbol.iterator];
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      configurable: true,
      writable: true,
      value(this: unknown[]) {
        if (this === rows) throw new Error('poisoned rows iterator was consumed');
        return originalIterator.call(this);
      },
    });
    try {
      const bucket = { ...VALID_BUCKET, rows };
      expect(() => assertAuthorCatalogBucketV1(bucket)).not.toThrow();
      expect(() => assertAuthorCatalogBucketScopeBindingV1(bucket, VALID_SCOPE)).not.toThrow();
    } finally {
      Object.defineProperty(Array.prototype, Symbol.iterator, {
        configurable: true,
        writable: true,
        value: originalIterator,
      });
    }
  });

  it('rejects hostile payload fields, row count, wire cap, and wrong object type', () => {
    expect(() => assertAuthorCatalogBucketV1({ ...VALID_BUCKET, headDigest: SCOPE_DIGEST }))
      .toThrow(/catalog-object-schema/);
    const accessor = { ...VALID_BUCKET };
    Object.defineProperty(accessor, 'era', { enumerable: true, get: () => '0' });
    expect(() => assertAuthorCatalogBucketV1(accessor)).toThrow(/catalog-object-schema/);
    const symbol = { ...VALID_BUCKET } as Record<PropertyKey, unknown>;
    symbol[Symbol('hidden')] = true;
    expect(() => assertAuthorCatalogBucketV1(symbol)).toThrow(/catalog-object-schema/);
    expect(() => assertAuthorCatalogBucketV1({
      ...VALID_BUCKET,
      rows: Array.from({ length: 1025 }, () => VALID_ROW),
    })).toThrow(/catalog-object-array/);
    expect(() => parseCanonicalAuthorCatalogBucketPayloadV1(
      '{'.padEnd(MAX_AUTHOR_CATALOG_BUCKET_PAYLOAD_BYTES_V1 + 1, 'x'),
    )).toThrow(/catalog-object-payload-too-large/);
    expect(() => assertUnsignedAuthorCatalogBucketEnvelopeV1({
      ...BUCKET_UNSIGNED,
      objectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    })).toThrow(/catalog-object-type/);
  });

  it('wraps and strictly parses the generic signed envelope without authority checks', () => {
    expect(() => assertSignedAuthorCatalogBucketEnvelopeV1(BUCKET_SIGNED)).not.toThrow();
    const bytes = canonicalizeSignedAuthorCatalogBucketEnvelopeBytesV1(BUCKET_SIGNED);
    expect(parseCanonicalSignedAuthorCatalogBucketEnvelopeV1(bytes)).toEqual(BUCKET_SIGNED);
    expect(() => parseCanonicalUnsignedAuthorCatalogBucketEnvelopeV1(
      ` ${BUCKET_UNSIGNED_CANONICAL}`,
    )).toThrow(/not RFC 8785 canonical/);
  });
});

describe('AuthorCatalogHeadV1 structural codec', () => {
  it('pins the exact empty-genesis payload, unsigned envelope, and object digest', () => {
    expect(canonicalizeAuthorCatalogHeadPayloadV1(VALID_HEAD)).toBe(HEAD_CANONICAL);
    expect(new TextEncoder().encode(HEAD_CANONICAL).byteLength).toBe(643);
    expect(new TextDecoder().decode(
      canonicalizeUnsignedAuthorCatalogHeadEnvelopeBytesV1(HEAD_UNSIGNED),
    )).toBe(HEAD_UNSIGNED_CANONICAL);
    expect(new TextEncoder().encode(HEAD_UNSIGNED_CANONICAL).byteLength).toBe(830);
    expect(computeAuthorCatalogHeadObjectDigestV1(HEAD_UNSIGNED)).toBe(HEAD_DIGEST);
    expect(parseCanonicalAuthorCatalogHeadPayloadV1(HEAD_CANONICAL)).toEqual(VALID_HEAD);
    expect(parseCanonicalUnsignedAuthorCatalogHeadEnvelopeV1(HEAD_UNSIGNED_CANONICAL))
      .toEqual(HEAD_UNSIGNED);
  });

  it('derives and binds the exact nine-key scope', () => {
    expect(deriveAuthorCatalogScopeFromHeadV1(VALID_HEAD)).toEqual(VALID_SCOPE);
    expect(() => assertAuthorCatalogHeadScopeBindingV1(VALID_HEAD, VALID_SCOPE)).not.toThrow();
    const otherScope = validatedScope({ ...VALID_SCOPE, era: '1' });
    expect(() => assertAuthorCatalogHeadScopeBindingV1(VALID_HEAD, otherScope)).toThrow(
      /catalog-object-scope-mismatch/,
    );
  });

  it.each([
    ['1', '0'],
    ['256', '0'],
    ['512', '1'],
    ['65536', '1'],
    ['131072', '2'],
    ['9223372036854775808', '7'],
  ])('derives directory height %s -> %s', (bucketCount, expectedHeight) => {
    expect(computeAuthorCatalogDirectoryHeightV1(bucketCount)).toBe(expectedHeight);
    expect(() => assertAuthorCatalogHeadV1({
      ...VALID_HEAD,
      bucketCount,
      directoryHeight: expectedHeight,
    })).not.toThrow();
  });

  it('rejects a mismatched height, zero root, malformed scalar, and half-null governance tuple', () => {
    expect(() => assertAuthorCatalogHeadV1({
      ...VALID_HEAD,
      bucketCount: '512',
      directoryHeight: '0',
    })).toThrow(/catalog-object-directory-height/);
    expect(() => assertAuthorCatalogHeadV1({
      ...VALID_HEAD,
      directoryRootDigest: `0x${'00'.repeat(32)}`,
    })).toThrow(/nonzero directory object/);
    expect(() => assertAuthorCatalogHeadV1({ ...VALID_HEAD, totalRows: 0 })).toThrow(
      /catalog-object-scalar/,
    );
    expect(() => assertAuthorCatalogHeadV1({
      ...VALID_HEAD,
      governanceContractAddress: null,
    })).toThrow(/both be null or both non-null/);
  });

  it('rejects missing, extra, accessor, symbol, and wrong object-type fields', () => {
    const missing = { ...VALID_HEAD } as Record<string, unknown>;
    delete missing.version;
    expect(() => assertAuthorCatalogHeadV1(missing)).toThrow(/catalog-object-schema/);
    expect(() => assertAuthorCatalogHeadV1({ ...VALID_HEAD, tier: 'swm' })).toThrow(
      /catalog-object-schema/,
    );
    const accessor = { ...VALID_HEAD };
    Object.defineProperty(accessor, 'version', { enumerable: true, get: () => '0' });
    expect(() => assertAuthorCatalogHeadV1(accessor)).toThrow(/catalog-object-schema/);
    const symbol = { ...VALID_HEAD } as Record<PropertyKey, unknown>;
    symbol[Symbol('hidden')] = true;
    expect(() => assertAuthorCatalogHeadV1(symbol)).toThrow(/catalog-object-schema/);
    expect(() => assertUnsignedAuthorCatalogHeadEnvelopeV1({
      ...HEAD_UNSIGNED,
      objectType: AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
    })).toThrow(/catalog-object-type/);
  });

  it('wraps and strictly parses the generic signed envelope without authority checks', () => {
    expect(() => assertSignedAuthorCatalogHeadEnvelopeV1(HEAD_SIGNED)).not.toThrow();
    const bytes = canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1(HEAD_SIGNED);
    expect(parseCanonicalSignedAuthorCatalogHeadEnvelopeV1(bytes)).toEqual(HEAD_SIGNED);
    expect(() => parseCanonicalUnsignedAuthorCatalogHeadEnvelopeV1(
      HEAD_UNSIGNED_CANONICAL.replace('"version":"0"', '"version":"0","version":"0"'),
    )).toThrow(/Duplicate object key/);
  });
});

function rowForNumber(number: bigint, coordinate: string): AuthorCatalogRowV1 {
  const kaId = ((BigInt(AUTHOR) << 96n) | number).toString();
  return validatedRow({ ...VALID_ROW, kaId, assertionCoordinate: coordinate });
}

function validatedScope(value: unknown): AuthorCatalogScopeV1 {
  assertAuthorCatalogScopeV1(value);
  return value;
}

function validatedRow(value: unknown): AuthorCatalogRowV1 {
  assertAuthorCatalogRowV1(value);
  return value;
}

function validatedBucket(value: unknown): AuthorCatalogBucketV1 {
  assertAuthorCatalogBucketV1(value);
  return value;
}

function validatedHead(value: unknown): AuthorCatalogHeadV1 {
  assertAuthorCatalogHeadV1(value);
  return value;
}
