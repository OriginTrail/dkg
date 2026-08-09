import { describe, expect, it } from 'vitest';

import {
  assertAuthorCatalogRowV1,
  type AuthorCatalogRowV1,
} from '../src/author-catalog-codec.js';
import {
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  computeAuthorCatalogHeadObjectDigestV1,
  type AuthorCatalogHeadV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
} from '../src/author-catalog-objects.js';
import {
  CG_SHARED_PRIVATE_ANCHOR_PREDICATE_V1,
  DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1,
  CgSharedProjectionError,
  assertVerifiedCgSharedProjectionForTransferV1,
  assertVerifiedCgSharedProjectionV1,
  decodeCanonicalGraphlessProjectionV1,
  readVerifiedCgSharedProjectionBytesV1,
  readVerifiedCgSharedProjectionMetadataV1,
  readVerifiedCgSharedProjectionV1,
  verifyCgSharedProjectionV1,
  type CgSharedProjectionErrorCode,
  type CgSharedProjectionVerificationLimitsV1,
} from '../src/cg-shared-projection.js';
import type { CatalogSealDeploymentProfileV1 } from '../src/catalog-seal-binding.js';
import {
  assertCanonicalGraphScopedAuthorSealV1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  type CanonicalGraphScopedAuthorSealV1,
} from '../src/canonical-graph-scoped-author-seal.js';
import { hashTripleV10 } from '../src/crypto/canonicalize.js';
import {
  SENTINEL_NO_PRIVATE_V10,
  V10MerkleTree,
} from '../src/crypto/v10-merkle.js';
import { encodeOpaqueKaBundleV1 } from '../src/ka-bundle-v1.js';
import { computeKaChunkTreeRootV1 } from '../src/ka-chunk-tree.js';
import type { UnsignedControlEnvelopeV1 } from '../src/sync-control-object.js';
import {
  readVerifiedTransferredCatalogBundleMetadataV1,
  readVerifiedTransferredCatalogProjectionBytesV1,
  verifyTransferredCatalogBundleV1,
  type VerifiedTransferredCatalogBundleV1,
} from '../src/transferred-catalog-bundle.js';

const AUTHOR = '0x3333333333333333333333333333333333333333';
const ISSUER = '0x5555555555555555555555555555555555555555';
const KAV10 = '0x4444444444444444444444444444444444444444';
const KA_ID =
  '23158417847463239084714197001737581570653996933112267175388663934063917137927';
const UAL = `did:dkg:otp:20430/${AUTHOR}/7`;
const COMMITMENT = `${UAL}/_cg-shared-v1`;
const EIP191_SIGNATURE = `0x${'77'.repeat(65)}`;
const ZERO_DIGEST = `0x${'00'.repeat(32)}`;
const UTF8 = new TextEncoder();

const PROFILE = {
  networkId: 'otp:20430',
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
} as CatalogSealDeploymentProfileV1;

const PUBLIC =
  '<https://example.org/alice> <https://schema.org/age> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
  + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n';
const MIXED =
  `<${COMMITMENT}> <http://dkg.io/ontology/privateDataAnchor> "true" .\n`
  + `<${COMMITMENT}> <http://dkg.io/ontology/privateDataHash> "95f31b6b9c7ac80554b3808b2cef2f6542c89a28947ede43d194bb8022398e2c"^^<http://www.w3.org/2001/XMLSchema#hexBinary> .\n`
  + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n';
const FULLY_WITHHELD =
  `<${COMMITMENT}> <http://dkg.io/ontology/privateDataAnchor> "true" .\n`
  + `<${COMMITMENT}> <http://dkg.io/ontology/privateDataHash> "034349e1ac2b108ba81720c55dff02bcae22762921f5c8354db83e687015872c"^^<http://www.w3.org/2001/XMLSchema#hexBinary> .\n`;

