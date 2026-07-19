import { describe, expect, it } from 'vitest';

import {
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  MAX_AUTHOR_CATALOG_DIRECTORY_PATH_NODES_V1,
  MAX_AUTHOR_CATALOG_DIRECTORY_PAYLOAD_BYTES_V1,
  assertAuthorCatalogDirectoryNodeScopeBindingV1,
  assertAuthorCatalogDirectoryNodeV1,
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  assertVerifiedAuthorCatalogDirectoryPathForHeadV1,
  assertUnsignedAuthorCatalogDirectoryNodeEnvelopeV1,
  canonicalizeAuthorCatalogDirectoryNodePayloadBytesV1,
  canonicalizeAuthorCatalogDirectoryNodePayloadV1,
  canonicalizeSignedAuthorCatalogDirectoryNodeEnvelopeBytesV1,
  canonicalizeUnsignedAuthorCatalogDirectoryNodeEnvelopeBytesV1,
  computeAuthorCatalogDirectoryNodeObjectDigestV1,
  parseCanonicalAuthorCatalogDirectoryNodePayloadV1,
  parseCanonicalSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  parseCanonicalUnsignedAuthorCatalogDirectoryNodeEnvelopeV1,
  readVerifiedAuthorCatalogBucketDescriptorV1,
  verifyAuthorCatalogDirectoryPathV1,
  type AuthorCatalogBucketDescriptorV1,
  type AuthorCatalogChildDescriptorV1,
  type AuthorCatalogDirectoryNodeV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
} from '../src/author-catalog-directory.js';
import {
  assertAuthorCatalogScopeV1,
  computeAuthorCatalogScopeDigestV1,
  type AuthorCatalogScopeV1,
} from '../src/author-catalog-codec.js';
import {
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  ZERO_DIGEST32_V1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  assertAuthorCatalogHeadV1,
  computeAuthorCatalogHeadObjectDigestV1,
  type AuthorCatalogHeadV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
} from '../src/author-catalog-objects.js';
import type {
  SignedControlEnvelopeV1,
  UnsignedControlEnvelopeV1,
} from '../src/sync-control-object.js';
import type { CountV1, Digest32V1 } from '../src/sync-wire-scalars.js';

const SCOPE_DIGEST =
  '0x7b18d141cbb6af4e7fdabe2e4d7d0b9512b042eb079b89a4797d3a0a7f1d4537';
const EMPTY_ROOT_DIGEST =
  '0x0163c048997ddaeb984d10a06f98064739a95546cf71d142c0d0a3de19f65f52';
const AUTHOR = '0x3333333333333333333333333333333333333333';
const ISSUER = '0x5555555555555555555555555555555555555555';
const DELEGATION_DIGEST = `0x${'66'.repeat(32)}`;
const EIP191_SIGNATURE = `0x${'77'.repeat(65)}`;

const EMPTY_DIRECTORY_PAYLOAD_CANONICAL =
  `{"catalogScopeDigest":"${SCOPE_DIGEST}","entries":[{"bucketDigest":"${ZERO_DIGEST32_V1}","bucketId":"0","byteLength":"0","rowCount":"0"}],"era":"0","firstBucketId":"0","level":"0"}`;
const EMPTY_DIRECTORY_UNSIGNED_CANONICAL =
  `{"issuer":"${ISSUER}","objectType":"AuthorCatalogDirectoryNodeV1","payload":${EMPTY_DIRECTORY_PAYLOAD_CANONICAL},"signatureEvidence":{"kind":"none"},"signatureSuite":"eip191-personal-sign-digest-v1"}`;

