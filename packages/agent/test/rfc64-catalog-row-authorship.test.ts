import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';

import {
  AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
  canonicalizeAuthorCatalogBucketPayloadBytesV1,
  canonicalizeAuthorCatalogRowV1,
  computeAuthorCatalogScopeDigestV1,
  computeControlObjectDigestHex,
  verifyAuthorCatalogDirectoryPathV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type KaIdV1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedAuthorCatalogIssuerDelegationEnvelopeV1,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  verifyControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';

import { computeDelegationDigest } from '../src/auth/agent-delegation.js';
import {
  AUTHOR_CATALOG_ROW_AUTHORSHIP_ERROR_CODES_V1,
  AuthorCatalogRowAuthorshipErrorV1,
  assertVerifiedAuthorCatalogRowAuthorshipForTargetV1,
  assertVerifiedAuthorCatalogRowAuthorshipV1,
  buildAuthorCatalogAgentScopeV1,
  computeAuthorAgentDelegationEvidenceDigestV1,
  computeAuthorCatalogAgentScopeDigestV1,
  readVerifiedAuthorCatalogRowAuthorshipV1,
  verifyAuthorCatalogRowAuthorshipV1,
  type AuthorAgentDelegationEvidenceV1,
  type AuthorCatalogAgentScopeV1,
  type VerifyAuthorCatalogRowAuthorshipInputV1,
} from '../src/rfc64/catalog-row-authorship.js';

const AUTHOR_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
const CATALOG_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
const THIRD_PRIVATE_KEY = `0x${'33'.repeat(32)}`;
const AUTHOR = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';
const CATALOG_ISSUER = '0x1563915e194d8cfba1943570603f7606a3115508';
const CONTEXT_GRAPH_ID = '0x1111111111111111111111111111111111111111/catalog-fixture';
const GOVERNANCE_CONTRACT = '0x2222222222222222222222222222222222222222';
const ZERO_DIGEST = `0x${'00'.repeat(32)}`;
const BLOB_DIGEST = `0x${'11'.repeat(32)}`;
const CHUNK_ROOT = `0x${'22'.repeat(32)}`;
const SEAL_DIGEST = `0x${'44'.repeat(32)}`;
const TARGET_KA_ID =
  '11717532788646872703907650691873846707067843023881409494733446432351458426881';
const TARGET_KA_ID_2 =
  '11717532788646872703907650691873846707067843023881409494733446432351458426882';
const WRONG_AUTHOR_KA_ID =
  ((BigInt(`0x${'44'.repeat(20)}`) << 96n) | 1n).toString();
const PARENT_SIGNATURE =
  '0xa2d72565e1a9dabdbac0c1311d8d65fe74d377bb965ea8fd9d0f0df522e995400bea5baaae6fe2288035a5af5e5c93dc7d176bcadabc99dadf4d0f41394334231b';
const EXPECTED_PARENT_DIGEST =
  '0xb50ae153356ec5fa420a4db1ad78a92c8a1445e975c30f6fd64df9faba043dd5';
const EXPECTED_AGENT_SCOPE_DIGEST =
  '0x962893b5aeb2981d0d3cbbd1b95a7ec8ace1ee468d57de635e4bada99e1c9a83';
const EXPECTED_DELEGATED_DELEGATION_DIGEST =
  '0xeab310c15a84618f0eaf9a6eb2e094a64789c407d1f984a0aea918b284b64143';
const EXPECTED_DIRECT_DELEGATION_DIGEST =
  '0x7b53f3fcf0d5b9c4d49da6ae8bdc9d0b99e893c588ebacbf6d8267d55458bacf';
const EXPECTED_SCOPE_DIGEST =
  '0x8bea420829cdde5cf1e5258895619ac1d484784d2b3998cd8a45e6c8eabbf832';
const EXPECTED_BUCKET_DIGEST =
  '0x82db48bc0cadf93a3803300348464d04d2d91b335426ba86b6fca83623bd25f5';
const EXPECTED_DIRECTORY_DIGEST =
  '0x5774cf8df10e1fe3421b87fa907bd403323c6ac11d71728e2e52dc6319d3f35d';
const EXPECTED_DELEGATED_HEAD_DIGEST =
  '0xa3964f6671e1c015276c692d75d6dd6250f77e4ec32aaf22c2481cf05bd111e1';
const EXPECTED_DIRECT_HEAD_DIGEST =
  '0x808232803f3d8f928c88287dff20ffdc2ad9488e2dc12e08b1bf633ccdc0e57b';
const EXPECTED_ROW_DIGEST =
  '0x0a8cb39f5593176e2eedf8a31b0b96465cc371115340f4f037e58610f04265bd';
const EXPECTED_TRANSFER_DIGEST =
  '0x007c995fd7d001736d39af9f2d3c79177c99b55682a1ff4d002fbc3e0345db25';

const authorWallet = new ethers.Wallet(AUTHOR_PRIVATE_KEY);
const catalogWallet = new ethers.Wallet(CATALOG_PRIVATE_KEY);
const thirdWallet = new ethers.Wallet(THIRD_PRIVATE_KEY);

interface FixtureOptions {
  readonly mode?: 'direct' | 'delegated';
  readonly contextGraphId?: string;
  readonly subGraphName?: string | null;
  readonly effectiveAt?: string;
  readonly delegationExpiresAt?: string;
  readonly headIssuedAt?: string;
  readonly parentIssuedAt?: string;
  readonly parentExpiresAt?: string;
  readonly parentEvidence?: AuthorAgentDelegationEvidenceV1;
  readonly evidenceDigestOverride?: string | null;
  readonly delegationSigner?: ethers.Wallet;
  readonly catalogIssuerKey?: string;
  readonly headSigner?: ethers.Wallet;
  readonly directorySigner?: ethers.Wallet;
  readonly bucketSigner?: ethers.Wallet;
  readonly kaId?: string;
  readonly targetKaId?: string;
  readonly assertionCoordinate?: string;
  readonly duplicateTarget?: boolean;
  readonly bucketIdOverride?: string;
  readonly delegationPayloadOverride?: Record<string, unknown>;
  readonly headPayloadOverride?: Record<string, unknown>;
}

interface Fixture {
  readonly input: VerifyAuthorCatalogRowAuthorshipInputV1;
  readonly parentEvidence: AuthorAgentDelegationEvidenceV1 | null;
  readonly delegation: SignedAuthorCatalogIssuerDelegationEnvelopeV1;
  readonly head: SignedAuthorCatalogHeadEnvelopeV1;
  readonly directory: SignedAuthorCatalogDirectoryNodeEnvelopeV1;
  readonly bucket: SignedAuthorCatalogBucketEnvelopeV1;
}

describe('RFC-64 catalog-row authorship normative closure', () => {
  it('pins the delegated parent, object, path, row, and transfer vectors', async () => {
    const fixture = await buildFixture();
    const token = verifyAuthorCatalogRowAuthorshipV1(fixture.input);
    const snapshot = readVerifiedAuthorCatalogRowAuthorshipV1(token);

    expect(computeAuthorAgentDelegationEvidenceDigestV1(fixture.parentEvidence!)).toBe(
      EXPECTED_PARENT_DIGEST,
    );
    expect(snapshot.authorCatalogAgentScopeDigest).toBe(EXPECTED_AGENT_SCOPE_DIGEST);
    expect(snapshot.catalogIssuerDelegationObjectDigest).toBe(
      EXPECTED_DELEGATED_DELEGATION_DIGEST,
    );
    expect(snapshot.catalogScopeDigest).toBe(EXPECTED_SCOPE_DIGEST);
    expect(snapshot.bucketObjectDigest).toBe(EXPECTED_BUCKET_DIGEST);
    expect(snapshot.directoryPathObjectDigests).toEqual([EXPECTED_DIRECTORY_DIGEST]);
    expect(snapshot.catalogHeadObjectDigest).toBe(EXPECTED_DELEGATED_HEAD_DIGEST);
    expect(snapshot.catalogRowDigest).toBe(EXPECTED_ROW_DIGEST);
    expect(snapshot.transferIdentityDigest).toBe(EXPECTED_TRANSFER_DIGEST);
    expect(snapshot.row.kaId).toBe(TARGET_KA_ID);
    expect(canonicalizeAuthorCatalogBucketPayloadBytesV1(fixture.bucket.payload).byteLength)
      .toBe(868);
    expect(() => assertVerifiedAuthorCatalogRowAuthorshipForTargetV1(
      token,
      EXPECTED_ROW_DIGEST,
      EXPECTED_TRANSFER_DIGEST,
    )).not.toThrow();
  });

  it('pins the direct-author delegation/head variant while retaining the same row target', async () => {
    const fixture = await buildFixture({ mode: 'direct' });
    const snapshot = readVerifiedAuthorCatalogRowAuthorshipV1(
      verifyAuthorCatalogRowAuthorshipV1(fixture.input),
    );
    expect(snapshot.authorAuthorityEvidenceDigest).toBeNull();
    expect(snapshot.catalogIssuerDelegationObjectDigest).toBe(
      EXPECTED_DIRECT_DELEGATION_DIGEST,
    );
    expect(snapshot.catalogHeadObjectDigest).toBe(EXPECTED_DIRECT_HEAD_DIGEST);
    expect(snapshot.catalogRowDigest).toBe(EXPECTED_ROW_DIGEST);
    expect(snapshot.transferIdentityDigest).toBe(EXPECTED_TRANSFER_DIGEST);
  });

  it('derives the exact seven-key scope and deployed v10 legacy digest', async () => {
    const fixture = await buildFixture();
    const payload = fixture.delegation.payload;
    const scope: AuthorCatalogAgentScopeV1 = {
      authorAddress: payload.authorAddress,
      contextGraphId: payload.contextGraphId,
      governanceChainId: payload.governanceChainId,
      governanceContractAddress: payload.governanceContractAddress,
      networkId: payload.networkId,
      ownershipTransitionDigest: payload.ownershipTransitionDigest,
      subGraphName: payload.subGraphName,
    };
    expect(computeAuthorCatalogAgentScopeDigestV1(scope)).toBe(EXPECTED_AGENT_SCOPE_DIGEST);
    expect(new TextEncoder().encode(canonicalizeFixtureJson(scope)).byteLength).toBe(318);
    expect(buildAuthorCatalogAgentScopeV1(scope)).toBe(
      `dkg:rfc64:author-catalog-issuer-v1:${EXPECTED_AGENT_SCOPE_DIGEST.slice(2)}`,
    );
    expect(new TextEncoder().encode(
      canonicalizeFixtureJson(fixture.parentEvidence),
    ).byteLength).toBe(459);
    expect(ethers.hexlify(computeDelegationDigest({
      agentAddress: AUTHOR,
      scope: buildAuthorCatalogAgentScopeV1(scope),
      issuedAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_121_000,
      delegateeOpKey: CATALOG_ISSUER,
    }))).toBe('0x341e615362648661f46ba3adbe3d9e748d54e147a5e22212025d4d210d4bb43e');
  });

  it('is D26-neutral and mints fresh process-local tokens in all four policy cells', async () => {
    const fixture = await buildFixture();
    const policyCells = [
      ['open', 'open'],
      ['open', 'curated'],
      ['invite-only', 'open'],
      ['invite-only', 'curated'],
    ] as const;
    const tokens = policyCells.map(() => verifyAuthorCatalogRowAuthorshipV1(fixture.input));
    expect(new Set(tokens).size).toBe(4);
    for (const token of tokens) {
      const snapshot = readVerifiedAuthorCatalogRowAuthorshipV1(token);
      expect(snapshot.catalogRowDigest).toBe(EXPECTED_ROW_DIGEST);
      expect('accessPolicy' in snapshot).toBe(false);
      expect('publishPolicy' in snapshot).toBe(false);
      expect('membership' in snapshot).toBe(false);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.row)).toBe(true);
      expect(Object.isFrozen(snapshot.row.transfer)).toBe(true);
    }
  });
});

