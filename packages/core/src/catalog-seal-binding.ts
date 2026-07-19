import {
  assertAuthorCatalogRowScopeBindingV1,
  assertAuthorCatalogRowV1,
  assertAuthorCatalogScopeV1,
  assertNetworkIdV1,
  buildCatalogAssertionScopeV1,
  canonicalizeAuthorCatalogRowV1,
  canonicalizeAuthorCatalogScopeV1,
  computeAuthorCatalogRowDigestV1,
  computeAuthorCatalogScopeDigestV1,
  iriComponentV1,
  parseCanonicalAuthorCatalogRowV1,
  parseCanonicalAuthorCatalogScopeV1,
  type AssertionCoordinateV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type NetworkIdV1,
} from './author-catalog-codec.js';
import {
  MAX_CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_BYTES_V1,
  classifyCanonicalGraphScopedAuthorSealRowsV1,
  parseCanonicalGraphScopedAuthorSealV1,
  projectCanonicalGraphScopedAuthorSealStoreRowsV1,
  type CanonicalGraphScopedAuthorSealPlacementV1,
  type CanonicalGraphScopedAuthorSealRowV1,
  type CanonicalGraphScopedAuthorSealV1,
} from './canonical-graph-scoped-author-seal.js';
import { parseDeterministicKnowledgeAssetUal } from './ka-content-scope.js';
import {
  assertCanonicalChainId,
  assertCanonicalEvmAddress,
  type ChainIdV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type KaIdV1,
} from './sync-wire-scalars.js';
import { assertExactKeys, isPlainRecord } from './sync-wire-objects.js';

declare const VERIFIED_CATALOG_SEAL_BINDING_BRAND_V1: unique symbol;

/** Pinned v10 lane mapping supplied by local subscription configuration. */
export interface CatalogSealDeploymentProfileV1 {
  readonly networkId: NetworkIdV1;
  readonly assertedAtChainId: ChainIdV1;
  readonly assertedAtKav10Address: EvmAddressV1;
}

/**
 * Unforgeable process-local proof that transferred canonical seal bytes match
 * one exact catalog row and locally pinned deployment profile.
 *
 * This is intentionally not `SemanticallyAdmittedCatalogRowV1`: KA projection
 * RDFC/structured-root verification, author-signature recovery, finalized VM
 * evidence, semantic-store commit, and post-read verification remain mandatory.
 */
export interface VerifiedCatalogSealBindingV1 {
  readonly [VERIFIED_CATALOG_SEAL_BINDING_BRAND_V1]: true;
}

export interface VerifiedCatalogSealBindingSnapshotV1 {
  readonly catalogScopeDigest: Digest32V1;
  readonly catalogRowDigest: Digest32V1;
  readonly networkId: NetworkIdV1;
  readonly authorAddress: EvmAddressV1;
  readonly kaId: KaIdV1;
  readonly assertionCoordinate: AssertionCoordinateV1;
  readonly assertionVersion: DecimalU64V1;
  readonly sealDigest: Digest32V1;
  readonly placement: Readonly<CanonicalGraphScopedAuthorSealPlacementV1>;
  readonly seal: Readonly<CanonicalGraphScopedAuthorSealV1>;
  readonly sealRows: readonly Readonly<CanonicalGraphScopedAuthorSealRowV1>[];
  /** Caller-owned copy; mutating it cannot alter the verifier's retained state. */
  readonly canonicalSealBytes: Uint8Array;
}

export type CatalogSealBindingErrorCode =
  | 'catalog-seal-input'
  | 'catalog-seal-profile'
  | 'catalog-seal-classifier'
  | 'catalog-seal-coordinate'
  | 'catalog-seal-ual'
  | 'catalog-seal-ka-id'
  | 'catalog-seal-version'
  | 'catalog-seal-digest'
  | 'catalog-seal-deployment'
  | 'catalog-seal-capability';

export class CatalogSealBindingError extends Error {
  constructor(
    readonly code: CatalogSealBindingErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'CatalogSealBindingError';
  }
}

interface CatalogSealBindingStateV1 {
  readonly snapshot: Omit<VerifiedCatalogSealBindingSnapshotV1, 'canonicalSealBytes'>;
  readonly canonicalSealBytes: Uint8Array;
}

const VERIFIED_CATALOG_SEAL_BINDINGS_V1 = new WeakMap<
  object,
  CatalogSealBindingStateV1
>();
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const GET_TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'buffer',
)!.get!;
const GET_TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
)!.get!;
const GET_TYPED_ARRAY_TAG = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  Symbol.toStringTag,
)!.get!;

/**
 * Bind one transferred canonical author seal to a staged catalog row.
 *
 * The strict typed-row reconstruction invokes PR #1780's canonical classifier
 * exactly once. This function performs no RDF payload parsing or persistence.
 */