const EMPTY_SCOPE = validatedScope({
  networkId: 'otp:20430',
  contextGraphId: '0x1111111111111111111111111111111111111111/catalog-fixture',
  governanceChainId: '20430',
  governanceContractAddress: '0x2222222222222222222222222222222222222222',
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: AUTHOR,
  era: '0',
  bucketCount: '1',
});
const EMPTY_NODE = validatedNode(
  JSON.parse(EMPTY_DIRECTORY_PAYLOAD_CANONICAL),
  EMPTY_SCOPE.bucketCount,
);
const EMPTY_UNSIGNED = JSON.parse(
  EMPTY_DIRECTORY_UNSIGNED_CANONICAL,
) as UnsignedControlEnvelopeV1;
const EMPTY_SIGNED = {
  ...EMPTY_UNSIGNED,
  objectDigest: EMPTY_ROOT_DIGEST,
  signature: EIP191_SIGNATURE,
} as SignedControlEnvelopeV1;
const EMPTY_HEAD_PAYLOAD = validatedHead({
  networkId: EMPTY_SCOPE.networkId,
  contextGraphId: EMPTY_SCOPE.contextGraphId,
  governanceChainId: EMPTY_SCOPE.governanceChainId,
  governanceContractAddress: EMPTY_SCOPE.governanceContractAddress,
  ownershipTransitionDigest: EMPTY_SCOPE.ownershipTransitionDigest,
  subGraphName: EMPTY_SCOPE.subGraphName,
  authorAddress: EMPTY_SCOPE.authorAddress,
  catalogIssuerDelegationDigest: DELEGATION_DIGEST,
  era: '0',
  version: '0',
  previousHeadDigest: null,
  bucketCount: '1',
  totalRows: '0',
  directoryHeight: '0',
  directoryRootDigest: EMPTY_ROOT_DIGEST,
  issuedAt: '1700000000123',
});
const EMPTY_HEAD = signedHeadEnvelope(EMPTY_HEAD_PAYLOAD);

