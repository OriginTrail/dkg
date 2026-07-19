import { describe, expect, it } from 'vitest';

import {
  MAX_AUTHOR_CATALOG_BUCKET_COUNT_V1,
  MAX_AUTHOR_CATALOG_ROW_BYTES_V1,
  MAX_AUTHOR_CATALOG_ROW_DIGEST_INPUT_BYTES_V1,
  MAX_AUTHOR_CATALOG_SCOPE_BYTES_V1,
  assertAssertionCoordinateV1,
  assertAuthorCatalogBucketCountV1,
  assertAuthorCatalogRowScopeBindingV1,
  assertAuthorCatalogRowV1,
  assertAuthorCatalogScopeV1,
  assertContextGraphIdV1,
  assertNetworkIdV1,
  assertPackedKaIdAuthorBindingV1,
  assertSubGraphNameV1,
  isCatalogForbiddenCodePointV1,
  buildCatalogAssertionScopeV1,
  buildCatalogAssertionSubjectV1,
  canonicalizeAuthorCatalogRowV1,
  canonicalizeAuthorCatalogScopeV1,
  catalogKeyDigestToBucketIdV1,
  catalogKeyToBucketIdV1,
  compareAuthorCatalogKaIdsV1,
  computeAuthorCatalogKeyDigestV1,
  computeAuthorCatalogRowDigestV1,
  computeAuthorCatalogScopeDigestV1,
  iriComponentV1,
  parseCanonicalAuthorCatalogRowV1,
  parseCanonicalAuthorCatalogScopeV1,
  type AssertionCoordinateV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type CatalogLaneV1,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type KaIdV1,
  type SubGraphNameV1,
} from '../src/index.js';

const ZERO_DIGEST = `0x${'00'.repeat(32)}`;
const BLOB_DIGEST = `0x${'11'.repeat(32)}`;
const CHUNK_TREE_ROOT = `0x${'22'.repeat(32)}`;
const SEAL_DIGEST = `0x${'44'.repeat(32)}`;
const AUTHOR = `0x${'33'.repeat(20)}`;
const GOVERNANCE_CONTRACT = `0x${'22'.repeat(20)}`;

const SCOPE_CANONICAL =
  '{"authorAddress":"0x3333333333333333333333333333333333333333","bucketCount":"1","contextGraphId":"0x1111111111111111111111111111111111111111/catalog-fixture","era":"0","governanceChainId":"20430","governanceContractAddress":"0x2222222222222222222222222222222222222222","networkId":"otp:20430","ownershipTransitionDigest":null,"subGraphName":null}';
const SCOPE_DIGEST =
  '0x7b18d141cbb6af4e7fdabe2e4d7d0b9512b042eb079b89a4797d3a0a7f1d4537';

const ROW_CANONICAL =
  '{"assertionCoordinate":"fixture","assertionVersion":"1","kaId":"1","projectionDigest":"0x0000000000000000000000000000000000000000000000000000000000000000","projectionId":"cg-shared-v1","sealDigest":"0x4444444444444444444444444444444444444444444444444444444444444444","transfer":{"blobDigest":"0x1111111111111111111111111111111111111111111111111111111111111111","byteLength":"16","chunkCount":"1","chunkSize":"262144","chunkTreeRoot":"0x2222222222222222222222222222222222222222222222222222222222222222","codec":"dkg-ka-bundle-v1","projectionDigest":"0x0000000000000000000000000000000000000000000000000000000000000000","projectionId":"cg-shared-v1"}}';
const ROW_DIGEST =
  '0x14820ff6ae773dc2e6496419e059f3a423bd99572b8f828de01deedbec76aad7';
const KEY_DIGEST =
  '0x3e8dfe2886837263349072315b5308d53ed04a8593c7c74124bcf56b218037de';

const VALID_SCOPE = validatedScope(JSON.parse(SCOPE_CANONICAL));
const VALID_ROW = validatedRow(JSON.parse(ROW_CANONICAL));

