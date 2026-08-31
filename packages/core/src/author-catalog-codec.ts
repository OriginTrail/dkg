import { sha256 } from '@noble/hashes/sha2.js';

import {
  canonicalizeJson,
  parseCanonicalJson,
  type CanonicalJsonValue,
  type StrictJsonParseOptions,
} from './canonical-json.js';
import {
  KA_TRANSFER_PROJECTION_V1,
  assertKaTransferDescriptorV1,
  type KaTransferDescriptorV1,
} from './ka-transfer-descriptor.js';
import {
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertCanonicalKaId,
  parseCanonicalDecimalU64,
  parseCanonicalDecimalU256,
  type CountV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type KaIdV1,
} from './sync-wire-scalars.js';
import {
  MAX_NETWORK_ID_BYTES_V1,
  assertNetworkIdV1 as assertSharedNetworkIdV1,
  type NetworkIdV1,
} from './sync-wire-identifiers.js';
import {
  assertExactKeys,
  isPlainRecord,
  snapshotSelectedDataRecord,
} from './sync-wire-objects.js';
import {
  AUTHOR_LANE_SCOPE_KEYS_V1,
  MAX_AUTHOR_LANE_IDENTIFIER_BYTES_V1,
  AuthorLaneScopeErrorV1,
  assertAuthorLaneContextGraphIdV1,
  assertAuthorLaneScopeFieldsV1 as assertSharedAuthorLaneScopeFieldsV1,
  assertAuthorLaneScopeV1 as assertSharedAuthorLaneScopeV1,
  assertAuthorLaneSubGraphNameV1,
  snapshotAuthorLaneScopeV1 as snapshotSharedAuthorLaneScopeV1,
  type AuthorLaneScopeV1,
  type CatalogLaneV1,
  type ContextGraphIdV1,
  type SubGraphNameV1,
} from './author-lane-scope-v1.js';
import { encodeCanonicalIriComponentV1 } from './canonical-iri-component-v1.js';

declare const ASSERTION_COORDINATE_V1_BRAND: unique symbol;
declare const CATALOG_ASSERTION_SCOPE_V1_BRAND: unique symbol;
declare const CATALOG_ASSERTION_SUBJECT_V1_BRAND: unique symbol;

export type { NetworkIdV1 } from './sync-wire-identifiers.js';
export {
  AUTHOR_LANE_SCOPE_KEYS_V1,
  type AuthorLaneScopeV1,
  type CatalogLaneV1,
  type ContextGraphIdV1,
  type SubGraphNameV1,
} from './author-lane-scope-v1.js';
export type AssertionCoordinateV1 = string & {
  readonly [ASSERTION_COORDINATE_V1_BRAND]: true;
};
export type CatalogAssertionScopeV1 = string & {
  readonly [CATALOG_ASSERTION_SCOPE_V1_BRAND]: true;
};
export type CatalogAssertionSubjectV1 = string & {
  readonly [CATALOG_ASSERTION_SUBJECT_V1_BRAND]: true;
};

export const AUTHOR_CATALOG_SCOPE_DIGEST_DOMAIN_V1 =
  'dkg-author-catalog-scope-v1\n' as const;
export const AUTHOR_CATALOG_KEY_DIGEST_DOMAIN_V1 =
  'dkg-author-catalog-key-v1\n' as const;
export const AUTHOR_CATALOG_ROW_DIGEST_DOMAIN_V1 =
  'dkg-author-catalog-row-v1\n' as const;

export const MAX_AUTHOR_CATALOG_NETWORK_ID_BYTES_V1 = MAX_NETWORK_ID_BYTES_V1;
export const MAX_AUTHOR_CATALOG_IDENTIFIER_BYTES_V1 = MAX_AUTHOR_LANE_IDENTIFIER_BYTES_V1;
export const MAX_AUTHOR_CATALOG_SCOPE_BYTES_V1 = 2048;
export const MAX_AUTHOR_CATALOG_ROW_BYTES_V1 = 2048;
export const MAX_AUTHOR_CATALOG_ROW_DIGEST_INPUT_BYTES_V1 = 4096;
export const MAX_AUTHOR_CATALOG_BUCKET_COUNT_V1 = 9_223_372_036_854_775_808n;
export const PACKED_KA_NUMBER_BITS_V1 = 96n;

