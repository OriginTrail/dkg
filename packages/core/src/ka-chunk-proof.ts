import { sha256 } from '@noble/hashes/sha2.js';

import {
  canonicalizeJson,
  parseCanonicalJson,
  type CanonicalJsonValue,
  type StrictJsonParseOptions,
} from './canonical-json.js';
import {
  KA_CHUNK_NODE_DIGEST_DOMAIN_V1,
  KA_CHUNK_ODD_DIGEST_DOMAIN_V1,
  computeKaChunkLeafDigestV1,
} from './ka-chunk-tree.js';
import {
  KA_TRANSFER_CHUNK_SIZE_BYTES_V1,
  MAX_KA_TRANSFER_BYTES_V1,
  MAX_KA_TRANSFER_CHUNKS_V1,
  MIN_KA_TRANSFER_BYTES_V1,
} from './ka-transfer-descriptor.js';
import { assertExactKeys, isPlainRecord } from './sync-wire-objects.js';
import {
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  parseCanonicalDecimalU64,
  type Digest32V1,
  type IndexV1,
} from './sync-wire-scalars.js';

export const MAX_KA_CHUNK_PROOF_BYTES_V1 = 1280;
export const MAX_KA_CHUNK_PROOF_DEPTH_V1 = 3;
export const MAX_KA_CHUNK_PROOF_STEPS_V1 = 12;
export const MAX_KA_CHUNK_PROOFS_PER_REQUEST_V1 = 16;

const UTF8 = new TextEncoder();
const NODE_DOMAIN_BYTES = UTF8.encode(KA_CHUNK_NODE_DIGEST_DOMAIN_V1);
const ODD_DOMAIN_BYTES = UTF8.encode(KA_CHUNK_ODD_DIGEST_DOMAIN_V1);
const DIGEST_BYTES = 32;

export type KaChunkProofStepV1 =
  | { readonly kind: 'left'; readonly digest: Digest32V1 }
  | { readonly kind: 'right'; readonly digest: Digest32V1 }
  | { readonly kind: 'odd' };

export interface KaChunkProofV1 {
  readonly chunkIndex: IndexV1;
  readonly steps: readonly KaChunkProofStepV1[];
}

export type KaChunkProofV1ErrorCode =
  | 'proof-schema'
  | 'proof-object-too-large'
  | 'proof-chunk-count'
  | 'proof-chunk-index'
  | 'proof-request-indexes'
  | 'proof-topology'
  | 'proof-chunk-byte-length'
  | 'proof-root-mismatch';

export class KaChunkProofV1Error extends Error {
  constructor(
    readonly code: KaChunkProofV1ErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'KaChunkProofV1Error';
  }
}

/** Validate a proof's exact closed schema and descriptor-derived topology. */
export function assertKaChunkProofV1(
  proof: unknown,
  chunkCount: bigint,
): asserts proof is KaChunkProofV1 {
  assertChunkCount(chunkCount);
  if (!isPlainRecord(proof)) fail('proof-schema', 'chunk proof must be a plain JSON object');
  try {
    assertExactKeys(proof, ['chunkIndex', 'steps'], 'chunk proof');
  } catch (cause) {
    fail('proof-schema', 'chunk proof has an invalid field set', cause);
  }

  try {
    assertCanonicalDecimalU64(proof.chunkIndex, 'chunkIndex');
  } catch (cause) {
    fail('proof-chunk-index', 'chunkIndex must be a canonical DecimalU64V1', cause);
  }
  const chunkIndex = parseCanonicalDecimalU64(proof.chunkIndex, 'chunkIndex');
  if (chunkIndex >= chunkCount) {
    fail('proof-chunk-index', `chunkIndex must be less than chunkCount ${chunkCount}`);
  }
  if (!Array.isArray(proof.steps) || proof.steps.length > MAX_KA_CHUNK_PROOF_STEPS_V1) {
    fail(
      'proof-schema',
      `steps must be an array of at most ${MAX_KA_CHUNK_PROOF_STEPS_V1} entries`,
    );
  }
  assertClosedDenseArray(proof.steps, 'steps', 'proof-schema');

  let position = chunkIndex;
  let width = chunkCount;
  let stepIndex = 0;
  while (width > 1n) {
    if (stepIndex >= proof.steps.length) {
      fail('proof-topology', 'proof omits a required tree level');
    }
    const step = proof.steps[stepIndex];
    const expectedKind = position % 2n === 1n
      ? 'left'
      : position + 1n < width
        ? 'right'
        : 'odd';
    assertProofStep(step, expectedKind, stepIndex);
    position /= 2n;
    width = (width + 1n) / 2n;
    stepIndex += 1;
  }
  if (stepIndex !== proof.steps.length) {
    fail('proof-topology', 'proof contains steps after the tree root');
  }
}

