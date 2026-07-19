import {
  canonicalizeJson,
  parseCanonicalJson,
  type CanonicalJsonValue,
  type StrictJsonParseOptions,
} from './canonical-json.js';
import {
  assertContextGraphIdV1,
  assertNetworkIdV1,
  assertSubGraphNameV1,
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
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type TimestampMsV1,
} from './sync-wire-scalars.js';
import { assertExactKeys, isPlainRecord } from './sync-wire-objects.js';

export const AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1 =
  'AuthorCatalogIssuerDelegationV1' as const;
export const CATALOG_HEAD_TIMELINESS_RECEIPT_OBJECT_TYPE_V1 =
  'CatalogHeadTimelinessReceiptV1' as const;
export const MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_BYTES_V1 = 16 * 1024;
export const MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_DEPTH_V1 = 1;

const UTF8 = new TextEncoder();

export interface AuthorCatalogIssuerDelegationV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly governanceChainId: ChainIdV1 | null;
  readonly governanceContractAddress: EvmAddressV1 | null;
  readonly ownershipTransitionDigest: Digest32V1 | null;
  readonly subGraphName: SubGraphNameV1 | null;
  readonly authorAddress: EvmAddressV1;
  readonly catalogEra: DecimalU64V1;
  readonly previousDelegationDigest: Digest32V1 | null;
  readonly catalogIssuerKey: EvmAddressV1;
  readonly authorAuthorityEvidenceDigest: Digest32V1 | null;
  readonly effectiveAt: TimestampMsV1;
  readonly expiresAt: TimestampMsV1;
}

export interface CatalogHeadTimelinessReceiptV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly governanceChainId: ChainIdV1 | null;
  readonly governanceContractAddress: EvmAddressV1 | null;
  readonly ownershipTransitionDigest: Digest32V1 | null;
  readonly subGraphName: SubGraphNameV1 | null;
  readonly checkpointAuthorityDelegationDigest: Digest32V1;
  readonly authorAddress: EvmAddressV1;
  readonly catalogIssuerDelegationDigest: Digest32V1;
  readonly catalogHeadDigest: Digest32V1;
  readonly observedAt: TimestampMsV1;
}

export type UnsignedAuthorCatalogIssuerDelegationEnvelopeV1 = UnsignedControlEnvelopeV1 & {
  readonly objectType: typeof AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1;
  readonly payload: AuthorCatalogIssuerDelegationV1;
};
export type SignedAuthorCatalogIssuerDelegationEnvelopeV1 = SignedControlEnvelopeV1 & {
  readonly objectType: typeof AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1;
  readonly payload: AuthorCatalogIssuerDelegationV1;
};
export type UnsignedCatalogHeadTimelinessReceiptEnvelopeV1 = UnsignedControlEnvelopeV1 & {
  readonly objectType: typeof CATALOG_HEAD_TIMELINESS_RECEIPT_OBJECT_TYPE_V1;
  readonly payload: CatalogHeadTimelinessReceiptV1;
};
export type SignedCatalogHeadTimelinessReceiptEnvelopeV1 = SignedControlEnvelopeV1 & {
  readonly objectType: typeof CATALOG_HEAD_TIMELINESS_RECEIPT_OBJECT_TYPE_V1;
  readonly payload: CatalogHeadTimelinessReceiptV1;
};

export type AuthorCatalogAuthorityCodecErrorCode =
  | 'catalog-authority-schema'
  | 'catalog-authority-scalar'
  | 'catalog-authority-type'
  | 'catalog-authority-governance'
  | 'catalog-authority-history'
  | 'catalog-authority-authority'
  | 'catalog-authority-time'
  | 'catalog-authority-payload-too-large';

export class AuthorCatalogAuthorityCodecError extends Error {
  constructor(
    readonly code: AuthorCatalogAuthorityCodecErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'AuthorCatalogAuthorityCodecError';
  }
}

export function assertAuthorCatalogIssuerDelegationV1(
  value: unknown,
): asserts value is AuthorCatalogIssuerDelegationV1 {
  validateDelegationSnapshot(value);
}

