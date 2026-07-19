import { sha256 } from '@noble/hashes/sha2.js';

import {
  MAX_KA_TRANSFER_BYTES_V1,
  MIN_KA_TRANSFER_BYTES_V1,
} from './ka-transfer-descriptor.js';
import type { Digest32V1 } from './sync-wire-scalars.js';

export const KA_BUNDLE_PROJECTION_DIGEST_DOMAIN_V1 = 'dkg-ka-projection-v1\n' as const;
export const KA_BUNDLE_BLOB_DIGEST_DOMAIN_V1 = 'dkg-ka-transfer-v1\n' as const;
export const KA_BUNDLE_U64_PREFIX_BYTES_V1 = 8;
export const MIN_KA_BUNDLE_BYTES_V1 = MIN_KA_TRANSFER_BYTES_V1;
export const MAX_KA_BUNDLE_BYTES_V1 = MAX_KA_TRANSFER_BYTES_V1;

const MAX_U64 = 18_446_744_073_709_551_615n;
const UTF8 = new TextEncoder();
const PROJECTION_DIGEST_DOMAIN_BYTES = UTF8.encode(KA_BUNDLE_PROJECTION_DIGEST_DOMAIN_V1);
const BLOB_DIGEST_DOMAIN_BYTES = UTF8.encode(KA_BUNDLE_BLOB_DIGEST_DOMAIN_V1);

export type KaBundleV1ErrorCode =
  | 'bundle-byte-length'
  | 'bundle-truncated'
  | 'bundle-length-overflow'
  | 'bundle-trailing-bytes';

export class KaBundleV1Error extends Error {
  constructor(
    readonly code: KaBundleV1ErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'KaBundleV1Error';
  }
}

export interface EncodedOpaqueKaBundleV1 {
  /** Exact `u64be(projection length) || projection || u64be(seal length) || seal`. */
  readonly bundleBytes: Uint8Array;
  readonly projectionDigest: Digest32V1;
  readonly blobDigest: Digest32V1;
}

export interface DecodedOpaqueKaBundleV1 {
  /**
   * Borrowed zero-copy view into the received bundle. It carries no RDF semantic
   * claim and is valid only while the caller leaves the input bytes unchanged.
   */
  readonly projectionBytes: Uint8Array;
  /**
   * Borrowed zero-copy view into the received bundle. It carries no seal semantic
   * claim and must be copied or ownership-pinned before asynchronous retention.
   */
  readonly sealBytes: Uint8Array;
  readonly projectionDigest: Digest32V1;
  readonly blobDigest: Digest32V1;
}

/**
 * Validate the exact v1 component-length arithmetic without allocating a bundle.
 * Inputs are bigint so no candidate u64 ever passes through binary floating point.
 */
export function calculateOpaqueKaBundleByteLengthV1(
  projectionByteLength: bigint,
  sealByteLength: bigint,
): bigint {
  assertU64Length(projectionByteLength, 'projectionByteLength');
  assertU64Length(sealByteLength, 'sealByteLength');

  const payloadLimit = MAX_KA_BUNDLE_BYTES_V1 - MIN_KA_BUNDLE_BYTES_V1;
  if (
    projectionByteLength > payloadLimit
    || sealByteLength > payloadLimit - projectionByteLength
  ) {
    fail(
      'bundle-length-overflow',
      `component lengths exceed the ${MAX_KA_BUNDLE_BYTES_V1}-byte v1 bundle limit`,
    );
  }

  const totalByteLength = MIN_KA_BUNDLE_BYTES_V1
    + projectionByteLength
    + sealByteLength;
  // Keep the complete-length gate shared with the decoder and advertised-length
  // admission path even though the component checks above already prove this bound.
  assertOpaqueKaBundleByteLengthV1(totalByteLength);
  return totalByteLength;
}

/** Validate an advertised/received complete bundle length before any payload work. */
export function assertOpaqueKaBundleByteLengthV1(totalByteLength: bigint): void {
  if (
    typeof totalByteLength !== 'bigint'
    || totalByteLength < MIN_KA_BUNDLE_BYTES_V1
    || totalByteLength > MAX_KA_BUNDLE_BYTES_V1
  ) {
    fail(
      'bundle-byte-length',
      `bundle length must be ${MIN_KA_BUNDLE_BYTES_V1}-${MAX_KA_BUNDLE_BYTES_V1} bytes`,
    );
  }
}

/**
 * Frame two opaque byte strings and compute both RFC-64 digests incrementally.
 * This function does not validate RDF, a structured root, or an author seal.
 */
