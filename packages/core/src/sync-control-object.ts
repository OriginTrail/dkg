import { sha256 } from '@noble/hashes/sha2.js';

import {
  MAX_CANONICAL_JSON_BYTES,
  MAX_CANONICAL_JSON_DEPTH,
  canonicalizeJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
  type StrictJsonParseOptions,
} from './canonical-json.js';
import {
  assertCanonicalChainId,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertCanonicalHexBytes,
} from './sync-wire-scalars.js';
import { assertExactKeys, isPlainRecord } from './sync-wire-objects.js';

export const CONTROL_OBJECT_DIGEST_DOMAIN = 'dkg-control-object-v1\n' as const;
export const CONTROL_SIGNATURE_VARIANT_DIGEST_DOMAIN =
  'dkg-control-signature-variant-v1\n' as const;
export const MAX_CONTROL_OBJECT_BYTES = MAX_CANONICAL_JSON_BYTES;
export const MAX_CONTROL_OBJECT_DEPTH = MAX_CANONICAL_JSON_DEPTH;
export const EIP191_SIGNATURE_BYTES = 65;
export const MAX_EIP1271_SIGNATURE_BYTES = 4096;
export const MAX_CONTROL_SIGNATURE_VARIANT_BYTES = 16 * 1024;

export const CONTROL_OBJECT_SIGNATURE_SUITES = Object.freeze([
  'eip191-personal-sign-digest-v1',
  'eip1271-current-finalized-v1',
] as const);

export type ControlObjectSignatureSuite = (typeof CONTROL_OBJECT_SIGNATURE_SUITES)[number];

export type ControlObjectSignatureEvidence =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'eip1271-current-finalized';
      /** Canonical unsigned decimal integer; JSON numbers are not used for chain IDs. */
      readonly chainId: string;
      readonly contractAddress: string;
    };

interface ControlEnvelopeBaseV1<Payload extends CanonicalJsonValue> {
  readonly objectType: string;
  readonly payload: Payload;
  readonly issuer: string;
}

export interface Eip191UnsignedControlEnvelopeV1<
  Payload extends CanonicalJsonValue = CanonicalJsonValue,
> extends ControlEnvelopeBaseV1<Payload> {
  readonly signatureSuite: 'eip191-personal-sign-digest-v1';
  readonly signatureEvidence: { readonly kind: 'none' };
}

export interface Eip1271UnsignedControlEnvelopeV1<
  Payload extends CanonicalJsonValue = CanonicalJsonValue,
> extends ControlEnvelopeBaseV1<Payload> {
  readonly signatureSuite: 'eip1271-current-finalized-v1';
  readonly signatureEvidence: {
    readonly kind: 'eip1271-current-finalized';
    readonly chainId: string;
    readonly contractAddress: string;
  };
}

export type UnsignedControlEnvelopeV1<
  Payload extends CanonicalJsonValue = CanonicalJsonValue,
> = Eip191UnsignedControlEnvelopeV1<Payload> | Eip1271UnsignedControlEnvelopeV1<Payload>;

interface SignedControlEnvelopeFieldsV1 {
  readonly objectDigest: string;
  readonly signature: string;
}

export type SignedControlEnvelopeV1<
  Payload extends CanonicalJsonValue = CanonicalJsonValue,
> = UnsignedControlEnvelopeV1<Payload> & SignedControlEnvelopeFieldsV1;

export interface ControlObjectSignatureVariantV1 {
  readonly objectDigest: string;
  readonly signatureVariantDigest: string;
  readonly signature: string;
}

const UTF8 = new TextEncoder();
const DOMAIN_BYTES = UTF8.encode(CONTROL_OBJECT_DIGEST_DOMAIN);
const SIGNATURE_VARIANT_DOMAIN_BYTES = UTF8.encode(CONTROL_SIGNATURE_VARIANT_DIGEST_DOMAIN);

/**
 * Return the exact RFC-64 unsigned-envelope bytes used by every digest/signature
 * implementation. Validation and bounded serialization happen in the same traversal.
 */