export function assertCatalogHeadTimelinessReceiptV1(
  value: unknown,
): asserts value is CatalogHeadTimelinessReceiptV1 {
  validateReceiptSnapshot(value);
}

export function canonicalizeAuthorCatalogIssuerDelegationPayloadV1(
  value: AuthorCatalogIssuerDelegationV1,
): string {
  return validateDelegationSnapshot(value).canonical;
}

export function canonicalizeAuthorCatalogIssuerDelegationPayloadBytesV1(
  value: AuthorCatalogIssuerDelegationV1,
): Uint8Array {
  return UTF8.encode(canonicalizeAuthorCatalogIssuerDelegationPayloadV1(value));
}

export function canonicalizeCatalogHeadTimelinessReceiptPayloadV1(
  value: CatalogHeadTimelinessReceiptV1,
): string {
  return validateReceiptSnapshot(value).canonical;
}

export function canonicalizeCatalogHeadTimelinessReceiptPayloadBytesV1(
  value: CatalogHeadTimelinessReceiptV1,
): Uint8Array {
  return UTF8.encode(canonicalizeCatalogHeadTimelinessReceiptPayloadV1(value));
}

export function parseCanonicalAuthorCatalogIssuerDelegationPayloadV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): AuthorCatalogIssuerDelegationV1 {
  rejectOversizedInput(input, 'author catalog issuer delegation');
  return validateDelegationSnapshot(parseCanonicalJson(input, {
    ...options,
    maxBytes: Math.min(
      options.maxBytes ?? MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_BYTES_V1,
      MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_BYTES_V1,
    ),
    maxDepth: Math.min(
      options.maxDepth ?? MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_DEPTH_V1,
      MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_DEPTH_V1,
    ),
  })).snapshot;
}

export function parseCanonicalCatalogHeadTimelinessReceiptPayloadV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): CatalogHeadTimelinessReceiptV1 {
  rejectOversizedInput(input, 'catalog head timeliness receipt');
  return validateReceiptSnapshot(parseCanonicalJson(input, {
    ...options,
    maxBytes: Math.min(
      options.maxBytes ?? MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_BYTES_V1,
      MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_BYTES_V1,
    ),
    maxDepth: Math.min(
      options.maxDepth ?? MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_DEPTH_V1,
      MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_DEPTH_V1,
    ),
  })).snapshot;
}

export function assertUnsignedAuthorCatalogIssuerDelegationEnvelopeV1(
  value: UnsignedControlEnvelopeV1,
): asserts value is UnsignedAuthorCatalogIssuerDelegationEnvelopeV1 {
  validateUnsignedDelegationEnvelopeSnapshot(value);
}

export function assertSignedAuthorCatalogIssuerDelegationEnvelopeV1(
  value: SignedControlEnvelopeV1,
): asserts value is SignedAuthorCatalogIssuerDelegationEnvelopeV1 {
  validateSignedDelegationEnvelopeSnapshot(value);
}

export function assertUnsignedCatalogHeadTimelinessReceiptEnvelopeV1(
  value: UnsignedControlEnvelopeV1,
): asserts value is UnsignedCatalogHeadTimelinessReceiptEnvelopeV1 {
  validateUnsignedReceiptEnvelopeSnapshot(value);
}

export function assertSignedCatalogHeadTimelinessReceiptEnvelopeV1(
  value: SignedControlEnvelopeV1,
): asserts value is SignedCatalogHeadTimelinessReceiptEnvelopeV1 {
  validateSignedReceiptEnvelopeSnapshot(value);
}

export function canonicalizeUnsignedAuthorCatalogIssuerDelegationEnvelopeBytesV1(
  value: UnsignedControlEnvelopeV1,
): Uint8Array {
  return canonicalizeUnsignedControlEnvelopeBytes(validateUnsignedDelegationEnvelopeSnapshot(value));
}

export function canonicalizeSignedAuthorCatalogIssuerDelegationEnvelopeBytesV1(
  value: SignedControlEnvelopeV1,
): Uint8Array {
  return canonicalizeSignedControlEnvelopeBytes(validateSignedDelegationEnvelopeSnapshot(value));
}