describe('RFC-64 author catalog identifiers and graph names', () => {
  it('pins the prefix-free root/subgraph names and exact UTF-8 IRI encoding', () => {
    const rootLane = validatedLane({ contextGraphId: 'a/b', subGraphName: null });
    const subgraphLane = validatedLane({ contextGraphId: 'a', subGraphName: 'b' });
    expect(buildCatalogAssertionScopeV1(rootLane)).toBe('v1/root/a%2Fb');
    expect(buildCatalogAssertionScopeV1(subgraphLane)).toBe('v1/subgraph/a/b');
    expect(buildCatalogAssertionScopeV1(rootLane)).not.toBe(
      buildCatalogAssertionScopeV1(subgraphLane),
    );

    const unicodeLane = validatedLane({ contextGraphId: 'cg', subGraphName: 'café' });
    const coordinate = validatedCoordinate('name λ');
    expect(iriComponentV1('AZaz09-._~ /é')).toBe('AZaz09-._~%20%2F%C3%A9');
    expect(buildCatalogAssertionSubjectV1(unicodeLane, AUTHOR as EvmAddressV1, coordinate))
      .toBe(
        `did:dkg:context-graph:v1/subgraph/cg/caf%C3%A9/assertion/${AUTHOR}/name%20%CE%BB`,
      );
  });

  it('enforces exact network/context grammar, NFC, and UTF-8 byte ceilings', () => {
    expect(() => assertNetworkIdV1('otp:20430')).not.toThrow();
    expect(() => assertContextGraphIdV1('owner/cg.name@v1')).not.toThrow();
    expect(() => assertNetworkIdV1('otp/20430')).toThrow(/catalog-identifier/);
    expect(() => assertContextGraphIdV1('café')).toThrow(/catalog-identifier/);
    expect(() => assertSubGraphNameV1('e\u0301')).toThrow(/NFC-normalized/);
    expect(() => assertSubGraphNameV1('é')).not.toThrow();
    expect(() => assertAssertionCoordinateV1('\ud800')).toThrow(/unpaired/);
    expect(() => assertNetworkIdV1('a'.repeat(129))).toThrow(/128 UTF-8 bytes/);
    expect(() => assertSubGraphNameV1('é'.repeat(129))).toThrow(/256 UTF-8 bytes/);
  });

  it.each(['\u00a0', '\u2028', '\u2029', '\u200b', '\ufeff'])
  ('rejects catalog-forbidden code point %j', (codePoint) => {
    expect(() => assertSubGraphNameV1(`a${codePoint}b`)).toThrow(/forbidden/);
    expect(() => assertAssertionCoordinateV1(`a${codePoint}b`)).toThrow(/forbidden/);
  });

  it('accepts U+200C while rejecting slash, forbidden ASCII, and reserved lanes', () => {
    expect(() => assertSubGraphNameV1('a\u200cb')).not.toThrow();
    expect(() => assertAssertionCoordinateV1('a\u200cb')).not.toThrow();
    for (const value of ['a/b', 'a<b', 'a>b', 'a"b', 'a{b', 'a}b', 'a|b', 'a^b', 'a`b', 'a\\b']) {
      expect(() => assertSubGraphNameV1(value)).toThrow(/forbidden/);
      expect(() => assertAssertionCoordinateV1(value)).toThrow(/forbidden/);
    }
    for (const value of ['_private', 'context', 'assertion', 'draft']) {
      expect(() => assertSubGraphNameV1(value)).toThrow(/catalog-identifier/);
    }
    expect(() => assertAssertionCoordinateV1('_private')).not.toThrow();
  });

  it('pins isCatalogForbiddenCodePointV1 at every forbidden endpoint and adjacent allowed value', () => {
    // Every range endpoint and singleton the predicate forbids. A regression
    // dropping any branch (e.g. the C1 range or a singleton) is caught here.
    for (const cp of [
      0x0000, 0x001f, // C0 range endpoints
      0x007f, 0x009f, // C1 range endpoints
      0x00a0,
      0x1680,
      0x2000, 0x200b, // 0x2000..0x200b range endpoints
      0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
    ]) {
      expect(isCatalogForbiddenCodePointV1(cp)).toBe(true);
    }
    // Values immediately adjacent to each forbidden range/singleton stay allowed,
    // including U+200C (ZWNJ) right after the 0x2000..0x200b block.
    for (const cp of [
      0x0020, 0x007e, 0x00a1, 0x167f, 0x1681, 0x1fff, 0x200c, 0x2027,
      0x202a, 0x202e, 0x2030, 0x205e, 0x2060, 0x2fff, 0x3001, 0xfefe, 0xff00,
    ]) {
      expect(isCatalogForbiddenCodePointV1(cp)).toBe(false);
    }
  });

  it('rejects every forbidden endpoint through the lane identifier validators', () => {
    // NFC-stable forbidden code points only: U+2000/U+2001 have canonical
    // decompositions and would trip the earlier NFC guard, so the 0x2000..0x200b
    // range is represented here by its NFC-stable endpoint U+200B (the predicate
    // boundary test above proves 0x2000 itself is forbidden).
    for (const cp of [
      0x0000, 0x001f, 0x007f, 0x009f, 0x00a0, 0x1680,
      0x200b, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
    ]) {
      const identifier = `a${String.fromCodePoint(cp)}b`;
      expect(() => assertSubGraphNameV1(identifier)).toThrow(/forbidden character or code point/);
      expect(() => assertAssertionCoordinateV1(identifier)).toThrow(/forbidden character or code point/);
    }
  });
});

