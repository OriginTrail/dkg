import { sha256 } from '@noble/hashes/sha2.js';

import {
  AUTHOR_LANE_SCOPE_KEYS_V1,
  assertAuthorLaneScopeV1,
  assertAssertionCoordinateV1,
  snapshotAuthorLaneScopeV1,
  type AssertionCoordinateV1,
  type AuthorLaneScopeV1,
} from './author-catalog-codec.js';
import {
  MAX_SEAL_TRIPLE_COUNT_V1,
} from './canonical-graph-scoped-author-seal.js';
import {
  canonicalizeJson,
  parseCanonicalJson,
  type CanonicalJsonValue,
  type StrictJsonParseOptions,
} from './canonical-json.js';
import {
  assertCanonicalDeterministicUalV1,
  type CanonicalDeterministicUalV1,
} from './ka-content-scope.js';
import {
  assertUnsignedControlEnvelope,
  assertSignedControlEnvelope,
  canonicalizeUnsignedControlEnvelopeBytes,
  canonicalizeSignedControlEnvelopeBytes,
  computeControlObjectDigestHex,
  parseCanonicalSignedControlEnvelope,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from './sync-control-object.js';
import {
  assertCanonicalDigest,
  assertCanonicalTimestampMs,
  parseCanonicalDecimalU64,
  type CountV1,
  type DecimalU64V1,
  type Digest32V1,
  type TimestampMsV1,
} from './sync-wire-scalars.js';
import { assertExactKeys, isPlainRecord } from './sync-wire-objects.js';

export const SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1 =
  'SwmAuthorInventoryHeadV1' as const;
export const SWM_AUTHOR_INVENTORY_SCOPE_DIGEST_DOMAIN_V1 =
  'dkg-swm-author-inventory-scope-v1\n' as const;
export const SWM_AUTHOR_INVENTORY_ROWS_DIGEST_DOMAIN_V1 =
  'dkg-swm-author-inventory-rows-v1\n' as const;
export const MAX_SWM_AUTHOR_INVENTORY_HEAD_BYTES_V1 = 4 * 1024;
export const MAX_SWM_AUTHOR_INVENTORY_ROWS_BYTES_V1 = 8 * 1024 * 1024;
export const MAX_SWM_AUTHOR_INVENTORY_ROWS_V1 = 100_000;
export const MAX_SWM_AUTHOR_INVENTORY_SHARE_OPERATION_ID_BYTES_V1 = 256;

const UTF8 = new TextEncoder();
const SCOPE_DOMAIN_BYTES = UTF8.encode(SWM_AUTHOR_INVENTORY_SCOPE_DIGEST_DOMAIN_V1);
const ROWS_DOMAIN_BYTES = UTF8.encode(SWM_AUTHOR_INVENTORY_ROWS_DIGEST_DOMAIN_V1);
const SWM_AUTHOR_INVENTORY_SCOPE_KEYS = AUTHOR_LANE_SCOPE_KEYS_V1;
const SWM_AUTHOR_INVENTORY_HEAD_ONLY_KEYS = Object.freeze([
  'version',
  'previousHeadDigest',
  'totalRows',
  'rowsDigest',
  'issuedAt',
] as const);
const SWM_AUTHOR_INVENTORY_HEAD_KEYS = Object.freeze([
  ...SWM_AUTHOR_INVENTORY_SCOPE_KEYS,
  ...SWM_AUTHOR_INVENTORY_HEAD_ONLY_KEYS,
] as const);

/**
 * Exact public-CG lane whose active, author-sealed SWM-only set is attested.
 * The separate object type and digest domain deliberately prevent this
 * pre-finalization claim from being mistaken for a finalized-VM catalog.
 */
export interface SwmAuthorInventoryScopeV1 extends AuthorLaneScopeV1 {}

/** One active, completely committed SWM assertion. */
export interface SwmAuthorInventoryRowV1 {
  readonly assertionCoordinate: AssertionCoordinateV1;
  readonly assertionVersion: DecimalU64V1;
  readonly kaUal: CanonicalDeterministicUalV1;
  readonly shareOperationId: string;
  readonly projectionDigest: Digest32V1;
  readonly publicTripleCount: CountV1;
  readonly privateTripleCount: CountV1;
  readonly sealDigest: Digest32V1;
  readonly sharedAt: TimestampMsV1;
  readonly expiresAt: TimestampMsV1 | null;
}

/** Constant-size signed exact-set commitment. The rows remain a separate blob. */
export interface SwmAuthorInventoryHeadV1 extends SwmAuthorInventoryScopeV1 {
  readonly version: DecimalU64V1;
  readonly previousHeadDigest: Digest32V1 | null;
  readonly totalRows: CountV1;
  readonly rowsDigest: Digest32V1;
  readonly issuedAt: TimestampMsV1;
}

export type UnsignedSwmAuthorInventoryHeadEnvelopeV1 = UnsignedControlEnvelopeV1 & {
  readonly objectType: typeof SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1;
  readonly payload: SwmAuthorInventoryHeadV1;
};

export type SignedSwmAuthorInventoryHeadEnvelopeV1 = SignedControlEnvelopeV1 & {
  readonly objectType: typeof SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1;
  readonly payload: SwmAuthorInventoryHeadV1;
};

export interface SwmAuthorInventorySnapshotV1 {
  readonly head: SignedSwmAuthorInventoryHeadEnvelopeV1;
  readonly rows: readonly SwmAuthorInventoryRowV1[];
}

export type SwmAuthorInventoryCodecErrorCodeV1 =
  | 'swm-inventory-schema'
  | 'swm-inventory-scalar'
  | 'swm-inventory-order'
  | 'swm-inventory-duplicate'
  | 'swm-inventory-binding'
  | 'swm-inventory-too-large';

export class SwmAuthorInventoryCodecErrorV1 extends Error {
  constructor(
    readonly code: SwmAuthorInventoryCodecErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'SwmAuthorInventoryCodecErrorV1';
  }
}

export function assertSwmAuthorInventoryScopeV1(
  value: unknown,
): asserts value is SwmAuthorInventoryScopeV1 {
  if (!isPlainRecord(value)) fail('swm-inventory-schema', 'scope must be a plain object');
  assertExactKeysAdapted(value, SWM_AUTHOR_INVENTORY_SCOPE_KEYS, 'scope');
  adaptScalars(() => assertAuthorLaneScopeV1(value));
}

export function canonicalizeSwmAuthorInventoryScopeV1(
  scope: SwmAuthorInventoryScopeV1,
): string {
  assertSwmAuthorInventoryScopeV1(scope);
  return canonicalizeJson(scope as unknown as CanonicalJsonValue, {
    maxBytes: MAX_SWM_AUTHOR_INVENTORY_HEAD_BYTES_V1,
    maxDepth: 1,
  });
}

export function computeSwmAuthorInventoryScopeDigestV1(
  scope: SwmAuthorInventoryScopeV1,
): Digest32V1 {
  return digestWithDomain(
    SCOPE_DOMAIN_BYTES,
    UTF8.encode(canonicalizeSwmAuthorInventoryScopeV1(scope)),
  );
}

export function assertSwmAuthorInventoryRowV1(
  value: unknown,
): asserts value is SwmAuthorInventoryRowV1 {
  if (!isPlainRecord(value)) fail('swm-inventory-schema', 'row must be a plain object');
  assertExactKeysAdapted(value, [
    'assertionCoordinate',
    'assertionVersion',
    'kaUal',
    'shareOperationId',
    'projectionDigest',
    'publicTripleCount',
    'privateTripleCount',
    'sealDigest',
    'sharedAt',
    'expiresAt',
  ], 'row');
  adaptScalars(() => {
    assertAssertionCoordinateV1(value.assertionCoordinate);
    const assertionVersion = parseCanonicalDecimalU64(value.assertionVersion, 'assertionVersion');
    if (assertionVersion < 1n) throw new Error('assertionVersion must be positive');
    assertCanonicalDeterministicUalV1(value.kaUal);
    assertBoundedIdentifier(value.shareOperationId, 'shareOperationId');
    assertCanonicalDigest(value.projectionDigest, 'projectionDigest');
    const publicTripleCount = parseCanonicalDecimalU64(
      value.publicTripleCount,
      'publicTripleCount',
    );
    const privateTripleCount = parseCanonicalDecimalU64(
      value.privateTripleCount,
      'privateTripleCount',
    );
    if (
      publicTripleCount > MAX_SEAL_TRIPLE_COUNT_V1
      || privateTripleCount > MAX_SEAL_TRIPLE_COUNT_V1
    ) {
      throw new Error('triple counts must fit the canonical author seal bounds');
    }
    if (publicTripleCount + privateTripleCount === 0n) {
      throw new Error('inventory row must commit at least one triple');
    }
    assertCanonicalDigest(value.sealDigest, 'sealDigest');
    assertCanonicalTimestampMs(value.sharedAt, 'sharedAt');
    if (value.expiresAt !== null) {
      assertCanonicalTimestampMs(value.expiresAt, 'expiresAt');
      if (BigInt(value.expiresAt) <= BigInt(value.sharedAt)) {
        throw new Error('expiresAt must be later than sharedAt');
      }
    }
  });
}

export function compareSwmAuthorInventoryRowsV1(
  left: SwmAuthorInventoryRowV1,
  right: SwmAuthorInventoryRowV1,
): number {
  return left.kaUal < right.kaUal ? -1 : left.kaUal > right.kaUal ? 1 : 0;
}

export function canonicalizeSwmAuthorInventoryRowsBytesV1(
  rows: readonly SwmAuthorInventoryRowV1[],
): Uint8Array {
  assertSwmAuthorInventoryRowsV1(rows);
  try {
    return UTF8.encode(canonicalizeJson(rows as unknown as CanonicalJsonValue, {
      maxBytes: MAX_SWM_AUTHOR_INVENTORY_ROWS_BYTES_V1,
      maxDepth: 2,
    }));
  } catch (cause) {
    fail('swm-inventory-too-large', 'row set exceeds the canonical v1 byte limit', cause);
  }
}

export function parseCanonicalSwmAuthorInventoryRowsV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): readonly SwmAuthorInventoryRowV1[] {
  let parsed: CanonicalJsonValue;
  try {
    parsed = parseCanonicalJson(input, {
      ...options,
      maxBytes: Math.min(
        options.maxBytes ?? MAX_SWM_AUTHOR_INVENTORY_ROWS_BYTES_V1,
        MAX_SWM_AUTHOR_INVENTORY_ROWS_BYTES_V1,
      ),
      maxDepth: Math.min(options.maxDepth ?? 2, 2),
    });
  } catch (cause) {
    fail('swm-inventory-schema', 'rows are not strict canonical JSON', cause);
  }
  assertSwmAuthorInventoryRowsV1(parsed);
  return Object.freeze(parsed.map((row) => Object.freeze({ ...row })));
}