export function canonicalizeUnsignedCatalogHeadTimelinessReceiptEnvelopeBytesV1(
  value: UnsignedControlEnvelopeV1,
): Uint8Array {
  return canonicalizeUnsignedControlEnvelopeBytes(validateUnsignedReceiptEnvelopeSnapshot(value));
}

export function canonicalizeSignedCatalogHeadTimelinessReceiptEnvelopeBytesV1(
  value: SignedControlEnvelopeV1,
): Uint8Array {
  return canonicalizeSignedControlEnvelopeBytes(validateSignedReceiptEnvelopeSnapshot(value));
}

export function computeAuthorCatalogIssuerDelegationObjectDigestV1(
  value: UnsignedControlEnvelopeV1,
): Digest32V1 {
  return asDigest(computeControlObjectDigestHex(validateUnsignedDelegationEnvelopeSnapshot(value)));
}

export function computeCatalogHeadTimelinessReceiptObjectDigestV1(
  value: UnsignedControlEnvelopeV1,
): Digest32V1 {
  return asDigest(computeControlObjectDigestHex(validateUnsignedReceiptEnvelopeSnapshot(value)));
}

export function parseCanonicalUnsignedAuthorCatalogIssuerDelegationEnvelopeV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): UnsignedAuthorCatalogIssuerDelegationEnvelopeV1 {
  return validateUnsignedDelegationEnvelopeSnapshot(
    parseCanonicalUnsignedControlEnvelope(input, options),
  );
}

export function parseCanonicalSignedAuthorCatalogIssuerDelegationEnvelopeV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): SignedAuthorCatalogIssuerDelegationEnvelopeV1 {
  return validateSignedDelegationEnvelopeSnapshot(
    parseCanonicalSignedControlEnvelope(input, options),
  );
}

export function parseCanonicalUnsignedCatalogHeadTimelinessReceiptEnvelopeV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): UnsignedCatalogHeadTimelinessReceiptEnvelopeV1 {
  return validateUnsignedReceiptEnvelopeSnapshot(
    parseCanonicalUnsignedControlEnvelope(input, options),
  );
}

export function parseCanonicalSignedCatalogHeadTimelinessReceiptEnvelopeV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): SignedCatalogHeadTimelinessReceiptEnvelopeV1 {
  return validateSignedReceiptEnvelopeSnapshot(
    parseCanonicalSignedControlEnvelope(input, options),
  );
}

function validateUnsignedDelegationEnvelopeSnapshot(
  value: unknown,
): UnsignedAuthorCatalogIssuerDelegationEnvelopeV1 {
  assertUnsignedControlEnvelope(value as UnsignedControlEnvelopeV1);
  const envelope = value as UnsignedControlEnvelopeV1;
  assertObjectType(envelope.objectType, AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1);
  validateDelegationPlain(envelope.payload);
  const snapshot = clonePlainData(envelope, 'unsigned catalog issuer delegation envelope');
  assertUnsignedControlEnvelope(snapshot);
  assertObjectType(snapshot.objectType, AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1);
  validateDelegationPlain(snapshot.payload);
  const typedSnapshot = snapshot as UnsignedAuthorCatalogIssuerDelegationEnvelopeV1;
  assertDelegationAuthorPairing(typedSnapshot);
  return typedSnapshot;
}

function validateSignedDelegationEnvelopeSnapshot(
  value: unknown,
): SignedAuthorCatalogIssuerDelegationEnvelopeV1 {
  assertSignedControlEnvelope(value as SignedControlEnvelopeV1);
  const envelope = value as SignedControlEnvelopeV1;
  assertObjectType(envelope.objectType, AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1);
  validateDelegationPlain(envelope.payload);
  const snapshot = clonePlainData(envelope, 'signed catalog issuer delegation envelope');
  assertSignedControlEnvelope(snapshot);
  assertObjectType(snapshot.objectType, AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1);
  validateDelegationPlain(snapshot.payload);
  const typedSnapshot = snapshot as SignedAuthorCatalogIssuerDelegationEnvelopeV1;
  assertDelegationAuthorPairing(typedSnapshot);
  return typedSnapshot;
}

