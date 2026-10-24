import { sha256 } from '@noble/hashes/sha2.js';

import {
  KA_TRANSFER_CHUNK_SIZE_BYTES_V1,
  MAX_KA_TRANSFER_BYTES_V1,
  MAX_KA_TRANSFER_CHUNKS_V1,
  MIN_KA_TRANSFER_BYTES_V1,
} from './ka-transfer-descriptor.js';
import {
  assertCanonicalDigest,
  type Digest32V1,
} from './sync-wire-scalars.js';

export const KA_CHUNK_LEAF_DIGEST_DOMAIN_V1 = 'dkg-ka-chunk-leaf-v1\n' as const;
export const KA_CHUNK_NODE_DIGEST_DOMAIN_V1 = 'dkg-ka-chunk-node-v1\n' as const;
export const KA_CHUNK_ODD_DIGEST_DOMAIN_V1 = 'dkg-ka-chunk-odd-v1\n' as const;
export const KA_CHUNK_EMPTY_DIGEST_DOMAIN_V1 = 'dkg-ka-chunk-empty-v1\n' as const;

const UTF8 = new TextEncoder();
const LEAF_DOMAIN_BYTES = UTF8.encode(KA_CHUNK_LEAF_DIGEST_DOMAIN_V1);
const NODE_DOMAIN_BYTES = UTF8.encode(KA_CHUNK_NODE_DIGEST_DOMAIN_V1);
const ODD_DOMAIN_BYTES = UTF8.encode(KA_CHUNK_ODD_DIGEST_DOMAIN_V1);
const EMPTY_DOMAIN_BYTES = UTF8.encode(KA_CHUNK_EMPTY_DIGEST_DOMAIN_V1);
const U64_BYTES = 8;

export type KaChunkTreeV1ErrorCode =
  | 'chunk-tree-byte-length'
  | 'chunk-index'
  | 'chunk-byte-length'
  | 'chunk-count';

export class KaChunkTreeV1Error extends Error {
  constructor(
    readonly code: KaChunkTreeV1ErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'KaChunkTreeV1Error';
  }
}

/**
 * Validate a complete transfer length before any transfer-sized buffer is
 * allocated or hashed. Callers that learn the declared length from a
 * descriptor can therefore reject an over-limit transfer up front.
 */
export function assertKaChunkTreeByteLengthV1(byteLength: bigint): void {
  if (
    typeof byteLength !== 'bigint'
    || byteLength < MIN_KA_TRANSFER_BYTES_V1
    || byteLength > MAX_KA_TRANSFER_BYTES_V1
  ) {
    fail(
      'chunk-tree-byte-length',
      `bundle length must be ${MIN_KA_TRANSFER_BYTES_V1}-${MAX_KA_TRANSFER_BYTES_V1} bytes`,
    );
  }
}

/**
 * Compute the exact index- and length-bound RFC-64 leaf digest for one non-empty
 * transfer chunk. This is a dormant structural primitive; it makes no RDF or seal claim.
 */
export function computeKaChunkLeafDigestV1(
  chunkIndex: bigint,
  chunkBytes: Uint8Array,
): Digest32V1 {
  assertOwnedFixedUint8Array(chunkBytes, 'chunkBytes');
  if (
    typeof chunkIndex !== 'bigint'
    || chunkIndex < 0n
    || chunkIndex >= MAX_KA_TRANSFER_CHUNKS_V1
  ) {
    fail(
      'chunk-index',
      `chunkIndex must be in 0..${MAX_KA_TRANSFER_CHUNKS_V1 - 1n}`,
    );
  }
  const byteLength = BigInt(chunkBytes.byteLength);
  if (byteLength < 1n || byteLength > KA_TRANSFER_CHUNK_SIZE_BYTES_V1) {
    fail(
      'chunk-byte-length',
      `chunk length must be in 1..${KA_TRANSFER_CHUNK_SIZE_BYTES_V1}`,
    );
  }
  return digestBytesToLowerHex(computeLeafDigestBytes(chunkIndex, chunkBytes));
}

function computeLeafDigestBytes(chunkIndex: bigint, chunkBytes: Uint8Array): Uint8Array {
  return digestBytes(
    LEAF_DOMAIN_BYTES,
    encodeU64Be(chunkIndex),
    encodeU64Be(BigInt(chunkBytes.byteLength)),
    chunkBytes,
  );
}

/**
 * Compute the canonical root for one complete transfer blob. Chunks are the exact
 * consecutive 256 KiB slices of `bundleBytes`; only the final chunk may be shorter.
 */
export function computeKaChunkTreeRootV1(bundleBytes: Uint8Array): Digest32V1 {
  assertOwnedFixedUint8Array(bundleBytes, 'bundleBytes');
  const byteLength = BigInt(bundleBytes.byteLength);
  assertKaChunkTreeByteLengthV1(byteLength);

  const chunkCount = ((byteLength - 1n) / KA_TRANSFER_CHUNK_SIZE_BYTES_V1) + 1n;
  if (chunkCount < 1n || chunkCount > MAX_KA_TRANSFER_CHUNKS_V1) {
    fail('chunk-count', `chunk count must be in 1..${MAX_KA_TRANSFER_CHUNKS_V1}`);
  }

  const chunkSize = Number(KA_TRANSFER_CHUNK_SIZE_BYTES_V1);
  let level: Uint8Array[] = [];
  for (let index = 0; index < Number(chunkCount); index += 1) {
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, bundleBytes.byteLength);
    const chunkBytes = bundleBytes.subarray(start, end);
    // The complete bundle bounds above prove the index and chunk-length domains.
    level.push(computeLeafDigestBytes(BigInt(index), chunkBytes));
  }

  while (level.length > 1) {
    const parentLevel: Uint8Array[] = [];
    for (let index = 0; index < level.length; index += 2) {
      parentLevel.push(
        index + 1 < level.length
          ? digestBytes(NODE_DOMAIN_BYTES, level[index], level[index + 1])
          : digestBytes(ODD_DOMAIN_BYTES, level[index]),
      );
    }
    level = parentLevel;
  }
  return digestBytesToLowerHex(level[0]);
}

/** Exact domain-separated root of an empty tree; no valid v1 transfer uses it. */
export function computeEmptyKaChunkTreeRootV1(): Digest32V1 {
  return digestBytesToLowerHex(digestBytes(EMPTY_DOMAIN_BYTES));
}

function assertOwnedFixedUint8Array(
  value: unknown,
  label: string,
): asserts value is Uint8Array {
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
  const encoded = new Uint8Array(U64_BYTES);
  let remaining = value;
  for (let index = encoded.length - 1; index >= 0; index -= 1) {
    encoded[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) fail('chunk-index', 'u64be value exceeds the unsigned 64-bit range');
  return encoded;
}

function digestBytes(domain: Uint8Array, ...chunks: readonly Uint8Array[]): Uint8Array {
  const hasher = sha256.create();
  hasher.update(domain);
  for (const chunk of chunks) hasher.update(chunk);
  return hasher.digest();
}

function digestBytesToLowerHex(digest: Uint8Array): Digest32V1 {
  let result = '0x';
  for (const byte of digest) result += byte.toString(16).padStart(2, '0');
  assertCanonicalDigest(result);
  return result;
}

function fail(code: KaChunkTreeV1ErrorCode, message: string): never {
  throw new KaChunkTreeV1Error(code, message);
}