describe('RFC-64 direct/delegated parent closure failures', () => {
  it('rejects direct issuance with supplied parent evidence', async () => {
    const direct = await buildFixture({ mode: 'direct' });
    const delegated = await buildFixture();
    expectCode(() => verifyAuthorCatalogRowAuthorshipV1({
      ...direct.input,
      parentAuthorAgentEvidence: delegated.parentEvidence,
    } as VerifyAuthorCatalogRowAuthorshipInputV1), 'AUTHORSHIP_ISSUER_CLOSURE_MISMATCH');
  });

  it('rejects structurally inconsistent direct/delegated evidence branches', async () => {
    const fixture = await buildFixture({
      evidenceDigestOverride: null,
    });
    expectCode(
      () => verifyAuthorCatalogRowAuthorshipV1(fixture.input),
      'AUTHORSHIP_ISSUER_CLOSURE_MISMATCH',
    );
  });

  it('rejects a catalog key that differs from the parent operational signer', async () => {
    const scope = defaultAgentScope();
    const thirdEvidence = await signParentEvidence({
      authorAddress: AUTHOR,
      delegateeOpKey: thirdWallet.address.toLowerCase(),
      delegateePeerId: null,
      expiresAt: '1700000121000',
      issuedAt: '1700000000000',
      scope: buildAuthorCatalogAgentScopeV1(scope),
    }, authorWallet);
    const fixture = await buildFixture({
      parentEvidence: thirdEvidence,
      delegationSigner: thirdWallet,
      catalogIssuerKey: CATALOG_ISSUER,
    });
    expectCode(
      () => verifyAuthorCatalogRowAuthorshipV1(fixture.input),
      'AUTHORSHIP_ISSUER_CLOSURE_MISMATCH',
    );
  });

  it('rejects a one-byte parent mutation before treating its signature as authority', async () => {
    const fixture = await buildFixture();
    const mutated = {
      ...fixture.parentEvidence!,
      delegateePeerId: 'x',
    };
    expectCode(() => verifyAuthorCatalogRowAuthorshipV1({
      ...fixture.input,
      parentAuthorAgentEvidence: mutated,
    }), 'AUTHORSHIP_PARENT_DIGEST_MISMATCH');
  });

  it('rejects a valid root-lane parent replayed into a named lane', async () => {
    const root = await buildFixture();
    const named = await buildFixture({
      subGraphName: 'named',
      parentEvidence: root.parentEvidence!,
    });
    expectCode(
      () => verifyAuthorCatalogRowAuthorshipV1(named.input),
      'AUTHORSHIP_PARENT_SCOPE_MISMATCH',
    );
  });

  it.each([
    ['missing operational key', (parent: AuthorAgentDelegationEvidenceV1) => ({
      ...parent,
      delegateeOpKey: undefined,
    })],
    ['zero expiry', (parent: AuthorAgentDelegationEvidenceV1) => ({
      ...parent,
      expiresAt: '0',
    })],
  ])('rejects invalid parent evidence: %s', async (_label, mutate) => {
    const fixture = await buildFixture();
    expectCode(() => verifyAuthorCatalogRowAuthorshipV1({
      ...fixture.input,
      parentAuthorAgentEvidence: mutate(fixture.parentEvidence!) as AuthorAgentDelegationEvidenceV1,
    }), 'AUTHORSHIP_PARENT_EVIDENCE_INVALID');
  });

  it('rejects high-s and wrong-recovered-author parent signatures', async () => {
    const base = await buildFixture();
    const highS = makeHighS(base.parentEvidence!);
    const highSFixture = await buildFixture({ parentEvidence: highS });
    expectCode(
      () => verifyAuthorCatalogRowAuthorshipV1(highSFixture.input),
      'AUTHORSHIP_PARENT_EVIDENCE_INVALID',
    );

    const unsigned = withoutSignature(base.parentEvidence!);
    const wrongSignature = await thirdWallet.signMessage(computeDelegationDigest({
      agentAddress: unsigned.authorAddress,
      scope: unsigned.scope,
      issuedAtMs: Number(unsigned.issuedAt),
      expiresAtMs: Number(unsigned.expiresAt),
      delegateePeerId: undefined,
      delegateeOpKey: unsigned.delegateeOpKey,
    }));
    const wrong = { ...unsigned, signature: wrongSignature } as AuthorAgentDelegationEvidenceV1;
    const wrongFixture = await buildFixture({ parentEvidence: wrong });
    expectCode(
      () => verifyAuthorCatalogRowAuthorshipV1(wrongFixture.input),
      'AUTHORSHIP_PARENT_EVIDENCE_INVALID',
    );
  });
});