/**
 * Close the structural direct/delegated issuer branch on the stable envelope
 * snapshot. A non-null evidence digest is only a reference here: resolving and
 * verifying the referenced author/agent delegation remains a runtime authority
 * check, outside this wire codec.
 */
function assertDelegationAuthorPairing(
  envelope:
    | UnsignedAuthorCatalogIssuerDelegationEnvelopeV1
    | SignedAuthorCatalogIssuerDelegationEnvelopeV1,
): void {
  const issuerIsAuthor = envelope.issuer === envelope.payload.authorAddress;
  const evidenceIsNull = envelope.payload.authorAuthorityEvidenceDigest === null;
  if (issuerIsAuthor !== evidenceIsNull) {
    fail(
      'catalog-authority-authority',
      'the author must issue directly without authority evidence, and every other issuer must name authority evidence',
    );
  }
}

function validateUnsignedReceiptEnvelopeSnapshot(
  value: unknown,
): UnsignedCatalogHeadTimelinessReceiptEnvelopeV1 {
  assertUnsignedControlEnvelope(value as UnsignedControlEnvelopeV1);
  const envelope = value as UnsignedControlEnvelopeV1;
  assertObjectType(envelope.objectType, CATALOG_HEAD_TIMELINESS_RECEIPT_OBJECT_TYPE_V1);
  validateReceiptPlain(envelope.payload);
  const snapshot = clonePlainData(envelope, 'unsigned catalog timeliness receipt envelope');
  assertUnsignedControlEnvelope(snapshot);
  assertObjectType(snapshot.objectType, CATALOG_HEAD_TIMELINESS_RECEIPT_OBJECT_TYPE_V1);
  validateReceiptPlain(snapshot.payload);
  return snapshot as UnsignedCatalogHeadTimelinessReceiptEnvelopeV1;
}

function validateSignedReceiptEnvelopeSnapshot(
  value: unknown,
): SignedCatalogHeadTimelinessReceiptEnvelopeV1 {
  assertSignedControlEnvelope(value as SignedControlEnvelopeV1);
  const envelope = value as SignedControlEnvelopeV1;
  assertObjectType(envelope.objectType, CATALOG_HEAD_TIMELINESS_RECEIPT_OBJECT_TYPE_V1);
  validateReceiptPlain(envelope.payload);
  const snapshot = clonePlainData(envelope, 'signed catalog timeliness receipt envelope');
  assertSignedControlEnvelope(snapshot);
  assertObjectType(snapshot.objectType, CATALOG_HEAD_TIMELINESS_RECEIPT_OBJECT_TYPE_V1);
  validateReceiptPlain(snapshot.payload);
  return snapshot as SignedCatalogHeadTimelinessReceiptEnvelopeV1;
}

function validateDelegationSnapshot(value: unknown): {
  readonly snapshot: AuthorCatalogIssuerDelegationV1;
  readonly canonical: string;
} {
  const bounded = validateDelegationPlain(value);
  return validateDelegationPlain(clonePlainData(bounded.snapshot, 'catalog issuer delegation'));
}