const CATALOG_IDENTIFIER_ASCII_FORBIDDEN = new Set([
  '<',
  '>',
  '"',
  '{',
  '}',
  '|',
  '^',
  '`',
  '\\',
]);
const UTF8 = new TextEncoder();
const SCOPE_DOMAIN_BYTES = UTF8.encode(AUTHOR_CATALOG_SCOPE_DIGEST_DOMAIN_V1);
const KEY_DOMAIN_BYTES = UTF8.encode(AUTHOR_CATALOG_KEY_DIGEST_DOMAIN_V1);
const ROW_DOMAIN_BYTES = UTF8.encode(AUTHOR_CATALOG_ROW_DIGEST_DOMAIN_V1);

/** Exact nine-key scope committed by every author-catalog era. */
export interface AuthorCatalogScopeV1 extends AuthorLaneScopeV1 {
  readonly bucketCount: CountV1;
}

/** Exact seven-key live author-catalog row. */
export interface AuthorCatalogRowV1 {
  readonly kaId: KaIdV1;
  readonly assertionCoordinate: AssertionCoordinateV1;
  readonly assertionVersion: DecimalU64V1;
  readonly projectionId: typeof KA_TRANSFER_PROJECTION_V1;
  readonly projectionDigest: Digest32V1;
  readonly sealDigest: Digest32V1;
  readonly transfer: KaTransferDescriptorV1;
}

export type AuthorCatalogCodecErrorCode =
  | 'catalog-schema'
  | 'catalog-identifier'
  | 'catalog-scalar'
  | 'catalog-governance-tuple'
  | 'catalog-bucket-count'
  | 'catalog-transfer-mismatch'
  | 'catalog-packed-author-mismatch'
  | 'object-too-large';

export class AuthorCatalogCodecError extends Error {
  constructor(
    readonly code: AuthorCatalogCodecErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'AuthorCatalogCodecError';
  }
}

/** Catalog-compatible public wrapper around the neutral percent encoder. */
export function iriComponentV1(value: string): string {
  return encodeCanonicalIriComponentV1(
    assertNfcUtf8Identifier(
      value,
      'IRI component',
      MAX_AUTHOR_CATALOG_IDENTIFIER_BYTES_V1,
    ),
  );
}

export function assertNetworkIdV1(
  value: unknown,
  label = 'networkId',
): asserts value is NetworkIdV1 {
  try {
    assertSharedNetworkIdV1(value, label);
  } catch (cause) {
    const message = cause instanceof Error
      ? cause.message
      : `${label} is not a canonical networkId`;
    fail('catalog-identifier', message, cause);
  }
}

export function assertContextGraphIdV1(
  value: unknown,
  label = 'contextGraphId',
): asserts value is ContextGraphIdV1 {
  adaptAuthorLane(() => assertAuthorLaneContextGraphIdV1(value, label));
}

export function assertSubGraphNameV1(
  value: unknown,
  label = 'subGraphName',
): asserts value is SubGraphNameV1 {
  adaptAuthorLane(() => assertAuthorLaneSubGraphNameV1(value, label));
}

export function assertAssertionCoordinateV1(
  value: unknown,
  label = 'assertionCoordinate',
): asserts value is AssertionCoordinateV1 {
  assertCatalogLaneIdentifier(value, label);
}

/** Exact RFC-64 forbidden-code-point predicate, intentionally permitting U+200C. */
export function isCatalogForbiddenCodePointV1(codePoint: number): boolean {
  return (
    (codePoint >= 0x0000 && codePoint <= 0x001f)
    || (codePoint >= 0x007f && codePoint <= 0x009f)
    || codePoint === 0x00a0
    || codePoint === 0x1680
    || (codePoint >= 0x2000 && codePoint <= 0x200b)
    || codePoint === 0x2028
    || codePoint === 0x2029
    || codePoint === 0x202f
    || codePoint === 0x205f
    || codePoint === 0x3000
    || codePoint === 0xfeff
  );
}

