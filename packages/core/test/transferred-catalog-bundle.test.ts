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
  assertVerifiedCatalogSealBindingV1,
  type CatalogSealDeploymentProfileV1,
} from '../src/catalog-seal-binding.js';
import {
  assertCanonicalGraphScopedAuthorSealV1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  type CanonicalGraphScopedAuthorSealV1,
} from '../src/canonical-graph-scoped-author-seal.js';
import { encodeOpaqueKaBundleV1 } from '../src/ka-bundle-v1.js';
import { computeKaChunkTreeRootV1 } from '../src/ka-chunk-tree.js';
import type { UnsignedControlEnvelopeV1 } from '../src/sync-control-object.js';
import {
  TransferredCatalogBundleError,
  assertVerifiedTransferredCatalogBundleForInputsV1,
  assertVerifiedTransferredCatalogBundleV1,
  readVerifiedTransferredCatalogBundleV1,
  verifyTransferredCatalogBundleV1,
  type TransferredCatalogBundleErrorCode,
} from '../src/transferred-catalog-bundle.js';

const AUTHOR = '0x3333333333333333333333333333333333333333';
const ISSUER = '0x5555555555555555555555555555555555555555';
const KAV10 = '0x4444444444444444444444444444444444444444';
const KA_ID =
  '23158417847463239084714197001737581570653996933112267175388663934063917137927';
const ZERO_DIGEST = `0x${'00'.repeat(32)}`;
const EIP191_SIGNATURE = `0x${'77'.repeat(65)}`;
const PROJECTION_BYTES = new TextEncoder().encode(
  '<did:example:s> <did:example:p> "opaque structural fixture" .\n',
);

