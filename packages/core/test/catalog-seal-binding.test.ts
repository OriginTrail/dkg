import { describe, expect, it } from 'vitest';

import {
  assertAuthorCatalogRowV1,
  assertAuthorCatalogScopeV1,
  computeAuthorCatalogRowDigestV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
} from '../src/author-catalog-codec.js';
import {
  CatalogSealBindingError,
  assertVerifiedCatalogSealBindingV1,
  readVerifiedCatalogSealBindingV1,
  verifyCatalogSealBindingV1,
  type CatalogSealBindingErrorCode,
  type CatalogSealDeploymentProfileV1,
} from '../src/catalog-seal-binding.js';
import {
  MAX_CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_BYTES_V1,
  assertCanonicalGraphScopedAuthorSealV1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  type CanonicalGraphScopedAuthorSealV1,
} from '../src/canonical-graph-scoped-author-seal.js';

const AUTHOR = '0x3333333333333333333333333333333333333333';
const KAV10 = '0x4444444444444444444444444444444444444444';
const KA_ID =
  '23158417847463239084714197001737581570653996933112267175388663934063917137927';
const NEXT_KA_ID =
  '23158417847463239084714197001737581570653996933112267175388663934063917137928';
const SEAL_DIGEST =
  '0x8fc37c7f66831aea9b2a0ed35aac26bb6eec2eb3042ed0dcdd2e023d3087632a';
const ZERO_DIGEST = `0x${'00'.repeat(32)}`;

const SCOPE = validScope({
  networkId: 'otp:20430',
  contextGraphId: 'a/b',
  governanceChainId: '20430',
  governanceContractAddress: '0x5555555555555555555555555555555555555555',
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: AUTHOR,
  era: '0',
  bucketCount: '1',
});
const ROW = validRow({
  kaId: KA_ID,
  assertionCoordinate: 'name λ',
  assertionVersion: '2',
  projectionId: 'cg-shared-v1',
  projectionDigest: ZERO_DIGEST,
  sealDigest: SEAL_DIGEST,
  transfer: {
    codec: 'dkg-ka-bundle-v1',
    projectionId: 'cg-shared-v1',
    projectionDigest: ZERO_DIGEST,
    byteLength: '16',
    chunkSize: '262144',
    chunkCount: '1',
    blobDigest: `0x${'11'.repeat(32)}`,
    chunkTreeRoot: `0x${'22'.repeat(32)}`,
  },
});
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