export function computeSwmAuthorInventoryRowsDigestV1(
  rows: readonly SwmAuthorInventoryRowV1[],
): Digest32V1 {
  return digestWithDomain(ROWS_DOMAIN_BYTES, canonicalizeSwmAuthorInventoryRowsBytesV1(rows));
}

export function assertSwmAuthorInventoryHeadV1(
  value: unknown,
): asserts value is SwmAuthorInventoryHeadV1 {
  if (!isPlainRecord(value)) fail('swm-inventory-schema', 'head must be a plain object');
  assertExactKeysAdapted(value, SWM_AUTHOR_INVENTORY_HEAD_KEYS, 'head');
  const scope = scopeCandidateFromHead(value);
  assertSwmAuthorInventoryScopeV1(scope);
  adaptScalars(() => {
    const version = parseCanonicalDecimalU64(value.version, 'version');
    if (value.previousHeadDigest !== null) {
      assertCanonicalDigest(value.previousHeadDigest, 'previousHeadDigest');
    }
    if ((version === 0n) !== (value.previousHeadDigest === null)) {
      throw new Error('only version 0 may have a null previousHeadDigest');
    }
    const totalRows = parseCanonicalDecimalU64(value.totalRows, 'totalRows');
    if (totalRows > BigInt(MAX_SWM_AUTHOR_INVENTORY_ROWS_V1)) {
      throw new Error(`totalRows must not exceed ${MAX_SWM_AUTHOR_INVENTORY_ROWS_V1}`);
    }
    assertCanonicalDigest(value.rowsDigest, 'rowsDigest');
    assertCanonicalTimestampMs(value.issuedAt, 'issuedAt');
  });
  try {
    canonicalizeJson(value as unknown as CanonicalJsonValue, {
      maxBytes: MAX_SWM_AUTHOR_INVENTORY_HEAD_BYTES_V1,
      maxDepth: 1,
    });
  } catch (cause) {
    fail('swm-inventory-too-large', 'head exceeds the canonical v1 byte limit', cause);
  }
}