describe('RFC-64 canonical cg-shared-v1 projection verification', () => {
  it('decodes exact canonical bytes into graphless triples', () => {
    expect(decodeCanonicalGraphlessProjectionV1(UTF8.encode(PUBLIC))).toEqual([
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/age',
        object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
      },
      {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/name',
        object: '"Alice"',
      },
    ]);
    expect(decodeCanonicalGraphlessProjectionV1(UTF8.encode(
      '<https://example.org/s> <https://example.org/p> <https://example.org/o> .\n',
    ))).toEqual([{
      subject: 'https://example.org/s',
      predicate: 'https://example.org/p',
      object: 'https://example.org/o',
    }]);
  });

  it.each([
    {
      name: 'graph term',
      bytes: UTF8.encode('<https://example.org/s> <https://example.org/p> <https://example.org/o> <https://example.org/g> .\n'),
      code: 'projection-iri',
    },
    {
      name: 'raw byte disorder',
      bytes: UTF8.encode(PUBLIC.split('\n').filter(Boolean).reverse().join('\n') + '\n'),
      code: 'projection-order',
    },
    {
      name: 'invalid UTF-8',
      bytes: new Uint8Array([
        ...UTF8.encode('<https://example.org/s> <https://example.org/p> "'),
        0xc3,
        0x28,
        ...UTF8.encode('" .\n'),
      ]),
      code: 'projection-utf8',
    },
  ])('rejects $name before returning triples', ({ bytes, code }) => {
    expectFailure(
      () => decodeCanonicalGraphlessProjectionV1(bytes),
      code as CgSharedProjectionErrorCode,
    );
  });

  it.each([
    {
      name: 'public',
      projection: PUBLIC,
      seal: {
        assertionMerkleRoot: '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f',
        publicTripleCount: '2',
        privateTripleCount: '0',
        privateMerkleRoot: null,
      },
      projectionDigest: '0x11e4d5cf843a836e3500a4a8d9bdc4495708056976247ad996f3497f5ff82e3d',
      publicRoot: '0x0ff81162102568cf16401e4beebc03561950e6bb5b19ac686b9fa0e4132637ba',
      privateDataHash: '0xdfba2a3576c2aa2d73ecd8c55d1c27cfb15691ca9d3237b86434a06592f160ee',
    },
    {
      name: 'mixed',
      projection: MIXED,
      seal: {
        assertionMerkleRoot: '0xb775676d78d72f9038ba726111b5f64c40f1cad159e7cada86dd7de16dbb6fa1',
        publicTripleCount: '3',
        privateTripleCount: '1',
        privateMerkleRoot: '0x95f31b6b9c7ac80554b3808b2cef2f6542c89a28947ede43d194bb8022398e2c',
      },
      projectionDigest: '0xc45c59668c441426519220914ebeb59694ed60b2e502c7bff2548f3a8a3bcc4f',
      publicRoot: '0xe3181c31fc57bed6862d86136c3f50b7c854ecfd602196a3862877bac2469e23',
      privateDataHash: '0x95f31b6b9c7ac80554b3808b2cef2f6542c89a28947ede43d194bb8022398e2c',
    },
    {
      name: 'fully withheld',
      projection: FULLY_WITHHELD,
      seal: {
        assertionMerkleRoot: '0xe0f1eb9ec6ed3efe806b900cf738b81277c28e68a669b345318bf825e51f4378',
        publicTripleCount: '2',
        privateTripleCount: '2',
        privateMerkleRoot: '0x034349e1ac2b108ba81720c55dff02bcae22762921f5c8354db83e687015872c',
      },
      projectionDigest: '0x508144f5a405975107fb0977fe7efb0554b63615b293ef8472b805fcded525fa',
      publicRoot: '0x7758136bc9fbf2e668b694c0b4dae7188d559eaad1ccd7d1fbc062de16360e92',
      privateDataHash: '0x034349e1ac2b108ba81720c55dff02bcae22762921f5c8354db83e687015872c',
    },
  ])('accepts the normative $name vector', (vector) => {
    const fixture = makeFixture(vector.projection, vector.seal);
    const verified = verifyProjection(fixture);
    expect(Object.getPrototypeOf(verified)).toBeNull();
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Reflect.ownKeys(verified as object)).toEqual([]);
    const snapshot = readProjection(verified, fixture);
    expect(snapshot).toMatchObject({
      projectionDigest: vector.projectionDigest,
      projectionByteLength: String(UTF8.encode(vector.projection).byteLength),
      publicRoot: vector.publicRoot,
      privateDataHash: vector.privateDataHash,
      assertionMerkleRoot: vector.seal.assertionMerkleRoot,
      publicTripleCount: vector.seal.publicTripleCount,
      privateTripleCount: vector.seal.privateTripleCount,
      privateMerkleRoot: vector.seal.privateMerkleRoot,
      kaUal: UAL,
      verificationLimits: DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1,
    });
    expect(snapshot.projectionBytes).toEqual(UTF8.encode(vector.projection));
  });

  it('sorts by raw UTF-8 bytes rather than JavaScript UTF-16 code units', () => {
    const first = '<https://example.org/\uF900> <https://schema.org/name> "bmp" .';
    const second = '<https://example.org/\u{10000}> <https://schema.org/name> "astral" .';
    expect([first, second].sort()).toEqual([second, first]);
    const canonical = `${first}\n${second}\n`;
    const fixture = makeFixture(canonical, sealForProjection(canonical, '0', null));
    expect(() => verifyProjection(fixture)).not.toThrow();

    const wrongOrder = `${second}\n${first}\n`;
    const wrong = makeFixture(wrongOrder, sealForProjection(wrongOrder, '0', null));
    expectFailure(() => verifyProjection(wrong), 'projection-order');
  });

  it.each([
    '<a:> <https://schema.org/name> "empty hierarchy" .\n',
    '<urn:test:\u00A0> <https://schema.org/name> "RFC3987 non-ASCII space" .\n',
  ])('accepts valid RFC3987 boundary IRIs without legacy regex narrowing', (projection) => {
    const fixture = makeFixture(projection, sealForProjection(projection, '0', null));
    expect(() => verifyProjection(fixture)).not.toThrow();
  });

  it('returns only fresh projection copies from both verification boundaries', () => {
    const fixture = makeFixture(PUBLIC, {
      assertionMerkleRoot: '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f',
      publicTripleCount: '2',
      privateTripleCount: '0',
      privateMerkleRoot: null,
    });
    const metadata = readVerifiedTransferredCatalogBundleMetadataV1(
      fixture.transferred,
      fixture.head,
      fixture.row,
      PROFILE,
    );
    expect('bundleBytes' in metadata).toBe(false);
    const firstTransferRead = readVerifiedTransferredCatalogProjectionBytesV1(
      fixture.transferred,
      fixture.head,
      fixture.row,
      PROFILE,
    );
    firstTransferRead.fill(0);
    expect(readVerifiedTransferredCatalogProjectionBytesV1(
      fixture.transferred,
      fixture.head,
      fixture.row,
      PROFILE,
    )).toEqual(UTF8.encode(PUBLIC));

    const verified = verifyProjection(fixture);
    const projectionMetadata = readVerifiedCgSharedProjectionMetadataV1(
      verified,
      fixture.transferred,
      fixture.head,
      fixture.row,
      PROFILE,
    );
    expect('projectionBytes' in projectionMetadata).toBe(false);
    expect(projectionMetadata.projectionByteLength).toBe(String(UTF8.encode(PUBLIC).byteLength));
    const explicitBytes = readVerifiedCgSharedProjectionBytesV1(
      verified,
      fixture.transferred,
      fixture.head,
      fixture.row,
      PROFILE,
    );
    explicitBytes.fill(0);
    expect(readVerifiedCgSharedProjectionBytesV1(
      verified,
      fixture.transferred,
      fixture.head,
      fixture.row,
      PROFILE,
    )).toEqual(UTF8.encode(PUBLIC));
    const first = readProjection(verified, fixture);
    first.projectionBytes.fill(0);
    expect(readProjection(verified, fixture).projectionBytes).toEqual(UTF8.encode(PUBLIC));
  });

  it('rejects forged capabilities and cross-transfer replay', () => {
    const fixture = publicFixture();
    const verified = verifyProjection(fixture);
    for (const forged of [
      Object.freeze({}),
      Object.freeze({ ...verified as object }),
      JSON.parse(JSON.stringify(verified)),
    ]) {
      expectFailure(() => assertVerifiedCgSharedProjectionV1(forged), 'projection-capability');
    }
    const secondTransfer = verifyTransferredCatalogBundleV1(
      fixture.head,
      fixture.row,
      fixture.encoded.bundleBytes,
      PROFILE,
    );
    expectFailure(
      () => assertVerifiedCgSharedProjectionForTransferV1(
        verified,
        secondTransfer,
        fixture.head,
        fixture.row,
        PROFILE,
      ),
      'projection-binding',
    );
  });

  it.each([
    {
      name: 'random private anchor',
      projection: FULLY_WITHHELD.replaceAll(COMMITMENT, 'urn:dkg:private:00000000-0000-4000-8000-000000000000'),
      seal: {
        assertionMerkleRoot: '0x05eea89e80cb5eb80720e2ae005ab8a7df9baa4e3a3abdd5cd8af0c9185dc096',
        publicTripleCount: '2', privateTripleCount: '2',
        privateMerkleRoot: '0x034349e1ac2b108ba81720c55dff02bcae22762921f5c8354db83e687015872c',
      },
      code: 'projection-private-subject',
    },
    {
      name: 'missing private hash',
      projection: FULLY_WITHHELD.split('\n')[0] + '\n',
      seal: {
        assertionMerkleRoot: '0x68c726f6225b11c09ee3d6b591a2a6c1fae140c976b73f285fd47d62d629370b',
        publicTripleCount: '1', privateTripleCount: '2',
        privateMerkleRoot: '0x034349e1ac2b108ba81720c55dff02bcae22762921f5c8354db83e687015872c',
      },
      code: 'projection-private-cardinality',
    },
    {
      name: 'wrong private hash',
      projection: FULLY_WITHHELD.replace(
        '034349e1ac2b108ba81720c55dff02bcae22762921f5c8354db83e687015872c',
        'f'.repeat(64),
      ),
      seal: {
        assertionMerkleRoot: '0x4b521d726668cc2d6cdd4427690c3e47e92cf6733d850e3303feb0fca0b68e31',
        publicTripleCount: '2', privateTripleCount: '2',
        privateMerkleRoot: '0x034349e1ac2b108ba81720c55dff02bcae22762921f5c8354db83e687015872c',
      },
      code: 'projection-private-root-mismatch',
    },
    {
      name: 'unsorted public lines',
      projection: PUBLIC.split('\n').filter(Boolean).reverse().join('\n') + '\n',
      seal: {
        assertionMerkleRoot: '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f',
        publicTripleCount: '2', privateTripleCount: '0', privateMerkleRoot: null,
      },
      code: 'projection-order',
    },
    {
      name: 'duplicate public line',
      projection: PUBLIC.split('\n')[0] + '\n' + PUBLIC,
      seal: {
        assertionMerkleRoot: '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f',
        publicTripleCount: '3', privateTripleCount: '0', privateMerkleRoot: null,
      },
      code: 'projection-duplicate',
    },
    {
      name: 'CRLF',
      projection: PUBLIC.replaceAll('\n', '\r\n'),
      seal: {
        assertionMerkleRoot: '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f',
        publicTripleCount: '2', privateTripleCount: '0', privateMerkleRoot: null,
      },
      code: 'projection-line-ending',
    },
  ] as const)('rejects the normative $name vector', (vector) => {
    const fixture = makeFixture(vector.projection, vector.seal);
    expectFailure(() => verifyProjection(fixture), vector.code);
  });

  it.each([
    ['missing final LF', PUBLIC.slice(0, -1), 'projection-line-ending'],
    ['leading BOM', `\uFEFF${PUBLIC}`, 'projection-utf8'],
    ['leading space', ` ${PUBLIC}`, 'projection-iri'],
    ['blank-node subject', '_:b0 <https://schema.org/name> "Alice" .\n', 'projection-iri'],
    ['relative IRI', '<relative> <https://schema.org/name> "Alice" .\n', 'projection-iri'],
    ['bad percent escape', '<https://example.org/%zz> <https://schema.org/name> "Alice" .\n', 'projection-iri'],
    ['malformed IP literal', '<http://[> <https://schema.org/name> "Alice" .\n', 'projection-iri'],
    ['forbidden bracket in path', '<http://example.org/[x> <https://schema.org/name> "Alice" .\n', 'projection-iri'],
    ['RFC3987 noncharacter', '<urn:test:\uFFFF> <https://schema.org/name> "Alice" .\n', 'projection-iri'],
    ['fourth graph term', '<https://example.org/s> <https://example.org/p> "x" <https://example.org/g> .\n', 'projection-literal'],
    ['blank-node object', '<https://example.org/s> <https://example.org/p> _:b0 .\n', 'projection-line'],
    ['RDF-star object', '<https://example.org/s> <https://example.org/p> << <https://example.org/a> <https://example.org/b> "x" >> .\n', 'projection-iri'],
    ['doubled separator', '<https://example.org/s>  <https://example.org/p> "x" .\n', 'projection-iri'],
    ['trailing space', '<https://example.org/s> <https://example.org/p> "x" . \n', 'projection-line'],
    ['explicit xsd:string', '<https://example.org/s> <https://example.org/p> "x"^^<http://www.w3.org/2001/XMLSchema#string> .\n', 'projection-literal'],
    ['uppercase language', '<https://example.org/s> <https://example.org/p> "x"@EN .\n', 'projection-literal'],
    ['noncanonical integer', '<https://example.org/s> <https://example.org/p> "+042"^^<http://www.w3.org/2001/XMLSchema#integer> .\n', 'projection-literal'],
    ['unknown reserved predicate', '<https://example.org/s> <http://dkg.io/ontology/privateDataOther> "x" .\n', 'projection-private-predicate'],
  ] as const)('rejects %s', (_name, projection, code) => {
    const fixture = makeFixture(
      projection,
      sealForProjection(projection, '0', null),
    );
    expectFailure(() => verifyProjection(fixture), code);
  });

  it('rejects an empty projection before root work', () => {
    const fixture = makeFixture('', {
      assertionMerkleRoot: ZERO_DIGEST,
      publicTripleCount: '1',
      privateTripleCount: '0',
      privateMerkleRoot: null,
    });
    expectFailure(() => verifyProjection(fixture), 'projection-empty');
  });

  it('rejects invalid UTF-8 before term work', () => {
    const bytes = UTF8.encode(PUBLIC);
    bytes[1] = 0xff;
    const fixture = makeFixtureBytes(bytes, {
      assertionMerkleRoot: '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f',
      publicTripleCount: '2', privateTripleCount: '0', privateMerkleRoot: null,
    });
    expectFailure(() => verifyProjection(fixture), 'projection-utf8');
  });

  it('rejects public count and structured-root mismatches independently', () => {
    const wrongCount = makeFixture(PUBLIC, {
      assertionMerkleRoot: '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f',
      publicTripleCount: '3', privateTripleCount: '0', privateMerkleRoot: null,
    });
    expectFailure(() => verifyProjection(wrongCount), 'projection-public-count');

    const wrongRoot = makeFixture(PUBLIC, {
      assertionMerkleRoot: ZERO_DIGEST,
      publicTripleCount: '2', privateTripleCount: '0', privateMerkleRoot: null,
    });
    expectFailure(() => verifyProjection(wrongRoot), 'projection-structured-root');
  });

  it('rejects private commitment predicates in a public-only projection', () => {
    const projection =
      `<${COMMITMENT}> <${CG_SHARED_PRIVATE_ANCHOR_PREDICATE_V1}> "true" .\n`;
    const fixture = makeFixture(projection, sealForProjection(projection, '0', null));
    expectFailure(() => verifyProjection(fixture), 'projection-private-cardinality');
  });

  it('rejects an xsd:boolean private anchor even when the alternate root is signed', () => {
    const projection = FULLY_WITHHELD.replace(
      '"true" .',
      '"true"^^<http://www.w3.org/2001/XMLSchema#boolean> .',
    );
    const fixture = makeFixture(
      projection,
      sealForProjection(
        projection,
        '2',
        '0x034349e1ac2b108ba81720c55dff02bcae22762921f5c8354db83e687015872c',
      ),
    );
    expectFailure(() => verifyProjection(fixture), 'projection-private-cardinality');
  });

  it('does not inherit mutation of the exported V10 no-private sentinel', () => {
    const fixture = publicFixture();
    const original = new Uint8Array(SENTINEL_NO_PRIVATE_V10);
    try {
      SENTINEL_NO_PRIVATE_V10.fill(0);
      const verified = verifyProjection(fixture);
      expect(readProjection(verified, fixture).assertionMerkleRoot).toBe(
        '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f',
      );
    } finally {
      SENTINEL_NO_PRIVATE_V10.set(original);
    }
  });

  it('reserves the deterministic commitment subject exclusively for codec rows', () => {
    const projection =
      `<${COMMITMENT}> <https://example.org/not-a-commitment> "x" .\n`;
    const fixture = makeFixture(projection, sealForProjection(projection, '0', null));
    expectFailure(() => verifyProjection(fixture), 'projection-private-subject');
  });

  it.each([
    {
      name: 'uppercase private hash',
      projection: FULLY_WITHHELD.replace('034349e1', 'A34349e1'),
    },
    {
      name: '0x-prefixed private hash',
      projection: FULLY_WITHHELD.replace('"034349e1', '"0x034349e1'),
    },
  ])('rejects $name even when the alternate bytes are sealed', ({ projection }) => {
    const fixture = makeFixture(
      projection,
      sealForProjection(
        projection,
        '2',
        '0x034349e1ac2b108ba81720c55dff02bcae22762921f5c8354db83e687015872c',
      ),
    );
    expectFailure(() => verifyProjection(fixture), 'projection-private-root-mismatch');
  });

  it('rejects distinct duplicate commitment predicates', () => {
    const duplicate =
      `<${COMMITMENT}> <${CG_SHARED_PRIVATE_ANCHOR_PREDICATE_V1}> "false" .\n`;
    const projection = [
      ...FULLY_WITHHELD.trimEnd().split('\n'),
      duplicate.trimEnd(),
    ].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))).join('\n') + '\n';
    const fixture = makeFixture(
      projection,
      sealForProjection(
        projection,
        '2',
        '0x034349e1ac2b108ba81720c55dff02bcae22762921f5c8354db83e687015872c',
      ),
    );
    expectFailure(() => verifyProjection(fixture), 'projection-private-cardinality');
  });

  it('distinguishes local resource refusal from malformed projection bytes', () => {
    const fixture = publicFixture();
    expectFailure(
      () => verifyProjection(fixture, {
        maxProjectionBytes: UTF8.encode(PUBLIC).byteLength - 1,
        maxPublicTriples: 2,
        maxLineBytes: UTF8.encode(PUBLIC).byteLength - 1,
      }),
      'projection-resource-refused',
    );
    expectFailure(
      () => verifyProjection(fixture, {
        maxProjectionBytes: UTF8.encode(PUBLIC).byteLength,
        maxPublicTriples: 1,
        maxLineBytes: UTF8.encode(PUBLIC).byteLength,
      }),
      'projection-resource-refused',
    );
    expectFailure(
      () => verifyProjection(fixture, {
        maxProjectionBytes: UTF8.encode(PUBLIC).byteLength,
        maxPublicTriples: 2,
        maxLineBytes: 32,
      }),
      'projection-resource-refused',
    );
  });

  it('rejects unsupported or internally inconsistent verifier limits', () => {
    const fixture = publicFixture();
    for (const limits of [
      { maxProjectionBytes: 0, maxPublicTriples: 2, maxLineBytes: 1 },
      {
        maxProjectionBytes:
          DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1.maxProjectionBytes + 1,
        maxPublicTriples: 2,
        maxLineBytes: 1,
      },
      { maxProjectionBytes: 64, maxPublicTriples: 2, maxLineBytes: 65 },
    ]) {
      expectFailure(
        () => verifyProjection(fixture, limits),
        'projection-resource-refused',
      );
    }
  });

  it('reads each caller-controlled limit exactly once (stateful-getter safe)', () => {
    const fixture = publicFixture();
    const hard = DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1;
    const reads = { maxProjectionBytes: 0, maxPublicTriples: 0, maxLineBytes: 0 };
    const limits: CgSharedProjectionVerificationLimitsV1 = {
      get maxProjectionBytes() {
        reads.maxProjectionBytes += 1;
        return hard.maxProjectionBytes;
      },
      get maxPublicTriples() {
        reads.maxPublicTriples += 1;
        return hard.maxPublicTriples;
      },
      get maxLineBytes() {
        reads.maxLineBytes += 1;
        return hard.maxLineBytes;
      },
    };
    const verified = verifyProjection(fixture, limits);
    // A stateful getter must be consulted exactly once per property so a later
    // read cannot diverge from the validated value.
    expect(reads).toEqual({ maxProjectionBytes: 1, maxPublicTriples: 1, maxLineBytes: 1 });
    expect(readProjection(verified, fixture).verificationLimits).toEqual(hard);
  });

  it('cannot be tricked by a getter that turns oversized after validation', () => {
    const fixture = publicFixture();
    const safeBelowProjection = UTF8.encode(PUBLIC).byteLength - 1;
    let projectionByteReads = 0;
    // First read returns a safe value that passes validation; every later read
    // returns an oversized value. A second read leaking into the effective
    // ceiling would accept this over-limit projection instead of refusing it.
    const limits: CgSharedProjectionVerificationLimitsV1 = {
      get maxProjectionBytes() {
        projectionByteReads += 1;
        return projectionByteReads === 1 ? safeBelowProjection : Number.MAX_SAFE_INTEGER;
      },
      maxPublicTriples: 2,
      maxLineBytes: safeBelowProjection,
    };
    expectFailure(() => verifyProjection(fixture, limits), 'projection-resource-refused');
  });
});