/** Return the exact bounded RFC 8785 JCS proof string. */
export function canonicalizeKaChunkProofV1(
  proof: KaChunkProofV1,
  chunkCount: bigint,
): string {
  assertKaChunkProofV1(proof, chunkCount);
  return canonicalizeJson(proof as unknown as CanonicalJsonValue, {
    maxBytes: MAX_KA_CHUNK_PROOF_BYTES_V1,
    maxDepth: MAX_KA_CHUNK_PROOF_DEPTH_V1,
  });
}

/** Strictly decode one canonical proof using the descriptor-derived chunk count. */
export function parseCanonicalKaChunkProofV1(
  input: string | Uint8Array,
  chunkCount: bigint,
  options: StrictJsonParseOptions = {},
): KaChunkProofV1 {
  if (wireByteLength(input) > MAX_KA_CHUNK_PROOF_BYTES_V1) {
    fail(
      'proof-object-too-large',
      `chunk proof exceeds ${MAX_KA_CHUNK_PROOF_BYTES_V1} bytes`,
    );
  }
  const parsed = parseCanonicalJson(input, {
    ...options,
    maxBytes: Math.min(
      options.maxBytes ?? MAX_KA_CHUNK_PROOF_BYTES_V1,
      MAX_KA_CHUNK_PROOF_BYTES_V1,
    ),
    maxDepth: Math.min(
      options.maxDepth ?? MAX_KA_CHUNK_PROOF_DEPTH_V1,
      MAX_KA_CHUNK_PROOF_DEPTH_V1,
    ),
  });
  assertKaChunkProofV1(parsed, chunkCount);
  return parsed;
}

/** Build the one canonical proof for `chunkIndex` from a complete bounded bundle. */
export function buildKaChunkProofV1(
  bundleBytes: Uint8Array,
  chunkIndex: bigint,
): KaChunkProofV1 {
  return buildKaChunkProofsV1(bundleBytes, [chunkIndex])[0];
}

/**
 * Build one logical request's sorted unique proofs while hashing the bundle tree once.
 * This is the provider-side primitive used to avoid O(request indexes × bundle bytes).
 */
