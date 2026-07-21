import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { compareCanonicalCbor } from './canonical-cbor.js';
import { unsignedProtocolTuple, validateProtocolTuple, validateUnsignedProtocolTuple } from './codec.js';
import { protocolError, WalProtocolError } from './errors.js';
import { protocolSignatureDigest } from './hashes.js';
import {
  PROTOCOL_TUPLES,
  type CborProtocolValue,
  type ProtocolTuple,
  type ProtocolTupleSchema,
  type SignedProtocolTupleName,
  type SingleSignedProtocolTupleName,
  type ThresholdSignedProtocolTupleName,
} from './schema.js';

const SECP256K1_ORDER = 0xffff_ffff_ffff_ffff_ffff_ffff_ffff_fffe_baaedce6_af48a03b_bfd25e8c_d0364141n;
const SECP256K1_HALF_ORDER = SECP256K1_ORDER >> 1n;
const EIP191_DIGEST_PREFIX = new TextEncoder().encode('\x19Ethereum Signed Message:\n32');

export interface WalEip191Signer {
  readonly address?: string | Uint8Array;
  getAddress?(): string | Uint8Array | Promise<string | Uint8Array>;
  getSignerAddress?(): string | Uint8Array | Promise<string | Uint8Array>;
  signMessage(message: Uint8Array): WalEip191Signature | Promise<WalEip191Signature>;
}

export interface WalCompactEip2098Signature {
  readonly r: Uint8Array;
  readonly vs: Uint8Array;
}

export type WalEip191Signature = string | Uint8Array | WalCompactEip2098Signature;

export interface WalThresholdAuthority {
  signerAddresses: readonly Uint8Array[];
  threshold: number | bigint;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function bytesToBigint(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function normalizeAddress20(value: string | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length !== 20) protocolError('WAL_SIGNATURE_ADAPTER', 'signer address must be exactly 20 bytes');
    return new Uint8Array(value);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    protocolError('WAL_SIGNATURE_ADAPTER', 'signer address must be a 0x-prefixed 20-byte hex value');
  }
  return Uint8Array.from(value.slice(2).match(/../g)!, byte => Number.parseInt(byte, 16));
}

function normalizeSignature65(value: WalEip191Signature): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value === 'string') {
    if (!/^0x[0-9a-fA-F]{130}$/.test(value)) {
      protocolError('WAL_SIGNATURE_ADAPTER', 'signature adapter must return a 0x-prefixed 65-byte signature');
    }
    return Uint8Array.from(value.slice(2).match(/../g)!, byte => Number.parseInt(byte, 16));
  }
  if (
    !value
    || !(value.r instanceof Uint8Array)
    || value.r.length !== 32
    || !(value.vs instanceof Uint8Array)
    || value.vs.length !== 32
  ) {
    protocolError('WAL_SIGNATURE_ADAPTER', 'compact signature adapter output must contain 32-byte r and vs values');
  }
  const signature = new Uint8Array(65);
  signature.set(value.r, 0);
  signature.set(value.vs, 32);
  signature[64] = (signature[32] & 0x80) === 0 ? 27 : 28;
  signature[32] &= 0x7f;
  return signature;
}

export function eip191DigestHash(digest: Uint8Array): Uint8Array {
  if (!(digest instanceof Uint8Array) || digest.length !== 32) {
    protocolError('WAL_SIGNATURE_LENGTH', 'EIP-191 protocol digest must be exactly 32 bytes');
  }
  return keccak_256(concat([EIP191_DIGEST_PREFIX, digest]));
}

export function assertCanonicalEip191Signature(signature: Uint8Array): void {
  if (!(signature instanceof Uint8Array) || signature.length !== 65) {
    protocolError('WAL_SIGNATURE_LENGTH', 'recoverable signature must be exactly 65 bytes');
  }
  const recovery = signature[64];
  if (recovery !== 27 && recovery !== 28) {
    protocolError('WAL_SIGNATURE_RECOVERY_BIT', 'signature recovery byte must be normalized to 27 or 28');
  }
  const r = bytesToBigint(signature.subarray(0, 32));
  const s = bytesToBigint(signature.subarray(32, 64));
  if (r <= 0n || r >= SECP256K1_ORDER) {
    protocolError('WAL_SIGNATURE_R_RANGE', 'signature r is outside the secp256k1 scalar range');
  }
  if (s <= 0n || s > SECP256K1_HALF_ORDER) {
    protocolError('WAL_SIGNATURE_HIGH_S', 'signature s must be nonzero and canonical low-S');
  }
}