/** Build the prefix-free root/subgraph assertion scope used by catalog-v1 seals. */
export function buildCatalogAssertionScopeV1(lane: CatalogLaneV1): CatalogAssertionScopeV1 {
  const snapshot = snapshotCatalogLaneV1(lane);
  return formatCatalogAssertionScopeV1(snapshot);
}

function formatCatalogAssertionScopeV1(
  snapshot: Readonly<CatalogLaneV1>,
): CatalogAssertionScopeV1 {
  const context = encodeCanonicalIriComponentV1(snapshot.contextGraphId);
  const result = snapshot.subGraphName === null
    ? `v1/root/${context}`
    : `v1/subgraph/${context}/${encodeCanonicalIriComponentV1(snapshot.subGraphName)}`;
  return result as CatalogAssertionScopeV1;
}

/** Build the exact graph-scoped author-seal subject for one catalog row. */
export function buildCatalogAssertionSubjectV1(
  lane: CatalogLaneV1,
  authorAddress: EvmAddressV1,
  assertionCoordinate: AssertionCoordinateV1,
): CatalogAssertionSubjectV1 {
  const snapshot = snapshotCatalogLaneV1(lane);
  assertCatalogScalar(() => assertCanonicalEvmAddress(authorAddress, 'authorAddress'));
  assertAssertionCoordinateV1(assertionCoordinate);
  return (
    `did:dkg:context-graph:${formatCatalogAssertionScopeV1(snapshot)}`
    + `/assertion/${authorAddress}/${encodeCanonicalIriComponentV1(assertionCoordinate)}`
  ) as CatalogAssertionSubjectV1;
}

/** Validate the complete in-memory catalog scope without signing or authority checks. */
export function assertAuthorCatalogScopeV1(
  scope: unknown,
): asserts scope is AuthorCatalogScopeV1 {
  if (!isPlainRecord(scope)) {
    fail('catalog-schema', 'author catalog scope must be a plain JSON object');
  }
  assertClosedKeys(scope, [
    ...AUTHOR_LANE_SCOPE_KEYS_V1,
    'bucketCount',
  ], 'author catalog scope');

  adaptAuthorLane(() => assertSharedAuthorLaneScopeFieldsV1(scope));
  assertAuthorCatalogBucketCountV1(scope.bucketCount);
}

/** Validate the exact shared author-lane scope used by catalog and SWM commitments. */
export function assertAuthorLaneScopeV1(
  scope: unknown,
): asserts scope is AuthorLaneScopeV1 {
  adaptAuthorLane(() => assertSharedAuthorLaneScopeV1(scope));
}

/** Copy a validated structural superset into one exact immutable author-lane scope. */
export function snapshotAuthorLaneScopeV1(scope: AuthorLaneScopeV1): AuthorLaneScopeV1 {
  return adaptAuthorLane(() => snapshotSharedAuthorLaneScopeV1(scope));
}

export function canonicalizeAuthorCatalogScopeV1(scope: AuthorCatalogScopeV1): string {
  assertAuthorCatalogScopeV1(scope);
  return canonicalizeJson(scope as unknown as CanonicalJsonValue, {
    maxBytes: MAX_AUTHOR_CATALOG_SCOPE_BYTES_V1,
    maxDepth: 1,
  });
}

export function parseCanonicalAuthorCatalogScopeV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): AuthorCatalogScopeV1 {
  rejectOversizedWireInput(input, MAX_AUTHOR_CATALOG_SCOPE_BYTES_V1, 'author catalog scope');
  const parsed = parseCanonicalJson(input, {
    ...options,
    maxBytes: Math.min(
      options.maxBytes ?? MAX_AUTHOR_CATALOG_SCOPE_BYTES_V1,
      MAX_AUTHOR_CATALOG_SCOPE_BYTES_V1,
    ),
    maxDepth: Math.min(options.maxDepth ?? 1, 1),
  });
  assertAuthorCatalogScopeV1(parsed);
  return parsed;
}