export function canonicalizeUnsignedControlEnvelopeBytes(
  envelope: UnsignedControlEnvelopeV1,
): Uint8Array {
  assertUnsignedControlEnvelopeFields(envelope);
  return canonicalizeUnsignedControlEnvelopeBytesAfterFields(envelope);
}

function canonicalizeUnsignedControlEnvelopeBytesAfterFields(
  envelope: UnsignedControlEnvelopeV1,
): Uint8Array {
  return canonicalizeJsonBytes(toCanonicalUnsignedEnvelope(envelope), {
    maxBytes: MAX_CONTROL_OBJECT_BYTES,
    maxDepth: MAX_CONTROL_OBJECT_DEPTH,
  });
}

/** Compute the raw 32-byte Track-2 object digest over the exact unsigned envelope. */
export function computeControlObjectDigest(
  envelope: UnsignedControlEnvelopeV1,
): Uint8Array {
  return digestWithDomain(DOMAIN_BYTES, canonicalizeUnsignedControlEnvelopeBytes(envelope));
}

export function computeControlObjectDigestHex(
  envelope: UnsignedControlEnvelopeV1,
): string {
  return bytesToLowerHex(computeControlObjectDigest(envelope));
}

export function assertControlObjectDigest(
  envelope: UnsignedControlEnvelopeV1,
  claimedDigest: string,
): void {
  assertCanonicalDigest(claimedDigest, 'objectDigest');
  const expected = computeControlObjectDigestHex(envelope);
  if (claimedDigest !== expected) {
    throw new Error(`Control-object digest mismatch: expected ${expected}`);
  }
}

/** Validate an in-memory unsigned envelope, including the generic byte/depth caps. */
export function assertUnsignedControlEnvelope(
  envelope: UnsignedControlEnvelopeV1,
): void {
  canonicalizeUnsignedControlEnvelopeBytes(envelope);
}

/**
 * Decode a received unsigned envelope. Wire bytes must already be canonical JCS;
 * the returned object has exactly the five unsigned-envelope fields.
 */
export function parseCanonicalUnsignedControlEnvelope(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): UnsignedControlEnvelopeV1 {
  const parsed = parseCanonicalJson(input, options);
  if (!isPlainRecord(parsed)) {
    throw new Error('Control-object envelope must be a plain JSON object');
  }
  const envelope = parsed as unknown as UnsignedControlEnvelopeV1;
  // parseCanonicalJson already enforced I-JSON, the caller's lower cap, and the
  // protocol hard caps. Only schema/evidence constraints remain here.
  assertUnsignedControlEnvelopeFields(envelope);
  return envelope;
}

/** Validate a complete signed wire envelope without performing authority verification. */
export function assertSignedControlEnvelope(
  envelope: SignedControlEnvelopeV1,
): void {
  validateSignedControlEnvelope(envelope);
}

/** Return the exact bounded canonical bytes of a complete signed envelope. */
export function canonicalizeSignedControlEnvelopeBytes(
  envelope: SignedControlEnvelopeV1,
): Uint8Array {
  return validateSignedControlEnvelope(envelope);
}

/** Strictly decode and validate a canonical signed wire envelope. */
export function parseCanonicalSignedControlEnvelope(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): SignedControlEnvelopeV1 {
  const parsed = parseCanonicalJson(input, options);
  if (!isPlainRecord(parsed)) {
    throw new Error('Signed control-object envelope must be a plain JSON object');
  }
  const envelope = parsed as unknown as SignedControlEnvelopeV1;
  validateSignedControlEnvelope(envelope);
  return envelope;
}

/** Compute the RFC-64 detached-signature record digest. */
export function computeControlSignatureVariantDigest(
  objectDigest: string,
  signature: string,
): Uint8Array {
  assertCanonicalDigest(objectDigest, 'objectDigest');
  assertCanonicalHexBytes(
    signature,
    'signature',
    1,
    MAX_EIP1271_SIGNATURE_BYTES,
  );
  const canonicalVariant = canonicalizeJsonBytes({ objectDigest, signature }, {
    maxBytes: MAX_CONTROL_OBJECT_BYTES,
    maxDepth: MAX_CONTROL_OBJECT_DEPTH,
  });
  return digestWithDomain(SIGNATURE_VARIANT_DOMAIN_BYTES, canonicalVariant);
}

