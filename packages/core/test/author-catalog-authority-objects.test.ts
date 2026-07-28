import { describe, expect, it } from 'vitest';

import {
  AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
  CATALOG_HEAD_TIMELINESS_RECEIPT_OBJECT_TYPE_V1,
  MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_BYTES_V1,
  MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_DEPTH_V1,
  assertAuthorCatalogIssuerDelegationV1,
  assertCatalogHeadTimelinessReceiptV1,
  assertSignedAuthorCatalogIssuerDelegationEnvelopeV1,
  assertSignedCatalogHeadTimelinessReceiptEnvelopeV1,
  assertUnsignedAuthorCatalogIssuerDelegationEnvelopeV1,
  assertUnsignedCatalogHeadTimelinessReceiptEnvelopeV1,
  canonicalizeAuthorCatalogIssuerDelegationPayloadV1,
  canonicalizeCatalogHeadTimelinessReceiptPayloadV1,
  canonicalizeSignedAuthorCatalogIssuerDelegationEnvelopeBytesV1,
  canonicalizeSignedCatalogHeadTimelinessReceiptEnvelopeBytesV1,
  canonicalizeUnsignedAuthorCatalogIssuerDelegationEnvelopeBytesV1,
  canonicalizeUnsignedCatalogHeadTimelinessReceiptEnvelopeBytesV1,
  computeAuthorCatalogIssuerDelegationObjectDigestV1,
  computeCatalogHeadTimelinessReceiptObjectDigestV1,
  parseCanonicalAuthorCatalogIssuerDelegationPayloadV1,
  parseCanonicalCatalogHeadTimelinessReceiptPayloadV1,
  parseCanonicalSignedAuthorCatalogIssuerDelegationEnvelopeV1,
  parseCanonicalSignedCatalogHeadTimelinessReceiptEnvelopeV1,
  parseCanonicalUnsignedAuthorCatalogIssuerDelegationEnvelopeV1,
  parseCanonicalUnsignedCatalogHeadTimelinessReceiptEnvelopeV1,
  type AuthorCatalogIssuerDelegationV1,
  type CatalogHeadTimelinessReceiptV1,
} from '../src/author-catalog-authority-objects.js';
import type {
  SignedControlEnvelopeV1,
  UnsignedControlEnvelopeV1,
} from '../src/sync-control-object.js';
import { computeControlObjectDigestHex } from '../src/sync-control-object.js';

const AUTHOR = '0x3333333333333333333333333333333333333333';
const ISSUER = '0x5555555555555555555555555555555555555555';
const CHECKPOINT = '0x7777777777777777777777777777777777777777';
const SIGNATURE = `0x${'99'.repeat(65)}`;
const AUTHOR_AUTHORITY_EVIDENCE_DIGEST = `0x${'44'.repeat(32)}`;
const DELEGATION_DIGEST = '0x00884f491e9e1725cc41b7b74dfc00fca65f7fdd247d75345f99e55a8546541b';
const DELEGATED_DELEGATION_DIGEST = '0x4a5a93a82cc7fa3aec78b082d3423d21c3e355ef9052ce41420d4c458014af85';
const RECEIPT_DIGEST = '0x0ecaa8f7835d1006f7a1f16c0682e8172fa634da7ea7fe7521ef8dd8ddb7b8d8';

const DELEGATION = validatedDelegation({
  networkId: 'otp:20430',
  contextGraphId: '0x1111111111111111111111111111111111111111/catalog-fixture',
  governanceChainId: '20430',
  governanceContractAddress: '0x2222222222222222222222222222222222222222',
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: AUTHOR,
  catalogEra: '0',
  previousDelegationDigest: null,
  catalogIssuerKey: ISSUER,
  authorAuthorityEvidenceDigest: null,
  effectiveAt: '1700000000000',
  expiresAt: '1700000120000',
});

const RECEIPT = validatedReceipt({
  networkId: DELEGATION.networkId,
  contextGraphId: DELEGATION.contextGraphId,
  governanceChainId: DELEGATION.governanceChainId,
  governanceContractAddress: DELEGATION.governanceContractAddress,
  ownershipTransitionDigest: DELEGATION.ownershipTransitionDigest,
  subGraphName: DELEGATION.subGraphName,
  checkpointAuthorityDelegationDigest: `0x${'77'.repeat(32)}`,
  authorAddress: AUTHOR,
  catalogIssuerDelegationDigest: DELEGATION_DIGEST,
  catalogHeadDigest: `0x${'66'.repeat(32)}`,
  observedAt: '1700000060000',
});