describe('AuthorCatalogDirectoryNodeV1 structural codec', () => {
  it('pins the normative empty-directory payload, envelope, and root digest', () => {
    expect(canonicalizeAuthorCatalogDirectoryNodePayloadV1(EMPTY_NODE, '1')).toBe(
      EMPTY_DIRECTORY_PAYLOAD_CANONICAL,
    );
    expect(new TextEncoder().encode(EMPTY_DIRECTORY_PAYLOAD_CANONICAL).byteLength).toBe(278);
    expect(new TextDecoder().decode(
      canonicalizeUnsignedAuthorCatalogDirectoryNodeEnvelopeBytesV1(EMPTY_UNSIGNED, '1'),
    )).toBe(EMPTY_DIRECTORY_UNSIGNED_CANONICAL);
    expect(new TextEncoder().encode(EMPTY_DIRECTORY_UNSIGNED_CANONICAL).byteLength).toBe(474);
    expect(computeAuthorCatalogDirectoryNodeObjectDigestV1(EMPTY_UNSIGNED, '1')).toBe(
      EMPTY_ROOT_DIGEST,
    );
    expect(parseCanonicalAuthorCatalogDirectoryNodePayloadV1(
      EMPTY_DIRECTORY_PAYLOAD_CANONICAL,
      '1',
    )).toEqual(EMPTY_NODE);
    expect(parseCanonicalUnsignedAuthorCatalogDirectoryNodeEnvelopeV1(
      EMPTY_DIRECTORY_UNSIGNED_CANONICAL,
      '1',
    )).toEqual(EMPTY_UNSIGNED);
  });

  it('validates signed digest linkage and resolves the height-zero empty path', () => {
    expect(() => assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(EMPTY_SIGNED, '1'))
      .not.toThrow();
    const signedBytes = canonicalizeSignedAuthorCatalogDirectoryNodeEnvelopeBytesV1(
      EMPTY_SIGNED,
      '1',
    );
    expect(parseCanonicalSignedAuthorCatalogDirectoryNodeEnvelopeV1(signedBytes, '1'))
      .toEqual(EMPTY_SIGNED);
    const verifiedPath = verifyAuthorCatalogDirectoryPathV1(EMPTY_HEAD, [EMPTY_SIGNED], '0');
    expect(() => assertVerifiedAuthorCatalogDirectoryPathForHeadV1(
      verifiedPath,
      EMPTY_HEAD,
    )).not.toThrow();
    expect(readVerifiedAuthorCatalogBucketDescriptorV1(verifiedPath, EMPTY_HEAD)).toEqual({
      bucketDigest: ZERO_DIGEST32_V1,
      bucketId: '0',
      byteLength: '0',
      rowCount: '0',
    });
    expect(() => assertSignedAuthorCatalogDirectoryNodeEnvelopeV1({
      ...EMPTY_SIGNED,
      objectDigest: digest(99),
    }, '1')).toThrow(/digest mismatch/);
  });

  it('binds nodes to the exact contextual scope and era', () => {
    expect(() => assertAuthorCatalogDirectoryNodeScopeBindingV1(EMPTY_NODE, EMPTY_SCOPE))
      .not.toThrow();
    expect(() => assertAuthorCatalogDirectoryNodeScopeBindingV1(
      { ...EMPTY_NODE, catalogScopeDigest: digest(12) },
      EMPTY_SCOPE,
    )).toThrow(/scope-mismatch/);
    expect(() => assertAuthorCatalogDirectoryNodeScopeBindingV1(
      { ...EMPTY_NODE, era: '1' },
      EMPTY_SCOPE,
    )).toThrow(/scope-mismatch/);
  });

  it('enforces canonical empty and non-empty leaf descriptor branches', () => {
    expect(() => assertAuthorCatalogDirectoryNodeV1({
      ...EMPTY_NODE,
      entries: [{ ...EMPTY_NODE.entries[0], bucketDigest: digest(1) }],
    }, '1')).toThrow(/canonical empty bucket descriptor/);
    expect(() => assertAuthorCatalogDirectoryNodeV1({
      ...EMPTY_NODE,
      entries: [{ ...EMPTY_NODE.entries[0], rowCount: '1' }],
    }, '1')).toThrow(/non-empty bucket bounds/);
    expect(() => assertAuthorCatalogDirectoryNodeV1({
      ...EMPTY_NODE,
      entries: [{
        bucketDigest: digest(1),
        bucketId: '0',
        byteLength: '1',
        rowCount: '1024',
      }],
    }, '1')).not.toThrow();
    expect(() => assertAuthorCatalogDirectoryNodeV1({
      ...EMPTY_NODE,
      entries: [{
        bucketDigest: digest(1),
        bucketId: '0',
        byteLength: '1048577',
        rowCount: '1',
      }],
    }, '1')).toThrow(/non-empty bucket bounds/);
    expect(() => assertAuthorCatalogDirectoryNodeV1({
      ...EMPTY_NODE,
      entries: [{
        bucketDigest: digest(1),
        bucketId: '0',
        byteLength: '1',
        rowCount: '1025',
      }],
    }, '1')).toThrow(/non-empty bucket bounds/);
  });

  it('requires exact level-zero count, consecutive IDs, and canonical node alignment', () => {
    const entries = emptyBucketDescriptors(256, 0n);
    expect(() => assertAuthorCatalogDirectoryNodeV1({
      ...EMPTY_NODE,
      entries,
    }, '256')).not.toThrow();
    expect(() => assertAuthorCatalogDirectoryNodeV1({
      ...EMPTY_NODE,
      entries: entries.slice(0, 255),
    }, '256')).toThrow(/exactly 256/);
    expect(() => assertAuthorCatalogDirectoryNodeV1({
      ...EMPTY_NODE,
      entries: entries.map((entry, index) => index === 4 ? { ...entry, bucketId: '5' } : entry),
    }, '256')).toThrow(/not consecutive/);
    expect(() => assertAuthorCatalogDirectoryNodeV1({
      ...EMPTY_NODE,
      firstBucketId: '1',
      entries,
    }, '512')).toThrow(/canonical level-0 node/);
    expect(() => assertAuthorCatalogDirectoryNodeV1({
      ...EMPTY_NODE,
      level: '1',
      entries: [{
        firstBucketId: '0',
        bucketSpan: '1',
        rowCount: '0',
        byteLength: '1',
        childDigest: digest(1),
      }],
    }, '1')).toThrow(/level must be in 0..0/);
  });

  it('enforces exact higher-level ranges, child bounds, and checked row sums', () => {
    const branch = branchNode(512n, 1n, 0n, SCOPE_DIGEST);
    expect(() => assertAuthorCatalogDirectoryNodeV1(branch, '512')).not.toThrow();
    expect(() => assertAuthorCatalogDirectoryNodeV1({
      ...branch,
      entries: branch.entries.map((entry, index) => index === 1
        ? { ...(entry as AuthorCatalogChildDescriptorV1), firstBucketId: '255' }
        : entry),
    }, '512')).toThrow(/non-canonical child range/);
    expect(() => assertAuthorCatalogDirectoryNodeV1({
      ...branch,
      entries: branch.entries.map((entry, index) => index === 0
        ? { ...(entry as AuthorCatalogChildDescriptorV1), bucketSpan: '255' }
        : entry),
    }, '512')).toThrow(/non-canonical child range/);
    expect(() => assertAuthorCatalogDirectoryNodeV1({
      ...branch,
      entries: branch.entries.map((entry, index) => index === 0
        ? { ...(entry as AuthorCatalogChildDescriptorV1), childDigest: ZERO_DIGEST32_V1 }
        : entry),
    }, '512')).toThrow(/childDigest must be nonzero/);
    expect(() => assertAuthorCatalogDirectoryNodeV1({
      ...branch,
      entries: branch.entries.map((entry, index) => index === 0
        ? { ...(entry as AuthorCatalogChildDescriptorV1), byteLength: '262145' }
        : entry),
    }, '512')).toThrow(/directory payload bounds/);

    const overflowing = branchNode(1n << 63n, 7n, 0n, SCOPE_DIGEST);
    const maximum = '18446744073709551615';
    expect(() => assertAuthorCatalogDirectoryNodeV1({
      ...overflowing,
      entries: overflowing.entries.map((entry) => ({
        ...(entry as AuthorCatalogChildDescriptorV1),
        rowCount: maximum,
      })),
    }, (1n << 63n).toString() as CountV1)).toThrow(/rowCount sum exceeds u64/);
  });

  it('rejects sparse, subclassed, accessor, symbol, and custom-property entry arrays', () => {
    expect(() => assertAuthorCatalogDirectoryNodeV1({
      ...EMPTY_NODE,
      entries: new Array(1),
    }, '1')).toThrow(/catalog-directory-array/);

    class Entries extends Array<AuthorCatalogBucketDescriptorV1> {}
    expect(() => assertAuthorCatalogDirectoryNodeV1({
      ...EMPTY_NODE,
      entries: new Entries(EMPTY_NODE.entries[0] as AuthorCatalogBucketDescriptorV1),
    }, '1')).toThrow(/catalog-directory-array/);

    const accessor = [EMPTY_NODE.entries[0]];
    Object.defineProperty(accessor, '0', {
      enumerable: true,
      get: () => EMPTY_NODE.entries[0],
    });
    expect(() => assertAuthorCatalogDirectoryNodeV1({ ...EMPTY_NODE, entries: accessor }, '1'))
      .toThrow(/catalog-directory-array/);

    const withSymbol = [EMPTY_NODE.entries[0]] as unknown[] & Record<PropertyKey, unknown>;
    withSymbol[Symbol('hidden')] = true;
    expect(() => assertAuthorCatalogDirectoryNodeV1({ ...EMPTY_NODE, entries: withSymbol }, '1'))
      .toThrow(/catalog-directory-array/);

    const withCustom = [EMPTY_NODE.entries[0]] as unknown[] & { extra?: boolean };
    withCustom.extra = true;
    expect(() => assertAuthorCatalogDirectoryNodeV1({ ...EMPTY_NODE, entries: withCustom }, '1'))
      .toThrow(/catalog-directory-array/);
  });

  it('rejects hostile node/entry shapes, lower-cap wire input, and the wrong object type', () => {
    expect(() => assertAuthorCatalogDirectoryNodeV1({ ...EMPTY_NODE, bucketCount: '1' }, '1'))
      .toThrow(/catalog-directory-schema/);
    const accessor = { ...EMPTY_NODE };
    Object.defineProperty(accessor, 'level', { enumerable: true, get: () => '0' });
    expect(() => assertAuthorCatalogDirectoryNodeV1(accessor, '1'))
      .toThrow(/catalog-directory-schema/);
    const symbol = { ...EMPTY_NODE } as Record<PropertyKey, unknown>;
    symbol[Symbol('hidden')] = true;
    expect(() => assertAuthorCatalogDirectoryNodeV1(symbol, '1'))
      .toThrow(/catalog-directory-schema/);
    expect(() => parseCanonicalAuthorCatalogDirectoryNodePayloadV1(
      '{'.padEnd(MAX_AUTHOR_CATALOG_DIRECTORY_PAYLOAD_BYTES_V1 + 1, 'x'),
      '1',
    )).toThrow(/payload-too-large/);
    expect(() => assertUnsignedAuthorCatalogDirectoryNodeEnvelopeV1({
      ...EMPTY_UNSIGNED,
      objectType: 'AuthorCatalogHeadV1',
    }, '1')).toThrow(/catalog-directory-type/);
  });
});