export function computeControlSignatureVariantDigestHex(
  objectDigest: string,
  signature: string,
): string {
  return bytesToLowerHex(computeControlSignatureVariantDigest(objectDigest, signature));
}

export function assertControlSignatureVariantDigest(
  objectDigest: string,
  signature: string,
  claimedDigest: string,
): void {
  assertCanonicalDigest(claimedDigest, 'signatureVariantDigest');
  const expected = computeControlSignatureVariantDigestHex(objectDigest, signature);
  if (claimedDigest !== expected) {
    throw new Error(`Control signature-variant digest mismatch: expected ${expected}`);
  }
}

/** Return the exact bounded canonical bytes of a detached signature variant. */
export function canonicalizeControlSignatureVariantBytes(
  variant: ControlObjectSignatureVariantV1,
): Uint8Array {
  if (!isPlainRecord(variant)) {
    throw new Error('Control signature variant must be a plain JSON object');
  }
  assertExactKeys(
    variant,
    ['objectDigest', 'signature', 'signatureVariantDigest'],
    'control signature variant',
  );
  assertControlSignatureVariantDigest(
    variant.objectDigest,
    variant.signature,
    variant.signatureVariantDigest,
  );
  return canonicalizeJsonBytes({
    objectDigest: variant.objectDigest,
    signature: variant.signature,
    signatureVariantDigest: variant.signatureVariantDigest,
  }, {
    maxBytes: MAX_CONTROL_SIGNATURE_VARIANT_BYTES,
    maxDepth: 1,
  });
}

/** Strictly decode the normalized detached-signature record defined by RFC-64. */
export function parseCanonicalControlSignatureVariant(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): ControlObjectSignatureVariantV1 {
  const parsed = parseCanonicalJson(input, {
    ...options,
    maxBytes: Math.min(
      options.maxBytes ?? MAX_CONTROL_SIGNATURE_VARIANT_BYTES,
      MAX_CONTROL_SIGNATURE_VARIANT_BYTES,
    ),
    maxDepth: Math.min(options.maxDepth ?? 1, 1),
  });
  const variant = parsed as unknown as ControlObjectSignatureVariantV1;
  canonicalizeControlSignatureVariantBytes(variant);
  return variant;
}

export interface SplitCanonicalSignedControlEnvelopeV1 {
  readonly envelope: SignedControlEnvelopeV1;
  readonly unsignedEnvelope: UnsignedControlEnvelopeV1;
  readonly signatureVariant: ControlObjectSignatureVariantV1;
  readonly unsignedEnvelopeBytes: Uint8Array;
  readonly signatureVariantBytes: Uint8Array;
}

/**
 * Snapshot one signed envelope into the exact immutable records used by the
 * RFC-64 digest-addressed cache. This is the sole schema-aware split boundary.
 */
export function splitCanonicalSignedControlEnvelopeV1(
  input: SignedControlEnvelopeV1,
): SplitCanonicalSignedControlEnvelopeV1 {
  const envelope = parseCanonicalSignedControlEnvelope(
    canonicalizeSignedControlEnvelopeBytes(input),
  );
  const unsignedEnvelope = extractUnsignedEnvelope(envelope);
  const signatureVariantDigest = computeControlSignatureVariantDigestHex(
    envelope.objectDigest,
    envelope.signature,
  );
  const signatureVariant: ControlObjectSignatureVariantV1 = {
    objectDigest: envelope.objectDigest,
    signature: envelope.signature,
    signatureVariantDigest,
  };
  return Object.freeze({
    envelope,
    unsignedEnvelope,
    signatureVariant,
    unsignedEnvelopeBytes: canonicalizeUnsignedControlEnvelopeBytes(unsignedEnvelope),
    signatureVariantBytes: canonicalizeControlSignatureVariantBytes(signatureVariant),
  });
}

