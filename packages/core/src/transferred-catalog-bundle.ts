import {
  assertAuthorCatalogRowScopeBindingV1,
  assertAuthorCatalogRowV1,
  assertNetworkIdV1,
  canonicalizeAuthorCatalogRowV1,
  computeAuthorCatalogRowDigestV1,
  computeAuthorCatalogScopeDigestV1,
  parseCanonicalAuthorCatalogRowV1,
  type AuthorCatalogRowV1,
  type NetworkIdV1,
} from './author-catalog-codec.js';
import {
  canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1,
  deriveAuthorCatalogScopeFromHeadV1,
  parseCanonicalSignedAuthorCatalogHeadEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
} from './author-catalog-objects.js';
import {
  readVerifiedCatalogSealBindingV1,
  verifyCatalogSealBindingV1,
  type CatalogSealDeploymentProfileV1,
  type VerifiedCatalogSealBindingV1,
} from './catalog-seal-binding.js';
import { decodeOpaqueKaBundleV1 } from './ka-bundle-v1.js';
import { computeKaChunkTreeRootV1 } from './ka-chunk-tree.js';
import {
  MAX_KA_TRANSFER_BYTES_V1,
  MIN_KA_TRANSFER_BYTES_V1,
  assertKaTransferDescriptorV1,
  computeKaTransferIdentityDigestV1,
  type KaTransferDescriptorV1,
} from './ka-transfer-descriptor.js';
import {
  assertCanonicalChainId,
  assertCanonicalEvmAddress,
  type ByteLengthV1,
  type Digest32V1,
  type EvmAddressV1,
} from './sync-wire-scalars.js';
import { assertExactKeys, isPlainRecord } from './sync-wire-objects.js';

declare const VERIFIED_TRANSFERRED_CATALOG_BUNDLE_BRAND_V1: unique symbol;

/**
 * Unforgeable process-local proof that one complete received byte string matches
 * one exact catalog row, signed head, and locally pinned deployment profile.
 *
 * This is a structural pre-admission capability only. It grants no RDF semantic,
 * structured-root, author-signature, VM-finality, triple-store, catalog-authority,
 * or activation authority.
 */
export interface VerifiedTransferredCatalogBundleV1 {
  readonly [VERIFIED_TRANSFERRED_CATALOG_BUNDLE_BRAND_V1]: true;
}

export interface VerifiedTransferredCatalogBundleSnapshotV1 {
  readonly headObjectDigest: Digest32V1;
  readonly headIssuer: EvmAddressV1;
  readonly catalogScopeDigest: Digest32V1;
  readonly catalogRowDigest: Digest32V1;
  readonly transferIdentityDigest: Digest32V1;
  readonly deployment: Readonly<CatalogSealDeploymentProfileV1>;
  readonly transfer: Readonly<KaTransferDescriptorV1>;
  readonly projectionByteLength: ByteLengthV1;
  readonly sealByteLength: ByteLengthV1;
  readonly projectionDigest: Digest32V1;
  readonly blobDigest: Digest32V1;
  readonly chunkTreeRoot: Digest32V1;
  /** Structural seal/row binding only; it is not semantic admission. */
  readonly catalogSealBinding: VerifiedCatalogSealBindingV1;
  /** Fresh caller-owned copy of the complete received bundle. */
  readonly bundleBytes: Uint8Array;
}

export type VerifiedTransferredCatalogBundleMetadataV1 = Omit<
  VerifiedTransferredCatalogBundleSnapshotV1,
  'bundleBytes'
>;

export type TransferredCatalogBundleErrorCode =
  | 'transferred-bundle-head'
  | 'transferred-bundle-row'
  | 'transferred-bundle-profile'
  | 'transferred-bundle-input'
  | 'transferred-bundle-length'
  | 'transferred-bundle-codec'
  | 'transferred-bundle-projection-digest'
  | 'transferred-bundle-blob-digest'
  | 'transferred-bundle-chunk-tree'
  | 'transferred-bundle-seal'
  | 'transferred-bundle-capability'
  | 'transferred-bundle-binding';