describe('author catalog selected directory paths', () => {
  it('derives both branch and leaf indexes and verifies child bytes/counts/digests', () => {
    const fixture = twoLevelFixture(300n);
    const verifiedPath = verifyAuthorCatalogDirectoryPathV1(
      fixture.head,
      fixture.path,
      '300',
    );
    expect(readVerifiedAuthorCatalogBucketDescriptorV1(
      verifiedPath,
      fixture.head,
    )).toEqual(fixture.selectedDescriptor);
    expect(() => verifyAuthorCatalogDirectoryPathV1(fixture.head, fixture.path, '10'))
      .toThrow(/selected childDigest/);

    const wrongDigestRoot = signedEnvelope({
      ...fixture.root.payload,
      entries: fixture.root.payload.entries.map((entry, index) => index === 1
        ? { ...(entry as AuthorCatalogChildDescriptorV1), childDigest: digest(999) }
        : entry),
    }, '512');
    expect(() => verifyAuthorCatalogDirectoryPathV1(
      signedHeadEnvelope({
        ...fixture.head.payload,
        directoryRootDigest: wrongDigestRoot.objectDigest,
      }),
      [wrongDigestRoot, fixture.leaf],
      '300',
    )).toThrow(/selected childDigest/);

    const wrongLengthRoot = signedEnvelope({
      ...fixture.root.payload,
      entries: fixture.root.payload.entries.map((entry, index) => index === 1
        ? { ...(entry as AuthorCatalogChildDescriptorV1), byteLength: '1' }
        : entry),
    }, '512');
    expect(() => verifyAuthorCatalogDirectoryPathV1(
      signedHeadEnvelope({
        ...fixture.head.payload,
        directoryRootDigest: wrongLengthRoot.objectDigest,
      }),
      [wrongLengthRoot, fixture.leaf],
      '300',
    )).toThrow(/child byteLength/);

    const wrongCountRoot = signedEnvelope({
      ...fixture.root.payload,
      entries: fixture.root.payload.entries.map((entry, index) => index === 1
        ? { ...(entry as AuthorCatalogChildDescriptorV1), rowCount: '2' }
        : entry),
    }, '512');
    expect(() => verifyAuthorCatalogDirectoryPathV1(
      signedHeadEnvelope({
        ...fixture.head.payload,
        totalRows: '2',
        directoryRootDigest: wrongCountRoot.objectDigest,
      }),
      [wrongCountRoot, fixture.leaf],
      '300',
    )).toThrow(/child rowCount/);
  });

  it('mints an opaque exact-head capability and rejects every structural forgery', () => {
    const fixture = twoLevelFixture(300n);
    const verifiedPath = verifyAuthorCatalogDirectoryPathV1(
      fixture.head,
      fixture.path,
      '300',
    );
    const descriptor = readVerifiedAuthorCatalogBucketDescriptorV1(
      verifiedPath,
      fixture.head,
    );

    expect(Object.getPrototypeOf(verifiedPath)).toBeNull();
    expect(Object.isFrozen(verifiedPath)).toBe(true);
    expect(Reflect.ownKeys(verifiedPath as object)).toEqual([]);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(descriptor).toEqual(fixture.selectedDescriptor);

    const structuralDescriptor = Object.freeze({ ...descriptor });
    expect(() => assertVerifiedAuthorCatalogDirectoryPathForHeadV1(
      structuralDescriptor,
      fixture.head,
    )).toThrow(/not minted/);
    expect(() => readVerifiedAuthorCatalogBucketDescriptorV1(
      structuralDescriptor,
      fixture.head,
    )).toThrow(/not minted/);

    const frozenClone = Object.freeze({ ...verifiedPath as object });
    expect(() => readVerifiedAuthorCatalogBucketDescriptorV1(
      frozenClone,
      fixture.head,
    )).toThrow(/not minted/);

    expect(JSON.stringify(verifiedPath)).toBe('{}');
    expect(() => readVerifiedAuthorCatalogBucketDescriptorV1(
      JSON.parse(JSON.stringify(verifiedPath)),
      fixture.head,
    )).toThrow(/not minted/);

    const otherHead = signedHeadEnvelope({
      ...fixture.head.payload,
      issuedAt: '1700000000124',
    });
    const otherHeadToken = verifyAuthorCatalogDirectoryPathV1(
      otherHead,
      fixture.path,
      '300',
    );
    expect(() => readVerifiedAuthorCatalogBucketDescriptorV1(
      otherHeadToken,
      fixture.head,
    )).toThrow(/not bound to the supplied signed catalog head/);
    expect(() => readVerifiedAuthorCatalogBucketDescriptorV1(
      verifiedPath,
      otherHead,
    )).toThrow(/not bound to the supplied signed catalog head/);
  });

  it('rejects mutated roots, paths, and leaf descriptors before minting trust', () => {
    const fixture = twoLevelFixture(300n);
    const wrongRootHead = signedHeadEnvelope({
      ...fixture.head.payload,
      directoryRootDigest: digest(900_001),
    });
    expect(() => verifyAuthorCatalogDirectoryPathV1(
      wrongRootHead,
      fixture.path,
      '300',
    )).toThrow(/root objectDigest/);

    const selectedIndex = 300 - 256;
    const mutatedLeaf = {
      ...fixture.leaf,
      payload: {
        ...fixture.leaf.payload,
        entries: fixture.leaf.payload.entries.map((entry, index) => index === selectedIndex
          ? { ...(entry as AuthorCatalogBucketDescriptorV1), rowCount: '2' }
          : entry),
      },
    } as SignedAuthorCatalogDirectoryNodeEnvelopeV1;
    expect(() => verifyAuthorCatalogDirectoryPathV1(
      fixture.head,
      [fixture.root, mutatedLeaf],
      '300',
    )).toThrow(/digest mismatch/);

    expect(() => verifyAuthorCatalogDirectoryPathV1(
      fixture.head,
      [fixture.leaf, fixture.root],
      '300',
    )).toThrow(/level 1/);
  });

  it('keeps the verified descriptor stable after untrusted proof input is mutated', () => {
    const fixture = twoLevelFixture(300n);
    const verifiedPath = verifyAuthorCatalogDirectoryPathV1(
      fixture.head,
      fixture.path,
      '300',
    );
    const expected = { ...fixture.selectedDescriptor };
    const selectedIndex = 300 - 256;
    (fixture.leaf.payload.entries as AuthorCatalogBucketDescriptorV1[])[selectedIndex] = {
      ...fixture.selectedDescriptor,
      bucketDigest: digest(900_002),
      rowCount: '2',
    };

    const firstRead = readVerifiedAuthorCatalogBucketDescriptorV1(
      verifiedPath,
      fixture.head,
    );
    const secondRead = readVerifiedAuthorCatalogBucketDescriptorV1(
      verifiedPath,
      fixture.head,
    );
    expect(firstRead).toBe(secondRead);
    expect(firstRead).toEqual(expected);
  });

  it('accepts the full eight-node path at the maximum v1 bucket count', () => {
    const fixture = maximumHeightFixture();
    expect(fixture.path).toHaveLength(MAX_AUTHOR_CATALOG_DIRECTORY_PATH_NODES_V1);
    const verifiedPath = verifyAuthorCatalogDirectoryPathV1(fixture.head, fixture.path, '0');
    expect(readVerifiedAuthorCatalogBucketDescriptorV1(verifiedPath, fixture.head))
      .toEqual(fixture.selectedDescriptor);
  });

  it('rejects omitted, reversed, repeated, sparse, subclassed, accessor, symbol, and custom paths', () => {
    const fixture = twoLevelFixture(300n);
    expect(() => verifyAuthorCatalogDirectoryPathV1(
      fixture.head,
      [fixture.root],
      '300',
    )).toThrow(/exactly 2/);
    expect(() => verifyAuthorCatalogDirectoryPathV1(
      fixture.head,
      [fixture.leaf, fixture.root],
      '300',
    )).toThrow(/level 1/);
    expect(() => verifyAuthorCatalogDirectoryPathV1(
      fixture.head,
      [fixture.root, fixture.root],
      '300',
    )).toThrow();
    expect(() => verifyAuthorCatalogDirectoryPathV1(
      fixture.head,
      new Array(2),
      '300',
    )).toThrow(/catalog-directory-path/);

    class Path extends Array<SignedAuthorCatalogDirectoryNodeEnvelopeV1> {}
    expect(() => verifyAuthorCatalogDirectoryPathV1(
      fixture.head,
      new Path(fixture.root, fixture.leaf),
      '300',
    )).toThrow(/catalog-directory-path/);

    const accessor = [fixture.root, fixture.leaf];
    Object.defineProperty(accessor, '1', { enumerable: true, get: () => fixture.leaf });
    expect(() => verifyAuthorCatalogDirectoryPathV1(fixture.head, accessor, '300'))
      .toThrow(/catalog-directory-path/);

    const withSymbol = [fixture.root, fixture.leaf] as unknown[] & Record<PropertyKey, unknown>;
    withSymbol[Symbol('hidden')] = true;
    expect(() => verifyAuthorCatalogDirectoryPathV1(fixture.head, withSymbol, '300'))
      .toThrow(/catalog-directory-path/);

    const withCustom = [fixture.root, fixture.leaf] as unknown[] & { extra?: boolean };
    withCustom.extra = true;
    expect(() => verifyAuthorCatalogDirectoryPathV1(fixture.head, withCustom, '300'))
      .toThrow(/catalog-directory-path/);
  });

  it('never consumes poisoned inherited iterators on entries or paths', () => {
    const entries = [...EMPTY_NODE.entries];
    const node = { ...EMPTY_NODE, entries };
    const signed = signedEnvelope(node, '1');
    const path = [signed];
    const head = signedHeadEnvelope({
      ...EMPTY_HEAD.payload,
      directoryRootDigest: signed.objectDigest,
    });
    const originalIterator = Array.prototype[Symbol.iterator];
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      configurable: true,
      writable: true,
      value(this: unknown[]) {
        if (this === entries || this === path) {
          throw new Error('poisoned directory iterator was consumed');
        }
        return originalIterator.call(this);
      },
    });
    try {
      expect(() => assertAuthorCatalogDirectoryNodeV1(node, '1')).not.toThrow();
      expect(() => verifyAuthorCatalogDirectoryPathV1(head, path, '0')).not.toThrow();
    } finally {
      Object.defineProperty(Array.prototype, Symbol.iterator, {
        configurable: true,
        writable: true,
        value: originalIterator,
      });
    }
  });
});