interface Fixture {
  readonly head: SignedAuthorCatalogHeadEnvelopeV1;
  readonly row: AuthorCatalogRowV1;
  readonly encoded: ReturnType<typeof encodeOpaqueKaBundleV1>;
  readonly transferred: VerifiedTransferredCatalogBundleV1;
}

function publicFixture(): Fixture {
  return makeFixture(PUBLIC, {
    assertionMerkleRoot: '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f',
    publicTripleCount: '2', privateTripleCount: '0', privateMerkleRoot: null,
  });
}

function makeFixture(
  projection: string,
  sealFields: Pick<
    CanonicalGraphScopedAuthorSealV1,
    'assertionMerkleRoot' | 'publicTripleCount' | 'privateTripleCount' | 'privateMerkleRoot'
  >,
): Fixture {
  return makeFixtureBytes(UTF8.encode(projection), sealFields);
}

function makeFixtureBytes(
  projectionBytes: Uint8Array,
  sealFields: Pick<
    CanonicalGraphScopedAuthorSealV1,
    'assertionMerkleRoot' | 'publicTripleCount' | 'privateTripleCount' | 'privateMerkleRoot'
  >,
): Fixture {
  const seal = validSeal({
    assertionMerkleRoot: sealFields.assertionMerkleRoot,
    authorAddress: AUTHOR,
    authorAttestationR: `0x${'11'.repeat(32)}`,
    authorAttestationVS: `0x${'22'.repeat(32)}`,
    authorSchemeVersion: '1',
    assertedAtChainId: '20430',
    assertedAtKav10Address: KAV10,
    reservedKaId: KA_ID,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal: UAL,
    assertionVersion: '2',
    publicTripleCount: sealFields.publicTripleCount,
    privateTripleCount: sealFields.privateTripleCount,
    privateMerkleRoot: sealFields.privateMerkleRoot,
  });
  const sealBytes = canonicalizeCanonicalGraphScopedAuthorSealBytesV1(seal);
  const encoded = encodeOpaqueKaBundleV1(projectionBytes, sealBytes);
  const row = rowForBundle(
    encoded.bundleBytes,
    encoded.projectionDigest,
    encoded.blobDigest,
    computeCanonicalGraphScopedAuthorSealDigestV1(seal),
  );
  const head = signedHead({
    networkId: 'otp:20430',
    contextGraphId: 'a/b',
    governanceChainId: '20430',
    governanceContractAddress: '0x6666666666666666666666666666666666666666',
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    catalogIssuerDelegationDigest: `0x${'77'.repeat(32)}`,
    era: '0',
    version: '1',
    previousHeadDigest: null,
    bucketCount: '1',
    totalRows: '1',
    directoryHeight: '0',
    directoryRootDigest: `0x${'88'.repeat(32)}`,
    issuedAt: '1700000000123',
  });
  const transferred = verifyTransferredCatalogBundleV1(
    head,
    row,
    encoded.bundleBytes,
    PROFILE,
  );
  return { head, row, encoded, transferred };
}

