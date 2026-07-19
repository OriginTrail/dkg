import {
  canonicalizeJson,
  parseCanonicalJson,
  type CanonicalJsonValue,
  type StrictJsonParseOptions,
} from './canonical-json.js';
import {
  assertAuthorCatalogBucketCountV1,
  assertAuthorCatalogScopeV1,
  computeAuthorCatalogScopeDigestV1,
  type AuthorCatalogScopeV1,
} from './author-catalog-codec.js';
import {
  AUTHOR_CATALOG_DIRECTORY_FANOUT_V1,
  MAX_AUTHOR_CATALOG_BUCKET_PAYLOAD_BYTES_V1,
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  MAX_AUTHOR_CATALOG_DIRECTORY_HEIGHT_V1,
  ZERO_DIGEST32_V1,
  assertAuthorCatalogHeadV1,
  computeAuthorCatalogDirectoryHeightV1,
  deriveAuthorCatalogScopeFromHeadV1,
  type AuthorCatalogHeadV1,
} from './author-catalog-objects.js';
import {
  assertSignedControlEnvelope,
  assertUnsignedControlEnvelope,
  canonicalizeSignedControlEnvelopeBytes,
  canonicalizeUnsignedControlEnvelopeBytes,
  computeControlObjectDigestHex,
  parseCanonicalSignedControlEnvelope,
  parseCanonicalUnsignedControlEnvelope,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from './sync-control-object.js';
import {
  MAX_DECIMAL_U64,
  assertCanonicalDigest,
  parseCanonicalDecimalU64,
  type ByteLengthV1,
  type CountV1,
  type DecimalU64V1,
  type Digest32V1,
} from './sync-wire-scalars.js';
import { assertExactKeys, isPlainRecord } from './sync-wire-objects.js';

export const AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1 =
  'AuthorCatalogDirectoryNodeV1' as const;
export const MAX_AUTHOR_CATALOG_DIRECTORY_ENTRIES_V1 = 256;
export const MAX_AUTHOR_CATALOG_DIRECTORY_PAYLOAD_BYTES_V1 = 256 * 1024;
export const MAX_AUTHOR_CATALOG_DIRECTORY_PATH_NODES_V1 = 8;

const UTF8 = new TextEncoder();

/** Canonical level-zero descriptor. Zero values denote the absence of a bucket object. */
export interface AuthorCatalogBucketDescriptorV1 {
  readonly bucketId: DecimalU64V1;
  readonly rowCount: CountV1;
  readonly byteLength: ByteLengthV1;
  readonly bucketDigest: Digest32V1;
}

/** Canonical higher-level descriptor for one immediately referenced child node. */
export interface AuthorCatalogChildDescriptorV1 {
  readonly firstBucketId: DecimalU64V1;
  readonly bucketSpan: CountV1;
  readonly rowCount: CountV1;
  readonly byteLength: ByteLengthV1;
  readonly childDigest: Digest32V1;
}

export type AuthorCatalogDirectoryEntryV1 =
  | AuthorCatalogBucketDescriptorV1
  | AuthorCatalogChildDescriptorV1;

/** Exact five-key directory-node payload; entry schema is selected by `level`. */
export interface AuthorCatalogDirectoryNodeV1 {
  readonly catalogScopeDigest: Digest32V1;
  readonly era: DecimalU64V1;
  readonly level: DecimalU64V1;
  readonly firstBucketId: DecimalU64V1;
  readonly entries: readonly AuthorCatalogDirectoryEntryV1[];
}

export type UnsignedAuthorCatalogDirectoryNodeEnvelopeV1 = UnsignedControlEnvelopeV1 & {
  readonly objectType: typeof AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1;
  readonly payload: AuthorCatalogDirectoryNodeV1;
};

export type SignedAuthorCatalogDirectoryNodeEnvelopeV1 = SignedControlEnvelopeV1 & {
  readonly objectType: typeof AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1;
  readonly payload: AuthorCatalogDirectoryNodeV1;
};

export type AuthorCatalogDirectoryErrorCode =
  | 'catalog-directory-schema'
  | 'catalog-directory-scalar'
  | 'catalog-directory-type'
  | 'catalog-directory-array'
  | 'catalog-directory-layout'
  | 'catalog-directory-descriptor'
  | 'catalog-directory-scope-mismatch'
  | 'catalog-directory-payload-too-large'
  | 'catalog-directory-path';

export class AuthorCatalogDirectoryError extends Error {
  constructor(
    readonly code: AuthorCatalogDirectoryErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'AuthorCatalogDirectoryError';
  }
}

/** Validate one canonical directory-node layout in the enclosing catalog's bucket domain. */
export function assertAuthorCatalogDirectoryNodeV1(
  node: unknown,
  bucketCount: CountV1,
): asserts node is AuthorCatalogDirectoryNodeV1 {
  assertAuthorCatalogDirectoryNodeStructureV1(node, bucketCount);
  canonicalizeDirectoryNodeAfterStructure(node);
}

/** Bind a structurally valid node to the exact scope carried by its enclosing head. */
export function assertAuthorCatalogDirectoryNodeScopeBindingV1(
  node: AuthorCatalogDirectoryNodeV1,
  scope: AuthorCatalogScopeV1,
): void {
  assertAuthorCatalogScopeV1(scope);
  assertAuthorCatalogDirectoryNodeV1(node, scope.bucketCount);
  if (node.catalogScopeDigest !== computeAuthorCatalogScopeDigestV1(scope)) {
    fail(
      'catalog-directory-scope-mismatch',
      'directory node catalogScopeDigest does not match the contextual catalog scope',
    );
  }
  if (node.era !== scope.era) {
    fail(
      'catalog-directory-scope-mismatch',
      'directory node era does not match the contextual catalog scope',
    );
  }
}

export function canonicalizeAuthorCatalogDirectoryNodePayloadBytesV1(
  node: AuthorCatalogDirectoryNodeV1,
  bucketCount: CountV1,
): Uint8Array {
  assertAuthorCatalogDirectoryNodeStructureV1(node, bucketCount);
  return UTF8.encode(canonicalizeDirectoryNodeAfterStructure(node));
}

export function canonicalizeAuthorCatalogDirectoryNodePayloadV1(
  node: AuthorCatalogDirectoryNodeV1,
  bucketCount: CountV1,
): string {
  assertAuthorCatalogDirectoryNodeStructureV1(node, bucketCount);
  return canonicalizeDirectoryNodeAfterStructure(node);
}

export function parseCanonicalAuthorCatalogDirectoryNodePayloadV1(
  input: string | Uint8Array,
  bucketCount: CountV1,
  options: StrictJsonParseOptions = {},
): AuthorCatalogDirectoryNodeV1 {
  rejectOversizedWireInput(
    input,
    MAX_AUTHOR_CATALOG_DIRECTORY_PAYLOAD_BYTES_V1,
    'author catalog directory payload',
  );
  const parsed = parseCanonicalJson(input, {
    ...options,
    maxBytes: Math.min(
      options.maxBytes ?? MAX_AUTHOR_CATALOG_DIRECTORY_PAYLOAD_BYTES_V1,
      MAX_AUTHOR_CATALOG_DIRECTORY_PAYLOAD_BYTES_V1,
    ),
    maxDepth: Math.min(options.maxDepth ?? 3, 3),
  });
  assertAuthorCatalogDirectoryNodeV1(parsed, bucketCount);
  return parsed;
}

export function assertUnsignedAuthorCatalogDirectoryNodeEnvelopeV1(
  envelope: UnsignedControlEnvelopeV1,
  bucketCount: CountV1,
): asserts envelope is UnsignedAuthorCatalogDirectoryNodeEnvelopeV1 {
  assertUnsignedControlEnvelope(envelope);
  assertEnvelopeObjectType(envelope.objectType);
  assertAuthorCatalogDirectoryNodeV1(envelope.payload, bucketCount);
}

export function assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(
  envelope: SignedControlEnvelopeV1,
  bucketCount: CountV1,
): asserts envelope is SignedAuthorCatalogDirectoryNodeEnvelopeV1 {
  assertSignedControlEnvelope(envelope);
  assertEnvelopeObjectType(envelope.objectType);
  assertAuthorCatalogDirectoryNodeV1(envelope.payload, bucketCount);
}

export function canonicalizeUnsignedAuthorCatalogDirectoryNodeEnvelopeBytesV1(
  envelope: UnsignedControlEnvelopeV1,
  bucketCount: CountV1,
): Uint8Array {
  assertUnsignedAuthorCatalogDirectoryNodeEnvelopeV1(envelope, bucketCount);
  return canonicalizeUnsignedControlEnvelopeBytes(envelope);
}

export function canonicalizeSignedAuthorCatalogDirectoryNodeEnvelopeBytesV1(
  envelope: SignedControlEnvelopeV1,
  bucketCount: CountV1,
): Uint8Array {
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(envelope, bucketCount);
  return canonicalizeSignedControlEnvelopeBytes(envelope);
}

export function computeAuthorCatalogDirectoryNodeObjectDigestV1(
  envelope: UnsignedControlEnvelopeV1,
  bucketCount: CountV1,
): Digest32V1 {
  assertUnsignedAuthorCatalogDirectoryNodeEnvelopeV1(envelope, bucketCount);
  const digest = computeControlObjectDigestHex(envelope);
  assertCanonicalDigest(digest, 'directory node objectDigest');
  return digest;
}

/** Parse the generic envelope first, then enforce the independent 256 KiB payload cap. */
export function parseCanonicalUnsignedAuthorCatalogDirectoryNodeEnvelopeV1(
  input: string | Uint8Array,
  bucketCount: CountV1,
  options: StrictJsonParseOptions = {},
): UnsignedAuthorCatalogDirectoryNodeEnvelopeV1 {
  const envelope = parseCanonicalUnsignedControlEnvelope(input, options);
  assertUnsignedAuthorCatalogDirectoryNodeEnvelopeV1(envelope, bucketCount);
  return envelope;
}

export function parseCanonicalSignedAuthorCatalogDirectoryNodeEnvelopeV1(
  input: string | Uint8Array,
  bucketCount: CountV1,
  options: StrictJsonParseOptions = {},
): SignedAuthorCatalogDirectoryNodeEnvelopeV1 {
  const envelope = parseCanonicalSignedControlEnvelope(input, options);
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(envelope, bucketCount);
  return envelope;
}

/**
 * Verify one selected root-to-leaf path under a structurally valid catalog head.
 *
 * This checks canonical object digests, topology, selected child indexes, immediate
 * child byte lengths, and selected-subtree row counts. It deliberately performs no
 * signature authority, history, full-directory closure, persistence, or RDF work.
 */
export function verifyAuthorCatalogDirectoryPathV1(
  head: AuthorCatalogHeadV1,
  path: unknown,
  selectedBucketId: DecimalU64V1,
): AuthorCatalogBucketDescriptorV1 {
  assertAuthorCatalogHeadV1(head);
  const scope = deriveAuthorCatalogScopeFromHeadV1(head);
  const bucketCount = BigInt(scope.bucketCount);
  const bucketId = assertDirectoryU64(selectedBucketId, 'selectedBucketId');
  if (bucketId >= bucketCount) {
    fail('catalog-directory-path', 'selectedBucketId must be less than bucketCount');
  }

  const expectedHeight = BigInt(head.directoryHeight);
  const expectedPathLength = Number(expectedHeight + 1n);
  assertDenseOrdinaryArray(
    path,
    'directory path',
    expectedPathLength,
    expectedPathLength,
    'catalog-directory-path',
  );
  if (path.length > MAX_AUTHOR_CATALOG_DIRECTORY_PATH_NODES_V1) {
    fail(
      'catalog-directory-path',
      `directory path must contain at most ${MAX_AUTHOR_CATALOG_DIRECTORY_PATH_NODES_V1} nodes`,
    );
  }

  const unvalidatedEnvelopes = path as SignedControlEnvelopeV1[];
  const envelopes: SignedAuthorCatalogDirectoryNodeEnvelopeV1[] = new Array(
    unvalidatedEnvelopes.length,
  );
  const seenDigests = new Set<string>();
  for (let pathIndex = 0; pathIndex < unvalidatedEnvelopes.length; pathIndex += 1) {
    const envelope = unvalidatedEnvelopes[pathIndex];
    assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(envelope, scope.bucketCount);
    assertAuthorCatalogDirectoryNodeScopeBindingV1(envelope.payload, scope);
    envelopes[pathIndex] = envelope;
    const expectedLevel = expectedHeight - BigInt(pathIndex);
    if (envelope.payload.level !== expectedLevel.toString()) {
      fail(
        'catalog-directory-path',
        `directory path node ${pathIndex} must have level ${expectedLevel}`,
      );
    }
    if (seenDigests.has(envelope.objectDigest)) {
      fail('catalog-directory-path', 'directory path must not repeat an object digest');
    }
    seenDigests.add(envelope.objectDigest);
  }

  const root = envelopes[0];
  if (root.objectDigest !== head.directoryRootDigest) {
    fail('catalog-directory-path', 'root objectDigest does not match directoryRootDigest');
  }
  if (root.payload.firstBucketId !== '0') {
    fail('catalog-directory-path', 'root directory node must start at bucket zero');
  }
  if (sumEntryRows(root.payload.entries) !== BigInt(head.totalRows)) {
    fail('catalog-directory-path', 'root rowCount sum does not match head totalRows');
  }

  for (let pathIndex = 0; pathIndex + 1 < envelopes.length; pathIndex += 1) {
    const current = envelopes[pathIndex].payload;
    const next = envelopes[pathIndex + 1];
    const level = BigInt(current.level);
    const currentFirst = BigInt(current.firstBucketId);
    const childWidth = directoryPower(level);
    if (bucketId < currentFirst) {
      fail('catalog-directory-path', 'selected bucket precedes the current node range');
    }
    const selectedIndex = (bucketId - currentFirst) / childWidth;
    if (selectedIndex >= BigInt(current.entries.length)) {
      fail('catalog-directory-path', 'selected bucket is outside the current node range');
    }
    const selected = current.entries[Number(selectedIndex)] as AuthorCatalogChildDescriptorV1;
    if (selected.childDigest !== next.objectDigest) {
      fail('catalog-directory-path', 'selected childDigest does not match the next path node');
    }
    if (selected.firstBucketId !== next.payload.firstBucketId) {
      fail('catalog-directory-path', 'selected child range does not match the next path node');
    }
    const nextPayloadBytes = canonicalizeAuthorCatalogDirectoryNodePayloadBytesV1(
      next.payload,
      scope.bucketCount,
    );
    if (BigInt(nextPayloadBytes.byteLength) !== BigInt(selected.byteLength)) {
      fail('catalog-directory-path', 'selected child byteLength does not match the next path node');
    }
    if (sumEntryRows(next.payload.entries) !== BigInt(selected.rowCount)) {
      fail('catalog-directory-path', 'selected child rowCount does not match the next path node');
    }
  }

  const leaf = envelopes[envelopes.length - 1].payload;
  const leafFirst = BigInt(leaf.firstBucketId);
  if (bucketId < leafFirst) {
    fail('catalog-directory-path', 'selected bucket precedes the leaf node range');
  }
  const selectedLeafIndex = bucketId - leafFirst;
  if (selectedLeafIndex >= BigInt(leaf.entries.length)) {
    fail('catalog-directory-path', 'selected bucket is outside the leaf node range');
  }
  const descriptor = leaf.entries[Number(selectedLeafIndex)] as AuthorCatalogBucketDescriptorV1;
  if (descriptor.bucketId !== selectedBucketId) {
    fail('catalog-directory-path', 'selected leaf descriptor does not match selectedBucketId');
  }
  return descriptor;
}

function assertAuthorCatalogDirectoryNodeStructureV1(
  node: unknown,
  bucketCountValue: CountV1,
): asserts node is AuthorCatalogDirectoryNodeV1 {
  assertAuthorCatalogBucketCountV1(bucketCountValue);
  const bucketCount = BigInt(bucketCountValue);
  if (!isPlainRecord(node)) {
    fail('catalog-directory-schema', 'directory node must be a plain JSON object');
  }
  assertClosedKeys(node, [
    'catalogScopeDigest',
    'entries',
    'era',
    'firstBucketId',
    'level',
  ], 'author catalog directory node');
  assertDirectoryScalar(() => assertCanonicalDigest(node.catalogScopeDigest, 'catalogScopeDigest'));
  assertDirectoryU64(node.era, 'era');
  const level = assertDirectoryU64(node.level, 'level');
  const maximumLevel = BigInt(computeAuthorCatalogDirectoryHeightV1(bucketCountValue));
  if (level > MAX_AUTHOR_CATALOG_DIRECTORY_HEIGHT_V1 || level > maximumLevel) {
    fail(
      'catalog-directory-layout',
      `level must be in 0..${maximumLevel} for bucketCount ${bucketCountValue}`,
    );
  }
  const firstBucketId = assertDirectoryU64(node.firstBucketId, 'firstBucketId');
  const nodeWidth = directoryPower(level + 1n);
  if (
    firstBucketId >= bucketCount
    || firstBucketId % nodeWidth !== 0n
  ) {
    fail(
      'catalog-directory-layout',
      `firstBucketId must identify a canonical level-${level} node`,
    );
  }

  const remainingBuckets = bucketCount - firstBucketId;
  const coverage = remainingBuckets < nodeWidth ? remainingBuckets : nodeWidth;
  const entryWidth = directoryPower(level);
  const expectedEntries = Number((coverage + entryWidth - 1n) / entryWidth);
  assertDenseOrdinaryArray(
    node.entries,
    'directory entries',
    expectedEntries,
    expectedEntries,
    'catalog-directory-array',
  );
  if (node.entries.length > MAX_AUTHOR_CATALOG_DIRECTORY_ENTRIES_V1) {
    fail(
      'catalog-directory-array',
      `directory entries must contain at most ${MAX_AUTHOR_CATALOG_DIRECTORY_ENTRIES_V1} values`,
    );
  }

  let rowCountSum = 0n;
  for (let entryIndex = 0; entryIndex < node.entries.length; entryIndex += 1) {
    const entry = node.entries[entryIndex];
    const expectedFirst = firstBucketId + BigInt(entryIndex) * entryWidth;
    const expectedSpan = bucketCount - expectedFirst < entryWidth
      ? bucketCount - expectedFirst
      : entryWidth;
    const rowCount = level === 0n
      ? assertBucketDescriptor(entry, expectedFirst, entryIndex)
      : assertChildDescriptor(entry, expectedFirst, expectedSpan, entryIndex);
    rowCountSum += rowCount;
    if (rowCountSum > MAX_DECIMAL_U64) {
      fail('catalog-directory-descriptor', 'directory rowCount sum exceeds u64');
    }
  }
}

function assertBucketDescriptor(
  entry: unknown,
  expectedBucketId: bigint,
  index: number,
): bigint {
  if (!isPlainRecord(entry)) {
    fail('catalog-directory-descriptor', `entries[${index}] must be a plain bucket descriptor`);
  }
  assertClosedKeys(entry, [
    'bucketDigest',
    'bucketId',
    'byteLength',
    'rowCount',
  ], `entries[${index}]`);
  const bucketId = assertDirectoryU64(entry.bucketId, `entries[${index}].bucketId`);
  if (bucketId !== expectedBucketId) {
    fail('catalog-directory-layout', `entries[${index}].bucketId is not consecutive`);
  }
  const rowCount = assertDirectoryU64(entry.rowCount, `entries[${index}].rowCount`);
  const byteLength = assertDirectoryU64(entry.byteLength, `entries[${index}].byteLength`);
  assertDirectoryScalar(() => assertCanonicalDigest(
    entry.bucketDigest,
    `entries[${index}].bucketDigest`,
  ));

  if (rowCount === 0n) {
    if (byteLength !== 0n || entry.bucketDigest !== ZERO_DIGEST32_V1) {
      fail(
        'catalog-directory-descriptor',
        `entries[${index}] must use the canonical empty bucket descriptor`,
      );
    }
    return rowCount;
  }
  if (
    rowCount > BigInt(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1)
    || byteLength < 1n
    || byteLength > BigInt(MAX_AUTHOR_CATALOG_BUCKET_PAYLOAD_BYTES_V1)
    || entry.bucketDigest === ZERO_DIGEST32_V1
  ) {
    fail(
      'catalog-directory-descriptor',
      `entries[${index}] is outside the non-empty bucket bounds`,
    );
  }
  return rowCount;
}

function assertChildDescriptor(
  entry: unknown,
  expectedFirstBucketId: bigint,
  expectedBucketSpan: bigint,
  index: number,
): bigint {
  if (!isPlainRecord(entry)) {
    fail('catalog-directory-descriptor', `entries[${index}] must be a plain child descriptor`);
  }
  assertClosedKeys(entry, [
    'bucketSpan',
    'byteLength',
    'childDigest',
    'firstBucketId',
    'rowCount',
  ], `entries[${index}]`);
  const firstBucketId = assertDirectoryU64(
    entry.firstBucketId,
    `entries[${index}].firstBucketId`,
  );
  const bucketSpan = assertDirectoryU64(entry.bucketSpan, `entries[${index}].bucketSpan`);
  if (firstBucketId !== expectedFirstBucketId || bucketSpan !== expectedBucketSpan) {
    fail('catalog-directory-layout', `entries[${index}] has a non-canonical child range`);
  }
  const rowCount = assertDirectoryU64(entry.rowCount, `entries[${index}].rowCount`);
  const maximumRows = expectedBucketSpan * BigInt(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1);
  if (rowCount > maximumRows) {
    fail('catalog-directory-descriptor', `entries[${index}].rowCount exceeds its bucket span`);
  }
  const byteLength = assertDirectoryU64(entry.byteLength, `entries[${index}].byteLength`);
  if (byteLength < 1n || byteLength > BigInt(MAX_AUTHOR_CATALOG_DIRECTORY_PAYLOAD_BYTES_V1)) {
    fail(
      'catalog-directory-descriptor',
      `entries[${index}].byteLength is outside the directory payload bounds`,
    );
  }
  assertDirectoryScalar(() => assertCanonicalDigest(
    entry.childDigest,
    `entries[${index}].childDigest`,
  ));
  if (entry.childDigest === ZERO_DIGEST32_V1) {
    fail('catalog-directory-descriptor', `entries[${index}].childDigest must be nonzero`);
  }
  return rowCount;
}

function assertDenseOrdinaryArray(
  value: unknown,
  label: string,
  minimumLength: number,
  maximumLength: number,
  code: AuthorCatalogDirectoryErrorCode,
): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(code, `${label} must be an ordinary Array`);
  }
  if (value.length < minimumLength || value.length > maximumLength) {
    fail(code, `${label} must contain exactly ${minimumLength}..${maximumLength} entries`);
  }
  const keys = Reflect.ownKeys(value);
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    if (typeof keys[keyIndex] !== 'string') {
      fail(code, `${label} must not contain symbol properties`);
    }
  }
  if (keys.length !== value.length + 1) {
    fail(code, `${label} must be dense and contain no custom properties`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')) {
    fail(code, `${label} length must be an ordinary data property`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(code, `${label}[${index}] must be an enumerable data property`);
    }
  }
}

