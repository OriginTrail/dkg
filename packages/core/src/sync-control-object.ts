import { sha256 } from '@noble/hashes/sha2.js';

import {
  MAX_CANONICAL_JSON_BYTES,
  MAX_CANONICAL_JSON_DEPTH,
  canonicalizeJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
  type StrictJsonParseOptions,
} from './canonical-json.js';

export const CONTROL_OBJECT_DIGEST_DOMAIN = 'dkg-control-object-v1\n' as const;
export const CONTROL_SIGNATURE_VARIANT_DIGEST_DOMAIN =
  'dkg-control-signature-variant-v1\n' as const;
export const MAX_CONTROL_OBJECT_BYTES = MAX_CANONICAL_JSON_BYTES;
export const MAX_CONTROL_OBJECT_DEPTH = MAX_CANONICAL_JSON_DEPTH;
export const EIP191_SIGNATURE_BYTES = 65;
export const MAX_EIP1271_SIGNATURE_BYTES = 4096;
export const MAX_CONTROL_SIGNATURE_VARIANT_BYTES = 16 * 1024;

export const CONTROL_OBJECT_SIGNATURE_SUITES = [
  'eip191-personal-sign-digest-v1',
  'eip1271-current-finalized-v1',
] as const;

export type ControlObjectSignatureSuite = (typeof CONTROL_OBJECT_SIGNATURE_SUITES)[number];

export type ControlObjectSignatureEvidence =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'eip1271-current-finalized';
      /** Canonical unsigned decimal integer; JSON numbers are not used for chain IDs. */
      readonly chainId: string;
      readonly contractAddress: string;
    };

export interface UnsignedControlEnvelopeV1<Payload extends CanonicalJsonValue = CanonicalJsonValue> {
  readonly objectType: string;
  readonly payload: Payload;
  readonly signatureSuite: ControlObjectSignatureSuite;
  readonly issuer: string;
  readonly signatureEvidence: ControlObjectSignatureEvidence;
}

export interface SignedControlEnvelopeV1<Payload extends CanonicalJsonValue = CanonicalJsonValue>
  extends UnsignedControlEnvelopeV1<Payload> {
  readonly objectDigest: string;
  readonly signature: string;
}

export interface ControlObjectSignatureVariantV1 {
  readonly objectDigest: string;
  readonly signatureVariantDigest: string;
  readonly signature: string;
}

const UTF8 = new TextEncoder();
const DOMAIN_BYTES = UTF8.encode(CONTROL_OBJECT_DIGEST_DOMAIN);
const SIGNATURE_VARIANT_DOMAIN_BYTES = UTF8.encode(CONTROL_SIGNATURE_VARIANT_DIGEST_DOMAIN);
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const LOWER_HEX_BYTES = /^0x(?:[0-9a-f]{2})+$/;
const CANONICAL_UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/;

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
  validateSignedControlEnvelope(envelope, true);
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
  validateSignedControlEnvelope(envelope, false);
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
  if (!isPlainRecord(parsed)) {
    throw new Error('Control signature variant must be a plain JSON object');
  }
  assertExactKeys(
    parsed,
    ['objectDigest', 'signature', 'signatureVariantDigest'],
    'control signature variant',
  );
  const variant = parsed as unknown as ControlObjectSignatureVariantV1;
  assertControlSignatureVariantDigest(
    variant.objectDigest,
    variant.signature,
    variant.signatureVariantDigest,
  );
  return variant;
}

export function assertCanonicalEvmAddress(value: string, label = 'address'): void {
  if (typeof value !== 'string' || !EVM_ADDRESS.test(value)) {
    throw new Error(`${label} must be a lowercase 20-byte 0x EVM address`);
  }
  if (value === '0x0000000000000000000000000000000000000000') {
    throw new Error(`${label} must not be the zero address`);
  }
}

export function bytesToLowerHex(bytes: Uint8Array): string {
  let result = '0x';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

function validateSignedControlEnvelope(
  envelope: SignedControlEnvelopeV1,
  enforceSignedSize: boolean,
): void {
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
  if (
    enforceSignedSize
    && canonicalUnsigned.byteLength + signedEnvelopeAdditionalBytes(envelope)
      > MAX_CONTROL_OBJECT_BYTES
  ) {
    throw new Error(`Signed control-object envelope exceeds ${MAX_CONTROL_OBJECT_BYTES} bytes`);
  }
  const expectedDigest = bytesToLowerHex(digestWithDomain(DOMAIN_BYTES, canonicalUnsigned));
  if (envelope.objectDigest !== expectedDigest) {
    throw new Error(`Control-object digest mismatch: expected ${expectedDigest}`);
  }
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
  if (/[ -]/u.test(envelope.objectType)) {
    throw new Error('Control-object type is outside the canonical string bounds');
  }
  if (!CONTROL_OBJECT_SIGNATURE_SUITES.includes(envelope.signatureSuite)) {
    throw new Error(`Unsupported control-object signature suite: ${String(envelope.signatureSuite)}`);
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
    if (
      typeof envelope.signatureEvidence.chainId !== 'string'
      || !CANONICAL_UNSIGNED_DECIMAL.test(envelope.signatureEvidence.chainId)
    ) {
      throw new Error('EIP-1271 chainId must be a canonical unsigned decimal string');
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

function assertCanonicalDigest(value: string, label: string): void {
  if (
    typeof value !== 'string'
    || value.length !== 66
    || !/^0x[0-9a-f]{64}$/.test(value)
  ) {
    throw new Error(`${label} must be a lowercase 32-byte 0x digest`);
  }
}

function assertCanonicalHexBytes(
  value: string,
  label: string,
  minBytes: number,
  maxBytes: number,
): void {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new Error(`${label} must be lowercase 0x-prefixed bytes`);
  }
  const hexLength = value.length - 2;
  if (
    hexLength % 2 !== 0
    || hexLength < minBytes * 2
    || hexLength > maxBytes * 2
    || !LOWER_HEX_BYTES.test(value)
  ) {
    throw new Error(
      `${label} must be ${minBytes === maxBytes ? `${minBytes}` : `${minBytes}-${maxBytes}`} lowercase bytes`,
    );
  }
}

function extractUnsignedEnvelope(
  envelope: SignedControlEnvelopeV1,
): UnsignedControlEnvelopeV1 {
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

function signedEnvelopeAdditionalBytes(
  envelope: SignedControlEnvelopeV1,
): number {
  // The signed form adds exactly two comma-delimited ASCII fields to the already
  // non-empty unsigned object. Sorting changes placement, never byte length.
  return (
    1 + '"objectDigest":'.length + envelope.objectDigest.length + 2
    + 1 + '"signature":'.length + envelope.signature.length + 2
  );
}

function digestWithDomain(domain: Uint8Array, payload: Uint8Array): Uint8Array {
  const preimage = new Uint8Array(domain.length + payload.length);
  preimage.set(domain);
  preimage.set(payload, domain.length);
  return sha256(preimage);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Reflect.ownKeys(record);
  if (actual.some((key) => typeof key !== 'string')) {
    throw new Error(`${label} must not contain symbol properties`);
  }
  const strings = actual as string[];
  if (
    strings.length !== expected.length
    || [...strings].sort().some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  for (const key of strings) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} fields must be enumerable data properties`);
    }
  }
}