export class TransferredCatalogBundleError extends Error {
  constructor(
    readonly code: TransferredCatalogBundleErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'TransferredCatalogBundleError';
  }
}

interface TransferredCatalogBundleInputsV1 {
  readonly signedHead: SignedAuthorCatalogHeadEnvelopeV1;
  readonly row: AuthorCatalogRowV1;
  readonly deployment: Readonly<CatalogSealDeploymentProfileV1>;
  readonly signedHeadBytes: Uint8Array;
  readonly rowBytes: Uint8Array;
}

interface TransferredCatalogBundleStateV1 {
  readonly signedHeadBytes: Uint8Array;
  readonly rowBytes: Uint8Array;
  readonly deployment: Readonly<CatalogSealDeploymentProfileV1>;
  readonly snapshot: Omit<VerifiedTransferredCatalogBundleSnapshotV1, 'bundleBytes'>;
  readonly bundleBytes: Uint8Array;
}

const VERIFIED_TRANSFERRED_CATALOG_BUNDLES_V1 = new WeakMap<
  object,
  TransferredCatalogBundleStateV1
>();
const UTF8 = new TextEncoder();
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
 * Verify the complete structural transfer boundary for one catalog row.
 *
 * The received byte view is copied in full before the decoder returns any
 * borrowed projection/seal views. The seal view is consumed only by
 * {@link verifyCatalogSealBindingV1}, which is the sole PR #1780 path.
 */