export function deriveSwmAuthorInventoryScopeFromHeadV1(
  head: SwmAuthorInventoryHeadV1,
): SwmAuthorInventoryScopeV1 {
  assertSwmAuthorInventoryHeadV1(head);
  return snapshotAuthorLaneScopeV1(head);
}

export function assertUnsignedSwmAuthorInventoryHeadEnvelopeV1(
  value: unknown,
): asserts value is UnsignedSwmAuthorInventoryHeadEnvelopeV1 {
  try {
    assertUnsignedControlEnvelope(value as UnsignedControlEnvelopeV1);
  } catch (cause) {
    fail('swm-inventory-schema', 'head envelope is not an unsigned control object', cause);
  }
  const envelope = value as UnsignedControlEnvelopeV1;
  assertSwmAuthorInventoryEnvelopeBinding(envelope);
  try {
    const bytes = canonicalizeUnsignedControlEnvelopeBytes(envelope);
    if (bytes.length > MAX_SWM_AUTHOR_INVENTORY_HEAD_BYTES_V1) {
      fail('swm-inventory-too-large', 'unsigned head exceeds the v1 byte limit');
    }
  } catch (cause) {
    if (cause instanceof SwmAuthorInventoryCodecErrorV1) throw cause;
    fail('swm-inventory-too-large', 'unsigned head exceeds control-object bounds', cause);
  }
}