describe('RFC-64 half-open interval closure', () => {
  it('accepts equality at parent containment boundaries', async () => {
    const fixture = await buildFixture({
      effectiveAt: '1700000000000',
      delegationExpiresAt: '1700000121000',
      headIssuedAt: '1700000000000',
    });
    expect(() => verifyAuthorCatalogRowAuthorshipV1(fixture.input)).not.toThrow();
  });

  it.each([
    ['child starts before parent', {
      effectiveAt: '1699999999999',
      headIssuedAt: '1700000000000',
    }],
    ['child ends after parent', {
      delegationExpiresAt: '1700000121001',
    }],
    ['empty child interval', {
      effectiveAt: '1700000120000',
      delegationExpiresAt: '1700000120000',
    }],
    ['head is exactly at child expiry', {
      headIssuedAt: '1700000120000',
    }],
  ])('rejects %s', async (_label, options) => {
    const fixture = await buildFixture(options);
    expectCode(
      () => verifyAuthorCatalogRowAuthorshipV1(fixture.input),
      'AUTHORSHIP_INTERVAL_MISMATCH',
    );
  });
});

describe('RFC-64 signed object and path closure failures', () => {
  it('rejects a head that names another exact delegation', async () => {
    const delegated = await buildFixture();
    const direct = await buildFixture({ mode: 'direct' });
    expectCode(() => verifyAuthorCatalogRowAuthorshipV1({
      ...direct.input,
      catalogHead: delegated.input.catalogHead,
      catalogHeadSignature: delegated.input.catalogHeadSignature,
      directoryPathEnvelopes: delegated.input.directoryPathEnvelopes,
      directoryPathSignatures: delegated.input.directoryPathSignatures,
      directoryPathProof: delegated.input.directoryPathProof,
      catalogBucket: delegated.input.catalogBucket,
      catalogBucketSignature: delegated.input.catalogBucketSignature,
    }), 'AUTHORSHIP_HEAD_BINDING_MISMATCH');
  });

  it('rejects a catalog object signed by another issuer', async () => {
    const fixture = await buildFixture({ bucketSigner: thirdWallet });
    expectCode(
      () => verifyAuthorCatalogRowAuthorshipV1(fixture.input),
      'AUTHORSHIP_HEAD_BINDING_MISMATCH',
    );
  });

  it('rejects omitted, cloned, foreign-head, and wrong-signature path dependencies', async () => {
    const delegated = await buildFixture();
    const direct = await buildFixture({ mode: 'direct' });
    expectCode(() => verifyAuthorCatalogRowAuthorshipV1({
      ...delegated.input,
      directoryPathEnvelopes: [],
      directoryPathSignatures: [],
    }), 'AUTHORSHIP_PATH_BINDING_MISMATCH');
    expectCode(() => verifyAuthorCatalogRowAuthorshipV1({
      ...delegated.input,
      directoryPathProof: { ...delegated.input.directoryPathProof },
    } as VerifyAuthorCatalogRowAuthorshipInputV1), 'AUTHORSHIP_PATH_BINDING_MISMATCH');
    expectCode(() => verifyAuthorCatalogRowAuthorshipV1({
      ...delegated.input,
      directoryPathProof: direct.input.directoryPathProof,
    }), 'AUTHORSHIP_PATH_BINDING_MISMATCH');
    expectCode(() => verifyAuthorCatalogRowAuthorshipV1({
      ...delegated.input,
      directoryPathSignatures: [delegated.input.catalogBucketSignature],
    }), 'AUTHORSHIP_PATH_BINDING_MISMATCH');
  });

  it('bounds both directory arrays before touching attacker-controlled elements', async () => {
    const fixture = await buildFixture();

    let oversizedEnvelopeTailTouched = false;
    const oversizedEnvelopes = new Array(2);
    oversizedEnvelopes[0] = fixture.input.directoryPathEnvelopes[0];
    Object.defineProperty(oversizedEnvelopes, '1', {
      enumerable: true,
      configurable: true,
      get() {
        oversizedEnvelopeTailTouched = true;
        throw new Error('oversized envelope tail must not be inspected');
      },
    });
    expectCode(() => verifyAuthorCatalogRowAuthorshipV1({
      ...fixture.input,
      directoryPathEnvelopes: oversizedEnvelopes,
    }), 'AUTHORSHIP_PATH_BINDING_MISMATCH');
    expect(oversizedEnvelopeTailTouched).toBe(false);

    let validLengthEnvelopeTouched = false;
    const trappedValidLengthEnvelopes = new Array(1);
    Object.defineProperty(trappedValidLengthEnvelopes, '0', {
      enumerable: true,
      configurable: true,
      get() {
        validLengthEnvelopeTouched = true;
        throw new Error('envelope must not be inspected before signature-array preflight');
      },
    });
    let oversizedSignatureTailTouched = false;
    const oversizedSignatures = new Array(2);
    oversizedSignatures[0] = fixture.input.directoryPathSignatures[0];
    Object.defineProperty(oversizedSignatures, '1', {
      enumerable: true,
      configurable: true,
      get() {
        oversizedSignatureTailTouched = true;
        throw new Error('oversized signature tail must not be inspected');
      },
    });
    expectCode(() => verifyAuthorCatalogRowAuthorshipV1({
      ...fixture.input,
      directoryPathEnvelopes: trappedValidLengthEnvelopes,
      directoryPathSignatures: oversizedSignatures,
    }), 'AUTHORSHIP_PATH_BINDING_MISMATCH');
    expect(validLengthEnvelopeTouched).toBe(false);
    expect(oversizedSignatureTailTouched).toBe(false);
  });

  it('rejects a signed bucket that differs from the selected leaf descriptor', async () => {
    const first = await buildFixture();
    const other = await buildFixture({ assertionCoordinate: 'other' });
    expectCode(() => verifyAuthorCatalogRowAuthorshipV1({
      ...first.input,
      catalogBucket: other.input.catalogBucket,
      catalogBucketSignature: other.input.catalogBucketSignature,
    }), 'AUTHORSHIP_BUCKET_BINDING_MISMATCH');
  });

  it('rejects wrong-object generic signature capabilities', async () => {
    const fixture = await buildFixture();
    expectCode(() => verifyAuthorCatalogRowAuthorshipV1({
      ...fixture.input,
      catalogHeadSignature: fixture.input.catalogBucketSignature,
    }), 'AUTHORSHIP_SIGNATURE_PROOF_INVALID');
  });
});

