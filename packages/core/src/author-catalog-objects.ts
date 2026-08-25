import {
  canonicalizeJson,
  parseCanonicalJson,
  type CanonicalJsonValue,
  type StrictJsonParseOptions,
} from './canonical-json.js';
import {
  assertAuthorCatalogBucketCountV1,
  assertAuthorCatalogRowScopeBindingV1,
  assertAuthorCatalogRowV1,
  assertAuthorCatalogScopeV1,
  assertContextGraphIdV1,
  assertNetworkIdV1,
  assertSubGraphNameV1,
  canonicalizeAuthorCatalogScopeV1,
  catalogKeyToBucketIdV1,
  compareAuthorCatalogKaIdsV1,
  computeAuthorCatalogKeyDigestV1,
  computeAuthorCatalogScopeDigestV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type ContextGraphIdV1,
  type NetworkIdV1,
  type SubGraphNameV1,
} from './author-catalog-codec.js';
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
  assertCanonicalChainId,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertCanonicalTimestampMs,
  parseCanonicalDecimalU64,
  type ChainIdV1,
  type CountV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type TimestampMsV1,
} from './sync-wire-scalars.js';
import { assertExactKeys, isPlainRecord } from './sync-wire-objects.js';

export const AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1 = 'AuthorCatalogBucketV1' as const;
export const AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1 = 'AuthorCatalogHeadV1' as const;
export const MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 = 1024;
export const MAX_AUTHOR_CATALOG_BUCKET_PAYLOAD_BYTES_V1 = 1024 * 1024;
export const MAX_AUTHOR_CATALOG_HEAD_PAYLOAD_BYTES_V1 = 4 * 1024;
export const MAX_AUTHOR_CATALOG_DIRECTORY_HEIGHT_V1 = 7n;
export const AUTHOR_CATALOG_DIRECTORY_FANOUT_V1 = 256n;
export const ZERO_DIGEST32_V1 = `0x${'00'.repeat(32)}` as Digest32V1;

const UTF8 = new TextEncoder();

/** Exact five-key immutable non-empty bucket payload. */
export interface AuthorCatalogBucketV1 {
  readonly catalogScopeDigest: Digest32V1;
  readonly era: DecimalU64V1;
  readonly bucketCount: CountV1;
  readonly bucketId: DecimalU64V1;
  readonly rows: readonly AuthorCatalogRowV1[];
}

/** Exact sixteen-key constant-size author-catalog head payload. */
export interface AuthorCatalogHeadV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly governanceChainId: ChainIdV1 | null;
  readonly governanceContractAddress: EvmAddressV1 | null;
  readonly ownershipTransitionDigest: Digest32V1 | null;
  readonly subGraphName: SubGraphNameV1 | null;
  readonly authorAddress: EvmAddressV1;
  readonly catalogIssuerDelegationDigest: Digest32V1;
  readonly era: DecimalU64V1;
  readonly version: DecimalU64V1;
  readonly previousHeadDigest: Digest32V1 | null;
  readonly bucketCount: CountV1;
  readonly totalRows: CountV1;
  readonly directoryHeight: DecimalU64V1;
  readonly directoryRootDigest: Digest32V1;
  readonly issuedAt: TimestampMsV1;
}

export type UnsignedAuthorCatalogBucketEnvelopeV1 = UnsignedControlEnvelopeV1 & {
  readonly objectType: typeof AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1;
  readonly payload: AuthorCatalogBucketV1;
};
export type SignedAuthorCatalogBucketEnvelopeV1 = SignedControlEnvelopeV1 & {
  readonly objectType: typeof AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1;
  readonly payload: AuthorCatalogBucketV1;
};
export type UnsignedAuthorCatalogHeadEnvelopeV1 = UnsignedControlEnvelopeV1 & {
  readonly objectType: typeof AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1;
  readonly payload: AuthorCatalogHeadV1;
};
export type SignedAuthorCatalogHeadEnvelopeV1 = SignedControlEnvelopeV1 & {
  readonly objectType: typeof AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1;
  readonly payload: AuthorCatalogHeadV1;
};

export type AuthorCatalogObjectCodecErrorCode =
  | 'catalog-object-schema'
  | 'catalog-object-scalar'
  | 'catalog-object-type'
  | 'catalog-object-array'
  | 'catalog-object-row-order'
  | 'catalog-object-duplicate'
  | 'catalog-object-bucket-mapping'
  | 'catalog-object-scope-mismatch'
  | 'catalog-object-directory-height'
  | 'catalog-object-payload-too-large';