export function recoverEip191Address(digest: Uint8Array, signature: Uint8Array): Uint8Array {
  assertCanonicalEip191Signature(signature);
  const recoveredSignature = new Uint8Array(65);
  recoveredSignature[0] = signature[64] - 27;
  recoveredSignature.set(signature.subarray(0, 64), 1);
  try {
    const compressed = secp256k1.recoverPublicKey(
      recoveredSignature,
      eip191DigestHash(digest),
      { prehash: false },
    );
    const uncompressed = secp256k1.Point.fromBytes(compressed).toBytes(false);
    return keccak_256(uncompressed.subarray(1)).subarray(12);
  } catch {
    return protocolError('WAL_SIGNATURE_RECOVERY_FAILED', 'signature public-key recovery failed');
  }
}

export function signEip191DigestWithPrivateKey(digest: Uint8Array, privateKey: Uint8Array): Uint8Array {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) {
    protocolError('WAL_SIGNATURE_ADAPTER', 'secp256k1 private key must be exactly 32 bytes');
  }
  let recovered: Uint8Array;
  try {
    recovered = secp256k1.sign(eip191DigestHash(digest), privateKey, {
      prehash: false,
      lowS: true,
      format: 'recovered',
    });
  } catch {
    return protocolError('WAL_SIGNATURE_ADAPTER', 'secp256k1 private key could not sign the digest');
  }
  const signature = new Uint8Array(65);
  signature.set(recovered.subarray(1), 0);
  signature[64] = recovered[0] + 27;
  assertCanonicalEip191Signature(signature);
  return signature;
}