function validateDelegationPlain(value: unknown): {
  readonly snapshot: AuthorCatalogIssuerDelegationV1;
  readonly canonical: string;
} {
  if (!isPlainRecord(value)) fail('catalog-authority-schema', 'delegation must be a plain object');
  closed(value, [
    'authorAddress',
    'authorAuthorityEvidenceDigest',
    'catalogEra',
    'catalogIssuerKey',
    'contextGraphId',
    'effectiveAt',
    'expiresAt',
    'governanceChainId',
    'governanceContractAddress',
    'networkId',
    'ownershipTransitionDigest',
    'previousDelegationDigest',
    'subGraphName',
  ], 'catalog issuer delegation');
  scalar(() => assertNetworkIdV1(value.networkId));
  scalar(() => assertContextGraphIdV1(value.contextGraphId));
  assertGovernanceScope(
    value.governanceChainId,
    value.governanceContractAddress,
    value.ownershipTransitionDigest,
  );
  if (value.subGraphName !== null) scalar(() => assertSubGraphNameV1(value.subGraphName));
  scalar(() => assertCanonicalEvmAddress(value.authorAddress, 'authorAddress'));
  const era = u64(value.catalogEra, 'catalogEra');
  optionalDigest(value.previousDelegationDigest, 'previousDelegationDigest');
  if ((era === 0n) !== (value.previousDelegationDigest === null)) {
    fail(
      'catalog-authority-history',
      'catalog era zero requires a null predecessor and later eras require one',
    );
  }
  scalar(() => assertCanonicalEvmAddress(value.catalogIssuerKey, 'catalogIssuerKey'));
  optionalDigest(value.authorAuthorityEvidenceDigest, 'authorAuthorityEvidenceDigest');
  const effectiveAt = timestamp(value.effectiveAt, 'effectiveAt');
  const expiresAt = timestamp(value.expiresAt, 'expiresAt');
  if (effectiveAt >= expiresAt) {
    fail('catalog-authority-time', 'effectiveAt must be strictly earlier than expiresAt');
  }
  const snapshot = value as unknown as AuthorCatalogIssuerDelegationV1;
  return { snapshot, canonical: canonicalizeBounded(snapshot, 'catalog issuer delegation') };
}

function validateReceiptSnapshot(value: unknown): {
  readonly snapshot: CatalogHeadTimelinessReceiptV1;
  readonly canonical: string;
} {
  const bounded = validateReceiptPlain(value);
  return validateReceiptPlain(clonePlainData(bounded.snapshot, 'catalog head timeliness receipt'));
}

function validateReceiptPlain(value: unknown): {
  readonly snapshot: CatalogHeadTimelinessReceiptV1;
  readonly canonical: string;
} {
  if (!isPlainRecord(value)) fail('catalog-authority-schema', 'receipt must be a plain object');
  closed(value, [
    'authorAddress',
    'catalogHeadDigest',
    'catalogIssuerDelegationDigest',
    'checkpointAuthorityDelegationDigest',
    'contextGraphId',
    'governanceChainId',
    'governanceContractAddress',
    'networkId',
    'observedAt',
    'ownershipTransitionDigest',
    'subGraphName',
  ], 'catalog head timeliness receipt');
  scalar(() => assertNetworkIdV1(value.networkId));
  scalar(() => assertContextGraphIdV1(value.contextGraphId));
  assertGovernanceScope(
    value.governanceChainId,
    value.governanceContractAddress,
    value.ownershipTransitionDigest,
  );
  if (value.subGraphName !== null) scalar(() => assertSubGraphNameV1(value.subGraphName));
  scalar(() => assertCanonicalDigest(
    value.checkpointAuthorityDelegationDigest,
    'checkpointAuthorityDelegationDigest',
  ));
  scalar(() => assertCanonicalEvmAddress(value.authorAddress, 'authorAddress'));
  scalar(() => assertCanonicalDigest(
    value.catalogIssuerDelegationDigest,
    'catalogIssuerDelegationDigest',
  ));
  scalar(() => assertCanonicalDigest(value.catalogHeadDigest, 'catalogHeadDigest'));
  timestamp(value.observedAt, 'observedAt');
  const snapshot = value as unknown as CatalogHeadTimelinessReceiptV1;
  return { snapshot, canonical: canonicalizeBounded(snapshot, 'catalog head timeliness receipt') };
}

function assertGovernanceScope(
  chainId: unknown,
  contractAddress: unknown,
  ownershipTransitionDigest: unknown,
): void {
  if ((chainId === null) !== (contractAddress === null)) {
    fail('catalog-authority-governance', 'governance tuple must be jointly null/non-null');
  }
  if (chainId === null) {
    if (ownershipTransitionDigest !== null) {
      fail('catalog-authority-governance', 'unregistered scope cannot name a transition');
    }
    return;
  }
  scalar(() => assertCanonicalChainId(chainId));
  scalar(() => assertCanonicalEvmAddress(contractAddress, 'governanceContractAddress'));
  optionalDigest(ownershipTransitionDigest, 'ownershipTransitionDigest');
}