function canonicalizeDirectoryNodeAfterStructure(node: AuthorCatalogDirectoryNodeV1): string {
  try {
    return canonicalizeJson(node as unknown as CanonicalJsonValue, {
      maxBytes: MAX_AUTHOR_CATALOG_DIRECTORY_PAYLOAD_BYTES_V1,
      maxDepth: 3,
    });
  } catch (cause) {
    fail(
      'catalog-directory-payload-too-large',
      `directory payload exceeds ${MAX_AUTHOR_CATALOG_DIRECTORY_PAYLOAD_BYTES_V1} bytes or depth`,
      cause,
    );
  }
}

function sumEntryRows(entries: readonly AuthorCatalogDirectoryEntryV1[]): bigint {
  let total = 0n;
  for (let index = 0; index < entries.length; index += 1) {
    total += BigInt(entries[index].rowCount);
    if (total > MAX_DECIMAL_U64) {
      fail('catalog-directory-descriptor', 'directory rowCount sum exceeds u64');
    }
  }
  return total;
}

function directoryPower(exponent: bigint): bigint {
  let value = 1n;
  for (let index = 0n; index < exponent; index += 1n) {
    value *= AUTHOR_CATALOG_DIRECTORY_FANOUT_V1;
  }
  return value;
}

function assertEnvelopeObjectType(actual: string): void {
  if (actual !== AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1) {
    fail(
      'catalog-directory-type',
      `objectType must be exactly ${AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1}`,
    );
  }
}

function assertClosedKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  try {
    assertExactKeys(record, keys, label);
  } catch (cause) {
    fail('catalog-directory-schema', `${label} has an invalid field set`, cause);
  }
}

function assertDirectoryScalar(operation: () => void): void {
  try {
    operation();
  } catch (cause) {
    fail('catalog-directory-scalar', 'directory scalar is not canonical', cause);
  }
}

function assertDirectoryU64(value: unknown, label: string): bigint {
  try {
    return parseCanonicalDecimalU64(value, label);
  } catch (cause) {
    fail('catalog-directory-scalar', `${label} is not a canonical DecimalU64V1`, cause);
  }
}

function rejectOversizedWireInput(
  input: string | Uint8Array,
  maxBytes: number,
  label: string,
): void {
  if (typeof input !== 'string') {
    if (input.byteLength > maxBytes) {
      fail('catalog-directory-payload-too-large', `${label} exceeds ${maxBytes} bytes`);
    }
    return;
  }
  if (input.length > maxBytes || UTF8.encode(input).byteLength > maxBytes) {
    fail('catalog-directory-payload-too-large', `${label} exceeds ${maxBytes} bytes`);
  }
}

function fail(
  code: AuthorCatalogDirectoryErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new AuthorCatalogDirectoryError(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