export class AuthorCatalogObjectCodecError extends Error {
  constructor(
    readonly code: AuthorCatalogObjectCodecErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'AuthorCatalogObjectCodecError';
  }
}

/** Validate one complete non-empty bucket, including its canonical 1 MiB cap. */
export function assertAuthorCatalogBucketV1(
  bucket: unknown,
): asserts bucket is AuthorCatalogBucketV1 {
  assertAuthorCatalogBucketStructureV1(bucket);
  canonicalizeBucketAfterStructure(bucket);
}

/**
 * Bind a structurally valid bucket to the exact scope carried by its enclosing
 * head. This is candidate staging only; it deliberately performs no RDF/seal work.
 */
export function assertAuthorCatalogBucketScopeBindingV1(
  bucket: AuthorCatalogBucketV1,
  scope: AuthorCatalogScopeV1,
): void {
  assertAuthorCatalogBucketV1(bucket);
  assertAuthorCatalogScopeV1(scope);
  const expectedScopeDigest = computeAuthorCatalogScopeDigestV1(scope);
  if (bucket.catalogScopeDigest !== expectedScopeDigest) {
    fail(
      'catalog-object-scope-mismatch',
      'bucket catalogScopeDigest does not match the contextual author catalog scope',
    );
  }
  if (bucket.era !== scope.era || bucket.bucketCount !== scope.bucketCount) {
    fail(
      'catalog-object-scope-mismatch',
      'bucket era and bucketCount must equal the contextual scope',
    );
  }
  for (let index = 0; index < bucket.rows.length; index += 1) {
    assertAuthorCatalogRowScopeBindingV1(bucket.rows[index], scope);
  }
}

/** Return exact RFC 8785 payload bytes and enforce the bucket's 1 MiB cap. */
export function canonicalizeAuthorCatalogBucketPayloadBytesV1(
  bucket: AuthorCatalogBucketV1,
): Uint8Array {
  assertAuthorCatalogBucketStructureV1(bucket);
  return UTF8.encode(canonicalizeBucketAfterStructure(bucket));
}

export function canonicalizeAuthorCatalogBucketPayloadV1(
  bucket: AuthorCatalogBucketV1,
): string {
  assertAuthorCatalogBucketStructureV1(bucket);
  return canonicalizeBucketAfterStructure(bucket);
}

/** Strict direct-payload decoder; envelope decoders intentionally use the generic cap first. */
export function parseCanonicalAuthorCatalogBucketPayloadV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): AuthorCatalogBucketV1 {
  rejectOversizedWireInput(
    input,
    MAX_AUTHOR_CATALOG_BUCKET_PAYLOAD_BYTES_V1,
    'author catalog bucket payload',
  );
  const parsed = parseCanonicalJson(input, {
    ...options,
    maxBytes: Math.min(
      options.maxBytes ?? MAX_AUTHOR_CATALOG_BUCKET_PAYLOAD_BYTES_V1,
      MAX_AUTHOR_CATALOG_BUCKET_PAYLOAD_BYTES_V1,
    ),
    maxDepth: Math.min(options.maxDepth ?? 4, 4),
  });
  assertAuthorCatalogBucketV1(parsed);
  return parsed;
}

/** Validate one head, its self-derived scope, height formula, and 4 KiB cap. */
export function assertAuthorCatalogHeadV1(
  head: unknown,
): asserts head is AuthorCatalogHeadV1 {
  assertAuthorCatalogHeadStructureV1(head);
  canonicalizeHeadAfterStructure(head);
}

/** Derive the exact nine-key catalog scope committed by this head. */
export function deriveAuthorCatalogScopeFromHeadV1(
  head: AuthorCatalogHeadV1,
): AuthorCatalogScopeV1 {
  assertAuthorCatalogHeadV1(head);
  return deriveScopeAfterHeadStructure(head);
}

/** Require a head to be in exactly the externally pinned catalog scope. */
export function assertAuthorCatalogHeadScopeBindingV1(
  head: AuthorCatalogHeadV1,
  expectedScope: AuthorCatalogScopeV1,
): void {
  assertAuthorCatalogHeadV1(head);
  assertAuthorCatalogScopeV1(expectedScope);
  const derived = deriveScopeAfterHeadStructure(head);
  if (
    canonicalizeAuthorCatalogScopeV1(derived)
    !== canonicalizeAuthorCatalogScopeV1(expectedScope)
  ) {
    fail(
      'catalog-object-scope-mismatch',
      'head fields do not equal the externally pinned author catalog scope',
    );
  }
}