function twoLevelFixture(selectedBucketId: bigint): {
  readonly head: SignedAuthorCatalogHeadEnvelopeV1;
  readonly root: SignedAuthorCatalogDirectoryNodeEnvelopeV1;
  readonly leaf: SignedAuthorCatalogDirectoryNodeEnvelopeV1;
  readonly path: SignedAuthorCatalogDirectoryNodeEnvelopeV1[];
  readonly selectedDescriptor: AuthorCatalogBucketDescriptorV1;
} {
  const scope = validatedScope({ ...EMPTY_SCOPE, bucketCount: '512' });
  const scopeDigest = computeAuthorCatalogScopeDigestV1(scope);
  const leafFirst = 256n;
  const selectedDescriptor = nonemptyBucketDescriptor(selectedBucketId);
  const leafEntries = emptyBucketDescriptors(256, leafFirst);
  leafEntries[Number(selectedBucketId - leafFirst)] = selectedDescriptor;
  const leaf = signedEnvelope({
    catalogScopeDigest: scopeDigest,
    entries: leafEntries,
    era: '0',
    firstBucketId: leafFirst.toString(),
    level: '0',
  }, scope.bucketCount);
  const leafBytes = canonicalizeAuthorCatalogDirectoryNodePayloadBytesV1(
    leaf.payload,
    scope.bucketCount,
  ).byteLength;
  const root = signedEnvelope({
    catalogScopeDigest: scopeDigest,
    entries: [
      {
        firstBucketId: '0',
        bucketSpan: '256',
        rowCount: '0',
        byteLength: '1',
        childDigest: digest(100),
      },
      {
        firstBucketId: '256',
        bucketSpan: '256',
        rowCount: '1',
        byteLength: leafBytes.toString(),
        childDigest: leaf.objectDigest,
      },
    ],
    era: '0',
    firstBucketId: '0',
    level: '1',
  }, scope.bucketCount);
  const head = signedHeadEnvelope({
    ...EMPTY_HEAD.payload,
    bucketCount: '512',
    totalRows: '1',
    directoryHeight: '1',
    directoryRootDigest: root.objectDigest,
  });
  return { head, root, leaf, path: [root, leaf], selectedDescriptor };
}