export function verifyTransferredCatalogBundleV1(
  signedHead: SignedAuthorCatalogHeadEnvelopeV1,
  row: AuthorCatalogRowV1,
  receivedBundleBytes: Uint8Array,
  deployment: CatalogSealDeploymentProfileV1,
): VerifiedTransferredCatalogBundleV1 {
  const inputs = snapshotTransferredBundleInputs(
    signedHead,
    row,
    deployment,
  );
  const transfer = inputs.row.transfer;
  // Snapshot before decode: no borrowed projection or seal view can outlive the
  // complete independently owned received-byte snapshot.
  const bundleBytes = snapshotCompleteBundleBytes(receivedBundleBytes);
  const receivedByteLength = BigInt(bundleBytes.byteLength);
  if (receivedByteLength !== BigInt(transfer.byteLength)) {
    fail(
      'transferred-bundle-length',
      'complete received byte length differs from row.transfer.byteLength',
    );
  }

  let decoded: ReturnType<typeof decodeOpaqueKaBundleV1>;
  try {
    decoded = decodeOpaqueKaBundleV1(bundleBytes);
  } catch (cause) {
    fail('transferred-bundle-codec', 'received bytes are not one strict opaque KA bundle', cause);
  }
  if (
    decoded.projectionDigest !== transfer.projectionDigest
    || decoded.projectionDigest !== inputs.row.projectionDigest
  ) {
    fail(
      'transferred-bundle-projection-digest',
      'decoded projection digest differs from the descriptor or catalog row',
    );
  }
  if (decoded.blobDigest !== transfer.blobDigest) {
    fail(
      'transferred-bundle-blob-digest',
      'complete bundle digest differs from row.transfer.blobDigest',
    );
  }

  let chunkTreeRoot: Digest32V1;
  try {
    chunkTreeRoot = computeKaChunkTreeRootV1(bundleBytes);
  } catch (cause) {
    fail(
      'transferred-bundle-chunk-tree',
      'complete received bytes could not produce the canonical chunk tree',
      cause,
    );
  }
  if (chunkTreeRoot !== transfer.chunkTreeRoot) {
    fail(
      'transferred-bundle-chunk-tree',
      'recomputed complete chunk-tree root differs from the descriptor',
    );
  }

  const scope = deriveAuthorCatalogScopeFromHeadV1(inputs.signedHead.payload);
  let catalogSealBinding: VerifiedCatalogSealBindingV1;
  try {
    catalogSealBinding = verifyCatalogSealBindingV1(
      scope,
      inputs.row,
      decoded.sealBytes,
      inputs.deployment,
    );
  } catch (cause) {
    fail(
      'transferred-bundle-seal',
      'decoded seal bytes do not bind to the exact catalog row and deployment',
      cause,
    );
  }
  const sealBindingSnapshot = readVerifiedCatalogSealBindingV1(catalogSealBinding);
  const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(scope);
  const transferSnapshot = Object.freeze({ ...transfer });
  const deploymentSnapshot = inputs.deployment;
  const snapshot = Object.freeze({
    headObjectDigest: inputs.signedHead.objectDigest as Digest32V1,
    headIssuer: inputs.signedHead.issuer as EvmAddressV1,
    catalogScopeDigest,
    catalogRowDigest: computeAuthorCatalogRowDigestV1(catalogScopeDigest, inputs.row),
    transferIdentityDigest: computeKaTransferIdentityDigestV1(transfer),
    deployment: deploymentSnapshot,
    transfer: transferSnapshot,
    projectionByteLength: String(decoded.projectionBytes.byteLength) as ByteLengthV1,
    sealByteLength: String(decoded.sealBytes.byteLength) as ByteLengthV1,
    projectionDigest: decoded.projectionDigest,
    blobDigest: decoded.blobDigest,
    chunkTreeRoot,
    catalogSealBinding,
  });

  // Defensive internal consistency check: the nested structural proof must refer
  // to the same canonical scope/row values bound above.
  if (
    sealBindingSnapshot.catalogScopeDigest !== snapshot.catalogScopeDigest
    || sealBindingSnapshot.catalogRowDigest !== snapshot.catalogRowDigest
  ) {
    fail('transferred-bundle-seal', 'nested catalog seal binding changed row identity');
  }

  const capability = Object.freeze(Object.create(null)) as VerifiedTransferredCatalogBundleV1;
  VERIFIED_TRANSFERRED_CATALOG_BUNDLES_V1.set(capability as object, Object.freeze({
    signedHeadBytes: inputs.signedHeadBytes,
    rowBytes: inputs.rowBytes,
    deployment: deploymentSnapshot,
    snapshot,
    bundleBytes,
  }));
  return capability;
}

export function assertVerifiedTransferredCatalogBundleV1(
  value: unknown,
): asserts value is VerifiedTransferredCatalogBundleV1 {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    fail(
      'transferred-bundle-capability',
      'transferred bundle proof was not minted by this verifier',
    );
  }
  if (!VERIFIED_TRANSFERRED_CATALOG_BUNDLES_V1.has(value as object)) {
    fail(
      'transferred-bundle-capability',
      'transferred bundle proof was not minted by this verifier',
    );
  }
}

/** Require this capability to be consumed with the exact canonical inputs it bound. */
export function assertVerifiedTransferredCatalogBundleForInputsV1(
  value: unknown,
  signedHead: SignedAuthorCatalogHeadEnvelopeV1,
  row: AuthorCatalogRowV1,
  deployment: CatalogSealDeploymentProfileV1,
): asserts value is VerifiedTransferredCatalogBundleV1 {
  assertVerifiedTransferredCatalogBundleV1(value);
  const state = VERIFIED_TRANSFERRED_CATALOG_BUNDLES_V1.get(value as object)!;
  let inputs: TransferredCatalogBundleInputsV1;
  try {
    inputs = snapshotTransferredBundleInputs(signedHead, row, deployment);
  } catch (cause) {
    fail(
      'transferred-bundle-binding',
      'supplied bundle-binding context is not canonical',
      cause,
    );
  }
  if (
    !equalBytes(inputs.signedHeadBytes, state.signedHeadBytes)
    || !equalBytes(inputs.rowBytes, state.rowBytes)
    || !equalDeployment(inputs.deployment, state.deployment)
  ) {
    fail(
      'transferred-bundle-binding',
      'transferred bundle capability is not bound to the supplied head, row, and deployment',
    );
  }
}