/** Return the canonical zero-based directory height for a valid bucket count. */
export function computeAuthorCatalogDirectoryHeightV1(
  bucketCount: CountV1,
): DecimalU64V1 {
  assertAuthorCatalogBucketCountV1(bucketCount);
  const count = BigInt(bucketCount);
  let height = 0n;
  let coveredBuckets = AUTHOR_CATALOG_DIRECTORY_FANOUT_V1;
  while (count > coveredBuckets) {
    coveredBuckets *= AUTHOR_CATALOG_DIRECTORY_FANOUT_V1;
    height += 1n;
  }
  if (height > MAX_AUTHOR_CATALOG_DIRECTORY_HEIGHT_V1) {
    fail('catalog-object-directory-height', 'derived directory height exceeds v1');
  }
  return height.toString() as DecimalU64V1;
}

export function canonicalizeAuthorCatalogHeadPayloadBytesV1(
  head: AuthorCatalogHeadV1,
): Uint8Array {
  assertAuthorCatalogHeadStructureV1(head);
  return UTF8.encode(canonicalizeHeadAfterStructure(head));
}

export function canonicalizeAuthorCatalogHeadPayloadV1(
  head: AuthorCatalogHeadV1,
): string {
  assertAuthorCatalogHeadStructureV1(head);
  return canonicalizeHeadAfterStructure(head);
}

export function parseCanonicalAuthorCatalogHeadPayloadV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): AuthorCatalogHeadV1 {
  rejectOversizedWireInput(
    input,
    MAX_AUTHOR_CATALOG_HEAD_PAYLOAD_BYTES_V1,
    'author catalog head payload',
  );
  const parsed = parseCanonicalJson(input, {
    ...options,
    maxBytes: Math.min(
      options.maxBytes ?? MAX_AUTHOR_CATALOG_HEAD_PAYLOAD_BYTES_V1,
      MAX_AUTHOR_CATALOG_HEAD_PAYLOAD_BYTES_V1,
    ),
    maxDepth: Math.min(options.maxDepth ?? 1, 1),
  });
  assertAuthorCatalogHeadV1(parsed);
  return parsed;
}

export function assertUnsignedAuthorCatalogBucketEnvelopeV1(
  envelope: UnsignedControlEnvelopeV1,
): asserts envelope is UnsignedAuthorCatalogBucketEnvelopeV1 {
  assertUnsignedControlEnvelope(envelope);
  assertEnvelopeObjectType(envelope.objectType, AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1);
  assertAuthorCatalogBucketV1(envelope.payload);
}

export function assertSignedAuthorCatalogBucketEnvelopeV1(
  envelope: SignedControlEnvelopeV1,
): asserts envelope is SignedAuthorCatalogBucketEnvelopeV1 {
  assertSignedControlEnvelope(envelope);
  assertEnvelopeObjectType(envelope.objectType, AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1);
  assertAuthorCatalogBucketV1(envelope.payload);
}

export function assertUnsignedAuthorCatalogHeadEnvelopeV1(
  envelope: UnsignedControlEnvelopeV1,
): asserts envelope is UnsignedAuthorCatalogHeadEnvelopeV1 {
  assertUnsignedControlEnvelope(envelope);
  assertEnvelopeObjectType(envelope.objectType, AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1);
  assertAuthorCatalogHeadV1(envelope.payload);
}

export function assertSignedAuthorCatalogHeadEnvelopeV1(
  envelope: SignedControlEnvelopeV1,
): asserts envelope is SignedAuthorCatalogHeadEnvelopeV1 {
  assertSignedControlEnvelope(envelope);
  assertEnvelopeObjectType(envelope.objectType, AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1);
  assertAuthorCatalogHeadV1(envelope.payload);
}

export function canonicalizeUnsignedAuthorCatalogBucketEnvelopeBytesV1(
  envelope: UnsignedControlEnvelopeV1,
): Uint8Array {
  assertUnsignedAuthorCatalogBucketEnvelopeV1(envelope);
  return canonicalizeUnsignedControlEnvelopeBytes(envelope);
}

export function canonicalizeSignedAuthorCatalogBucketEnvelopeBytesV1(
  envelope: SignedControlEnvelopeV1,
): Uint8Array {
  assertSignedAuthorCatalogBucketEnvelopeV1(envelope);
  return canonicalizeSignedControlEnvelopeBytes(envelope);
}