export function computeAuthorCatalogScopeDigestV1(
  scope: AuthorCatalogScopeV1,
): Digest32V1 {
  return digestWithDomain(
    SCOPE_DOMAIN_BYTES,
    UTF8.encode(canonicalizeAuthorCatalogScopeV1(scope)),
  );
}

export function computeAuthorCatalogKeyDigestV1(kaId: KaIdV1): Digest32V1 {
  assertCatalogScalar(() => assertCanonicalKaId(kaId, 'kaId'));
  const canonical = canonicalizeJson({ kaId } as CanonicalJsonValue, {
    maxBytes: 128,
    maxDepth: 1,
  });
  return digestWithDomain(KEY_DOMAIN_BYTES, UTF8.encode(canonical));
}

/** Compare canonical u256 KA identifiers by mathematical value, never lexically. */
export function compareAuthorCatalogKaIdsV1(left: KaIdV1, right: KaIdV1): -1 | 0 | 1 {
  const leftValue = parseCatalogU256(left, 'left kaId');
  const rightValue = parseCatalogU256(right, 'right kaId');
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

export function assertAuthorCatalogBucketCountV1(
  value: unknown,
  label = 'bucketCount',
): asserts value is CountV1 {
  const count = assertCatalogU64(value, label);
  if (
    count < 1n
    || count > MAX_AUTHOR_CATALOG_BUCKET_COUNT_V1
    || (count & (count - 1n)) !== 0n
  ) {
    fail(
      'catalog-bucket-count',
      `${label} must be a power of two in 1..${MAX_AUTHOR_CATALOG_BUCKET_COUNT_V1}`,
    );
  }
}

/** Map a key digest to the unsigned integer formed by its first log2(bucketCount) bits. */
export function catalogKeyDigestToBucketIdV1(
  catalogKeyDigest: Digest32V1,
  bucketCount: CountV1,
): DecimalU64V1 {
  assertCatalogScalar(() => assertCanonicalDigest(catalogKeyDigest, 'catalogKeyDigest'));
  assertAuthorCatalogBucketCountV1(bucketCount);
  const count = BigInt(bucketCount);
  if (count === 1n) return '0' as DecimalU64V1;

  let prefixBits = 0n;
  for (let remaining = count; remaining > 1n; remaining >>= 1n) prefixBits += 1n;
  const bucketId = BigInt(catalogKeyDigest) >> (256n - prefixBits);
  const result = bucketId.toString();
  parseCanonicalDecimalU64(result, 'bucketId');
  return result as DecimalU64V1;
}

export function catalogKeyToBucketIdV1(
  kaId: KaIdV1,
  bucketCount: CountV1,
): DecimalU64V1 {
  return catalogKeyDigestToBucketIdV1(
    computeAuthorCatalogKeyDigestV1(kaId),
    bucketCount,
  );
}

/** Validate the complete in-memory row, including transfer/row projection equality. */
export function assertAuthorCatalogRowV1(
  row: unknown,
): asserts row is AuthorCatalogRowV1 {
  if (!isPlainRecord(row)) {
    fail('catalog-schema', 'author catalog row must be a plain JSON object');
  }
  assertClosedKeys(row, [
    'assertionCoordinate',
    'assertionVersion',
    'kaId',
    'projectionDigest',
    'projectionId',
    'sealDigest',
    'transfer',
  ], 'author catalog row');

  assertCatalogScalar(() => assertCanonicalKaId(row.kaId, 'kaId'));
  assertAssertionCoordinateV1(row.assertionCoordinate);
  assertCatalogPositiveU64(row.assertionVersion, 'assertionVersion');
  if (row.projectionId !== KA_TRANSFER_PROJECTION_V1) {
    fail('catalog-schema', `projectionId must be ${KA_TRANSFER_PROJECTION_V1}`);
  }
  assertCatalogScalar(() => assertCanonicalDigest(row.projectionDigest, 'projectionDigest'));
  assertCatalogScalar(() => assertCanonicalDigest(row.sealDigest, 'sealDigest'));

  try {
    assertKaTransferDescriptorV1(row.transfer);
  } catch (cause) {
    fail('catalog-schema', 'transfer is not a structurally valid KaTransferDescriptorV1', cause);
  }
  if (
    row.transfer.projectionId !== row.projectionId
    || row.transfer.projectionDigest !== row.projectionDigest
  ) {
    fail(
      'catalog-transfer-mismatch',
      'transfer projectionId and projectionDigest must equal the row values',
    );
  }
}

export function canonicalizeAuthorCatalogRowV1(row: AuthorCatalogRowV1): string {
  assertAuthorCatalogRowV1(row);
  return canonicalizeJson(row as unknown as CanonicalJsonValue, {
    maxBytes: MAX_AUTHOR_CATALOG_ROW_BYTES_V1,
    maxDepth: 2,
  });
}

export function parseCanonicalAuthorCatalogRowV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): AuthorCatalogRowV1 {
  rejectOversizedWireInput(input, MAX_AUTHOR_CATALOG_ROW_BYTES_V1, 'author catalog row');
  const parsed = parseCanonicalJson(input, {
    ...options,
    maxBytes: Math.min(
      options.maxBytes ?? MAX_AUTHOR_CATALOG_ROW_BYTES_V1,
      MAX_AUTHOR_CATALOG_ROW_BYTES_V1,
    ),
    maxDepth: Math.min(options.maxDepth ?? 2, 2),
  });
  assertAuthorCatalogRowV1(parsed);
  return parsed;
}