function canonicalizeBounded(
  value: AuthorCatalogIssuerDelegationV1 | CatalogHeadTimelinessReceiptV1,
  label: string,
): string {
  try {
    return canonicalizeJson(value as unknown as CanonicalJsonValue, {
      maxBytes: MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_BYTES_V1,
      maxDepth: MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_DEPTH_V1,
    });
  } catch (cause) {
    fail('catalog-authority-payload-too-large', `${label} exceeds its canonical cap`, cause);
  }
}

function clonePlainData<T>(value: T, label: string): T {
  assertStablePlainData(value, label, 0, new Set<object>());
  try {
    return structuredClone(value);
  } catch (cause) {
    fail('catalog-authority-schema', `${label} must be structured-cloneable JSON data`, cause);
  }
}

function assertStablePlainData(
  value: unknown,
  label: string,
  depth: number,
  ancestors: Set<object>,
): void {
  if (depth > 64) fail('catalog-authority-schema', `${label} exceeds nesting safety cap`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('catalog-authority-schema', `${label} has a non-JSON number`);
    return;
  }
  if (typeof value !== 'object') {
    fail('catalog-authority-schema', `${label} has a non-JSON implementation value`);
  }
  if (ancestors.has(value)) fail('catalog-authority-schema', `${label} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        fail('catalog-authority-schema', `${label} contains a non-ordinary array`);
      }
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== 'string') || keys.length !== value.length + 1) {
        fail('catalog-authority-schema', `${label} contains a sparse or custom array`);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          fail('catalog-authority-schema', `${label} contains an array accessor`);
        }
        assertStablePlainData(descriptor.value, `${label}[${index}]`, depth + 1, ancestors);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('catalog-authority-schema', `${label} contains a non-plain object`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') fail('catalog-authority-schema', `${label} contains a symbol`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        fail('catalog-authority-schema', `${label} contains an object accessor`);
      }
      assertStablePlainData(descriptor.value, `${label}.${key}`, depth + 1, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function optionalDigest(value: unknown, label: string): void {
  if (value !== null) scalar(() => assertCanonicalDigest(value, label));
}

function u64(value: unknown, label: string): bigint {
  try {
    return parseCanonicalDecimalU64(value, label);
  } catch (cause) {
    fail('catalog-authority-scalar', `${label} must be canonical DecimalU64V1`, cause);
  }
}

function timestamp(value: unknown, label: string): bigint {
  scalar(() => assertCanonicalTimestampMs(value, label));
  return BigInt(value as string);
}

function scalar(operation: () => void): void {
  try {
    operation();
  } catch (cause) {
    fail('catalog-authority-scalar', 'catalog authority scalar is not canonical', cause);
  }
}

function closed(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  try {
    assertExactKeys(record, keys, label);
  } catch (cause) {
    fail('catalog-authority-schema', `${label} has an invalid field set`, cause);
  }
}

function assertObjectType(actual: string, expected: string): void {
  if (actual !== expected) fail('catalog-authority-type', `objectType must be exactly ${expected}`);
}

function asDigest(value: string): Digest32V1 {
  assertCanonicalDigest(value, 'objectDigest');
  return value;
}

function rejectOversizedInput(input: string | Uint8Array, label: string): void {
  if (
    typeof input === 'string'
    && input.length > MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_BYTES_V1
  ) {
    fail(
      'catalog-authority-payload-too-large',
      `${label} exceeds ${MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_BYTES_V1} bytes`,
    );
  }
  const bytes = typeof input === 'string' ? UTF8.encode(input).byteLength : input.byteLength;
  if (bytes > MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_BYTES_V1) {
    fail(
      'catalog-authority-payload-too-large',
      `${label} exceeds ${MAX_AUTHOR_CATALOG_AUTHORITY_PAYLOAD_BYTES_V1} bytes`,
    );
  }
}

function fail(
  code: AuthorCatalogAuthorityCodecErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new AuthorCatalogAuthorityCodecError(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