describe('RFC-64 exact target row and capability closure', () => {
  it('rejects an absent target row', async () => {
    const fixture = await buildFixture({ targetKaId: TARGET_KA_ID_2 });
    expectCode(
      () => verifyAuthorCatalogRowAuthorshipV1(fixture.input),
      'AUTHORSHIP_ROW_BINDING_MISMATCH',
    );
  });

  it('rejects duplicate and wrong-bucket target rows', async () => {
    const duplicate = await buildFixture({ duplicateTarget: true });
    expectCode(
      () => verifyAuthorCatalogRowAuthorshipV1(duplicate.input),
      'AUTHORSHIP_ROW_BINDING_MISMATCH',
    );
    const wrongBucket = await buildFixture({ bucketIdOverride: '1' });
    expectCode(
      () => verifyAuthorCatalogRowAuthorshipV1(wrongBucket.input),
      'AUTHORSHIP_ROW_BINDING_MISMATCH',
    );
  });

  it('rejects a fully re-signed self-consistent row whose high 160 bits name another author', async () => {
    const fixture = await buildFixture({
      kaId: WRONG_AUTHOR_KA_ID,
      targetKaId: WRONG_AUTHOR_KA_ID,
    });
    expectCode(
      () => verifyAuthorCatalogRowAuthorshipV1(fixture.input),
      'AUTHORSHIP_ROW_BINDING_MISMATCH',
    );
  });

  it('snapshots source objects and cannot be retargeted after verification', async () => {
    const fixture = await buildFixture();
    const token = verifyAuthorCatalogRowAuthorshipV1(fixture.input);
    const snapshot = readVerifiedAuthorCatalogRowAuthorshipV1(token);
    (fixture.input.catalogBucket.payload.rows[0] as { assertionCoordinate: string })
      .assertionCoordinate = 'mutated';
    expect(snapshot.row.assertionCoordinate).toBe('fixture');
    expect(snapshot.catalogRowDigest).toBe(EXPECTED_ROW_DIGEST);
    expectCode(
      () => assertVerifiedAuthorCatalogRowAuthorshipForTargetV1(
        token,
        `0x${'99'.repeat(32)}`,
        snapshot.transferIdentityDigest,
      ),
      'AUTHORSHIP_CAPABILITY_INVALID',
    );
  });

  it('rejects cast, spread, JSON, and structured clones of the opaque token', async () => {
    const fixture = await buildFixture();
    const token = verifyAuthorCatalogRowAuthorshipV1(fixture.input);
    const clones: unknown[] = [
      {},
      { ...token },
      JSON.parse(JSON.stringify(token)),
      structuredClone(token),
    ];
    for (const clone of clones) {
      expectCode(
        () => assertVerifiedAuthorCatalogRowAuthorshipV1(clone),
        'AUTHORSHIP_CAPABILITY_INVALID',
      );
    }
  });

  it('preserves Unicode scalar sequence as raw UTF-8 bytes without UTF-16 reordering', async () => {
    const bmpThenAstral = await buildFixture({ assertionCoordinate: '\ue000\u{10000}' });
    const astralThenBmp = await buildFixture({ assertionCoordinate: '\u{10000}\ue000' });
    const first = readVerifiedAuthorCatalogRowAuthorshipV1(
      verifyAuthorCatalogRowAuthorshipV1(bmpThenAstral.input),
    );
    const second = readVerifiedAuthorCatalogRowAuthorshipV1(
      verifyAuthorCatalogRowAuthorshipV1(astralThenBmp.input),
    );
    expect(first.row.assertionCoordinate).toBe('\ue000\u{10000}');
    expect(second.row.assertionCoordinate).toBe('\u{10000}\ue000');
    expect(first.catalogRowDigest).not.toBe(second.catalogRowDigest);
    const raw = Buffer.from(canonicalizeAuthorCatalogRowV1(first.row)).toString('hex');
    expect(raw.indexOf('ee8080')).toBeLessThan(raw.indexOf('f0908080'));
  });

  it('exposes only the frozen closed error-code registry', () => {
    expect(AUTHOR_CATALOG_ROW_AUTHORSHIP_ERROR_CODES_V1).toHaveLength(13);
    expect(Object.isFrozen(AUTHOR_CATALOG_ROW_AUTHORSHIP_ERROR_CODES_V1)).toBe(true);
    expect(() => new AuthorCatalogRowAuthorshipErrorV1(
      'NOT_CLOSED' as never,
      'bad',
    )).toThrow(/Unsupported catalog-row authorship error code/);
  });
});