describe('AuthorCatalogScopeV1', () => {
  it('pins the exact 346-byte canonical fixture and scope digest', () => {
    expect(canonicalizeAuthorCatalogScopeV1(VALID_SCOPE)).toBe(SCOPE_CANONICAL);
    expect(new TextEncoder().encode(SCOPE_CANONICAL).byteLength).toBe(346);
    expect(computeAuthorCatalogScopeDigestV1(VALID_SCOPE)).toBe(SCOPE_DIGEST);
    expect(parseCanonicalAuthorCatalogScopeV1(SCOPE_CANONICAL)).toEqual(VALID_SCOPE);
    expect(buildCatalogAssertionScopeV1(VALID_SCOPE)).toBe(
      'v1/root/0x1111111111111111111111111111111111111111%2Fcatalog-fixture',
    );
  });

  it('accepts only paired governance fields and exact closed scalar fields', () => {
    const unregistered = validatedScope({
      ...VALID_SCOPE,
      governanceChainId: null,
      governanceContractAddress: null,
    });
    expect(() => assertAuthorCatalogScopeV1(unregistered)).not.toThrow();
    expect(() => assertAuthorCatalogScopeV1({
      ...VALID_SCOPE,
      governanceContractAddress: null,
    })).toThrow(/catalog-governance-tuple/);
    expect(() => assertAuthorCatalogScopeV1({ ...VALID_SCOPE, era: 0 })).toThrow(
      /catalog-scalar/,
    );
    expect(() => assertAuthorCatalogScopeV1({
      ...VALID_SCOPE,
      ownershipTransitionDigest: `0x${'AA'.repeat(32)}`,
    })).toThrow(/catalog-scalar/);
    expect(() => assertAuthorCatalogScopeV1({
      ...VALID_SCOPE,
      governanceContractAddress: `0x${'00'.repeat(20)}`,
    })).toThrow(/catalog-scalar/);
  });

  it('requires a canonical power-of-two bucket count through 2^63', () => {
    for (const value of ['1', '2', '256', MAX_AUTHOR_CATALOG_BUCKET_COUNT_V1.toString()]) {
      expect(() => assertAuthorCatalogBucketCountV1(value)).not.toThrow();
    }
    for (const value of ['0', '3', '9223372036854775809', 1, '01']) {
      expect(() => assertAuthorCatalogBucketCountV1(value)).toThrow();
    }
  });

  it('rejects missing, extra, symbol, accessor, noncanonical, and duplicate wire fields', () => {
    const missing = { ...VALID_SCOPE } as Record<string, unknown>;
    delete missing.era;
    expect(() => assertAuthorCatalogScopeV1(missing)).toThrow(/catalog-schema/);
    expect(() => assertAuthorCatalogScopeV1({ ...VALID_SCOPE, tier: 'swm' })).toThrow(
      /catalog-schema/,
    );
    const symbol = { ...VALID_SCOPE } as Record<PropertyKey, unknown>;
    symbol[Symbol('hidden')] = true;
    expect(() => assertAuthorCatalogScopeV1(symbol)).toThrow(/catalog-schema/);
    const accessor = { ...VALID_SCOPE };
    Object.defineProperty(accessor, 'era', { enumerable: true, get: () => '0' });
    expect(() => assertAuthorCatalogScopeV1(accessor)).toThrow(/catalog-schema/);
    expect(() => parseCanonicalAuthorCatalogScopeV1(
      SCOPE_CANONICAL.replace('"era":"0"', '"era":"0","era":"0"'),
    )).toThrow(/Duplicate object key/);
    expect(() => parseCanonicalAuthorCatalogScopeV1(` ${SCOPE_CANONICAL}`)).toThrow(
      /not RFC 8785 canonical/,
    );
  });
});