function maximumHeightFixture(): {
  readonly head: SignedAuthorCatalogHeadEnvelopeV1;
  readonly path: SignedAuthorCatalogDirectoryNodeEnvelopeV1[];
  readonly selectedDescriptor: AuthorCatalogBucketDescriptorV1;
} {
  const bucketCount = 1n << 63n;
  const bucketCountWire = bucketCount.toString() as CountV1;
  const scope = validatedScope({ ...EMPTY_SCOPE, bucketCount: bucketCountWire });
  const scopeDigest = computeAuthorCatalogScopeDigestV1(scope);
  const selectedDescriptor = nonemptyBucketDescriptor(0n);
  const leafEntries = emptyBucketDescriptors(256, 0n);
  leafEntries[0] = selectedDescriptor;
  let child = signedEnvelope({
    catalogScopeDigest: scopeDigest,
    entries: leafEntries,
    era: '0',
    firstBucketId: '0',
    level: '0',
  }, bucketCountWire);
  const leafToRoot: SignedAuthorCatalogDirectoryNodeEnvelopeV1[] = [child];

  for (let level = 1n; level <= 7n; level += 1n) {
    const width = 256n ** level;
    const parentCoverage = minimum(256n ** (level + 1n), bucketCount);
    const entryCount = Number((parentCoverage + width - 1n) / width);
    const entries: AuthorCatalogChildDescriptorV1[] = new Array(entryCount);
    const childBytes = canonicalizeAuthorCatalogDirectoryNodePayloadBytesV1(
      child.payload,
      bucketCountWire,
    ).byteLength;
    for (let index = 0; index < entryCount; index += 1) {
      entries[index] = {
        firstBucketId: (BigInt(index) * width).toString(),
        bucketSpan: minimum(width, bucketCount - BigInt(index) * width).toString(),
        rowCount: index === 0 ? '1' : '0',
        byteLength: index === 0 ? childBytes.toString() : '1',
        childDigest: index === 0 ? child.objectDigest : digest(Number(level) * 1000 + index + 1),
      };
    }
    child = signedEnvelope({
      catalogScopeDigest: scopeDigest,
      entries,
      era: '0',
      firstBucketId: '0',
      level: level.toString(),
    }, bucketCountWire);
    leafToRoot.push(child);
  }
  const path = leafToRoot.reverse();
  const head = signedHeadEnvelope({
    ...EMPTY_HEAD.payload,
    bucketCount: bucketCountWire,
    totalRows: '1',
    directoryHeight: '7',
    directoryRootDigest: path[0].objectDigest,
  });
  return { head, path, selectedDescriptor };
}