/**
 * Recombine exact cache records only when both records are canonical for the
 * requested digest keys. Signed-envelope validation re-computes objectDigest.
 */
export function recombineCanonicalSignedControlEnvelopeV1(
  unsignedEnvelopeInput: string | Uint8Array,
  signatureVariantInput: string | Uint8Array,
  expectedObjectDigest: string,
  expectedSignatureVariantDigest: string,
): SignedControlEnvelopeV1 {
  assertCanonicalDigest(expectedObjectDigest, 'expectedObjectDigest');
  assertCanonicalDigest(
    expectedSignatureVariantDigest,
    'expectedSignatureVariantDigest',
  );
  const unsignedEnvelope = parseCanonicalUnsignedControlEnvelope(unsignedEnvelopeInput);
  const signatureVariant = parseCanonicalControlSignatureVariant(signatureVariantInput);
  if (
    signatureVariant.objectDigest !== expectedObjectDigest
    || signatureVariant.signatureVariantDigest !== expectedSignatureVariantDigest
  ) {
    throw new Error('Control-object cache records do not match the requested digest keys');
  }
  return parseCanonicalSignedControlEnvelope(canonicalizeSignedControlEnvelopeBytes({
    ...unsignedEnvelope,
    objectDigest: expectedObjectDigest,
    signature: signatureVariant.signature,
  }));
}