export function encodeOpaqueKaBundleV1(
  projectionBytes: Uint8Array,
  sealBytes: Uint8Array,
): EncodedOpaqueKaBundleV1 {
  assertUint8Array(projectionBytes, 'projectionBytes');
  assertUint8Array(sealBytes, 'sealBytes');

  const projectionByteLength = BigInt(projectionBytes.byteLength);
  const sealByteLength = BigInt(sealBytes.byteLength);
  const totalByteLength = calculateOpaqueKaBundleByteLengthV1(
    projectionByteLength,
    sealByteLength,
  );

  // The protocol ceiling is 1 GiB, so the checked bigint is exactly representable.
  const bundleBytes = new Uint8Array(Number(totalByteLength));
  const projectionPrefix = encodeU64Be(projectionByteLength);
  const sealPrefix = encodeU64Be(sealByteLength);
  let cursor = 0;
  bundleBytes.set(projectionPrefix, cursor);
  cursor += KA_BUNDLE_U64_PREFIX_BYTES_V1;
  bundleBytes.set(projectionBytes, cursor);
  cursor += projectionBytes.byteLength;
  bundleBytes.set(sealPrefix, cursor);
  cursor += KA_BUNDLE_U64_PREFIX_BYTES_V1;
  bundleBytes.set(sealBytes, cursor);

  const finalizedProjectionBytes = bundleBytes.subarray(
    KA_BUNDLE_U64_PREFIX_BYTES_V1,
    KA_BUNDLE_U64_PREFIX_BYTES_V1 + projectionBytes.byteLength,
  );

  return {
    bundleBytes,
    projectionDigest: digestToLowerHex(
      PROJECTION_DIGEST_DOMAIN_BYTES,
      finalizedProjectionBytes,
    ),
    blobDigest: digestToLowerHex(BLOB_DIGEST_DOMAIN_BYTES, bundleBytes),
  };
}

/**
 * Strictly decode one complete frame. Component bytes are returned as zero-copy views;
 * all framing checks finish before either digest is updated.
 */
export function decodeOpaqueKaBundleV1(bundleBytes: Uint8Array): DecodedOpaqueKaBundleV1 {
  assertUint8Array(bundleBytes, 'bundleBytes');

  const receivedByteLength = BigInt(bundleBytes.byteLength);
  assertOpaqueKaBundleByteLengthV1(receivedByteLength);

  const projectionByteLength = decodeU64Be(bundleBytes, 0);
  // This shared arithmetic check distinguishes an impossible v1 declaration from a
  // merely truncated received frame, without converting an unchecked u64 to number.
  const minimumWithProjection = calculateOpaqueKaBundleByteLengthV1(
    projectionByteLength,
    0n,
  );
  if (minimumWithProjection > receivedByteLength) {
    fail('bundle-truncated', 'projection payload or seal-length prefix is truncated');
  }

  const projectionStart = KA_BUNDLE_U64_PREFIX_BYTES_V1;
  const projectionEnd = projectionStart + Number(projectionByteLength);
  const sealByteLength = decodeU64Be(bundleBytes, projectionEnd);
  const expectedByteLength = calculateOpaqueKaBundleByteLengthV1(
    projectionByteLength,
    sealByteLength,
  );

  if (expectedByteLength > receivedByteLength) {
    fail('bundle-truncated', 'seal payload is truncated');
  }
  if (expectedByteLength < receivedByteLength) {
    fail('bundle-trailing-bytes', 'bundle contains bytes after the declared seal payload');
  }

  const sealStart = projectionEnd + KA_BUNDLE_U64_PREFIX_BYTES_V1;
  const sealEnd = sealStart + Number(sealByteLength);
  const projectionBytes = bundleBytes.subarray(projectionStart, projectionEnd);
  const sealBytes = bundleBytes.subarray(sealStart, sealEnd);

  return {
    projectionBytes,
    sealBytes,
    projectionDigest: digestToLowerHex(PROJECTION_DIGEST_DOMAIN_BYTES, projectionBytes),
    blobDigest: digestToLowerHex(BLOB_DIGEST_DOMAIN_BYTES, bundleBytes),
  };
}

function assertU64Length(value: bigint, label: string): void {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_U64) {
    fail('bundle-length-overflow', `${label} is not an unsigned 64-bit length`);
  }
}

function assertUint8Array(value: unknown, label: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be a Uint8Array`);
  }
  if (!(value.buffer instanceof ArrayBuffer)) {
    throw new TypeError(`${label} must not use shared backing memory`);
  }
  if ((value.buffer as ArrayBuffer & { readonly resizable?: boolean }).resizable === true) {
    throw new TypeError(`${label} must not use resizable backing memory`);
  }
}

function encodeU64Be(value: bigint): Uint8Array {
  assertU64Length(value, 'u64be value');
  const encoded = new Uint8Array(KA_BUNDLE_U64_PREFIX_BYTES_V1);
  let remaining = value;
  for (let index = encoded.length - 1; index >= 0; index -= 1) {
    encoded[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return encoded;
}

function decodeU64Be(bytes: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + KA_BUNDLE_U64_PREFIX_BYTES_V1 > bytes.byteLength) {
    fail('bundle-truncated', 'u64be length prefix is truncated');
  }
  let value = 0n;
  for (let index = offset; index < offset + KA_BUNDLE_U64_PREFIX_BYTES_V1; index += 1) {
    value = (value << 8n) | BigInt(bytes[index]);
  }
  return value;
}

function digestToLowerHex(domain: Uint8Array, ...chunks: readonly Uint8Array[]): Digest32V1 {
  const hasher = sha256.create();
  hasher.update(domain);
  for (const chunk of chunks) hasher.update(chunk);
  const digest = hasher.digest();
  let result = '0x';
  for (const byte of digest) result += byte.toString(16).padStart(2, '0');
  return result;
}

function fail(code: KaBundleV1ErrorCode, message: string): never {
  throw new KaBundleV1Error(code, message);
}