function sealForProjection(
  projection: string,
  privateTripleCount: string,
  privateMerkleRoot: string | null,
): Pick<
  CanonicalGraphScopedAuthorSealV1,
  'assertionMerkleRoot' | 'publicTripleCount' | 'privateTripleCount' | 'privateMerkleRoot'
> {
  const lines = projection.endsWith('\n')
    ? projection.slice(0, -1).split('\n')
    : projection.split('\n');
  const leaves = lines.filter(Boolean).map((line) => {
    const match = /^(<[^>]+>) (<[^>]+>) (.+) \.$/.exec(line);
    if (!match) return hashTripleV10('https://invalid.example/s', 'https://invalid.example/p', '"x"');
    return hashTripleV10(match[1].slice(1, -1), match[2].slice(1, -1), match[3]);
  });
  const publicRoot = leaves.length === 0 ? new Uint8Array(32) : new V10MerkleTree(leaves).root;
  const privateDataHash = privateMerkleRoot === null
    ? SENTINEL_NO_PRIVATE_V10
    : hexToBytes(privateMerkleRoot);
  return {
    assertionMerkleRoot: bytesToHex(V10MerkleTree.computeKARoot(publicRoot, privateDataHash)),
    publicTripleCount: String(lines.filter(Boolean).length),
    privateTripleCount,
    privateMerkleRoot,
  } as Pick<
    CanonicalGraphScopedAuthorSealV1,
    'assertionMerkleRoot' | 'publicTripleCount' | 'privateTripleCount' | 'privateMerkleRoot'
  >;
}