export function buildKaChunkProofsV1(
  bundleBytes: Uint8Array,
  chunkIndexes: readonly bigint[],
): readonly KaChunkProofV1[] {
  assertOwnedFixedUint8Array(bundleBytes, 'bundleBytes');
  const byteLength = BigInt(bundleBytes.byteLength);
  if (byteLength < MIN_KA_TRANSFER_BYTES_V1 || byteLength > MAX_KA_TRANSFER_BYTES_V1) {
    fail(
      'proof-chunk-byte-length',
      `bundle length must be ${MIN_KA_TRANSFER_BYTES_V1}-${MAX_KA_TRANSFER_BYTES_V1}`,
    );
  }
  const chunkCount = expectedChunkCount(byteLength);
  if (
    !Array.isArray(chunkIndexes)
    || chunkIndexes.length < 1
    || chunkIndexes.length > MAX_KA_CHUNK_PROOFS_PER_REQUEST_V1
  ) {
    fail(
      'proof-request-indexes',
      `chunkIndexes must contain 1..${MAX_KA_CHUNK_PROOFS_PER_REQUEST_V1} entries`,
    );
  }
  assertClosedDenseArray(chunkIndexes, 'chunkIndexes', 'proof-request-indexes');
  let previous = -1n;
  for (let requestIndex = 0; requestIndex < chunkIndexes.length; requestIndex += 1) {
    const chunkIndex = chunkIndexes[requestIndex];
    if (
      typeof chunkIndex !== 'bigint'
      || chunkIndex < 0n
      || chunkIndex >= chunkCount
      || chunkIndex <= previous
    ) {
      fail(
        'proof-request-indexes',
        `chunkIndexes must be strictly increasing unique values in 0..${chunkCount - 1n}`,
      );
    }
    previous = chunkIndex;
  }

  const chunkSize = Number(KA_TRANSFER_CHUNK_SIZE_BYTES_V1);
  let level: Digest32V1[] = [];
  for (let index = 0; index < Number(chunkCount); index += 1) {
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, bundleBytes.byteLength);
    level.push(computeKaChunkLeafDigestV1(BigInt(index), bundleBytes.subarray(start, end)));
  }

  const levels: Digest32V1[][] = [];
  while (level.length > 1) {
    levels.push(level);
    const parentLevel: Digest32V1[] = [];
    for (let index = 0; index < level.length; index += 2) {
      parentLevel.push(
        index + 1 < level.length
          ? combineNodeDigests(level[index], level[index + 1])
          : combineOddDigest(level[index]),
      );
    }
    level = parentLevel;
  }

  const proofs: KaChunkProofV1[] = [];
  for (let requestIndex = 0; requestIndex < chunkIndexes.length; requestIndex += 1) {
    const chunkIndex = chunkIndexes[requestIndex];
    const steps: KaChunkProofStepV1[] = [];
    let position = Number(chunkIndex);
    for (const proofLevel of levels) {
      if (position % 2 === 1) {
        steps.push({ kind: 'left', digest: proofLevel[position - 1] });
      } else if (position + 1 < proofLevel.length) {
        steps.push({ kind: 'right', digest: proofLevel[position + 1] });
      } else {
        steps.push({ kind: 'odd' });
      }
      position = Math.floor(position / 2);
    }
    const proof = {
      chunkIndex: chunkIndex.toString() as IndexV1,
      steps,
    };
    assertKaChunkProofV1(proof, chunkCount);
    proofs.push(proof);
  }
  return proofs;
}

/**
 * Verify one exact chunk against a structurally valid descriptor tuple. A malformed
 * proof throws a stable reason; a well-shaped proof for the wrong bytes/root also fails.
 */
export function assertValidKaChunkProofV1(
  proof: KaChunkProofV1,
  chunkBytes: Uint8Array,
  transferByteLength: bigint,
  expectedRoot: Digest32V1,
): void {
  assertOwnedFixedUint8Array(chunkBytes, 'chunkBytes');
  if (
    typeof transferByteLength !== 'bigint'
    || transferByteLength < MIN_KA_TRANSFER_BYTES_V1
    || transferByteLength > MAX_KA_TRANSFER_BYTES_V1
  ) {
    fail(
      'proof-chunk-byte-length',
      `transferByteLength must be ${MIN_KA_TRANSFER_BYTES_V1}-${MAX_KA_TRANSFER_BYTES_V1}`,
    );
  }
  try {
    assertCanonicalDigest(expectedRoot, 'chunkTreeRoot');
  } catch (cause) {
    fail('proof-schema', 'chunkTreeRoot must be a canonical Digest32V1', cause);
  }

  const chunkCount = expectedChunkCount(transferByteLength);
  assertKaChunkProofV1(proof, chunkCount);
  const chunkIndex = parseCanonicalDecimalU64(proof.chunkIndex, 'chunkIndex');
  const expectedLength = chunkIndex + 1n < chunkCount
    ? KA_TRANSFER_CHUNK_SIZE_BYTES_V1
    : transferByteLength - (chunkCount - 1n) * KA_TRANSFER_CHUNK_SIZE_BYTES_V1;
  if (BigInt(chunkBytes.byteLength) !== expectedLength) {
    fail(
      'proof-chunk-byte-length',
      `chunk ${chunkIndex} must contain exactly ${expectedLength} bytes`,
    );
  }

  let digest = computeKaChunkLeafDigestV1(chunkIndex, chunkBytes);
  for (let stepIndex = 0; stepIndex < proof.steps.length; stepIndex += 1) {
    const step = proof.steps[stepIndex];
    if (step.kind === 'left') digest = combineNodeDigests(step.digest, digest);
    else if (step.kind === 'right') digest = combineNodeDigests(digest, step.digest);
    else digest = combineOddDigest(digest);
  }
  if (digest !== expectedRoot) {
    fail(
      'proof-root-mismatch',
      "chunk proof does not produce the exact descriptor's chunkTreeRoot",
    );
  }
}