describe('RFC-64 transferred catalog seal binding', () => {
  it('binds one exact row through typed reconstruction and the #1780 classifier', () => {
    const verified = verifyCatalogSealBindingV1(SCOPE, ROW, SEAL_BYTES, PROFILE);
    expect(Object.getPrototypeOf(verified)).toBeNull();
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Reflect.ownKeys(verified as object)).toEqual([]);
    expect(() => assertVerifiedCatalogSealBindingV1(verified)).not.toThrow();

    const snapshot = readVerifiedCatalogSealBindingV1(verified);
    expect(snapshot).toMatchObject({
      networkId: 'otp:20430',
      authorAddress: AUTHOR,
      kaId: KA_ID,
      assertionCoordinate: 'name λ',
      assertionVersion: '2',
      sealDigest: SEAL_DIGEST,
      placement: {
        subject: `did:dkg:context-graph:v1/root/a%2Fb/assertion/${AUTHOR}/name%20%CE%BB`,
        metaGraph: 'did:dkg:context-graph:v1/root/a%2Fb/_meta',
      },
      seal: SEAL,
    });
    expect(snapshot.catalogRowDigest).toBe(
      computeAuthorCatalogRowDigestV1(snapshot.catalogScopeDigest, ROW),
    );
    expect(snapshot.sealRows).toHaveLength(14);
    expect(new TextDecoder().decode(snapshot.canonicalSealBytes)).toBe(
      new TextDecoder().decode(SEAL_BYTES),
    );
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.seal)).toBe(true);
    expect(Object.isFrozen(snapshot.placement)).toBe(true);
    expect(Object.isFrozen(snapshot.sealRows)).toBe(true);
  });

  it('retains immutable verifier state while returning caller-owned byte copies', () => {
    const source = SEAL_BYTES.slice();
    const verified = verifyCatalogSealBindingV1(SCOPE, ROW, source, PROFILE);
    source.fill(0);
    const first = readVerifiedCatalogSealBindingV1(verified);
    first.canonicalSealBytes.fill(0);
    const second = readVerifiedCatalogSealBindingV1(verified);
    expect(new TextDecoder().decode(second.canonicalSealBytes)).toBe(
      new TextDecoder().decode(SEAL_BYTES),
    );
  });

  it('normalizes Buffer and typed-array subclasses without exposing retained bytes', () => {
    class SealBytes extends Uint8Array {}
    for (const source of [
      Buffer.from(SEAL_BYTES),
      new SealBytes(SEAL_BYTES),
    ]) {
      const verified = verifyCatalogSealBindingV1(SCOPE, ROW, source, PROFILE);
      source.fill(0);
      const first = readVerifiedCatalogSealBindingV1(verified);
      expect(first.canonicalSealBytes.constructor).toBe(Uint8Array);
      expect(Buffer.isBuffer(first.canonicalSealBytes)).toBe(false);
      first.canonicalSealBytes.fill(0);
      const second = readVerifiedCatalogSealBindingV1(verified);
      expect(second.canonicalSealBytes.constructor).toBe(Uint8Array);
      expect(Buffer.isBuffer(second.canonicalSealBytes)).toBe(false);
      expect(new TextDecoder().decode(second.canonicalSealBytes)).toBe(
        new TextDecoder().decode(SEAL_BYTES),
      );
    }
  });

  it('rejects over-cap byte inputs before attempting semantic parsing', () => {
    const spoofedOversized = Buffer.alloc(
      MAX_CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_BYTES_V1 + 1,
    );
    Object.defineProperties(spoofedOversized, {
      buffer: { value: new ArrayBuffer(1) },
      byteLength: { value: 1 },
    });
    expectFailure(
      () => verifyCatalogSealBindingV1(
        SCOPE,
        ROW,
        Buffer.alloc(MAX_CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_BYTES_V1 + 1),
        PROFILE,
      ),
      'catalog-seal-input',
    );
    expectFailure(
      () => verifyCatalogSealBindingV1(SCOPE, ROW, spoofedOversized, PROFILE),
      'catalog-seal-input',
    );
  });

  it('rejects structural casts, frozen clones, and JSON round trips', () => {
    const verified = verifyCatalogSealBindingV1(SCOPE, ROW, SEAL_BYTES, PROFILE);
    for (const forged of [
      Object.freeze({}),
      Object.freeze({ ...verified as object }),
      JSON.parse(JSON.stringify(verified)),
    ]) {
      expectFailure(
        () => assertVerifiedCatalogSealBindingV1(forged),
        'catalog-seal-capability',
      );
      expectFailure(
        () => readVerifiedCatalogSealBindingV1(forged),
        'catalog-seal-capability',
      );
    }
  });

  it('fails closed on row identity, version, digest, UAL, and deployment mismatches', () => {
    expectFailure(
      () => verifyCatalogSealBindingV1(
        SCOPE,
        validRow({ ...ROW, kaId: NEXT_KA_ID }),
        SEAL_BYTES,
        PROFILE,
      ),
      'catalog-seal-ka-id',
    );
    expectFailure(
      () => verifyCatalogSealBindingV1(
        SCOPE,
        validRow({ ...ROW, assertionVersion: '3' }),
        SEAL_BYTES,
        PROFILE,
      ),
      'catalog-seal-version',
    );
    expectFailure(
      () => verifyCatalogSealBindingV1(
        SCOPE,
        validRow({ ...ROW, sealDigest: ZERO_DIGEST }),
        SEAL_BYTES,
        PROFILE,
      ),
      'catalog-seal-digest',
    );
    const otherLaneSeal = validSeal({
      ...SEAL,
      kaUal: `did:dkg:base:8453/${AUTHOR}/7`,
    });
    expectFailure(
      () => verifyCatalogSealBindingV1(
        SCOPE,
        ROW,
        canonicalizeCanonicalGraphScopedAuthorSealBytesV1(otherLaneSeal),
        PROFILE,
      ),
      'catalog-seal-ual',
    );
    expectFailure(
      () => verifyCatalogSealBindingV1(SCOPE, ROW, SEAL_BYTES, {
        ...PROFILE,
        assertedAtChainId: '20431',
      }),
      'catalog-seal-deployment',
    );
    expectFailure(
      () => verifyCatalogSealBindingV1(SCOPE, ROW, SEAL_BYTES, {
        ...PROFILE,
        assertedAtKav10Address: '0x6666666666666666666666666666666666666666',
      }),
      'catalog-seal-deployment',
    );
    expectFailure(
      () => verifyCatalogSealBindingV1(SCOPE, ROW, SEAL_BYTES, {
        ...PROFILE,
        networkId: 'base:8453',
      }),
      'catalog-seal-deployment',
    );
  });

  it('rejects malformed profile records and mutable-memory classes before classification', () => {
    expectFailure(
      () => verifyCatalogSealBindingV1(SCOPE, ROW, SEAL_BYTES, {
        ...PROFILE,
        extra: true,
      } as unknown as CatalogSealDeploymentProfileV1),
      'catalog-seal-profile',
    );
    expectFailure(
      () => verifyCatalogSealBindingV1(
        SCOPE,
        ROW,
        new Uint8Array(new SharedArrayBuffer(SEAL_BYTES.byteLength)),
        PROFILE,
      ),
      'catalog-seal-input',
    );
  });
});

function validScope(value: unknown): AuthorCatalogScopeV1 {
  assertAuthorCatalogScopeV1(value);
  return value;
}

function validRow(value: unknown): AuthorCatalogRowV1 {
  assertAuthorCatalogRowV1(value);
  return value;
}

function validSeal(value: unknown): CanonicalGraphScopedAuthorSealV1 {
  assertCanonicalGraphScopedAuthorSealV1(value);
  return value;
}

function expectFailure(operation: () => unknown, code: CatalogSealBindingErrorCode): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogSealBindingError);
    expect((error as CatalogSealBindingError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}