function verifyProjection(
  fixture: Fixture,
  limits?: CgSharedProjectionVerificationLimitsV1,
) {
  return verifyCgSharedProjectionV1(
    fixture.transferred,
    fixture.head,
    fixture.row,
    PROFILE,
    limits,
  );
}

function readProjection(
  verified: ReturnType<typeof verifyCgSharedProjectionV1>,
  fixture: Fixture,
) {
  return readVerifiedCgSharedProjectionV1(
    verified,
    fixture.transferred,
    fixture.head,
    fixture.row,
    PROFILE,
  );
}

function rowForBundle(
  bundleBytes: Uint8Array,
  projectionDigest: string,
  blobDigest: string,
  sealDigest: string,
): AuthorCatalogRowV1 {
  const byteLength = BigInt(bundleBytes.byteLength);
  return validRow({
    kaId: KA_ID,
    assertionCoordinate: 'name λ',
    assertionVersion: '2',
    projectionId: 'cg-shared-v1',
    projectionDigest,
    sealDigest,
    transfer: {
      codec: 'dkg-ka-bundle-v1',
      projectionId: 'cg-shared-v1',
      projectionDigest,
      byteLength: byteLength.toString(),
      chunkSize: '262144',
      chunkCount: (((byteLength - 1n) / 262_144n) + 1n).toString(),
      blobDigest,
      chunkTreeRoot: computeKaChunkTreeRootV1(bundleBytes),
    },
  });
}