function bytesToLowerHex(bytes: Uint8Array): string {
  let result = '0x';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

function validateSignedControlEnvelope(
  envelope: SignedControlEnvelopeV1,
): Uint8Array {
  if (!isPlainRecord(envelope)) {
    throw new Error('Signed control-object envelope must be a plain JSON object');
  }
  assertExactKeys(envelope, [
    'issuer',
    'objectDigest',
    'objectType',
    'payload',
    'signature',
    'signatureEvidence',
    'signatureSuite',
  ], 'signed control-object envelope');

  const unsigned = extractUnsignedEnvelope(envelope);
  assertUnsignedControlEnvelopeFields(unsigned);
  assertCanonicalDigest(envelope.objectDigest, 'objectDigest');
  assertSignatureForSuite(envelope.signature, envelope.signatureSuite);
  const canonicalUnsigned = canonicalizeUnsignedControlEnvelopeBytesAfterFields(unsigned);
  const canonicalSigned = canonicalizeJsonBytes(toCanonicalSignedEnvelope(envelope), {
    maxBytes: MAX_CONTROL_OBJECT_BYTES,
    maxDepth: MAX_CONTROL_OBJECT_DEPTH,
  });
  const expectedDigest = bytesToLowerHex(digestWithDomain(DOMAIN_BYTES, canonicalUnsigned));
  if (envelope.objectDigest !== expectedDigest) {
    throw new Error(`Control-object digest mismatch: expected ${expectedDigest}`);
  }
  return canonicalSigned;
}

function assertUnsignedControlEnvelopeFields(
  envelope: UnsignedControlEnvelopeV1,
): void {
  if (!isPlainRecord(envelope)) {
    throw new Error('Control-object envelope must be a plain JSON object');
  }
  assertExactKeys(envelope, [
    'issuer',
    'objectType',
    'payload',
    'signatureEvidence',
    'signatureSuite',
  ], 'control-object envelope');
  if (typeof envelope.objectType !== 'string' || envelope.objectType.length === 0) {
    throw new Error('Control-object type must be a non-empty string');
  }
  let objectTypeScalars = 0;
  for (const _scalar of envelope.objectType) {
    objectTypeScalars += 1;
    if (objectTypeScalars > 128) {
      throw new Error('Control-object type is outside the canonical string bounds');
    }
  }
  if (/[\u0000-\u001f\u007f]/u.test(envelope.objectType)) {
    throw new Error('Control-object type is outside the canonical string bounds');
  }
  if (!isControlObjectSignatureSuite(envelope.signatureSuite)) {
    throw new Error('Unsupported control-object signature suite');
  }
  assertCanonicalEvmAddress(envelope.issuer, 'issuer');

  if (!isPlainRecord(envelope.signatureEvidence)) {
    throw new Error('Control-object signature evidence must be a plain JSON object');
  }

  if (envelope.signatureSuite === 'eip191-personal-sign-digest-v1') {
    assertExactKeys(envelope.signatureEvidence, ['kind'], 'EIP-191 signature evidence');
    if (envelope.signatureEvidence.kind !== 'none') {
      throw new Error('EIP-191 control objects require signatureEvidence.kind=none');
    }
  } else {
    assertExactKeys(
      envelope.signatureEvidence,
      ['chainId', 'contractAddress', 'kind'],
      'EIP-1271 signature evidence',
    );
    if (envelope.signatureEvidence.kind !== 'eip1271-current-finalized') {
      throw new Error('EIP-1271 control objects require current-finalized evidence');
    }
    try {
      assertCanonicalChainId(envelope.signatureEvidence.chainId, 'EIP-1271 chainId');
    } catch {
      throw new Error('EIP-1271 chainId must be a canonical unsigned decimal u256 string');
    }
    assertCanonicalEvmAddress(
      envelope.signatureEvidence.contractAddress,
      'signatureEvidence.contractAddress',
    );
    if (envelope.signatureEvidence.contractAddress !== envelope.issuer) {
      throw new Error('EIP-1271 evidence contract must equal the envelope issuer');
    }
  }
}

function isControlObjectSignatureSuite(
  value: unknown,
): value is ControlObjectSignatureSuite {
  return typeof value === 'string'
    && CONTROL_OBJECT_SIGNATURE_SUITES.includes(value as ControlObjectSignatureSuite);
}

function assertSignatureForSuite(
  signature: string,
  suite: ControlObjectSignatureSuite,
): void {
  if (suite === 'eip191-personal-sign-digest-v1') {
    assertCanonicalHexBytes(
      signature,
      'EIP-191 signature',
      EIP191_SIGNATURE_BYTES,
      EIP191_SIGNATURE_BYTES,
    );
    return;
  }
  assertCanonicalHexBytes(
    signature,
    'EIP-1271 signature',
    1,
    MAX_EIP1271_SIGNATURE_BYTES,
  );
}

function extractUnsignedEnvelope(
  envelope: SignedControlEnvelopeV1,
): UnsignedControlEnvelopeV1 {
  if (envelope.signatureSuite === 'eip191-personal-sign-digest-v1') {
    return {
      issuer: envelope.issuer,
      objectType: envelope.objectType,
      payload: envelope.payload,
      signatureEvidence: envelope.signatureEvidence,
      signatureSuite: envelope.signatureSuite,
    };
  }
  return {
    issuer: envelope.issuer,
    objectType: envelope.objectType,
    payload: envelope.payload,
    signatureEvidence: envelope.signatureEvidence,
    signatureSuite: envelope.signatureSuite,
  };
}

function toCanonicalUnsignedEnvelope(
  envelope: UnsignedControlEnvelopeV1,
): CanonicalJsonValue {
  const evidence: CanonicalJsonValue = envelope.signatureEvidence.kind === 'none'
    ? { kind: 'none' }
    : {
        chainId: envelope.signatureEvidence.chainId,
        contractAddress: envelope.signatureEvidence.contractAddress,
        kind: 'eip1271-current-finalized',
      };

  return {
    issuer: envelope.issuer,
    objectType: envelope.objectType,
    payload: envelope.payload,
    signatureEvidence: evidence,
    signatureSuite: envelope.signatureSuite,
  };
}

function toCanonicalSignedEnvelope(
  envelope: SignedControlEnvelopeV1,
): CanonicalJsonValue {
  const unsigned = toCanonicalUnsignedEnvelope(envelope) as Record<
    string,
    CanonicalJsonValue
  >;
  return {
    ...unsigned,
    objectDigest: envelope.objectDigest,
    signature: envelope.signature,
  };
}

function digestWithDomain(domain: Uint8Array, payload: Uint8Array): Uint8Array {
  const preimage = new Uint8Array(domain.length + payload.length);
  preimage.set(domain);
  preimage.set(payload, domain.length);
  return sha256(preimage);
}