const DELEGATION_CANONICAL = '{"authorAddress":"0x3333333333333333333333333333333333333333","authorAuthorityEvidenceDigest":null,"catalogEra":"0","catalogIssuerKey":"0x5555555555555555555555555555555555555555","contextGraphId":"0x1111111111111111111111111111111111111111/catalog-fixture","effectiveAt":"1700000000000","expiresAt":"1700000120000","governanceChainId":"20430","governanceContractAddress":"0x2222222222222222222222222222222222222222","networkId":"otp:20430","ownershipTransitionDigest":null,"previousDelegationDigest":null,"subGraphName":null}';
const RECEIPT_CANONICAL = '{"authorAddress":"0x3333333333333333333333333333333333333333","catalogHeadDigest":"0x6666666666666666666666666666666666666666666666666666666666666666","catalogIssuerDelegationDigest":"0x00884f491e9e1725cc41b7b74dfc00fca65f7fdd247d75345f99e55a8546541b","checkpointAuthorityDelegationDigest":"0x7777777777777777777777777777777777777777777777777777777777777777","contextGraphId":"0x1111111111111111111111111111111111111111/catalog-fixture","governanceChainId":"20430","governanceContractAddress":"0x2222222222222222222222222222222222222222","networkId":"otp:20430","observedAt":"1700000060000","ownershipTransitionDigest":null,"subGraphName":null}';

const DELEGATION_UNSIGNED = unsigned(
  AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
  AUTHOR,
  DELEGATION,
);
const DELEGATED_DELEGATION = validatedDelegation({
  ...DELEGATION,
  authorAuthorityEvidenceDigest: AUTHOR_AUTHORITY_EVIDENCE_DIGEST,
});
const DELEGATED_DELEGATION_UNSIGNED = unsigned(
  AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
  ISSUER,
  DELEGATED_DELEGATION,
);
const RECEIPT_UNSIGNED = unsigned(
  CATALOG_HEAD_TIMELINESS_RECEIPT_OBJECT_TYPE_V1,
  CHECKPOINT,
  RECEIPT,
);
const DELEGATION_SIGNED = signed(DELEGATION_UNSIGNED, DELEGATION_DIGEST);
const DELEGATED_DELEGATION_SIGNED = signed(
  DELEGATED_DELEGATION_UNSIGNED,
  DELEGATED_DELEGATION_DIGEST,
);
const RECEIPT_SIGNED = signed(RECEIPT_UNSIGNED, RECEIPT_DIGEST);

