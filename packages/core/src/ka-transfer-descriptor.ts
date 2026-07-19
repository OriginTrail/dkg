import { sha256 } from '@noble/hashes/sha2.js';

import {
  canonicalizeJson,
  parseCanonicalJson,
  type CanonicalJsonValue,
  type StrictJsonParseOptions,
} from './canonical-json.js';
import {
  assertCanonicalDigest,
  parseCanonicalDecimalU64,
  type ByteLengthV1,
  type CountV1,
  type Digest32V1,
} from './sync-wire-scalars.js';
import { assertExactKeys, isPlainRecord } from './sync-wire-objects.js';

export const KA_TRANSFER_CODEC_V1 = 'dkg-ka-bundle-v1' as const;
export const KA_TRANSFER_PROJECTION_V1 = 'cg-shared-v1' as const;
export const KA_TRANSFER_CHUNK_SIZE_V1 = '262144' as const;
export const KA_TRANSFER_CHUNK_SIZE_BYTES_V1 = 262_144n;
export const MIN_KA_TRANSFER_BYTES_V1 = 16n;
export const MAX_KA_TRANSFER_BYTES_V1 = 1_073_741_824n;
export const MAX_KA_TRANSFER_CHUNKS_V1 = 4096n;
export const MAX_KA_TRANSFER_DESCRIPTOR_BYTES_V1 = 512;
export const MAX_KA_TRANSFER_DESCRIPTOR_DEPTH_V1 = 1;
export const KA_TRANSFER_IDENTITY_DIGEST_DOMAIN_V1 =
  'dkg-ka-transfer-descriptor-v1\n' as const;
const UTF8 = new TextEncoder();
const IDENTITY_DOMAIN_BYTES = UTF8.encode(KA_TRANSFER_IDENTITY_DIGEST_DOMAIN_V1);

/**
 * Exact nested author-catalog transfer value. It is not a signed control object
 * and deliberately has no objectType or wrapper field.
 */
export interface KaTransferDescriptorV1 {
  readonly codec: typeof KA_TRANSFER_CODEC_V1;
  readonly projectionId: typeof KA_TRANSFER_PROJECTION_V1;
  readonly projectionDigest: Digest32V1;
  readonly byteLength: ByteLengthV1;
  readonly chunkSize: typeof KA_TRANSFER_CHUNK_SIZE_V1;
  readonly chunkCount: CountV1;
  readonly blobDigest: Digest32V1;
  readonly chunkTreeRoot: Digest32V1;
}

export type KaTransferDescriptorErrorCode =
  | 'descriptor-schema'
  | 'descriptor-byte-length'
  | 'descriptor-chunk-count'
  | 'descriptor-chunk-size'
  | 'noncanonical-unsigned-integer'
  | 'noncanonical-digest'
  | 'object-too-large';

export class KaTransferDescriptorError extends Error {
  constructor(
    readonly code: KaTransferDescriptorErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'KaTransferDescriptorError';
  }
}

/** Validate one in-memory descriptor without signing, hashing, or storage side effects. */
export function assertKaTransferDescriptorV1(
  descriptor: unknown,
): asserts descriptor is KaTransferDescriptorV1 {
  if (!isPlainRecord(descriptor)) {
    fail('descriptor-schema', 'KA transfer descriptor must be a plain JSON object');
  }

  try {
    assertExactKeys(descriptor, [
      'blobDigest',
      'byteLength',
      'chunkCount',
      'chunkSize',
      'chunkTreeRoot',
      'codec',
      'projectionDigest',
      'projectionId',
    ], 'KA transfer descriptor');
  } catch (cause) {
    fail('descriptor-schema', 'KA transfer descriptor has an invalid field set', cause);
  }

  if (
    descriptor.codec !== KA_TRANSFER_CODEC_V1
    || descriptor.projectionId !== KA_TRANSFER_PROJECTION_V1
  ) {
    fail(
      'descriptor-schema',
      `codec and projectionId must be ${KA_TRANSFER_CODEC_V1} and ${KA_TRANSFER_PROJECTION_V1}`,
    );
  }

  assertDescriptorDigest(descriptor.projectionDigest, 'projectionDigest');
  assertDescriptorDigest(descriptor.blobDigest, 'blobDigest');
  assertDescriptorDigest(descriptor.chunkTreeRoot, 'chunkTreeRoot');

  const byteLength = parseDescriptorU64(descriptor.byteLength, 'byteLength');
  if (byteLength < MIN_KA_TRANSFER_BYTES_V1 || byteLength > MAX_KA_TRANSFER_BYTES_V1) {
    fail(
      'descriptor-byte-length',
      `byteLength must be ${MIN_KA_TRANSFER_BYTES_V1}-${MAX_KA_TRANSFER_BYTES_V1}`,
    );
  }

  if (descriptor.chunkSize !== KA_TRANSFER_CHUNK_SIZE_V1) {
    fail('descriptor-chunk-size', `chunkSize must be ${KA_TRANSFER_CHUNK_SIZE_V1}`);
  }

  const chunkCount = parseDescriptorU64(descriptor.chunkCount, 'chunkCount');
  const expectedChunkCount =
    ((byteLength - 1n) / KA_TRANSFER_CHUNK_SIZE_BYTES_V1) + 1n;
  if (
    chunkCount < 1n
    || chunkCount > MAX_KA_TRANSFER_CHUNKS_V1
    || chunkCount !== expectedChunkCount
  ) {
    fail(
      'descriptor-chunk-count',
      `chunkCount must equal ceil(byteLength/${KA_TRANSFER_CHUNK_SIZE_BYTES_V1})`,
    );
  }
}