export function canonicalizeUnsignedAuthorCatalogHeadEnvelopeBytesV1(
  envelope: UnsignedControlEnvelopeV1,
): Uint8Array {
  assertUnsignedAuthorCatalogHeadEnvelopeV1(envelope);
  return canonicalizeUnsignedControlEnvelopeBytes(envelope);
}

export function canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1(
  envelope: SignedControlEnvelopeV1,
): Uint8Array {
  assertSignedAuthorCatalogHeadEnvelopeV1(envelope);
  return canonicalizeSignedControlEnvelopeBytes(envelope);
}

export function computeAuthorCatalogBucketObjectDigestV1(
  envelope: UnsignedControlEnvelopeV1,
): Digest32V1 {
  assertUnsignedAuthorCatalogBucketEnvelopeV1(envelope);
  const digest = computeControlObjectDigestHex(envelope);
  assertCanonicalDigest(digest, 'bucket objectDigest');
  return digest;
}

export function computeAuthorCatalogHeadObjectDigestV1(
  envelope: UnsignedControlEnvelopeV1,
): Digest32V1 {
  assertUnsignedAuthorCatalogHeadEnvelopeV1(envelope);
  const digest = computeControlObjectDigestHex(envelope);
  assertCanonicalDigest(digest, 'head objectDigest');
  return digest;
}

/** Parse the generic envelope first, then enforce the lower payload cap and schema. */
export function parseCanonicalUnsignedAuthorCatalogBucketEnvelopeV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): UnsignedAuthorCatalogBucketEnvelopeV1 {
  const envelope = parseCanonicalUnsignedControlEnvelope(input, options);
  assertUnsignedAuthorCatalogBucketEnvelopeV1(envelope);
  return envelope;
}

export function parseCanonicalSignedAuthorCatalogBucketEnvelopeV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): SignedAuthorCatalogBucketEnvelopeV1 {
  const envelope = parseCanonicalSignedControlEnvelope(input, options);
  assertSignedAuthorCatalogBucketEnvelopeV1(envelope);
  return envelope;
}

export function parseCanonicalUnsignedAuthorCatalogHeadEnvelopeV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): UnsignedAuthorCatalogHeadEnvelopeV1 {
  const envelope = parseCanonicalUnsignedControlEnvelope(input, options);
  assertUnsignedAuthorCatalogHeadEnvelopeV1(envelope);
  return envelope;
}

export function parseCanonicalSignedAuthorCatalogHeadEnvelopeV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): SignedAuthorCatalogHeadEnvelopeV1 {
  const envelope = parseCanonicalSignedControlEnvelope(input, options);
  assertSignedAuthorCatalogHeadEnvelopeV1(envelope);
  return envelope;
}

function assertAuthorCatalogBucketStructureV1(
  bucket: unknown,
): asserts bucket is AuthorCatalogBucketV1 {
  if (!isPlainRecord(bucket)) {
    fail('catalog-object-schema', 'author catalog bucket must be a plain JSON object');
  }
  assertClosedKeys(bucket, [
    'bucketCount',
    'bucketId',
    'catalogScopeDigest',
    'era',
    'rows',
  ], 'author catalog bucket');
  assertObjectScalar(() => assertCanonicalDigest(
    bucket.catalogScopeDigest,
    'catalogScopeDigest',
  ));
  assertObjectU64(bucket.era, 'era');
  assertAuthorCatalogBucketCountV1(bucket.bucketCount);
  const bucketId = assertObjectU64(bucket.bucketId, 'bucketId');
  if (bucketId >= BigInt(bucket.bucketCount)) {
    fail('catalog-object-bucket-mapping', 'bucketId must be less than bucketCount');
  }

  assertDenseOrdinaryRowsArray(bucket.rows);
  const seenKaIds = new Set<string>();
  const seenKeyDigests = new Set<string>();
  const seenCoordinates = new Set<string>();
  let previousRow: AuthorCatalogRowV1 | undefined;
  for (let index = 0; index < bucket.rows.length; index += 1) {
    const row = bucket.rows[index];
    assertAuthorCatalogRowV1(row);
    if (seenKaIds.has(row.kaId)) {
      fail('catalog-object-duplicate', `duplicate kaId ${row.kaId}`);
    }
    seenKaIds.add(row.kaId);

    const keyDigest = computeAuthorCatalogKeyDigestV1(row.kaId);
    if (seenKeyDigests.has(keyDigest)) {
      fail('catalog-object-duplicate', `duplicate catalogKeyDigest ${keyDigest}`);
    }
    seenKeyDigests.add(keyDigest);
    if (seenCoordinates.has(row.assertionCoordinate)) {
      fail(
        'catalog-object-duplicate',
        `duplicate assertionCoordinate ${row.assertionCoordinate}`,
      );
    }
    seenCoordinates.add(row.assertionCoordinate);

    if (previousRow !== undefined && compareAuthorCatalogKaIdsV1(previousRow.kaId, row.kaId) >= 0) {
      fail('catalog-object-row-order', 'bucket rows must be strictly increasing by numeric kaId');
    }
    previousRow = row;

    if (catalogKeyToBucketIdV1(row.kaId, bucket.bucketCount) !== bucket.bucketId) {
      fail(
        'catalog-object-bucket-mapping',
        `row kaId ${row.kaId} does not map to bucketId ${bucket.bucketId}`,
      );
    }
  }
}