async function buildFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const mode = options.mode ?? 'delegated';
  const contextGraphId = options.contextGraphId ?? CONTEXT_GRAPH_ID;
  const subGraphName = options.subGraphName ?? null;
  const effectiveAt = options.effectiveAt ?? '1700000000000';
  const delegationExpiresAt = options.delegationExpiresAt ?? '1700000120000';
  const headIssuedAt = options.headIssuedAt ?? '1700000000123';
  const delegationSigner = options.delegationSigner
    ?? (mode === 'direct' ? authorWallet : catalogWallet);
  const catalogIssuerKey = (options.catalogIssuerKey ?? CATALOG_ISSUER).toLowerCase();

  const agentScope = defaultAgentScope({ contextGraphId, subGraphName });
  let parentEvidence: AuthorAgentDelegationEvidenceV1 | null = null;
  if (mode === 'delegated') {
    parentEvidence = options.parentEvidence ?? await signParentEvidence({
      authorAddress: AUTHOR,
      delegateeOpKey: delegationSigner.address.toLowerCase(),
      delegateePeerId: null,
      expiresAt: options.parentExpiresAt ?? '1700000121000',
      issuedAt: options.parentIssuedAt ?? '1700000000000',
      scope: buildAuthorCatalogAgentScopeV1(agentScope),
    }, authorWallet);
  }
  const evidenceDigest = options.evidenceDigestOverride !== undefined
    ? options.evidenceDigestOverride
    : parentEvidence === null
      ? null
      : computeAuthorAgentDelegationEvidenceDigestV1(parentEvidence);

  const delegationPayload = {
    authorAddress: AUTHOR,
    authorAuthorityEvidenceDigest: evidenceDigest,
    catalogEra: '0',
    catalogIssuerKey,
    contextGraphId,
    effectiveAt,
    expiresAt: delegationExpiresAt,
    governanceChainId: '20430',
    governanceContractAddress: GOVERNANCE_CONTRACT,
    networkId: 'otp:20430',
    ownershipTransitionDigest: null,
    previousDelegationDigest: null,
    subGraphName,
    ...options.delegationPayloadOverride,
  };
  const delegation = await signControlEnvelope({
    issuer: delegationSigner.address.toLowerCase(),
    objectType: AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
    payload: delegationPayload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  }, delegationSigner) as SignedAuthorCatalogIssuerDelegationEnvelopeV1;

  const scope = {
    authorAddress: AUTHOR,
    bucketCount: '1',
    contextGraphId,
    era: '0',
    governanceChainId: '20430',
    governanceContractAddress: GOVERNANCE_CONTRACT,
    networkId: 'otp:20430',
    ownershipTransitionDigest: null,
    subGraphName,
  } as AuthorCatalogScopeV1;
  const scopeDigest = computeAuthorCatalogScopeDigestV1(scope);
  const kaId = (options.kaId ?? TARGET_KA_ID) as KaIdV1;
  const row: AuthorCatalogRowV1 = {
    assertionCoordinate: (options.assertionCoordinate ?? 'fixture') as AuthorCatalogRowV1['assertionCoordinate'],
    assertionVersion: '1',
    kaId,
    projectionDigest: ZERO_DIGEST,
    projectionId: 'cg-shared-v1',
    sealDigest: SEAL_DIGEST,
    transfer: {
      blobDigest: BLOB_DIGEST,
      byteLength: '16',
      chunkCount: '1',
      chunkSize: '262144',
      chunkTreeRoot: CHUNK_ROOT,
      codec: 'dkg-ka-bundle-v1',
      projectionDigest: ZERO_DIGEST,
      projectionId: 'cg-shared-v1',
    },
  };
  const rows = options.duplicateTarget ? [row, structuredClone(row)] : [row];
  const bucketPayload = {
    bucketCount: '1',
    bucketId: options.bucketIdOverride ?? '0',
    catalogScopeDigest: scopeDigest,
    era: '0',
    rows,
  };
  const bucketSigner = options.bucketSigner ?? catalogWallet;
  const bucket = await signControlEnvelope({
    issuer: bucketSigner.address.toLowerCase(),
    objectType: AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
    payload: bucketPayload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  }, bucketSigner) as SignedAuthorCatalogBucketEnvelopeV1;

  const bucketPayloadBytes = canonicalPayloadBytes(bucketPayload);
  const directoryPayload = {
    catalogScopeDigest: scopeDigest,
    entries: [{
      bucketDigest: bucket.objectDigest,
      bucketId: '0',
      byteLength: String(bucketPayloadBytes.byteLength),
      rowCount: String(rows.length),
    }],
    era: '0',
    firstBucketId: '0',
    level: '0',
  };
  const directorySigner = options.directorySigner ?? catalogWallet;
  const directory = await signControlEnvelope({
    issuer: directorySigner.address.toLowerCase(),
    objectType: AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
    payload: directoryPayload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  }, directorySigner) as SignedAuthorCatalogDirectoryNodeEnvelopeV1;

  const headPayload = {
    authorAddress: AUTHOR,
    bucketCount: '1',
    catalogIssuerDelegationDigest: delegation.objectDigest,
    contextGraphId,
    directoryHeight: '0',
    directoryRootDigest: directory.objectDigest,
    era: '0',
    governanceChainId: '20430',
    governanceContractAddress: GOVERNANCE_CONTRACT,
    issuedAt: headIssuedAt,
    networkId: 'otp:20430',
    ownershipTransitionDigest: null,
    previousHeadDigest: null,
    subGraphName,
    totalRows: String(rows.length),
    version: '0',
    ...options.headPayloadOverride,
  };
  const headSigner = options.headSigner ?? catalogWallet;
  const head = await signControlEnvelope({
    issuer: headSigner.address.toLowerCase(),
    objectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    payload: headPayload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  }, headSigner) as SignedAuthorCatalogHeadEnvelopeV1;

  const delegationProof = await verifyControlEnvelopeIssuerSignatureV1(delegation);
  const headProof = await verifyControlEnvelopeIssuerSignatureV1(head);
  const directoryProof = await verifyControlEnvelopeIssuerSignatureV1(directory);
  const bucketProof = await verifyControlEnvelopeIssuerSignatureV1(bucket);
  let pathProof: ReturnType<typeof verifyAuthorCatalogDirectoryPathV1>;
  try {
    pathProof = verifyAuthorCatalogDirectoryPathV1(head, [directory], '0');
  } catch {
    // Some negative fixtures are intentionally structurally invalid before the
    // authorship verifier maps their closed error. Borrow a valid opaque proof;
    // verification will fail before it can grant authority.
    const valid = await buildFixture();
    pathProof = valid.input.directoryPathProof;
  }

  return {
    parentEvidence,
    delegation,
    head,
    directory,
    bucket,
    input: {
      catalogBucket: bucket,
      catalogBucketSignature: bucketProof,
      catalogHead: head,
      catalogHeadSignature: headProof,
      catalogIssuerDelegation: delegation,
      catalogIssuerDelegationSignature: delegationProof,
      directoryPathEnvelopes: [directory],
      directoryPathProof: pathProof,
      directoryPathSignatures: [directoryProof],
      parentAuthorAgentEvidence: parentEvidence,
      targetKaId: (options.targetKaId ?? kaId) as KaIdV1,
    },
  };
}