export function canonicalizeUnsignedSwmAuthorInventoryHeadEnvelopeBytesV1(
  envelope: UnsignedSwmAuthorInventoryHeadEnvelopeV1,
): Uint8Array {
  assertUnsignedSwmAuthorInventoryHeadEnvelopeV1(envelope);
  return canonicalizeUnsignedControlEnvelopeBytes(envelope);
}

export function computeSwmAuthorInventoryHeadObjectDigestV1(
  envelope: UnsignedSwmAuthorInventoryHeadEnvelopeV1,
): Digest32V1 {
  assertUnsignedSwmAuthorInventoryHeadEnvelopeV1(envelope);
  const digest = computeControlObjectDigestHex(envelope);
  assertCanonicalDigest(digest, 'SWM author inventory head objectDigest');
  return digest;
}

export function assertSignedSwmAuthorInventoryHeadEnvelopeV1(
  value: unknown,
): asserts value is SignedSwmAuthorInventoryHeadEnvelopeV1 {
  try {
    assertSignedControlEnvelope(value as SignedControlEnvelopeV1);
  } catch (cause) {
    fail('swm-inventory-schema', 'head envelope is not a signed control object', cause);
  }
  const envelope = value as SignedControlEnvelopeV1;
  assertSwmAuthorInventoryEnvelopeBinding(envelope);
  try {
    const bytes = canonicalizeSignedControlEnvelopeBytes(envelope);
    if (bytes.length > MAX_SWM_AUTHOR_INVENTORY_HEAD_BYTES_V1) {
      fail('swm-inventory-too-large', 'signed head exceeds the v1 byte limit');
    }
  } catch (cause) {
    if (cause instanceof SwmAuthorInventoryCodecErrorV1) throw cause;
    fail('swm-inventory-too-large', 'signed head exceeds control-object bounds', cause);
  }
}