function assertAuthorCatalogHeadStructureV1(
  head: unknown,
): asserts head is AuthorCatalogHeadV1 {
  if (!isPlainRecord(head)) {
    fail('catalog-object-schema', 'author catalog head must be a plain JSON object');
  }
  assertClosedKeys(head, [
    'authorAddress',
    'bucketCount',
    'catalogIssuerDelegationDigest',
    'contextGraphId',
    'directoryHeight',
    'directoryRootDigest',
    'era',
    'governanceChainId',
    'governanceContractAddress',
    'issuedAt',
    'networkId',
    'ownershipTransitionDigest',
    'previousHeadDigest',
    'subGraphName',
    'totalRows',
    'version',
  ], 'author catalog head');

  // Scope derivation performs the identifier, governance-pair, author, era, and
  // bucket-count checks once over the exact same values committed by the head.
  const derivedScope = deriveScopeAfterHeadKeys(head);
  assertObjectScalar(() => assertCanonicalDigest(
    head.catalogIssuerDelegationDigest,
    'catalogIssuerDelegationDigest',
  ));
  assertObjectU64(head.version, 'version');
  if (head.previousHeadDigest !== null) {
    assertObjectScalar(() => assertCanonicalDigest(head.previousHeadDigest, 'previousHeadDigest'));
  }
  assertObjectU64(head.totalRows, 'totalRows');
  const height = assertObjectU64(head.directoryHeight, 'directoryHeight');
  if (height > MAX_AUTHOR_CATALOG_DIRECTORY_HEIGHT_V1) {
    fail('catalog-object-directory-height', 'directoryHeight must be in 0..7');
  }
  const expectedHeight = computeAuthorCatalogDirectoryHeightV1(derivedScope.bucketCount);
  if (head.directoryHeight !== expectedHeight) {
    fail(
      'catalog-object-directory-height',
      `directoryHeight must be ${expectedHeight} for bucketCount ${head.bucketCount}`,
    );
  }
  assertObjectScalar(() => assertCanonicalDigest(head.directoryRootDigest, 'directoryRootDigest'));
  if (head.directoryRootDigest === ZERO_DIGEST32_V1) {
    fail('catalog-object-schema', 'directoryRootDigest must name a nonzero directory object');
  }
  assertObjectScalar(() => assertCanonicalTimestampMs(head.issuedAt, 'issuedAt'));
}

function deriveScopeAfterHeadKeys(
  head: Record<string, unknown>,
): AuthorCatalogScopeV1 {
  assertNetworkIdV1(head.networkId);
  assertContextGraphIdV1(head.contextGraphId);
  if (head.subGraphName !== null) assertSubGraphNameV1(head.subGraphName);
  assertObjectScalar(() => assertCanonicalEvmAddress(head.authorAddress, 'authorAddress'));
  assertObjectU64(head.era, 'era');
  assertAuthorCatalogBucketCountV1(head.bucketCount);

  const chainIsNull = head.governanceChainId === null;
  const contractIsNull = head.governanceContractAddress === null;
  if (chainIsNull !== contractIsNull) {
    fail(
      'catalog-object-schema',
      'governanceChainId and governanceContractAddress must both be null or both non-null',
    );
  }
  if (!chainIsNull) {
    assertObjectScalar(() => assertCanonicalChainId(head.governanceChainId, 'governanceChainId'));
    assertObjectScalar(() => assertCanonicalEvmAddress(
      head.governanceContractAddress,
      'governanceContractAddress',
    ));
  }
  if (head.ownershipTransitionDigest !== null) {
    assertObjectScalar(() => assertCanonicalDigest(
      head.ownershipTransitionDigest,
      'ownershipTransitionDigest',
    ));
  }

  const scope = {
    networkId: head.networkId,
    contextGraphId: head.contextGraphId,
    governanceChainId: head.governanceChainId,
    governanceContractAddress: head.governanceContractAddress,
    ownershipTransitionDigest: head.ownershipTransitionDigest,
    subGraphName: head.subGraphName,
    authorAddress: head.authorAddress,
    era: head.era,
    bucketCount: head.bucketCount,
  };
  assertAuthorCatalogScopeV1(scope);
  return scope;
}