export async function signEip191DigestWithAdapter(
  digest: Uint8Array,
  signer: WalEip191Signer,
): Promise<{ signerAddress: Uint8Array; signature: Uint8Array }> {
  if (
    !signer
    || typeof signer.signMessage !== 'function'
    || (
      typeof signer.getAddress !== 'function'
      && typeof signer.getSignerAddress !== 'function'
      && signer.address === undefined
    )
  ) {
    protocolError(
      'WAL_SIGNATURE_ADAPTER',
      'signer must expose address, getAddress(), or getSignerAddress(), and implement signMessage()',
    );
  }
  let signerAddress: Uint8Array;
  let signature: Uint8Array;
  try {
    const address = typeof signer.getAddress === 'function'
      ? await signer.getAddress()
      : typeof signer.getSignerAddress === 'function'
        ? await signer.getSignerAddress()
        : signer.address!;
    signerAddress = normalizeAddress20(address);
    signature = normalizeSignature65(await signer.signMessage(new Uint8Array(digest)));
  } catch (error) {
    if (error instanceof WalProtocolError) throw error;
    return protocolError(
      'WAL_SIGNATURE_ADAPTER',
      `signature adapter failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const recovered = recoverEip191Address(digest, signature);
  if (!bytesEqual(recovered, signerAddress)) {
    protocolError('WAL_SIGNATURE_SIGNER_MISMATCH', 'signature adapter address does not match recovered signer');
  }
  return { signerAddress, signature };
}

export function verifySingleSignedProtocolTuple<Name extends SingleSignedProtocolTupleName>(
  name: Name,
  value: ProtocolTuple<Name>,
): Uint8Array {
  validateProtocolTuple(name, value);
  const schema: ProtocolTupleSchema = PROTOCOL_TUPLES[name];
  if (schema.signed !== 'single' || schema.signerField === undefined || !schema.signatureDomain) {
    return protocolError('WAL_SIGNATURE_DOMAIN', `${name} is not a single-signer protocol tuple`);
  }
  const expected = value[schema.signerField] as Uint8Array;
  const signature = value[value.length - 1] as Uint8Array;
  const digest = protocolSignatureDigest(name, unsignedProtocolTuple(name, value));
  const recovered = recoverEip191Address(digest, signature);
  if (!bytesEqual(recovered, expected)) {
    protocolError('WAL_SIGNATURE_SIGNER_MISMATCH', `${name} signature does not match its signed author`);
  }
  return recovered;
}

export function verifyThresholdSignedProtocolTuple<Name extends ThresholdSignedProtocolTupleName>(
  name: Name,
  value: ProtocolTuple<Name>,
  authority: WalThresholdAuthority,
): readonly Uint8Array[] {
  validateProtocolTuple(name, value);
  const schema: ProtocolTupleSchema = PROTOCOL_TUPLES[name];
  if (schema.signed !== 'threshold' || !schema.signatureDomain) {
    return protocolError('WAL_SIGNATURE_DOMAIN', `${name} is not a threshold-signed protocol tuple`);
  }
  if (
    typeof authority.threshold === 'number'
    && (!Number.isSafeInteger(authority.threshold) || authority.threshold <= 0)
  ) {
    return protocolError('WAL_SIGNATURE_THRESHOLD', 'authority threshold must be a positive safe integer');
  }
  const threshold = typeof authority.threshold === 'bigint' ? authority.threshold : BigInt(authority.threshold);
  if (threshold <= 0n || threshold > BigInt(authority.signerAddresses.length)) {
    return protocolError('WAL_SIGNATURE_THRESHOLD', 'authority threshold must be positive and attainable');
  }
  const authorized = new Map(authority.signerAddresses.map(address => {
    const normalized = normalizeAddress20(address);
    return [bytesToHex(normalized), normalized] as const;
  }));
  if (authorized.size !== authority.signerAddresses.length) {
    return protocolError('WAL_SIGNATURE_DUPLICATE_SIGNER', 'authority contains duplicate signer addresses');
  }
  const digest = protocolSignatureDigest(name, unsignedProtocolTuple(name, value));
  const entries = value[value.length - 1] as readonly (readonly [Uint8Array, Uint8Array])[];
  const recovered: Uint8Array[] = [];
  for (const [claimedAddress, signature] of entries) {
    const signer = recoverEip191Address(digest, signature);
    if (!bytesEqual(signer, claimedAddress)) {
      protocolError('WAL_SIGNATURE_SIGNER_MISMATCH', `${name} signature entry does not match its signer address`);
    }
    if (!authorized.has(bytesToHex(signer))) {
      protocolError('WAL_SIGNATURE_SIGNER_MISMATCH', `${name} contains a signer outside the supplied authority set`);
    }
    recovered.push(signer);
  }
  if (BigInt(recovered.length) < threshold) {
    protocolError('WAL_SIGNATURE_THRESHOLD', `${name} does not meet the supplied authority threshold`);
  }
  return recovered;
}

export async function signSingleProtocolTuple<Name extends SingleSignedProtocolTupleName>(
  name: Name,
  unsigned: readonly CborProtocolValue[],
  signer: WalEip191Signer,
): Promise<ProtocolTuple<Name>> {
  validateUnsignedProtocolTuple(name, unsigned);
  const schema: ProtocolTupleSchema = PROTOCOL_TUPLES[name];
  if (schema.signed !== 'single' || schema.signerField === undefined) {
    return protocolError('WAL_SIGNATURE_DOMAIN', `${name} is not a single-signer protocol tuple`);
  }
  const signed = await signEip191DigestWithAdapter(protocolSignatureDigest(name, unsigned), signer);
  const expectedAddress = unsigned[schema.signerField];
  if (!(expectedAddress instanceof Uint8Array) || !bytesEqual(expectedAddress, signed.signerAddress)) {
    return protocolError('WAL_SIGNATURE_SIGNER_MISMATCH', `${name} signer does not match the signed author field`);
  }
  const value = [...unsigned, signed.signature] as unknown as ProtocolTuple<Name>;
  validateProtocolTuple(name, value);
  return value;
}

export async function signThresholdProtocolTuple<Name extends ThresholdSignedProtocolTupleName>(
  name: Name,
  unsigned: readonly CborProtocolValue[],
  signers: readonly WalEip191Signer[],
): Promise<ProtocolTuple<Name>> {
  validateUnsignedProtocolTuple(name, unsigned);
  const schema: ProtocolTupleSchema = PROTOCOL_TUPLES[name];
  if (schema.signed !== 'threshold') {
    return protocolError('WAL_SIGNATURE_DOMAIN', `${name} is not a threshold-signed protocol tuple`);
  }
  const digest = protocolSignatureDigest(name, unsigned);
  const entries = await Promise.all(signers.map(async signer => {
    const signed = await signEip191DigestWithAdapter(digest, signer);
    return [signed.signerAddress, signed.signature] as const;
  }));
  entries.sort((left, right) => compareCanonicalCbor(left[0], right[0]));
  for (let index = 1; index < entries.length; index += 1) {
    if (bytesEqual(entries[index - 1][0], entries[index][0])) {
      return protocolError('WAL_SIGNATURE_DUPLICATE_SIGNER', `${name} cannot contain duplicate signers`);
    }
  }
  const value = [...unsigned, entries] as unknown as ProtocolTuple<Name>;
  validateProtocolTuple(name, value);
  return value;
}