function branchNode(
  bucketCount: bigint,
  level: bigint,
  firstBucketId: bigint,
  scopeDigest: Digest32V1,
): AuthorCatalogDirectoryNodeV1 {
  const entryWidth = 256n ** level;
  const nodeWidth = entryWidth * 256n;
  const coverage = minimum(nodeWidth, bucketCount - firstBucketId);
  const entryCount = Number((coverage + entryWidth - 1n) / entryWidth);
  const entries: AuthorCatalogChildDescriptorV1[] = new Array(entryCount);
  for (let index = 0; index < entryCount; index += 1) {
    const childFirst = firstBucketId + BigInt(index) * entryWidth;
    entries[index] = {
      firstBucketId: childFirst.toString(),
      bucketSpan: minimum(entryWidth, bucketCount - childFirst).toString(),
      rowCount: '0',
      byteLength: '1',
      childDigest: digest(index + 1),
    };
  }
  return {
    catalogScopeDigest: scopeDigest,
    entries,
    era: '0',
    firstBucketId: firstBucketId.toString(),
    level: level.toString(),
  };
}

function emptyBucketDescriptors(
  count: number,
  firstBucketId: bigint,
): AuthorCatalogBucketDescriptorV1[] {
  return Array.from({ length: count }, (_, index) => ({
    bucketDigest: ZERO_DIGEST32_V1,
    bucketId: (firstBucketId + BigInt(index)).toString(),
    byteLength: '0',
    rowCount: '0',
  }));
}