export function computeAuthorCatalogRowDigestV1(
  catalogScopeDigest: Digest32V1,
  row: AuthorCatalogRowV1,
): Digest32V1 {
  assertCatalogScalar(() => assertCanonicalDigest(catalogScopeDigest, 'catalogScopeDigest'));
  assertAuthorCatalogRowV1(row);
  const canonical = canonicalizeJson(
    { catalogScopeDigest, row } as unknown as CanonicalJsonValue,
    { maxBytes: MAX_AUTHOR_CATALOG_ROW_DIGEST_INPUT_BYTES_V1, maxDepth: 3 },
  );
  return digestWithDomain(ROW_DOMAIN_BYTES, UTF8.encode(canonical));
}

/**
 * Check the structural portion of Option-1 identity available without parsing a
 * seal/UAL: the high 160 bits of the packed u256 KA id must equal the scope author.
 */
export function assertPackedKaIdAuthorBindingV1(
  kaId: KaIdV1,
  authorAddress: EvmAddressV1,
): void {
  const packedKaId = parseCatalogU256(kaId, 'kaId');
  assertCatalogScalar(() => assertCanonicalEvmAddress(authorAddress, 'authorAddress'));
  const packedAuthor = packedKaId >> PACKED_KA_NUMBER_BITS_V1;
  if (packedAuthor !== BigInt(authorAddress)) {
    fail(
      'catalog-packed-author-mismatch',
      'the high 160 bits of kaId must equal authorAddress',
    );
  }
}

/** Validate all structural row/scope bindings available before RDF seal admission. */
export function assertAuthorCatalogRowScopeBindingV1(
  row: AuthorCatalogRowV1,
  scope: AuthorCatalogScopeV1,
): void {
  assertAuthorCatalogRowV1(row);
  assertAuthorCatalogScopeV1(scope);
  assertPackedKaIdAuthorBindingV1(row.kaId, scope.authorAddress);
}

function snapshotCatalogLaneV1(lane: unknown): Readonly<CatalogLaneV1> {
  let snapshot: ReturnType<typeof snapshotSelectedDataRecord<
    readonly ['contextGraphId', 'subGraphName']
  >>;
  try {
    snapshot = snapshotSelectedDataRecord(
      lane,
      ['contextGraphId', 'subGraphName'] as const,
      'catalog lane',
    );
  } catch (cause) {
    fail('catalog-schema', 'catalog lane must expose enumerable data properties', cause);
  }
  const { contextGraphId, subGraphName } = snapshot;
  assertContextGraphIdV1(contextGraphId);
  if (subGraphName !== null) assertSubGraphNameV1(subGraphName);
  return Object.freeze({ contextGraphId, subGraphName });
}