describe('AuthorCatalogIssuerDelegationV1 codec', () => {
  it('pins canonical payload bytes, envelope digest, and signed round trips', () => {
    expect(canonicalizeAuthorCatalogIssuerDelegationPayloadV1(DELEGATION))
      .toBe(DELEGATION_CANONICAL);
    expect(new TextEncoder().encode(DELEGATION_CANONICAL)).toHaveLength(526);
    expect(parseCanonicalAuthorCatalogIssuerDelegationPayloadV1(DELEGATION_CANONICAL))
      .toEqual(DELEGATION);
    expect(computeAuthorCatalogIssuerDelegationObjectDigestV1(DELEGATION_UNSIGNED))
      .toBe(DELEGATION_DIGEST);

    const unsignedBytes = canonicalizeUnsignedAuthorCatalogIssuerDelegationEnvelopeBytesV1(
      DELEGATION_UNSIGNED,
    );
    expect(unsignedBytes).toHaveLength(725);
    expect(parseCanonicalUnsignedAuthorCatalogIssuerDelegationEnvelopeV1(unsignedBytes))
      .toEqual(DELEGATION_UNSIGNED);
    expect(parseCanonicalSignedAuthorCatalogIssuerDelegationEnvelopeV1(
      canonicalizeSignedAuthorCatalogIssuerDelegationEnvelopeBytesV1(DELEGATION_SIGNED),
    )).toEqual(DELEGATION_SIGNED);
    expect(() => assertUnsignedAuthorCatalogIssuerDelegationEnvelopeV1(DELEGATION_UNSIGNED))
      .not.toThrow();
    expect(() => assertSignedAuthorCatalogIssuerDelegationEnvelopeV1(DELEGATION_SIGNED))
      .not.toThrow();
  });

  it('closes governance, era/predecessor, validity, and scalar branches', () => {
    expect(() => assertAuthorCatalogIssuerDelegationV1({
      ...DELEGATION,
      governanceContractAddress: null,
    })).toThrow(/catalog-authority-governance/);
    expect(() => assertAuthorCatalogIssuerDelegationV1({
      ...DELEGATION,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: `0x${'44'.repeat(32)}`,
    })).toThrow(/catalog-authority-governance/);
    expect(() => assertAuthorCatalogIssuerDelegationV1({
      ...DELEGATION,
      catalogEra: '1',
    })).toThrow(/catalog-authority-history/);
    expect(() => assertAuthorCatalogIssuerDelegationV1({
      ...DELEGATION,
      previousDelegationDigest: `0x${'11'.repeat(32)}`,
    })).toThrow(/catalog-authority-history/);
    expect(() => assertAuthorCatalogIssuerDelegationV1({
      ...DELEGATION,
      expiresAt: DELEGATION.effectiveAt,
    })).toThrow(/catalog-authority-time/);
    expect(() => assertAuthorCatalogIssuerDelegationV1({ ...DELEGATION, catalogEra: 0 }))
      .toThrow(/catalog-authority-scalar/);
    expect(() => assertAuthorCatalogIssuerDelegationV1({ ...DELEGATION, extra: true }))
      .toThrow(/catalog-authority-schema/);
  });

  it('enforces exact direct/delegated author pairing on the cloned envelope', () => {
    // Direct-author positive: direct issuance carries no delegation evidence.
    expect(() => assertUnsignedAuthorCatalogIssuerDelegationEnvelopeV1(DELEGATION_UNSIGNED))
      .not.toThrow();

    // Delegated positive: the structural codec retains, but deliberately does not
    // resolve, the exact evidence digest; the authority resolver verifies it later.
    expect(() => assertUnsignedAuthorCatalogIssuerDelegationEnvelopeV1(
      DELEGATED_DELEGATION_UNSIGNED,
    )).not.toThrow();
    expect(() => assertSignedAuthorCatalogIssuerDelegationEnvelopeV1(
      DELEGATED_DELEGATION_SIGNED,
    )).not.toThrow();
    expect(computeAuthorCatalogIssuerDelegationObjectDigestV1(DELEGATED_DELEGATION_UNSIGNED))
      .toBe(DELEGATED_DELEGATION_DIGEST);

    // An arbitrary non-author issuer cannot masquerade as direct issuance.
    expect(() => assertUnsignedAuthorCatalogIssuerDelegationEnvelopeV1(unsigned(
      AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
      ISSUER,
      DELEGATION,
    ))).toThrow(/catalog-authority-authority/);

    const redigestedWrongIssuer = unsigned(
      AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
      ISSUER,
      DELEGATION,
    );
    expect(() => assertSignedAuthorCatalogIssuerDelegationEnvelopeV1(signed(
      redigestedWrongIssuer,
      computeControlObjectDigestHex(redigestedWrongIssuer),
    ))).toThrow(/catalog-authority-authority/);

    // Conversely, the author cannot attach spurious delegated-authority evidence.
    expect(() => assertUnsignedAuthorCatalogIssuerDelegationEnvelopeV1(unsigned(
      AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
      AUTHOR,
      DELEGATED_DELEGATION,
    ))).toThrow(/catalog-authority-authority/);
  });

  it('accepts registered pre-transfer and unregistered scope but rejects replay between them', () => {
    expect(() => assertAuthorCatalogIssuerDelegationV1(DELEGATION)).not.toThrow();
    expect(() => assertAuthorCatalogIssuerDelegationV1({
      ...DELEGATION,
      governanceChainId: null,
      governanceContractAddress: null,
    })).not.toThrow();
    expect(() => assertAuthorCatalogIssuerDelegationV1({
      ...DELEGATION,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: `0x${'88'.repeat(32)}`,
    })).toThrow(/catalog-authority-governance/);
  });

  it('rejects noncanonical wire, oversize input, accessors, and stateful values', () => {
    expect(() => parseCanonicalAuthorCatalogIssuerDelegationPayloadV1(
      DELEGATION_CANONICAL.replace('"catalogEra":"0"', '"catalogEra": "0"'),
    )).toThrow();
    const oversized = `{"x":"${'a'.repeat(MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_BYTES_V1)}"}`;
    expect(() => parseCanonicalAuthorCatalogIssuerDelegationPayloadV1(oversized))
      .toThrow(/payload-too-large/);

    let getterCalls = 0;
    const hostile = { ...DELEGATION } as Record<string, unknown>;
    Object.defineProperty(hostile, 'catalogIssuerKey', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return ISSUER;
      },
    });
    expect(() => assertAuthorCatalogIssuerDelegationV1(hostile))
      .toThrow(/catalog-authority-schema/);
    expect(getterCalls).toBe(0);
  });

  it('freezes the depth/byte caps and accepts structurally legal zero digests', () => {
    expect(MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_DEPTH_V1).toBe(1);
    expect(() => assertAuthorCatalogIssuerDelegationV1({
      ...DELEGATION,
      ownershipTransitionDigest: `0x${'00'.repeat(32)}`,
      authorAuthorityEvidenceDigest: `0x${'00'.repeat(32)}`,
    })).not.toThrow();

    const exactCapUnknownPayload = `{"x":"${'a'.repeat(
      MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_BYTES_V1 - 8,
    )}"}`;
    expect(new TextEncoder().encode(exactCapUnknownPayload)).toHaveLength(
      MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_BYTES_V1,
    );
    expect(() => parseCanonicalAuthorCatalogIssuerDelegationPayloadV1(exactCapUnknownPayload))
      .toThrow(/catalog-authority-schema/);

    const capPlusOne = `{"x":"${'a'.repeat(
      MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_BYTES_V1 - 7,
    )}"}`;
    expect(() => parseCanonicalAuthorCatalogIssuerDelegationPayloadV1(capPlusOne))
      .toThrow(/payload-too-large/);
    const multibyteOverCap = `{"x":"${'é'.repeat(
      Math.ceil(MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_BYTES_V1 / 2),
    )}"}`;
    expect(multibyteOverCap.length).toBeLessThan(MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_BYTES_V1);
    expect(() => parseCanonicalAuthorCatalogIssuerDelegationPayloadV1(multibyteOverCap))
      .toThrow(/payload-too-large/);
    expect(() => parseCanonicalAuthorCatalogIssuerDelegationPayloadV1(
      new Uint8Array(MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_BYTES_V1 + 1),
    )).toThrow(/payload-too-large/);
    expect(() => parseCanonicalAuthorCatalogIssuerDelegationPayloadV1('{"x":{"y":{}}}'))
      .toThrow(/nesting/i);
  });

  it('rejects wrong object types and signed digest substitution', () => {
    expect(() => assertUnsignedAuthorCatalogIssuerDelegationEnvelopeV1({
      ...DELEGATION_UNSIGNED,
      objectType: CATALOG_HEAD_TIMELINESS_RECEIPT_OBJECT_TYPE_V1,
    })).toThrow(/catalog-authority-type/);
    expect(() => assertSignedAuthorCatalogIssuerDelegationEnvelopeV1({
      ...DELEGATION_SIGNED,
      objectDigest: `0x${'00'.repeat(32)}`,
    })).toThrow(/digest mismatch/i);
  });
});