async function signControlEnvelope(
  unsigned: UnsignedControlEnvelopeV1,
  wallet: ethers.Wallet,
): Promise<SignedControlEnvelopeV1> {
  const objectDigest = computeControlObjectDigestHex(unsigned);
  return {
    ...unsigned,
    objectDigest,
    signature: await wallet.signMessage(ethers.getBytes(objectDigest)),
  };
}

async function signParentEvidence(
  unsigned: Omit<AuthorAgentDelegationEvidenceV1, 'signature'>,
  wallet: ethers.Wallet,
): Promise<AuthorAgentDelegationEvidenceV1> {
  const signature = await wallet.signMessage(computeDelegationDigest({
    agentAddress: unsigned.authorAddress,
    scope: unsigned.scope,
    issuedAtMs: Number(unsigned.issuedAt),
    expiresAtMs: Number(unsigned.expiresAt),
    delegateePeerId: unsigned.delegateePeerId ?? undefined,
    delegateeOpKey: unsigned.delegateeOpKey,
  }));
  return { ...unsigned, signature };
}

function defaultAgentScope(
  options: { readonly contextGraphId?: string; readonly subGraphName?: string | null } = {},
): AuthorCatalogAgentScopeV1 {
  return {
    authorAddress: AUTHOR,
    contextGraphId: (options.contextGraphId ?? CONTEXT_GRAPH_ID) as AuthorCatalogAgentScopeV1['contextGraphId'],
    governanceChainId: '20430',
    governanceContractAddress: GOVERNANCE_CONTRACT,
    networkId: 'otp:20430' as AuthorCatalogAgentScopeV1['networkId'],
    ownershipTransitionDigest: null,
    subGraphName: (options.subGraphName ?? null) as AuthorCatalogAgentScopeV1['subGraphName'],
  };
}