function assertCatalogLaneIdentifier(value: unknown, label: string): string {
  const identifier = assertNfcUtf8Identifier(
    value,
    label,
    MAX_AUTHOR_CATALOG_IDENTIFIER_BYTES_V1,
  );
  for (const character of identifier) {
    const codePoint = character.codePointAt(0) as number;
    if (
      character === '/'
      || CATALOG_IDENTIFIER_ASCII_FORBIDDEN.has(character)
      || isCatalogForbiddenCodePointV1(codePoint)
    ) {
      fail('catalog-identifier', `${label} contains a forbidden character or code point`);
    }
  }
  return identifier;
}

function assertNfcUtf8Identifier(
  value: unknown,
  label: string,
  maxBytes: number,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('catalog-identifier', `${label} must be a non-empty string`);
  }
  // UTF-8 byte length is never less than UTF-16 code-unit length. Reject a
  // hostile oversized input before normalization or encoding allocates a copy.
  if (value.length > maxBytes) {
    fail('catalog-identifier', `${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
  assertWellFormedUnicode(value, label);
  if (value.normalize('NFC') !== value) {
    fail('catalog-identifier', `${label} must already be NFC-normalized`);
  }
  if (UTF8.encode(value).byteLength > maxBytes) {
    fail('catalog-identifier', `${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail('catalog-identifier', `${label} contains an unpaired UTF-16 surrogate`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail('catalog-identifier', `${label} contains an unpaired UTF-16 surrogate`);
    }
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
    fail('catalog-schema', `${label} has an invalid field set`, cause);
  }
}

function adaptAuthorLane<T>(operation: () => T): T {
  try {
    return operation();
  } catch (cause) {
    if (!(cause instanceof AuthorLaneScopeErrorV1)) throw cause;
    const code: AuthorCatalogCodecErrorCode = cause.code === 'author-lane-schema'
      ? 'catalog-schema'
      : cause.code === 'author-lane-identifier'
        ? 'catalog-identifier'
        : cause.code === 'author-lane-governance-tuple'
          ? 'catalog-governance-tuple'
          : 'catalog-scalar';
    fail(code, cause.message, cause);
  }
}

function assertCatalogScalar(operation: () => void): void {
  try {
    operation();
  } catch (cause) {
    fail('catalog-scalar', 'catalog scalar is not canonical', cause);
  }
}

function assertCatalogU64(value: unknown, label: string): bigint {
  try {
    return parseCanonicalDecimalU64(value, label);
  } catch (cause) {
    fail('catalog-scalar', `${label} is not a canonical DecimalU64V1`, cause);
  }
}

function assertCatalogPositiveU64(value: unknown, label: string): bigint {
  const parsed = assertCatalogU64(value, label);
  if (parsed < 1n) {
    fail('catalog-scalar', `${label} must be a positive DecimalU64V1`);
  }
  return parsed;
}

function parseCatalogU256(value: unknown, label: string): bigint {
  try {
    return parseCanonicalDecimalU256(value, label);
  } catch (cause) {
    fail('catalog-scalar', `${label} is not a canonical DecimalU256V1`, cause);
  }
}

function digestWithDomain(domain: Uint8Array, canonicalBytes: Uint8Array): Digest32V1 {
  const hasher = sha256.create();
  hasher.update(domain);
  hasher.update(canonicalBytes);
  let result = '0x';
  for (const byte of hasher.digest()) result += byte.toString(16).padStart(2, '0');
  assertCanonicalDigest(result, 'computed catalog digest');
  return result;
}

function rejectOversizedWireInput(
  input: string | Uint8Array,
  maxBytes: number,
  label: string,
): void {
  if (typeof input !== 'string') {
    if (input.byteLength > maxBytes) {
      fail('object-too-large', `${label} exceeds ${maxBytes} bytes`);
    }
    return;
  }
  if (input.length > maxBytes || UTF8.encode(input).byteLength > maxBytes) {
    fail('object-too-large', `${label} exceeds ${maxBytes} bytes`);
  }
}

function fail(
  code: AuthorCatalogCodecErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new AuthorCatalogCodecError(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