describe('CatalogHeadTimelinessReceiptV1 codec', () => {
  it('pins canonical payload bytes, envelope digest, and signed round trips', () => {
    expect(canonicalizeCatalogHeadTimelinessReceiptPayloadV1(RECEIPT))
      .toBe(RECEIPT_CANONICAL);
    expect(new TextEncoder().encode(RECEIPT_CANONICAL)).toHaveLength(644);
    expect(parseCanonicalCatalogHeadTimelinessReceiptPayloadV1(RECEIPT_CANONICAL))
      .toEqual(RECEIPT);
    expect(computeCatalogHeadTimelinessReceiptObjectDigestV1(RECEIPT_UNSIGNED))
      .toBe(RECEIPT_DIGEST);

    const unsignedBytes = canonicalizeUnsignedCatalogHeadTimelinessReceiptEnvelopeBytesV1(
      RECEIPT_UNSIGNED,
    );
    expect(unsignedBytes).toHaveLength(842);
    expect(parseCanonicalUnsignedCatalogHeadTimelinessReceiptEnvelopeV1(unsignedBytes))
      .toEqual(RECEIPT_UNSIGNED);
    expect(parseCanonicalSignedCatalogHeadTimelinessReceiptEnvelopeV1(
      canonicalizeSignedCatalogHeadTimelinessReceiptEnvelopeBytesV1(RECEIPT_SIGNED),
    )).toEqual(RECEIPT_SIGNED);
    expect(() => assertUnsignedCatalogHeadTimelinessReceiptEnvelopeV1(RECEIPT_UNSIGNED))
      .not.toThrow();
    expect(() => assertSignedCatalogHeadTimelinessReceiptEnvelopeV1(RECEIPT_SIGNED))
      .not.toThrow();
  });

  it('closes governance, field set, digest, address, and timestamp encodings', () => {
    expect(() => assertCatalogHeadTimelinessReceiptV1({
      ...RECEIPT,
      governanceChainId: null,
      governanceContractAddress: null,
    })).not.toThrow();
    expect(() => assertCatalogHeadTimelinessReceiptV1({
      ...RECEIPT,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: `0x${'88'.repeat(32)}`,
    })).toThrow(/catalog-authority-governance/);
    expect(() => assertCatalogHeadTimelinessReceiptV1({ ...RECEIPT, observedAt: 0 }))
      .toThrow(/catalog-authority-scalar/);
    expect(() => assertCatalogHeadTimelinessReceiptV1({ ...RECEIPT, authorAddress: AUTHOR.toUpperCase() }))
      .toThrow(/catalog-authority-scalar/);
    expect(() => assertCatalogHeadTimelinessReceiptV1({ ...RECEIPT, catalogHeadDigest: '0x00' }))
      .toThrow(/catalog-authority-scalar/);
    expect(() => assertCatalogHeadTimelinessReceiptV1({ ...RECEIPT, retryAfter: null }))
      .toThrow(/catalog-authority-schema/);
    expect(() => assertCatalogHeadTimelinessReceiptV1({
      ...RECEIPT,
      ownershipTransitionDigest: `0x${'00'.repeat(32)}`,
      checkpointAuthorityDelegationDigest: `0x${'00'.repeat(32)}`,
      catalogIssuerDelegationDigest: `0x${'00'.repeat(32)}`,
      catalogHeadDigest: `0x${'00'.repeat(32)}`,
    })).not.toThrow();
  });

  it('rejects stateful receipt payloads and whole envelopes before reading accessors', () => {
    let payloadGetterCalls = 0;
    const hostileReceipt = { ...RECEIPT } as Record<string, unknown>;
    Object.defineProperty(hostileReceipt, 'observedAt', {
      enumerable: true,
      get() {
        payloadGetterCalls += 1;
        return RECEIPT.observedAt;
      },
    });
    expect(() => assertCatalogHeadTimelinessReceiptV1(hostileReceipt))
      .toThrow(/catalog-authority-schema/);
    expect(payloadGetterCalls).toBe(0);

    let envelopeGetterCalls = 0;
    const hostileEnvelope = { ...RECEIPT_UNSIGNED } as Record<string, unknown>;
    Object.defineProperty(hostileEnvelope, 'issuer', {
      enumerable: true,
      get() {
        envelopeGetterCalls += 1;
        return CHECKPOINT;
      },
    });
    expect(() => assertUnsignedCatalogHeadTimelinessReceiptEnvelopeV1(hostileEnvelope))
      .toThrow();
    expect(envelopeGetterCalls).toBe(0);
    expect(() => assertCatalogHeadTimelinessReceiptV1(new Proxy({ ...RECEIPT }, {})))
      .toThrow(/catalog-authority-schema/);
  });

  it('rejects wrong object types and signed digest substitution', () => {
    expect(() => assertUnsignedCatalogHeadTimelinessReceiptEnvelopeV1({
      ...RECEIPT_UNSIGNED,
      objectType: AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
    })).toThrow(/catalog-authority-type/);
    expect(() => assertSignedCatalogHeadTimelinessReceiptEnvelopeV1({
      ...RECEIPT_SIGNED,
      objectDigest: `0x${'00'.repeat(32)}`,
    })).toThrow(/digest mismatch/i);
  });
});

function validatedDelegation(value: unknown): AuthorCatalogIssuerDelegationV1 {
  assertAuthorCatalogIssuerDelegationV1(value);
  return value;
}

function validatedReceipt(value: unknown): CatalogHeadTimelinessReceiptV1 {
  assertCatalogHeadTimelinessReceiptV1(value);
  return value;
}

function unsigned(
  objectType: string,
  issuer: string,
  payload: AuthorCatalogIssuerDelegationV1 | CatalogHeadTimelinessReceiptV1,
): UnsignedControlEnvelopeV1 {
  return {
    issuer,
    objectType,
    payload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as UnsignedControlEnvelopeV1;
}

function signed(
  envelope: UnsignedControlEnvelopeV1,
  objectDigest: string,
): SignedControlEnvelopeV1 {
  return { ...envelope, objectDigest, signature: SIGNATURE } as SignedControlEnvelopeV1;
}
