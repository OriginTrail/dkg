import { describe, expect, it } from 'vitest';

import {
  CONTROL_OBJECT_SIGNATURE_SUITES,
  MAX_CONTROL_OBJECT_BYTES,
  MAX_EIP1271_SIGNATURE_BYTES,
  assertControlObjectDigest,
  assertSignedControlEnvelope,
  assertUnsignedControlEnvelope,
  canonicalizeSignedControlEnvelopeBytes,
  canonicalizeUnsignedControlEnvelopeBytes,
  computeControlObjectDigestHex,
  computeControlSignatureVariantDigestHex,
  parseCanonicalControlSignatureVariant,
  parseCanonicalSignedControlEnvelope,
  parseCanonicalUnsignedControlEnvelope,
  type ControlObjectSignatureSuite,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from '../src/sync-control-object.js';

const CG_ID = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/threat-intel';
const EOA_ISSUER = '0x1111111111111111111111111111111111111111';
const SAFE_ISSUER = '0x2222222222222222222222222222222222222222';
const EOA_DIGEST = '0xf76fc6928b271be4cdd13b2e463a8f303af95b84be619c6aea0fad1ab8259da3';
const SAFE_DIGEST = '0xbaa5433cc34c3b621c556c408b1b290382cbd97f2fa99e2df714439f819bc072';
const EOA_SIGNATURE = `0x${'11'.repeat(65)}`;

// Normative bytes generated independently with Python hashlib over these literal
// UTF-8 fixtures. Do not regenerate expected values from the implementation under test.
const EOA_CANONICAL_UNSIGNED =
  '{"issuer":"0x1111111111111111111111111111111111111111","objectType":"ContextGraphPolicyV1","payload":{"accessPolicy":"invite-only","contextGraphId":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/threat-intel","era":"0","networkId":"otp:2043","publishPolicy":"curated","version":"1"},"signatureEvidence":{"kind":"none"},"signatureSuite":"eip191-personal-sign-digest-v1"}';
const SAFE_CANONICAL_UNSIGNED =
  '{"issuer":"0x2222222222222222222222222222222222222222","objectType":"ContextGraphCheckpointV1","payload":{"authorityEpoch":"7","checkpointVersion":"42","contextGraphId":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/threat-intel","networkId":"otp:2043"},"signatureEvidence":{"chainId":"2043","contractAddress":"0x2222222222222222222222222222222222222222","kind":"eip1271-current-finalized"},"signatureSuite":"eip1271-current-finalized-v1"}';
const EOA_CANONICAL_SIGNED =
  '{"issuer":"0x1111111111111111111111111111111111111111","objectDigest":"0xf76fc6928b271be4cdd13b2e463a8f303af95b84be619c6aea0fad1ab8259da3","objectType":"ContextGraphPolicyV1","payload":{"accessPolicy":"invite-only","contextGraphId":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/threat-intel","era":"0","networkId":"otp:2043","publishPolicy":"curated","version":"1"},"signature":"0x1111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111","signatureEvidence":{"kind":"none"},"signatureSuite":"eip191-personal-sign-digest-v1"}';
const EOA_SIGNATURE_VARIANT_DIGEST =
  '0x4ee07bedb94b7050086d75012344b1fc0b883ded2b36b7b0f987d1235b360509';
const EOA_CANONICAL_SIGNATURE_VARIANT =
  '{"objectDigest":"0xf76fc6928b271be4cdd13b2e463a8f303af95b84be619c6aea0fad1ab8259da3","signature":"0x1111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111","signatureVariantDigest":"0x4ee07bedb94b7050086d75012344b1fc0b883ded2b36b7b0f987d1235b360509"}';

const EOA_VECTOR: UnsignedControlEnvelopeV1 = {
  objectType: 'ContextGraphPolicyV1',
  payload: {
    accessPolicy: 'invite-only',
    contextGraphId: CG_ID,
    era: '0',
    networkId: 'otp:2043',
    publishPolicy: 'curated',
    version: '1',
  },
  signatureSuite: 'eip191-personal-sign-digest-v1',
  issuer: EOA_ISSUER,
  signatureEvidence: { kind: 'none' },
};

const SAFE_VECTOR: UnsignedControlEnvelopeV1 = {
  objectType: 'ContextGraphCheckpointV1',
  payload: {
    authorityEpoch: '7',
    checkpointVersion: '42',
    contextGraphId: CG_ID,
    networkId: 'otp:2043',
  },
  signatureSuite: 'eip1271-current-finalized-v1',
  issuer: SAFE_ISSUER,
  signatureEvidence: {
    kind: 'eip1271-current-finalized',
    chainId: '2043',
    contractAddress: SAFE_ISSUER,
  },
};

const EOA_SIGNED: SignedControlEnvelopeV1 = {
  ...EOA_VECTOR,
  objectDigest: EOA_DIGEST,
  signature: EOA_SIGNATURE,
};

const SAFE_SIGNED: SignedControlEnvelopeV1 = {
  ...SAFE_VECTOR,
  objectDigest: SAFE_DIGEST,
  signature: '0x1234',
};

describe('Track-2 control-object envelopes', () => {
  it('pins the exact EIP-191 canonical preimage and domain-separated SHA-256 vector', () => {
    expect(new TextDecoder().decode(canonicalizeUnsignedControlEnvelopeBytes(EOA_VECTOR)))
      .toBe(EOA_CANONICAL_UNSIGNED);
    expect(computeControlObjectDigestHex(EOA_VECTOR)).toBe(
      EOA_DIGEST,
    );
  });

  it('pins the exact EIP-1271 canonical preimage and domain-separated SHA-256 vector', () => {
    expect(new TextDecoder().decode(canonicalizeUnsignedControlEnvelopeBytes(SAFE_VECTOR)))
      .toBe(SAFE_CANONICAL_UNSIGNED);
    expect(computeControlObjectDigestHex(SAFE_VECTOR)).toBe(
      SAFE_DIGEST,
    );
  });

  it('strictly decodes only canonical unsigned envelopes with the exact field set', () => {
    expect(parseCanonicalUnsignedControlEnvelope(EOA_CANONICAL_UNSIGNED)).toMatchObject({
      objectType: 'ContextGraphPolicyV1',
      issuer: EOA_ISSUER,
    });
    expect(() => parseCanonicalUnsignedControlEnvelope(` ${EOA_CANONICAL_UNSIGNED}`)).toThrow(
      /not RFC 8785 canonical/,
    );
    const unknownField = `${EOA_CANONICAL_UNSIGNED.slice(0, -1)},"unknown":true}`;
    expect(() => parseCanonicalUnsignedControlEnvelope(unknownField)).toThrow(
      /unknown or missing fields/,
    );
  });

  it('strictly decodes and validates canonical EIP-191 and EIP-1271 signed envelopes', () => {
    expect(new TextDecoder().decode(canonicalizeSignedControlEnvelopeBytes(EOA_SIGNED)))
      .toBe(EOA_CANONICAL_SIGNED);
    expect(parseCanonicalSignedControlEnvelope(EOA_CANONICAL_SIGNED)).toMatchObject({
      objectDigest: EOA_DIGEST,
      signature: EOA_SIGNATURE,
    });
    expect(() => assertSignedControlEnvelope(EOA_SIGNED)).not.toThrow();
    expect(() => assertSignedControlEnvelope(SAFE_SIGNED)).not.toThrow();
    expect(() => parseCanonicalSignedControlEnvelope(` ${EOA_CANONICAL_SIGNED}`)).toThrow(
      /not RFC 8785 canonical/,
    );
  });

  it('pins and strictly decodes the detached signature-variant digest', () => {
    expect(computeControlSignatureVariantDigestHex(EOA_DIGEST, EOA_SIGNATURE)).toBe(
      EOA_SIGNATURE_VARIANT_DIGEST,
    );
    expect(parseCanonicalControlSignatureVariant(EOA_CANONICAL_SIGNATURE_VARIANT))
      .toEqual({
        objectDigest: EOA_DIGEST,
        signature: EOA_SIGNATURE,
        signatureVariantDigest: EOA_SIGNATURE_VARIANT_DIGEST,
      });
  });

  it('is independent of JavaScript insertion order and verifies exact claims', () => {
    const reordered = {
      signatureEvidence: { kind: 'none' },
      issuer: EOA_ISSUER,
      signatureSuite: 'eip191-personal-sign-digest-v1',
      payload: {
        version: '1',
        publishPolicy: 'curated',
        networkId: 'otp:2043',
        era: '0',
        contextGraphId: CG_ID,
        accessPolicy: 'invite-only',
      },
      objectType: 'ContextGraphPolicyV1',
    } satisfies UnsignedControlEnvelopeV1;

    const digest = computeControlObjectDigestHex(EOA_VECTOR);
    expect(computeControlObjectDigestHex(reordered)).toBe(digest);
    expect(() => assertControlObjectDigest(reordered, digest)).not.toThrow();
    expect(() => assertControlObjectDigest(reordered, `0x${'00'.repeat(32)}`)).toThrow(
      /digest mismatch/,
    );
  });

  it('fails closed on suite/evidence substitution', () => {
    expect(() => assertUnsignedControlEnvelope({
      ...EOA_VECTOR,
      signatureEvidence: {
        kind: 'eip1271-current-finalized',
        chainId: '2043',
        contractAddress: EOA_ISSUER,
      },
    })).toThrow(/EIP-191 signature evidence|unknown or missing fields/);

    expect(() => assertUnsignedControlEnvelope({
      ...SAFE_VECTOR,
      signatureEvidence: { kind: 'none' },
    })).toThrow(/EIP-1271 signature evidence|unknown or missing fields/);
  });

  it('keeps the immutable signature-suite registry authoritative', () => {
    expect(Object.isFrozen(CONTROL_OBJECT_SIGNATURE_SUITES)).toBe(true);
    expect(() => (CONTROL_OBJECT_SIGNATURE_SUITES as unknown as string[]).push('evil-suite'))
      .toThrow();
    const validEnvelopeBySuite = {
      'eip191-personal-sign-digest-v1': EOA_VECTOR,
      'eip1271-current-finalized-v1': SAFE_VECTOR,
    } satisfies Record<ControlObjectSignatureSuite, UnsignedControlEnvelopeV1>;
    for (const suite of CONTROL_OBJECT_SIGNATURE_SUITES) {
      expect(validEnvelopeBySuite[suite].signatureSuite).toBe(suite);
      expect(() => assertUnsignedControlEnvelope(validEnvelopeBySuite[suite])).not.toThrow();
    }
    expect(() => assertUnsignedControlEnvelope({
      ...SAFE_VECTOR,
      signatureSuite: 'evil-suite',
    } as unknown as UnsignedControlEnvelopeV1)).toThrow(
      /Unsupported control-object signature suite/,
    );
  });

  it.each(['01', '+1', '-1', '1.0', '1e3', ''])('rejects non-canonical chainId %j', (chainId) => {
    expect(() => assertUnsignedControlEnvelope({
      ...SAFE_VECTOR,
      signatureEvidence: { ...SAFE_VECTOR.signatureEvidence, chainId },
    })).toThrow(/canonical unsigned decimal/);
  });

  it('uses the complete canonical u256 range for EIP-1271 chain IDs', () => {
    expect(() => assertUnsignedControlEnvelope({
      ...SAFE_VECTOR,
      signatureEvidence: {
        ...SAFE_VECTOR.signatureEvidence,
        chainId: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
      },
    })).not.toThrow();
    expect(() => assertUnsignedControlEnvelope({
      ...SAFE_VECTOR,
      signatureEvidence: {
        ...SAFE_VECTOR.signatureEvidence,
        chainId: '115792089237316195423570985008687907853269984665640564039457584007913129639936',
      },
    })).toThrow(/canonical unsigned decimal/);
  });

  it('rejects a non-string chain ID and evidence for a different contract', () => {
    expect(() => assertUnsignedControlEnvelope({
      ...SAFE_VECTOR,
      signatureEvidence: {
        ...SAFE_VECTOR.signatureEvidence,
        chainId: 2043 as unknown as string,
      },
    })).toThrow(/canonical unsigned decimal/);

    expect(() => assertUnsignedControlEnvelope({
      ...SAFE_VECTOR,
      signatureEvidence: {
        ...SAFE_VECTOR.signatureEvidence,
        contractAddress: EOA_ISSUER,
      },
    })).toThrow(/must equal the envelope issuer/);
  });

  it('enforces the full unsigned 256-bit chainId boundary before BigInt conversion', () => {
    const maxU256 = ((1n << 256n) - 1n).toString();
    expect(() => assertUnsignedControlEnvelope({
      ...SAFE_VECTOR,
      signatureEvidence: { ...SAFE_VECTOR.signatureEvidence, chainId: maxU256 },
    })).not.toThrow();
    expect(() => assertUnsignedControlEnvelope({
      ...SAFE_VECTOR,
      signatureEvidence: {
        ...SAFE_VECTOR.signatureEvidence,
        chainId: (1n << 256n).toString(),
      },
    })).toThrow(/u256/);
    expect(() => assertUnsignedControlEnvelope({
      ...SAFE_VECTOR,
      signatureEvidence: { ...SAFE_VECTOR.signatureEvidence, chainId: '9'.repeat(100_000) },
    })).toThrow(/u256/);
  });

  it('rejects non-canonical and zero EVM issuers', () => {
    expect(() => assertUnsignedControlEnvelope({
      ...EOA_VECTOR,
      issuer: '0x111111111111111111111111111111111111111A',
    })).toThrow(/lowercase 20-byte/);
    expect(() => assertUnsignedControlEnvelope({
      ...EOA_VECTOR,
      issuer: `0x${'00'.repeat(20)}`,
    })).toThrow(/zero address/);
  });

  it('rejects malformed, non-canonical, and mismatched signed-envelope digests', () => {
    expect(() => assertSignedControlEnvelope({
      ...EOA_SIGNED,
      objectDigest: `0x${'00'.repeat(32)}`,
    })).toThrow(/digest mismatch/);
    expect(() => assertSignedControlEnvelope({
      ...EOA_SIGNED,
      objectDigest: `0x${'AA'.repeat(32)}`,
    })).toThrow(/lowercase 32-byte/);

    const signedWithUnknown = `${EOA_CANONICAL_SIGNED.slice(0, -1)},"unknown":true}`;
    expect(() => parseCanonicalSignedControlEnvelope(signedWithUnknown)).toThrow(
      /unknown or missing fields/,
    );
  });

  it('enforces exact EIP-191 and bounded EIP-1271 signature encodings', () => {
    expect(() => assertSignedControlEnvelope({
      ...EOA_SIGNED,
      signature: `0x${'11'.repeat(64)}`,
    })).toThrow(/65 lowercase bytes/);
    expect(() => assertSignedControlEnvelope({
      ...EOA_SIGNED,
      signature: `0x${'AA'.repeat(65)}`,
    })).toThrow(/65 lowercase bytes/);
    expect(() => assertSignedControlEnvelope({
      ...SAFE_SIGNED,
      signature: '0x',
    })).toThrow(/1-4096 lowercase bytes/);
    expect(() => assertSignedControlEnvelope({
      ...SAFE_SIGNED,
      signature: '0xabc',
    })).toThrow(/1-4096 lowercase bytes/);
    expect(() => assertSignedControlEnvelope({
      ...SAFE_SIGNED,
      signature: `0x${'aa'.repeat(MAX_EIP1271_SIGNATURE_BYTES + 1)}`,
    })).toThrow(/1-4096 lowercase bytes/);
    expect(() => assertSignedControlEnvelope({
      ...SAFE_SIGNED,
      signature: `0x${'aa'.repeat(MAX_EIP1271_SIGNATURE_BYTES)}`,
    })).not.toThrow();
  });

  it('measures the object-type limit in Unicode scalar values', () => {
    expect(() => assertUnsignedControlEnvelope({
      ...EOA_VECTOR,
      objectType: '🚀'.repeat(128),
    })).not.toThrow();
    expect(() => assertUnsignedControlEnvelope({
      ...EOA_VECTOR,
      objectType: '🚀'.repeat(129),
    })).toThrow(/canonical string bounds/);
  });

  it('rejects unknown, missing, accessor, and symbol envelope/evidence fields', () => {
    expect(() => assertUnsignedControlEnvelope({
      ...EOA_VECTOR,
      extra: true,
    } as unknown as UnsignedControlEnvelopeV1)).toThrow(/unknown or missing fields/);

    const missing = { ...EOA_VECTOR } as Partial<UnsignedControlEnvelopeV1>;
    delete missing.payload;
    expect(() => assertUnsignedControlEnvelope(missing as UnsignedControlEnvelopeV1)).toThrow(
      /unknown or missing fields/,
    );

    const evidenceWithExtra = {
      kind: 'none',
      staleBlock: '7',
    } as unknown as UnsignedControlEnvelopeV1['signatureEvidence'];
    expect(() => assertUnsignedControlEnvelope({
      ...EOA_VECTOR,
      signatureEvidence: evidenceWithExtra,
    })).toThrow(/unknown or missing fields/);

    const accessor = { ...EOA_VECTOR };
    Object.defineProperty(accessor, 'issuer', { enumerable: true, get: () => EOA_ISSUER });
    expect(() => assertUnsignedControlEnvelope(accessor)).toThrow(/enumerable data properties/);

    const symbolEnvelope = { ...EOA_VECTOR } as UnsignedControlEnvelopeV1 & Record<symbol, true>;
    symbolEnvelope[Symbol('hidden')] = true;
    expect(() => assertUnsignedControlEnvelope(symbolEnvelope)).toThrow(/symbol properties/);
  });

  it('rejects non-I-JSON payloads before computing a digest', () => {
    const payload = { value: Number.POSITIVE_INFINITY } as unknown as UnsignedControlEnvelopeV1['payload'];
    expect(() => computeControlObjectDigestHex({ ...EOA_VECTOR, payload })).toThrow(
      /finite IEEE-754/,
    );
  });

  it('fails oversized in-memory envelopes during bounded traversal', () => {
    const payload = {
      blob: 'x'.repeat(MAX_CONTROL_OBJECT_BYTES),
    } as UnsignedControlEnvelopeV1['payload'];
    expect(() => computeControlObjectDigestHex({ ...EOA_VECTOR, payload })).toThrow(
      /Canonical JSON exceeds/,
    );
  });

  it('enforces the complete signed-envelope byte ceiling through canonical serialization', () => {
    const emptyPayloadEnvelope: UnsignedControlEnvelopeV1 = {
      ...EOA_VECTOR,
      payload: { blob: '' },
    };
    const unsignedBaseBytes = canonicalizeUnsignedControlEnvelopeBytes(
      emptyPayloadEnvelope,
    ).byteLength;
    const unsignedAtLimit: UnsignedControlEnvelopeV1 = {
      ...emptyPayloadEnvelope,
      payload: { blob: 'x'.repeat(MAX_CONTROL_OBJECT_BYTES - unsignedBaseBytes) },
    };
    expect(canonicalizeUnsignedControlEnvelopeBytes(unsignedAtLimit)).toHaveLength(
      MAX_CONTROL_OBJECT_BYTES,
    );
    expect(() => assertSignedControlEnvelope({
      ...unsignedAtLimit,
      objectDigest: computeControlObjectDigestHex(unsignedAtLimit),
      signature: EOA_SIGNATURE,
    })).toThrow(/Canonical JSON exceeds/);

    const emptySigned: SignedControlEnvelopeV1 = {
      ...emptyPayloadEnvelope,
      objectDigest: computeControlObjectDigestHex(emptyPayloadEnvelope),
      signature: EOA_SIGNATURE,
    };
    const signedBaseBytes = canonicalizeSignedControlEnvelopeBytes(emptySigned).byteLength;
    const signedAtLimitUnsigned: UnsignedControlEnvelopeV1 = {
      ...emptyPayloadEnvelope,
      payload: { blob: 'x'.repeat(MAX_CONTROL_OBJECT_BYTES - signedBaseBytes) },
    };
    const signedAtLimit: SignedControlEnvelopeV1 = {
      ...signedAtLimitUnsigned,
      objectDigest: computeControlObjectDigestHex(signedAtLimitUnsigned),
      signature: EOA_SIGNATURE,
    };
    expect(canonicalizeSignedControlEnvelopeBytes(signedAtLimit)).toHaveLength(
      MAX_CONTROL_OBJECT_BYTES,
    );
    expect(() => assertSignedControlEnvelope(signedAtLimit)).not.toThrow();
  });

  it('rejects malformed or mismatched detached signature variants', () => {
    const mismatched = EOA_CANONICAL_SIGNATURE_VARIANT.replace(
      EOA_SIGNATURE_VARIANT_DIGEST,
      `0x${'00'.repeat(32)}`,
    );
    expect(() => parseCanonicalControlSignatureVariant(mismatched)).toThrow(
      /digest mismatch/,
    );
    const uppercaseSignature = EOA_CANONICAL_SIGNATURE_VARIANT.replace(
      EOA_SIGNATURE,
      `0x${'AA'.repeat(65)}`,
    );
    expect(() => parseCanonicalControlSignatureVariant(uppercaseSignature)).toThrow(
      /lowercase bytes/,
    );
    // Exact-key contract: an extra field in canonical (sorted) position passes
    // canonicalization but must be rejected by the exact-key check.
    const withExtraField = `${EOA_CANONICAL_SIGNATURE_VARIANT.slice(0, -1)},"unknown":"metadata"}`;
    expect(() => parseCanonicalControlSignatureVariant(withExtraField)).toThrow(
      /unknown or missing fields/,
    );
    // Variant parser limits: maxDepth 1 rejects nesting, and the 16 KiB byte cap
    // rejects an over-cap canonical input before materialization.
    expect(() => parseCanonicalControlSignatureVariant('{"a":{"b":1}}')).toThrow(/nesting/);
    const oversizedVariant = `{"a":"${'x'.repeat(16 * 1024)}"}`;
    expect(() => parseCanonicalControlSignatureVariant(oversizedVariant)).toThrow();
  });
});