/**
 * Return immutable scalar state plus one fresh caller-owned copy of the complete
 * bundle. Decode that copy if projection/seal byte views are needed.
 */
export function readVerifiedTransferredCatalogBundleV1(
  value: unknown,
  signedHead: SignedAuthorCatalogHeadEnvelopeV1,
  row: AuthorCatalogRowV1,
  deployment: CatalogSealDeploymentProfileV1,
): VerifiedTransferredCatalogBundleSnapshotV1 {
  const metadata = readVerifiedTransferredCatalogBundleMetadataV1(
    value,
    signedHead,
    row,
    deployment,
  );
  const state = VERIFIED_TRANSFERRED_CATALOG_BUNDLES_V1.get(value as object)!;
  return Object.freeze({
    ...metadata,
    bundleBytes: new Uint8Array(state.bundleBytes),
  });
}

/**
 * Read only immutable scalar/capability metadata without copying a potentially
 * one-gibibyte bundle. Exact input rebinding remains mandatory.
 */
export function readVerifiedTransferredCatalogBundleMetadataV1(
  value: unknown,
  signedHead: SignedAuthorCatalogHeadEnvelopeV1,
  row: AuthorCatalogRowV1,
  deployment: CatalogSealDeploymentProfileV1,
): VerifiedTransferredCatalogBundleMetadataV1 {
  assertVerifiedTransferredCatalogBundleForInputsV1(
    value,
    signedHead,
    row,
    deployment,
  );
  const state = VERIFIED_TRANSFERRED_CATALOG_BUNDLES_V1.get(value as object)!;
  return Object.freeze({ ...state.snapshot });
}

/**
 * Return only the canonical projection component as a fresh caller-owned copy.
 * This avoids copying the seal and framing bytes when the semantic projection
 * verifier consumes a large, already-verified transfer.
 */
export function readVerifiedTransferredCatalogProjectionBytesV1(
  value: unknown,
  signedHead: SignedAuthorCatalogHeadEnvelopeV1,
  row: AuthorCatalogRowV1,
  deployment: CatalogSealDeploymentProfileV1,
): Uint8Array {
  assertVerifiedTransferredCatalogBundleForInputsV1(
    value,
    signedHead,
    row,
    deployment,
  );
  const state = VERIFIED_TRANSFERRED_CATALOG_BUNDLES_V1.get(value as object)!;
  const decoded = decodeOpaqueKaBundleV1(state.bundleBytes);
  return new Uint8Array(decoded.projectionBytes);
}

function snapshotTransferredBundleInputs(
  signedHead: SignedAuthorCatalogHeadEnvelopeV1,
  row: AuthorCatalogRowV1,
  deployment: CatalogSealDeploymentProfileV1,
): TransferredCatalogBundleInputsV1 {
  let signedHeadBytes: Uint8Array;
  let headSnapshot: SignedAuthorCatalogHeadEnvelopeV1;
  try {
    signedHeadBytes = canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1(signedHead);
    headSnapshot = parseCanonicalSignedAuthorCatalogHeadEnvelopeV1(signedHeadBytes);
  } catch (cause) {
    fail('transferred-bundle-head', 'signed catalog head is not canonical', cause);
  }
  let rowBytes: Uint8Array;
  let rowSnapshot: AuthorCatalogRowV1;
  try {
    assertAuthorCatalogRowV1(row);
    assertKaTransferDescriptorV1(row.transfer);
    rowBytes = UTF8.encode(canonicalizeAuthorCatalogRowV1(row));
    rowSnapshot = parseCanonicalAuthorCatalogRowV1(rowBytes);
    assertAuthorCatalogRowScopeBindingV1(
      rowSnapshot,
      deriveAuthorCatalogScopeFromHeadV1(headSnapshot.payload),
    );
  } catch (cause) {
    fail(
      'transferred-bundle-row',
      'catalog row or row.transfer is not structurally bound to the signed head',
      cause,
    );
  }
  const deploymentSnapshot = snapshotDeploymentProfile(deployment);
  return Object.freeze({
    signedHead: headSnapshot,
    row: rowSnapshot,
    deployment: deploymentSnapshot,
    signedHeadBytes,
    rowBytes,
  });
}