function signedHead(head: AuthorCatalogHeadV1): SignedAuthorCatalogHeadEnvelopeV1 {
  const unsigned = {
    issuer: ISSUER,
    objectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    payload: head,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as UnsignedControlEnvelopeV1;
  return validatedSignedHead({
    ...unsigned,
    objectDigest: computeAuthorCatalogHeadObjectDigestV1(unsigned),
    signature: EIP191_SIGNATURE,
  });
}

function validRow(value: unknown): AuthorCatalogRowV1 {
  assertAuthorCatalogRowV1(value);
  return value;
}

function validSeal(value: unknown): CanonicalGraphScopedAuthorSealV1 {
  assertCanonicalGraphScopedAuthorSealV1(value);
  return value;
}

function validatedSignedHead(value: unknown): SignedAuthorCatalogHeadEnvelopeV1 {
  assertSignedAuthorCatalogHeadEnvelopeV1(value as SignedAuthorCatalogHeadEnvelopeV1);
  return value as SignedAuthorCatalogHeadEnvelopeV1;
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}

function bytesToHex(value: Uint8Array): string {
  return `0x${[...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function expectFailure(
  operation: () => unknown,
  code: CgSharedProjectionErrorCode,
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CgSharedProjectionError);
    expect((error as CgSharedProjectionError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}