function withoutSignature(
  evidence: AuthorAgentDelegationEvidenceV1,
): Omit<AuthorAgentDelegationEvidenceV1, 'signature'> {
  const { signature: _signature, ...unsigned } = evidence;
  return unsigned;
}

function makeHighS(
  evidence: AuthorAgentDelegationEvidenceV1,
): AuthorAgentDelegationEvidenceV1 {
  const n = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
  const r = evidence.signature.slice(2, 66);
  const lowS = BigInt(`0x${evidence.signature.slice(66, 130)}`);
  const highS = (n - lowS).toString(16).padStart(64, '0');
  return {
    ...evidence,
    signature: `0x${r}${highS}${evidence.signature.slice(130)}`,
  };
}

function canonicalPayloadBytes(payload: unknown): Uint8Array {
  // Every fixture payload contains only canonical JSON strings/null/arrays.
  // The production codec independently revalidates the exact JCS byte length.
  return new TextEncoder().encode(canonicalizeFixtureJson(payload));
}

function canonicalizeFixtureJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeFixtureJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalizeFixtureJson(record[key])}`).join(',')}}`;
}

function expectCode(
  operation: () => unknown,
  code: (typeof AUTHOR_CATALOG_ROW_AUTHORSHIP_ERROR_CODES_V1)[number],
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AuthorCatalogRowAuthorshipErrorV1);
    expect((error as AuthorCatalogRowAuthorshipErrorV1).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}