export function verifyCatalogSealBindingV1(
  catalogScope: AuthorCatalogScopeV1,
  row: AuthorCatalogRowV1,
  canonicalSealBytes: Uint8Array,
  deployment: CatalogSealDeploymentProfileV1,
): VerifiedCatalogSealBindingV1 {
  let scope: AuthorCatalogScopeV1;
  let catalogRow: AuthorCatalogRowV1;
  try {
    assertAuthorCatalogScopeV1(catalogScope);
    assertAuthorCatalogRowV1(row);
    scope = parseCanonicalAuthorCatalogScopeV1(
      canonicalizeAuthorCatalogScopeV1(catalogScope),
    );
    catalogRow = parseCanonicalAuthorCatalogRowV1(
      canonicalizeAuthorCatalogRowV1(row),
    );
    assertAuthorCatalogRowScopeBindingV1(catalogRow, scope);
  } catch (cause) {
    fail('catalog-seal-input', 'catalog scope or row is not structurally bound', cause);
  }
  assertDeploymentProfile(deployment);
  const pinnedDeployment = Object.freeze({
    networkId: deployment.networkId,
    assertedAtChainId: deployment.assertedAtChainId,
    assertedAtKav10Address: deployment.assertedAtKav10Address,
  });
  if (pinnedDeployment.networkId !== scope.networkId) {
    fail('catalog-seal-deployment', 'deployment networkId differs from catalog scope');
  }
  const receivedSealBytes = snapshotCanonicalBytes(canonicalSealBytes);
  let seal: CanonicalGraphScopedAuthorSealV1;
  try {
    seal = parseCanonicalGraphScopedAuthorSealV1(receivedSealBytes);
  } catch (cause) {
    fail('catalog-seal-input', 'canonicalSealBytes are not a canonical graph-scoped seal', cause);
  }

  const coordinate = {
    contextGraphId: scope.contextGraphId,
    subGraphName: scope.subGraphName,
    authorAddress: scope.authorAddress,
    assertionCoordinate: catalogRow.assertionCoordinate,
  };
  let classified: ReturnType<typeof classifyCanonicalGraphScopedAuthorSealRowsV1>;
  try {
    const storeRows = projectCanonicalGraphScopedAuthorSealStoreRowsV1(seal, coordinate);
    classified = classifyCanonicalGraphScopedAuthorSealRowsV1(storeRows, coordinate);
  } catch (cause) {
    fail(
      'catalog-seal-classifier',
      'strict typed-row reconstruction or PR #1780 classification failed',
      cause,
    );
  }

  if (!equalBytes(receivedSealBytes, classified.canonicalSealBytes)) {
    fail('catalog-seal-digest', 'classifier reconstruction changed canonical seal bytes');
  }
  const expectedScope = buildCatalogAssertionScopeV1(scope);
  if (
    classified.candidate.coordinate.scope !== expectedScope
    || classified.candidate.coordinate.agentAddress !== scope.authorAddress
    || classified.candidate.coordinate.name !== iriComponentV1(catalogRow.assertionCoordinate)
  ) {
    fail('catalog-seal-coordinate', 'PR #1780 coordinate differs from the catalog row');
  }

  let ual: ReturnType<typeof parseDeterministicKnowledgeAssetUal>;
  try {
    ual = parseDeterministicKnowledgeAssetUal(seal.kaUal);
  } catch (cause) {
    fail('catalog-seal-ual', 'seal UAL is not a canonical packed graph identity', cause);
  }
  if (
    ual.chainId !== pinnedDeployment.networkId
    || ual.agentAddress !== scope.authorAddress
    || classified.candidate.seal.kaUal !== seal.kaUal
  ) {
    fail('catalog-seal-ual', 'seal UAL namespace or author differs from the pinned catalog lane');
  }

  const expectedKaId = (BigInt(ual.agentAddress) << 96n) | BigInt(ual.kaNumber);
  if (
    BigInt(catalogRow.kaId) !== expectedKaId
    || BigInt(seal.reservedKaId) !== expectedKaId
    || classified.candidate.seal.reservedKaId !== expectedKaId
  ) {
    fail('catalog-seal-ka-id', 'UAL, row kaId, and reservedKaId do not identify one KA');
  }
  if (
    seal.assertionVersion !== catalogRow.assertionVersion
    || classified.candidate.seal.assertionVersion !== catalogRow.assertionVersion
  ) {
    fail('catalog-seal-version', 'seal assertionVersion differs from the catalog row');
  }
  if (classified.sealDigest !== catalogRow.sealDigest) {
    fail('catalog-seal-digest', 'canonical seal digest differs from the catalog row');
  }
  if (
    seal.assertedAtChainId !== pinnedDeployment.assertedAtChainId
    || seal.assertedAtKav10Address !== pinnedDeployment.assertedAtKav10Address
    || classified.candidate.seal.chainId !== BigInt(pinnedDeployment.assertedAtChainId)
    || classified.candidate.seal.kav10Address !== pinnedDeployment.assertedAtKav10Address
  ) {
    fail('catalog-seal-deployment', 'seal chain or KAv10 deployment differs from local pins');
  }

  const placement = Object.freeze({ ...classified.placement });
  const sealSnapshot = Object.freeze({ ...classified.payload });
  const sealRows = Object.freeze(classified.rows.map((sealRow) => Object.freeze({ ...sealRow })));
  const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(scope);
  const snapshot = Object.freeze({
    catalogScopeDigest,
    catalogRowDigest: computeAuthorCatalogRowDigestV1(
      catalogScopeDigest,
      catalogRow,
    ),
    networkId: pinnedDeployment.networkId,
    authorAddress: scope.authorAddress,
    kaId: catalogRow.kaId,
    assertionCoordinate: catalogRow.assertionCoordinate,
    assertionVersion: catalogRow.assertionVersion,
    sealDigest: classified.sealDigest,
    placement,
    seal: sealSnapshot,
    sealRows,
  });
  const capability = Object.freeze(Object.create(null)) as VerifiedCatalogSealBindingV1;
  VERIFIED_CATALOG_SEAL_BINDINGS_V1.set(capability as object, Object.freeze({
    snapshot,
    canonicalSealBytes: receivedSealBytes,
  }));
  return capability;
}