function assertProofStep(
  step: unknown,
  expectedKind: KaChunkProofStepV1['kind'],
  index: number,
): void {
  if (!isPlainRecord(step)) fail('proof-schema', `steps[${index}] must be a plain object`);
  try {
    assertExactKeys(
      step,
      expectedKind === 'odd' ? ['kind'] : ['digest', 'kind'],
      `steps[${index}]`,
    );
  } catch (cause) {
    fail('proof-schema', `steps[${index}] has an invalid field set`, cause);
  }
  if (step.kind !== expectedKind) {
    fail(
      'proof-topology',
      `steps[${index}] must be ${expectedKind} for this chunk position and tree width`,
    );
  }
  if (expectedKind !== 'odd') {
    try {
      assertCanonicalDigest(step.digest, `steps[${index}].digest`);
    } catch (cause) {
      fail('proof-schema', `steps[${index}].digest is not a canonical Digest32V1`, cause);
    }
  }
}

function assertChunkCount(chunkCount: bigint): void {
  if (
    typeof chunkCount !== 'bigint'
    || chunkCount < 1n
    || chunkCount > MAX_KA_TRANSFER_CHUNKS_V1
  ) {
    fail('proof-chunk-count', `chunkCount must be in 1..${MAX_KA_TRANSFER_CHUNKS_V1}`);
  }
}

function assertClosedDenseArray(
  value: readonly unknown[],
  label: string,
  code: KaChunkProofV1ErrorCode,
): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    fail(code, `${label} must use the ordinary Array prototype`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    fail(code, `${label} must not contain symbol properties`);
  }
  const expected = new Set(['length']);
  for (let index = 0; index < value.length; index += 1) expected.add(String(index));
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key as string))) {
    fail(code, `${label} must be a dense array without custom properties`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(code, `${label}[${index}] must be an enumerable data property`);
    }
  }
}

function expectedChunkCount(byteLength: bigint): bigint {
  const chunkCount = ((byteLength - 1n) / KA_TRANSFER_CHUNK_SIZE_BYTES_V1) + 1n;
  assertChunkCount(chunkCount);
  return chunkCount;
}

function combineNodeDigests(left: Digest32V1, right: Digest32V1): Digest32V1 {
  return digestToLowerHex(NODE_DOMAIN_BYTES, digestFromLowerHex(left), digestFromLowerHex(right));
}

function combineOddDigest(child: Digest32V1): Digest32V1 {
  return digestToLowerHex(ODD_DOMAIN_BYTES, digestFromLowerHex(child));
}

function digestFromLowerHex(digest: Digest32V1): Uint8Array {
  assertCanonicalDigest(digest);
  const bytes = new Uint8Array(DIGEST_BYTES);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(digest.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}

function digestToLowerHex(domain: Uint8Array, ...chunks: readonly Uint8Array[]): Digest32V1 {
  const hasher = sha256.create();
  hasher.update(domain);
  for (const chunk of chunks) hasher.update(chunk);
  const digest = hasher.digest();
  let result = '0x';
  for (const byte of digest) result += byte.toString(16).padStart(2, '0');
  assertCanonicalDigest(result);
  return result;
}

function assertOwnedFixedUint8Array(
  value: unknown,
  label: string,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be a Uint8Array`);
  if (!(value.buffer instanceof ArrayBuffer)) {
    throw new TypeError(`${label} must not use shared backing memory`);
  }
  if ((value.buffer as ArrayBuffer & { readonly resizable?: boolean }).resizable === true) {
    throw new TypeError(`${label} must not use resizable backing memory`);
  }
}

function wireByteLength(input: string | Uint8Array): number {
  if (typeof input !== 'string') return input.byteLength;
  if (input.length > MAX_KA_CHUNK_PROOF_BYTES_V1) {
    return MAX_KA_CHUNK_PROOF_BYTES_V1 + 1;
  }
  return UTF8.encode(input).byteLength;
}

function fail(
  code: KaChunkProofV1ErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new KaChunkProofV1Error(code, message, cause === undefined ? {} : { cause });
}