describe('AuthorCatalogRowV1 and key placement', () => {
  it('pins the exact key and seven-key row digest fixtures', () => {
    expect(new TextEncoder().encode('{"kaId":"1"}').byteLength).toBe(12);
    expect(computeAuthorCatalogKeyDigestV1('1' as KaIdV1)).toBe(KEY_DIGEST);
    expect(canonicalizeAuthorCatalogRowV1(VALID_ROW)).toBe(ROW_CANONICAL);
    expect(new TextEncoder().encode(
      `{"catalogScopeDigest":"${SCOPE_DIGEST}","row":${ROW_CANONICAL}}`,
    ).byteLength).toBe(746);
    expect(computeAuthorCatalogRowDigestV1(SCOPE_DIGEST, VALID_ROW)).toBe(ROW_DIGEST);
    expect(parseCanonicalAuthorCatalogRowV1(ROW_CANONICAL)).toEqual(VALID_ROW);
  });

  it('requires exact row/transfer projection equality', () => {
    expect(() => assertAuthorCatalogRowV1({
      ...VALID_ROW,
      transfer: { ...VALID_ROW.transfer, projectionDigest: BLOB_DIGEST },
    })).toThrow(/catalog-transfer-mismatch/);
    expect(() => assertAuthorCatalogRowV1({
      ...VALID_ROW,
      projectionId: 'private-v1',
    })).toThrow(/catalog-schema/);
    expect(() => assertAuthorCatalogRowV1({
      ...VALID_ROW,
      transfer: { ...VALID_ROW.transfer, chunkCount: '2' },
    })).toThrow(/catalog-schema/);
  });

  it('rejects hostile row shape, scalars, coordinate, and oversized wire input', () => {
    const missing = { ...VALID_ROW } as Record<string, unknown>;
    delete missing.sealDigest;
    expect(() => assertAuthorCatalogRowV1(missing)).toThrow(/catalog-schema/);
    expect(() => assertAuthorCatalogRowV1({ ...VALID_ROW, tier: 'swm' })).toThrow(
      /catalog-schema/,
    );
    const symbol = { ...VALID_ROW } as Record<PropertyKey, unknown>;
    symbol[Symbol('hidden')] = true;
    expect(() => assertAuthorCatalogRowV1(symbol)).toThrow(/catalog-schema/);
    const accessor = { ...VALID_ROW };
    Object.defineProperty(accessor, 'sealDigest', {
      enumerable: true,
      get: () => SEAL_DIGEST,
    });
    expect(() => assertAuthorCatalogRowV1(accessor)).toThrow(/catalog-schema/);
    expect(() => assertAuthorCatalogRowV1({ ...VALID_ROW, kaId: 1 })).toThrow(
      /catalog-scalar/,
    );
    expect(() => assertAuthorCatalogRowV1({ ...VALID_ROW, assertionVersion: '01' })).toThrow(
      /catalog-scalar/,
    );
    expect(() => assertAuthorCatalogRowV1({ ...VALID_ROW, assertionVersion: '0' })).toThrow(
      /positive DecimalU64V1/,
    );
    expect(() => parseCanonicalAuthorCatalogRowV1(
      ROW_CANONICAL.replace('"assertionVersion":"1"', '"assertionVersion":"0"'),
    )).toThrow(/positive DecimalU64V1/);
    expect(() => assertAuthorCatalogRowV1({
      ...VALID_ROW,
      assertionCoordinate: 'bad/name',
    })).toThrow(/catalog-identifier/);
    expect(() => parseCanonicalAuthorCatalogRowV1(
      '{'.padEnd(MAX_AUTHOR_CATALOG_ROW_BYTES_V1 + 1, 'x'),
    )).toThrow(/object-too-large/);
  });

  it('compares full u256 KA ids numerically and maps key prefixes to buckets', () => {
    expect(compareAuthorCatalogKaIdsV1('2' as KaIdV1, '10' as KaIdV1)).toBe(-1);
    expect(compareAuthorCatalogKaIdsV1('10' as KaIdV1, '2' as KaIdV1)).toBe(1);
    expect(compareAuthorCatalogKaIdsV1('10' as KaIdV1, '10' as KaIdV1)).toBe(0);
    expect(compareAuthorCatalogKaIdsV1(
      '115792089237316195423570985008687907853269984665640564039457584007913129639935' as KaIdV1,
      '10' as KaIdV1,
    )).toBe(1);

    expect(catalogKeyDigestToBucketIdV1(KEY_DIGEST, '1')).toBe('0');
    expect(catalogKeyDigestToBucketIdV1(KEY_DIGEST, '8')).toBe('1');
    expect(catalogKeyDigestToBucketIdV1(KEY_DIGEST, '16')).toBe('3');
    expect(catalogKeyDigestToBucketIdV1(KEY_DIGEST, '256')).toBe('62');
    expect(catalogKeyDigestToBucketIdV1(
      KEY_DIGEST,
      MAX_AUTHOR_CATALOG_BUCKET_COUNT_V1.toString() as AuthorCatalogScopeV1['bucketCount'],
    )).toBe('2253769126038321457');
    expect(catalogKeyToBucketIdV1('1' as KaIdV1, '256')).toBe('62');
  });

  it('keeps defensive codec ceilings above maximum-width valid scope and row values', () => {
    const maximumScope = validatedScope({
      ...VALID_SCOPE,
      networkId: 'n'.repeat(128),
      contextGraphId: 'c'.repeat(256),
      governanceChainId:
        '115792089237316195423570985008687907853269984665640564039457584007913129639935',
      ownershipTransitionDigest: ZERO_DIGEST,
      subGraphName: 'é'.repeat(128),
      era: '18446744073709551615',
      bucketCount: MAX_AUTHOR_CATALOG_BUCKET_COUNT_V1.toString(),
    });
    const maximumRow = validatedRow({
      ...VALID_ROW,
      kaId:
        '115792089237316195423570985008687907853269984665640564039457584007913129639935',
      assertionCoordinate: 'é'.repeat(128),
      assertionVersion: '18446744073709551615',
      transfer: {
        ...VALID_ROW.transfer,
        byteLength: '1073741824',
        chunkCount: '4096',
      },
    });

    expect(new TextEncoder().encode(canonicalizeAuthorCatalogScopeV1(maximumScope)).byteLength)
      .toBeLessThanOrEqual(MAX_AUTHOR_CATALOG_SCOPE_BYTES_V1);
    expect(new TextEncoder().encode(canonicalizeAuthorCatalogRowV1(maximumRow)).byteLength)
      .toBeLessThanOrEqual(MAX_AUTHOR_CATALOG_ROW_BYTES_V1);
    expect(() => computeAuthorCatalogRowDigestV1(SCOPE_DIGEST, maximumRow)).not.toThrow();
    expect(MAX_AUTHOR_CATALOG_ROW_DIGEST_INPUT_BYTES_V1).toBeGreaterThan(
      MAX_AUTHOR_CATALOG_ROW_BYTES_V1,
    );
  });

  it('checks the safely derivable packed high-160 author binding', () => {
    const packed = ((BigInt(AUTHOR) << 96n) | 7n).toString() as KaIdV1;
    expect(() => assertPackedKaIdAuthorBindingV1(packed, AUTHOR as EvmAddressV1))
      .not.toThrow();
    expect(() => assertPackedKaIdAuthorBindingV1(
      packed,
      `0x${'55'.repeat(20)}` as EvmAddressV1,
    )).toThrow(/catalog-packed-author-mismatch/);

    const boundRow = validatedRow({ ...VALID_ROW, kaId: packed });
    expect(() => assertAuthorCatalogRowScopeBindingV1(boundRow, VALID_SCOPE)).not.toThrow();
    expect(() => assertAuthorCatalogRowScopeBindingV1(VALID_ROW, VALID_SCOPE)).toThrow(
      /catalog-packed-author-mismatch/,
    );
  });
});

function validatedScope(value: unknown): AuthorCatalogScopeV1 {
  assertAuthorCatalogScopeV1(value);
  return value;
}

function validatedRow(value: unknown): AuthorCatalogRowV1 {
  assertAuthorCatalogRowV1(value);
  return value;
}

function validatedCoordinate(value: unknown): AssertionCoordinateV1 {
  assertAssertionCoordinateV1(value);
  return value;
}

function validatedLane(value: {
  contextGraphId: string;
  subGraphName: string | null;
}): CatalogLaneV1 {
  assertContextGraphIdV1(value.contextGraphId);
  if (value.subGraphName !== null) assertSubGraphNameV1(value.subGraphName);
  return value as {
    contextGraphId: ContextGraphIdV1;
    subGraphName: SubGraphNameV1 | null;
  };
}