export function canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1(
  envelope: SignedSwmAuthorInventoryHeadEnvelopeV1,
): Uint8Array {
  assertSignedSwmAuthorInventoryHeadEnvelopeV1(envelope);
  const bytes = canonicalizeSignedControlEnvelopeBytes(envelope);
  if (bytes.length > MAX_SWM_AUTHOR_INVENTORY_HEAD_BYTES_V1) {
    fail('swm-inventory-too-large', 'signed head exceeds the v1 byte limit');
  }
  return bytes;
}

export function parseCanonicalSignedSwmAuthorInventoryHeadEnvelopeV1(
  input: string | Uint8Array,
): SignedSwmAuthorInventoryHeadEnvelopeV1 {
  let parsed: SignedControlEnvelopeV1;
  try {
    parsed = parseCanonicalSignedControlEnvelope(input, {
      maxBytes: MAX_SWM_AUTHOR_INVENTORY_HEAD_BYTES_V1,
      maxDepth: 3,
    });
  } catch (cause) {
    fail('swm-inventory-schema', 'signed head is not strict canonical JSON', cause);
  }
  assertSignedSwmAuthorInventoryHeadEnvelopeV1(parsed);
  return parsed;
}

export function assertSwmAuthorInventorySnapshotBindingV1(
  snapshot: SwmAuthorInventorySnapshotV1,
): void {
  assertSignedSwmAuthorInventoryHeadEnvelopeV1(snapshot.head);
  assertSwmAuthorInventoryRowsV1(snapshot.rows);
  const expectedCount = BigInt(snapshot.rows.length);
  if (BigInt(snapshot.head.payload.totalRows) !== expectedCount) {
    fail('swm-inventory-binding', 'head totalRows does not equal the exact row set');
  }
  const expectedRowsDigest = computeSwmAuthorInventoryRowsDigestV1(snapshot.rows);
  if (snapshot.head.payload.rowsDigest !== expectedRowsDigest) {
    fail('swm-inventory-binding', 'head rowsDigest does not commit to the exact row set');
  }
  for (const row of snapshot.rows) {
    const parsedUal = assertCanonicalDeterministicUalV1(row.kaUal);
    if (parsedUal.chainId !== snapshot.head.payload.networkId) {
      fail('swm-inventory-binding', 'row kaUal network does not equal the scoped networkId');
    }
    if (parsedUal.agentAddress !== snapshot.head.payload.authorAddress) {
      fail('swm-inventory-binding', 'row kaUal author does not equal the scoped authorAddress');
    }
    if (BigInt(row.sharedAt) > BigInt(snapshot.head.payload.issuedAt)) {
      fail('swm-inventory-binding', 'row sharedAt must not be later than head issuedAt');
    }
    if (
      row.expiresAt !== null
      && BigInt(row.expiresAt) <= BigInt(snapshot.head.payload.issuedAt)
    ) {
      fail('swm-inventory-binding', 'row expiresAt must be later than head issuedAt');
    }
  }
}