const PROFILE = {
  networkId: 'otp:20430',
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
} as CatalogSealDeploymentProfileV1;
const SEAL = validSeal({
  assertionMerkleRoot: `0x${'aa'.repeat(32)}`,
  authorAddress: AUTHOR,
  authorAttestationR: `0x${'11'.repeat(32)}`,
  authorAttestationVS: `0x${'22'.repeat(32)}`,
  authorSchemeVersion: '1',
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
  reservedKaId: KA_ID,
  assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
  contentScopeVersion: '2',
  kaUal: `did:dkg:otp:20430/${AUTHOR}/7`,
  assertionVersion: '2',
  publicTripleCount: '12977',
  privateTripleCount: '0',
  privateMerkleRoot: null,
});
const SEAL_BYTES = canonicalizeCanonicalGraphScopedAuthorSealBytesV1(SEAL);
const ENCODED = encodeOpaqueKaBundleV1(PROJECTION_BYTES, SEAL_BYTES);
const ROW = rowForBundle(
  ENCODED.bundleBytes,
  ENCODED.projectionDigest,
  ENCODED.blobDigest,
  computeCanonicalGraphScopedAuthorSealDigestV1(SEAL),
);
const HEAD = signedHead({
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

describe('RFC-64 complete transferred catalog bundle binding', () => {
  it('binds complete bytes to the exact row, signed head, deployment, tree, and sole seal path', () => {
    const verified = verifyTransferredCatalogBundleV1(
      HEAD,
      ROW,
      ENCODED.bundleBytes,
      PROFILE,
    );
    expect(Object.getPrototypeOf(verified)).toBeNull();
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Reflect.ownKeys(verified as object)).toEqual([]);
    expect(() => assertVerifiedTransferredCatalogBundleV1(verified)).not.toThrow();
    expect(() => assertVerifiedTransferredCatalogBundleForInputsV1(
      verified,
      clone(HEAD),
      clone(ROW),
      clone(PROFILE),
    )).not.toThrow();

    const snapshot = readVerifiedTransferredCatalogBundleV1(
      verified,
      HEAD,
      ROW,
      PROFILE,
    );
    expect(snapshot).toMatchObject({
      headObjectDigest: HEAD.objectDigest,
      headIssuer: ISSUER,
      transfer: ROW.transfer,
      projectionByteLength: String(PROJECTION_BYTES.byteLength),
      sealByteLength: String(SEAL_BYTES.byteLength),
      projectionDigest: ENCODED.projectionDigest,
      blobDigest: ENCODED.blobDigest,
      chunkTreeRoot: ROW.transfer.chunkTreeRoot,
    });
    expect(snapshot.bundleBytes).toEqual(ENCODED.bundleBytes);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.transfer)).toBe(true);
    expect(Object.isFrozen(snapshot.deployment)).toBe(true);
    expect(() => assertVerifiedCatalogSealBindingV1(snapshot.catalogSealBinding))
      .not.toThrow();
    expect('semanticAdmission' in snapshot).toBe(false);
    expect('finality' in snapshot).toBe(false);
    expect('storeAuthority' in snapshot).toBe(false);
  });

  it('snapshots the complete visible view before retaining decoder views', () => {
    const original = ENCODED.bundleBytes.slice();
    const padded = Buffer.concat([
      Buffer.from([0xff]),
      Buffer.from(original),
      Buffer.from([0xee]),
    ]);
    const visible = padded.subarray(1, padded.byteLength - 1);
    const verified = verifyTransferredCatalogBundleV1(HEAD, ROW, visible, PROFILE);
    visible.fill(0);

    const first = readVerifiedTransferredCatalogBundleV1(verified, HEAD, ROW, PROFILE);
    expect(first.bundleBytes.constructor).toBe(Uint8Array);
    expect(Buffer.isBuffer(first.bundleBytes)).toBe(false);
    expect(first.bundleBytes).toEqual(original);
    first.bundleBytes.fill(0);
    const second = readVerifiedTransferredCatalogBundleV1(verified, HEAD, ROW, PROFILE);
    expect(second.bundleBytes).toEqual(original);
  });

  it('rejects forged capabilities, frozen clones, and JSON round trips', () => {
    const verified = verifyTransferredCatalogBundleV1(HEAD, ROW, ENCODED.bundleBytes, PROFILE);
    for (const forged of [
      Object.freeze({}),
      Object.freeze({ ...verified as object }),
      JSON.parse(JSON.stringify(verified)),
    ]) {
      expectFailure(
        () => assertVerifiedTransferredCatalogBundleV1(forged),
        'transferred-bundle-capability',
      );
      expectFailure(
        () => readVerifiedTransferredCatalogBundleV1(forged, HEAD, ROW, PROFILE),
        'transferred-bundle-capability',
      );
    }
  });

  it('rejects cross-head, cross-row, and cross-deployment consumption', () => {
    const verified = verifyTransferredCatalogBundleV1(HEAD, ROW, ENCODED.bundleBytes, PROFILE);
    const otherSignature = validatedSignedHead({
      ...HEAD,
      signature: `0x${'99'.repeat(65)}`,
    });
    const otherRow = validRow({ ...ROW, assertionCoordinate: 'other' });
    for (const [head, row, deployment] of [
      [otherSignature, ROW, PROFILE],
      [HEAD, otherRow, PROFILE],
      [HEAD, ROW, { ...PROFILE, assertedAtChainId: '20431' }],
    ] as const) {
      expectFailure(
        () => assertVerifiedTransferredCatalogBundleForInputsV1(
          verified,
          head as SignedAuthorCatalogHeadEnvelopeV1,
          row as AuthorCatalogRowV1,
          deployment as CatalogSealDeploymentProfileV1,
        ),
        'transferred-bundle-binding',
      );
    }
  });

  it('requires a valid row.transfer and exact advertised/received length', () => {
    expectFailure(
      () => verifyTransferredCatalogBundleV1(HEAD, {
        ...ROW,
        transfer: { ...ROW.transfer, codec: 'other' },
      } as unknown as AuthorCatalogRowV1, ENCODED.bundleBytes, PROFILE),
      'transferred-bundle-row',
    );
    const advertisedLonger = validRow({
      ...ROW,
      transfer: {
        ...ROW.transfer,
        byteLength: String(ENCODED.bundleBytes.byteLength + 1),
      },
    });
    expectFailure(
      () => verifyTransferredCatalogBundleV1(
        HEAD,
        advertisedLonger,
        ENCODED.bundleBytes,
        PROFILE,
      ),
      'transferred-bundle-length',
    );
  });

  it('strictly decodes the complete opaque frame before digest work', () => {
    const malformed = ENCODED.bundleBytes.slice();
    malformed.fill(0xff, 0, 8);
    const malformedRow = rowForBundle(
      malformed,
      ROW.projectionDigest,
      ROW.transfer.blobDigest,
      ROW.sealDigest,
    );
    expectFailure(
      () => verifyTransferredCatalogBundleV1(HEAD, malformedRow, malformed, PROFILE),
      'transferred-bundle-codec',
    );
  });

  it('rejects projection and whole-blob digest mismatches independently', () => {
    const wrongProjection = validRow({
      ...ROW,
      projectionDigest: ZERO_DIGEST,
      transfer: { ...ROW.transfer, projectionDigest: ZERO_DIGEST },
    });
    expectFailure(
      () => verifyTransferredCatalogBundleV1(
        HEAD,
        wrongProjection,
        ENCODED.bundleBytes,
        PROFILE,
      ),
      'transferred-bundle-projection-digest',
    );
    const wrongBlob = validRow({
      ...ROW,
      transfer: { ...ROW.transfer, blobDigest: ZERO_DIGEST },
    });
    expectFailure(
      () => verifyTransferredCatalogBundleV1(
        HEAD,
        wrongBlob,
        ENCODED.bundleBytes,
        PROFILE,
      ),
      'transferred-bundle-blob-digest',
    );
  });

  it('recomputes the complete chunk-tree root and rejects a descriptor mismatch', () => {
    const wrongTree = validRow({
      ...ROW,
      transfer: { ...ROW.transfer, chunkTreeRoot: ZERO_DIGEST },
    });
    expectFailure(
      () => verifyTransferredCatalogBundleV1(
        HEAD,
        wrongTree,
        ENCODED.bundleBytes,
        PROFILE,
      ),
      'transferred-bundle-chunk-tree',
    );
  });

  it('routes decoded seal bytes through the catalog seal binding and fails closed', () => {
    const otherSeal = validSeal({ ...SEAL, assertionVersion: '3' });
    const otherEncoded = encodeOpaqueKaBundleV1(
      PROJECTION_BYTES,
      canonicalizeCanonicalGraphScopedAuthorSealBytesV1(otherSeal),
    );
    const mismatchedSealRow = rowForBundle(
      otherEncoded.bundleBytes,
      otherEncoded.projectionDigest,
      otherEncoded.blobDigest,
      ROW.sealDigest,
    );
    expectFailure(
      () => verifyTransferredCatalogBundleV1(
        HEAD,
        mismatchedSealRow,
        otherEncoded.bundleBytes,
        PROFILE,
      ),
      'transferred-bundle-seal',
    );
  });

  it('rejects shared backing memory and spoofed Uint8Array properties', () => {
    expectFailure(
      () => verifyTransferredCatalogBundleV1(
        HEAD,
        ROW,
        new Uint8Array(new SharedArrayBuffer(ENCODED.bundleBytes.byteLength)),
        PROFILE,
      ),
      'transferred-bundle-input',
    );
    const short = Buffer.alloc(15);
    Object.defineProperties(short, {
      buffer: { value: new ArrayBuffer(ENCODED.bundleBytes.byteLength) },
      byteLength: { value: ENCODED.bundleBytes.byteLength },
    });
    expectFailure(
      () => verifyTransferredCatalogBundleV1(HEAD, ROW, short, PROFILE),
      'transferred-bundle-input',
    );
  });
});

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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectFailure(
  operation: () => unknown,
  code: TransferredCatalogBundleErrorCode,
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(TransferredCatalogBundleError);
    expect((error as TransferredCatalogBundleError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}