function snapshotDeploymentProfile(
  deployment: unknown,
): Readonly<CatalogSealDeploymentProfileV1> {
  try {
    if (!isPlainRecord(deployment)) throw new Error('profile must be a plain object');
    assertExactKeys(
      deployment,
      ['assertedAtChainId', 'assertedAtKav10Address', 'networkId'],
      'transferred bundle deployment profile',
    );
    assertNetworkIdV1(deployment.networkId);
    assertCanonicalChainId(deployment.assertedAtChainId, 'assertedAtChainId');
    assertCanonicalEvmAddress(deployment.assertedAtKav10Address, 'assertedAtKav10Address');
    return Object.freeze({
      networkId: deployment.networkId as NetworkIdV1,
      assertedAtChainId: deployment.assertedAtChainId,
      assertedAtKav10Address: deployment.assertedAtKav10Address,
    });
  } catch (cause) {
    fail('transferred-bundle-profile', 'deployment profile is not canonical', cause);
  }
}

function snapshotCompleteBundleBytes(value: unknown): Uint8Array {
  let backingBuffer: ArrayBufferLike;
  let byteLength: number;
  let typedArrayTag: string | undefined;
  try {
    backingBuffer = Reflect.apply(GET_TYPED_ARRAY_BUFFER, value, []);
    byteLength = Reflect.apply(GET_TYPED_ARRAY_BYTE_LENGTH, value, []);
    typedArrayTag = Reflect.apply(GET_TYPED_ARRAY_TAG, value, []);
  } catch (cause) {
    fail('transferred-bundle-input', 'receivedBundleBytes must be a genuine Uint8Array', cause);
  }
  if (typedArrayTag !== 'Uint8Array') {
    fail('transferred-bundle-input', 'receivedBundleBytes must be a Uint8Array');
  }
  if (!(backingBuffer instanceof ArrayBuffer)) {
    fail('transferred-bundle-input', 'receivedBundleBytes must not use shared backing memory');
  }
  if ((backingBuffer as ArrayBuffer & { readonly resizable?: boolean }).resizable === true) {
    fail('transferred-bundle-input', 'receivedBundleBytes must not use resizable backing memory');
  }
  const boundedLength = BigInt(byteLength);
  if (
    boundedLength < MIN_KA_TRANSFER_BYTES_V1
    || boundedLength > MAX_KA_TRANSFER_BYTES_V1
  ) {
    fail(
      'transferred-bundle-input',
      `receivedBundleBytes must contain ${MIN_KA_TRANSFER_BYTES_V1}-${MAX_KA_TRANSFER_BYTES_V1} bytes`,
    );
  }
  try {
    // Normalize Buffer and subclasses to an ordinary, independently backed view.
    return new Uint8Array(value as Uint8Array);
  } catch (cause) {
    fail('transferred-bundle-input', 'receivedBundleBytes could not be snapshotted safely', cause);
  }
}

function equalDeployment(
  left: Readonly<CatalogSealDeploymentProfileV1>,
  right: Readonly<CatalogSealDeploymentProfileV1>,
): boolean {
  return left.networkId === right.networkId
    && left.assertedAtChainId === right.assertedAtChainId
    && left.assertedAtKav10Address === right.assertedAtKav10Address;
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
  code: TransferredCatalogBundleErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new TransferredCatalogBundleError(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