function assertSwmAuthorInventoryRowsV1(
  value: unknown,
): asserts value is SwmAuthorInventoryRowV1[] {
  if (!Array.isArray(value)) fail('swm-inventory-schema', 'rows must be an array');
  if (value.length > MAX_SWM_AUTHOR_INVENTORY_ROWS_V1) {
    fail('swm-inventory-too-large', 'row set exceeds the v1 row limit');
  }
  let previous: SwmAuthorInventoryRowV1 | undefined;
  const coordinates = new Set<string>();
  const operations = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const row = value[index];
    assertSwmAuthorInventoryRowV1(row);
    if (previous && compareSwmAuthorInventoryRowsV1(previous, row) >= 0) {
      fail(
        previous.kaUal === row.kaUal ? 'swm-inventory-duplicate' : 'swm-inventory-order',
        `rows must be strictly ordered by canonical kaUal at index ${index}`,
      );
    }
    if (coordinates.has(row.assertionCoordinate)) {
      fail('swm-inventory-duplicate', 'assertionCoordinate must be unique within a row set');
    }
    if (operations.has(row.shareOperationId)) {
      fail('swm-inventory-duplicate', 'shareOperationId must be unique within a row set');
    }
    coordinates.add(row.assertionCoordinate);
    operations.add(row.shareOperationId);
    previous = row;
  }
}

function assertBoundedIdentifier(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.normalize('NFC') !== value) {
    throw new Error(`${label} must be a nonempty NFC string`);
  }
  const bytes = UTF8.encode(value);
  if (bytes.length > MAX_SWM_AUTHOR_INVENTORY_SHARE_OPERATION_ID_BYTES_V1) {
    throw new Error(`${label} exceeds its v1 byte limit`);
  }
  for (const codePoint of value) {
    const point = codePoint.codePointAt(0)!;
    if (point <= 0x1f || (point >= 0x7f && point <= 0x9f)) {
      throw new Error(`${label} contains a forbidden control character`);
    }
  }
}

function scopeCandidateFromHead(value: Record<string, unknown>): Record<string, unknown> {
  return {
    authorAddress: value.authorAddress,
    contextGraphId: value.contextGraphId,
    era: value.era,
    governanceChainId: value.governanceChainId,
    governanceContractAddress: value.governanceContractAddress,
    networkId: value.networkId,
    ownershipTransitionDigest: value.ownershipTransitionDigest,
    subGraphName: value.subGraphName,
  };
}

function assertSwmAuthorInventoryEnvelopeBinding(
  envelope: UnsignedControlEnvelopeV1,
): void {
  if (envelope.objectType !== SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1) {
    fail('swm-inventory-schema', 'head envelope has the wrong objectType');
  }
  assertSwmAuthorInventoryHeadV1(envelope.payload);
  if (envelope.issuer !== envelope.payload.authorAddress) {
    fail('swm-inventory-binding', 'head issuer must equal the scoped authorAddress');
  }
}

function adaptScalars(operation: () => void): void {
  try {
    operation();
  } catch (cause) {
    if (cause instanceof SwmAuthorInventoryCodecErrorV1) throw cause;
    const detail = cause instanceof Error ? `: ${cause.message}` : '';
    fail('swm-inventory-scalar', `inventory scalar is not canonical${detail}`, cause);
  }
}

function assertExactKeysAdapted(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  try {
    assertExactKeys(value, keys, `SWM author inventory ${label}`);
  } catch (cause) {
    fail('swm-inventory-schema', `${label} has unexpected or missing keys`, cause);
  }
}

function digestWithDomain(domain: Uint8Array, bytes: Uint8Array): Digest32V1 {
  const hasher = sha256.create();
  hasher.update(domain);
  hasher.update(bytes);
  return `0x${Array.from(
    hasher.digest() as Uint8Array,
    (byte: number) => byte.toString(16).padStart(2, '0'),
  ).join('')}` as Digest32V1;
}

function fail(
  code: SwmAuthorInventoryCodecErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new SwmAuthorInventoryCodecErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