export function assertVerifiedCatalogSealBindingV1(
  value: unknown,
): asserts value is VerifiedCatalogSealBindingV1 {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    fail('catalog-seal-capability', 'catalog seal binding was not minted by this verifier');
  }
  if (!VERIFIED_CATALOG_SEAL_BINDINGS_V1.has(value as object)) {
    fail('catalog-seal-capability', 'catalog seal binding was not minted by this verifier');
  }
}

/** Return immutable scalar state plus a fresh caller-owned canonical byte copy. */
export function readVerifiedCatalogSealBindingV1(
  value: unknown,
): VerifiedCatalogSealBindingSnapshotV1 {
  assertVerifiedCatalogSealBindingV1(value);
  const state = VERIFIED_CATALOG_SEAL_BINDINGS_V1.get(value as object)!;
  return Object.freeze({
    ...state.snapshot,
    canonicalSealBytes: new Uint8Array(state.canonicalSealBytes),
  });
}

function assertDeploymentProfile(
  deployment: unknown,
): asserts deployment is CatalogSealDeploymentProfileV1 {
  try {
    if (!isPlainRecord(deployment)) throw new Error('profile must be a plain object');
    assertExactKeys(
      deployment,
      ['assertedAtChainId', 'assertedAtKav10Address', 'networkId'],
      'catalog seal deployment profile',
    );
    assertNetworkIdV1(deployment.networkId);
    assertCanonicalChainId(deployment.assertedAtChainId, 'assertedAtChainId');
    assertCanonicalEvmAddress(deployment.assertedAtKav10Address, 'assertedAtKav10Address');
  } catch (cause) {
    fail('catalog-seal-profile', 'deployment profile is not canonical', cause);
  }
}

function snapshotCanonicalBytes(value: unknown): Uint8Array {
  let backingBuffer: ArrayBufferLike;
  let byteLength: number;
  let typedArrayTag: string | undefined;
  try {
    backingBuffer = Reflect.apply(GET_TYPED_ARRAY_BUFFER, value, []);
    byteLength = Reflect.apply(GET_TYPED_ARRAY_BYTE_LENGTH, value, []);
    typedArrayTag = Reflect.apply(GET_TYPED_ARRAY_TAG, value, []);
  } catch (cause) {
    fail('catalog-seal-input', 'canonicalSealBytes must be a genuine Uint8Array', cause);
  }
  if (typedArrayTag !== 'Uint8Array') {
    fail('catalog-seal-input', 'canonicalSealBytes must be a Uint8Array');
  }
  if (!(backingBuffer instanceof ArrayBuffer)) {
    fail('catalog-seal-input', 'canonicalSealBytes must not use shared backing memory');
  }
  if ((backingBuffer as ArrayBuffer & { readonly resizable?: boolean }).resizable === true) {
    fail('catalog-seal-input', 'canonicalSealBytes must not use resizable backing memory');
  }
  if (byteLength > MAX_CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_BYTES_V1) {
    fail(
      'catalog-seal-input',
      `canonicalSealBytes exceed ${MAX_CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_BYTES_V1} bytes`,
    );
  }
  try {
    // Always normalize Buffer and typed-array subclasses to an ordinary,
    // independently backed Uint8Array. Buffer.prototype.slice() returns a
    // shared view, so retaining a Buffer here would make later reads mutable.
    return new Uint8Array(value as Uint8Array);
  } catch (cause) {
    fail('catalog-seal-input', 'canonicalSealBytes could not be snapshotted safely', cause);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function fail(
  code: CatalogSealBindingErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new CatalogSealBindingError(code, message, cause === undefined ? {} : { cause });
}