/** Return the exact bounded RFC 8785 JCS descriptor string. */
export function canonicalizeKaTransferDescriptorV1(
  descriptor: KaTransferDescriptorV1,
): string {
  assertKaTransferDescriptorV1(descriptor);
  return canonicalizeJson(descriptor as unknown as CanonicalJsonValue, {
    maxBytes: MAX_KA_TRANSFER_DESCRIPTOR_BYTES_V1,
    maxDepth: MAX_KA_TRANSFER_DESCRIPTOR_DEPTH_V1,
  });
}

/** Return the exact bounded RFC 8785 JCS descriptor bytes. */
export function canonicalizeKaTransferDescriptorBytesV1(
  descriptor: KaTransferDescriptorV1,
): Uint8Array {
  return UTF8.encode(canonicalizeKaTransferDescriptorV1(descriptor));
}

/**
 * Bind verified partial chunks to every canonical descriptor field rather than
 * merely to the final blob digest. This is the exact durable-resume/cache key.
 */
export function computeKaTransferIdentityDigestV1(
  descriptor: KaTransferDescriptorV1,
): Digest32V1 {
  const hasher = sha256.create();
  hasher.update(IDENTITY_DOMAIN_BYTES);
  hasher.update(canonicalizeKaTransferDescriptorBytesV1(descriptor));
  let result = '0x';
  for (const byte of hasher.digest()) result += byte.toString(16).padStart(2, '0');
  assertCanonicalDigest(result, 'transferIdentityDigest');
  return result;
}

/**
 * Strictly decode a descriptor whose received bytes are already canonical JCS.
 * The protocol's 512-byte ceiling is checked before parsing/materialization.
 */
export function parseCanonicalKaTransferDescriptorV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): KaTransferDescriptorV1 {
  if (wireByteLength(input) > MAX_KA_TRANSFER_DESCRIPTOR_BYTES_V1) {
    fail(
      'object-too-large',
      `KA transfer descriptor exceeds ${MAX_KA_TRANSFER_DESCRIPTOR_BYTES_V1} bytes`,
    );
  }

  const parsed = parseCanonicalJson(input, {
    ...options,
    maxBytes: Math.min(
      options.maxBytes ?? MAX_KA_TRANSFER_DESCRIPTOR_BYTES_V1,
      MAX_KA_TRANSFER_DESCRIPTOR_BYTES_V1,
    ),
    maxDepth: Math.min(
      options.maxDepth ?? MAX_KA_TRANSFER_DESCRIPTOR_DEPTH_V1,
      MAX_KA_TRANSFER_DESCRIPTOR_DEPTH_V1,
    ),
  });
  assertKaTransferDescriptorV1(parsed);
  return parsed;
}

function assertDescriptorDigest(value: unknown, label: string): void {
  if (value === null || typeof value !== 'string') {
    fail('descriptor-schema', `${label} must be a string`);
  }
  try {
    assertCanonicalDigest(value, label);
  } catch (cause) {
    fail('noncanonical-digest', `${label} is not a canonical Digest32V1`, cause);
  }
}

function parseDescriptorU64(value: unknown, label: string): bigint {
  try {
    return parseCanonicalDecimalU64(value, label);
  } catch (cause) {
    fail(
      'noncanonical-unsigned-integer',
      `${label} is not a canonical DecimalU64V1`,
      cause,
    );
  }
}

function wireByteLength(input: string | Uint8Array): number {
  if (typeof input !== 'string') return input.byteLength;
  // UTF-8 length is never smaller than UTF-16 code-unit length. Avoid allocating
  // a second hostile-size buffer merely to reject a string over the wire cap.
  if (input.length > MAX_KA_TRANSFER_DESCRIPTOR_BYTES_V1) {
    return MAX_KA_TRANSFER_DESCRIPTOR_BYTES_V1 + 1;
  }
  return UTF8.encode(input).byteLength;
}

function fail(
  code: KaTransferDescriptorErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new KaTransferDescriptorError(code, message, cause === undefined ? {} : { cause });
}