function deriveScopeAfterHeadStructure(head: AuthorCatalogHeadV1): AuthorCatalogScopeV1 {
  return {
    networkId: head.networkId,
    contextGraphId: head.contextGraphId,
    governanceChainId: head.governanceChainId,
    governanceContractAddress: head.governanceContractAddress,
    ownershipTransitionDigest: head.ownershipTransitionDigest,
    subGraphName: head.subGraphName,
    authorAddress: head.authorAddress,
    era: head.era,
    bucketCount: head.bucketCount,
  };
}

function assertDenseOrdinaryRowsArray(
  value: unknown,
): asserts value is AuthorCatalogRowV1[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('catalog-object-array', 'rows must be an ordinary Array');
  }
  if (value.length < 1 || value.length > MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1) {
    fail(
      'catalog-object-array',
      `rows must contain 1..${MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1} entries`,
    );
  }

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    fail('catalog-object-array', 'rows must not contain symbol properties');
  }
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes('length')) {
    fail('catalog-object-array', 'rows must be dense and contain no custom properties');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')) {
    fail('catalog-object-array', 'rows length must be an ordinary data property');
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('catalog-object-array', 'rows must be a dense array of enumerable data properties');
    }
  }
}

function canonicalizeBucketAfterStructure(bucket: AuthorCatalogBucketV1): string {
  try {
    return canonicalizeJson(bucket as unknown as CanonicalJsonValue, {
      maxBytes: MAX_AUTHOR_CATALOG_BUCKET_PAYLOAD_BYTES_V1,
      maxDepth: 4,
    });
  } catch (cause) {
    fail(
      'catalog-object-payload-too-large',
      `author catalog bucket payload exceeds ${MAX_AUTHOR_CATALOG_BUCKET_PAYLOAD_BYTES_V1} bytes or depth`,
      cause,
    );
  }
}

function canonicalizeHeadAfterStructure(head: AuthorCatalogHeadV1): string {
  try {
    return canonicalizeJson(head as unknown as CanonicalJsonValue, {
      maxBytes: MAX_AUTHOR_CATALOG_HEAD_PAYLOAD_BYTES_V1,
      maxDepth: 1,
    });
  } catch (cause) {
    fail(
      'catalog-object-payload-too-large',
      `author catalog head payload exceeds ${MAX_AUTHOR_CATALOG_HEAD_PAYLOAD_BYTES_V1} bytes or depth`,
      cause,
    );
  }
}

function assertEnvelopeObjectType(actual: string, expected: string): void {
  if (actual !== expected) {
    fail('catalog-object-type', `objectType must be exactly ${expected}`);
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
    fail('catalog-object-schema', `${label} has an invalid field set`, cause);
  }
}

function assertObjectScalar(operation: () => void): void {
  try {
    operation();
  } catch (cause) {
    fail('catalog-object-scalar', 'catalog object scalar is not canonical', cause);
  }
}

function assertObjectU64(value: unknown, label: string): bigint {
  try {
    return parseCanonicalDecimalU64(value, label);
  } catch (cause) {
    fail('catalog-object-scalar', `${label} is not a canonical DecimalU64V1`, cause);
  }
}

function rejectOversizedWireInput(
  input: string | Uint8Array,
  maxBytes: number,
  label: string,
): void {
  if (typeof input !== 'string') {
    if (input.byteLength > maxBytes) {
      fail('catalog-object-payload-too-large', `${label} exceeds ${maxBytes} bytes`);
    }
    return;
  }
  if (input.length > maxBytes || UTF8.encode(input).byteLength > maxBytes) {
    fail('catalog-object-payload-too-large', `${label} exceeds ${maxBytes} bytes`);
  }
}

function fail(
  code: AuthorCatalogObjectCodecErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new AuthorCatalogObjectCodecError(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