function nonemptyBucketDescriptor(bucketId: bigint): AuthorCatalogBucketDescriptorV1 {
  return {
    bucketDigest: digest(500_000 + Number(bucketId % 100_000n)),
    bucketId: bucketId.toString(),
    byteLength: '868',
    rowCount: '1',
  };
}

function signedEnvelope(
  node: AuthorCatalogDirectoryNodeV1,
  bucketCount: CountV1,
): SignedAuthorCatalogDirectoryNodeEnvelopeV1 {
  const unsigned = {
    issuer: ISSUER,
    objectType: AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
    payload: node,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as UnsignedControlEnvelopeV1;
  const signed = {
    ...unsigned,
    objectDigest: computeAuthorCatalogDirectoryNodeObjectDigestV1(unsigned, bucketCount),
    signature: EIP191_SIGNATURE,
  } as SignedControlEnvelopeV1;
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(signed, bucketCount);
  return signed;
}

function signedHeadEnvelope(
  head: AuthorCatalogHeadV1,
): SignedAuthorCatalogHeadEnvelopeV1 {
  const payload = validatedHead(head);
  const unsigned = {
    issuer: ISSUER,
    objectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    payload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as UnsignedControlEnvelopeV1;
  const signed = {
    ...unsigned,
    objectDigest: computeAuthorCatalogHeadObjectDigestV1(unsigned),
    signature: EIP191_SIGNATURE,
  } as SignedControlEnvelopeV1;
  assertSignedAuthorCatalogHeadEnvelopeV1(signed);
  return signed;
}

function validatedScope(value: unknown): AuthorCatalogScopeV1 {
  assertAuthorCatalogScopeV1(value);
  return value;
}

function validatedNode(
  value: unknown,
  bucketCount: CountV1,
): AuthorCatalogDirectoryNodeV1 {
  assertAuthorCatalogDirectoryNodeV1(value, bucketCount);
  return value;
}

function validatedHead(value: unknown): AuthorCatalogHeadV1 {
  assertAuthorCatalogHeadV1(value);
  return value;
}

function digest(value: number): Digest32V1 {
  return `0x${value.toString(16).padStart(64, '0')}` as Digest32V1;
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
