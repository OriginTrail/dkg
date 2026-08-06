import {
  AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_DIRECTORY_FANOUT_V1,
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  MAX_DECIMAL_U64,
  ZERO_DIGEST32_V1,
  assertAuthorCatalogBucketScopeBindingV1,
  assertAuthorCatalogHeadScopeBindingV1,
  assertAuthorCatalogScopeV1,
  assertSignedAuthorCatalogBucketEnvelopeV1,
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  canonicalizeAuthorCatalogBucketPayloadBytesV1,
  canonicalizeAuthorCatalogDirectoryNodePayloadBytesV1,
  canonicalizeAuthorCatalogRowV1,
  canonicalizeSignedAuthorCatalogBucketEnvelopeBytesV1,
  canonicalizeSignedAuthorCatalogDirectoryNodeEnvelopeBytesV1,
  canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1,
  computeAuthorCatalogBucketObjectDigestV1,
  computeAuthorCatalogDirectoryNodeObjectDigestV1,
  computeAuthorCatalogHeadObjectDigestV1,
  computeAuthorCatalogScopeDigestV1,
  deriveAuthorCatalogScopeFromHeadV1,
  parseCanonicalAuthorCatalogBucketPayloadV1,
  parseCanonicalAuthorCatalogRowV1,
  parseCanonicalSignedAuthorCatalogBucketEnvelopeV1,
  parseCanonicalSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  parseCanonicalSignedAuthorCatalogHeadEnvelopeV1,
  readVerifiedAuthorCatalogBucketDescriptorV1,
  verifyAuthorCatalogDirectoryPathV1,
  type AuthorCatalogBucketDescriptorV1,
  type AuthorCatalogBucketV1,
  type AuthorCatalogChildDescriptorV1,
  type AuthorCatalogDirectoryEntryV1,
  type AuthorCatalogDirectoryNodeV1,
  type AuthorCatalogHeadV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedControlEnvelopeV1,
  type TimestampMsV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import {
  Rfc64ControlEnvelopeSigningErrorV1,
  signAndVerifyRfc64ControlEnvelopeV1,
  type Rfc64ControlEnvelopeEip191SignerV1,
} from './control-envelope-signer-v1.js';

export const RFC64_AUTHOR_CATALOG_PRODUCTION_ERROR_CODES_V1 = Object.freeze([
  'catalog-production-input',
  'catalog-production-history',
  'catalog-production-path',
  'catalog-production-delta',
  'catalog-production-noop',
  'catalog-production-signer',
] as const);

export type Rfc64AuthorCatalogProductionErrorCodeV1 =
  (typeof RFC64_AUTHOR_CATALOG_PRODUCTION_ERROR_CODES_V1)[number];

export class Rfc64AuthorCatalogProductionErrorV1 extends Error {
  constructor(
    readonly code: Rfc64AuthorCatalogProductionErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    if (!RFC64_AUTHOR_CATALOG_PRODUCTION_ERROR_CODES_V1.includes(code)) {
      throw new TypeError(`Unsupported RFC-64 author catalog production error code: ${code}`);
    }
    this.name = 'Rfc64AuthorCatalogProductionErrorV1';
  }
}

/**
 * Local EOA signer used for catalog production. The callback signs the raw
 * 32-byte control-object digest with EIP-191 personal-sign framing.
 */
export type Rfc64AuthorCatalogEip191SignerV1 = Rfc64ControlEnvelopeEip191SignerV1;

export interface ProduceEmptyAuthorCatalogGenesisInputV1 {
  readonly scope: AuthorCatalogScopeV1;
  readonly catalogIssuerDelegationDigest: Digest32V1;
  readonly issuedAt: TimestampMsV1;
  readonly signer: Rfc64AuthorCatalogEip191SignerV1;
}

export interface ProduceSparseAuthorCatalogSuccessorInputV1 {
  readonly previousHead: SignedAuthorCatalogHeadEnvelopeV1;
  readonly previousDirectoryPath: readonly SignedAuthorCatalogDirectoryNodeEnvelopeV1[];
  /** Exact prior bucket object, or null when the selected descriptor is empty. */
  readonly previousBucket: SignedAuthorCatalogBucketEnvelopeV1 | null;
  readonly selectedBucketId: DecimalU64V1;
  /** Complete replacement live set for the selected bucket. */
  readonly nextRows: readonly AuthorCatalogRowV1[];
  readonly issuedAt: TimestampMsV1;
  readonly signer: Rfc64AuthorCatalogEip191SignerV1;
}

export interface ProducedAuthorCatalogPublicationV1 {
  /** Signed candidate only; this grants no durable-staging or semantic-ref authority. */
  readonly head: SignedAuthorCatalogHeadEnvelopeV1;
  /** Root-to-leaf path under {@link head}. */
  readonly directoryPath: readonly SignedAuthorCatalogDirectoryNodeEnvelopeV1[];
  /** Null denotes the selected bucket's canonical empty descriptor. */
  readonly bucket: SignedAuthorCatalogBucketEnvelopeV1 | null;
  /** Immutable objects in required staging order: bucket, leaf-to-root path, head. */
  readonly stagedObjects: readonly SignedControlEnvelopeV1[];
}

type SnapshotEip191SignerV1 = Rfc64ControlEnvelopeEip191SignerV1;

/** Produce the canonical scoped empty catalog used to bootstrap later sparse writes. */
export async function produceEmptyAuthorCatalogGenesisV1(
  input: ProduceEmptyAuthorCatalogGenesisInputV1,
): Promise<ProducedAuthorCatalogPublicationV1> {
  try {
    return await produceEmptyAuthorCatalogGenesisUncheckedV1(input);
  } catch (cause) {
    normalizePublicError('empty author catalog genesis production failed', cause);
  }
}

async function produceEmptyAuthorCatalogGenesisUncheckedV1(
  input: ProduceEmptyAuthorCatalogGenesisInputV1,
): Promise<ProducedAuthorCatalogPublicationV1> {
  const scopeInput = input.scope;
  const delegationDigest = input.catalogIssuerDelegationDigest;
  const issuedAt = input.issuedAt;
  const signer = snapshotSigner(input.signer);

  const scope = snapshotScope(scopeInput);
  if (scope.era !== '0' || scope.bucketCount !== '1') {
    fail(
      'catalog-production-history',
      'empty genesis requires era=0 and bucketCount=1',
    );
  }

  const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(scope);
  const rootPayload: AuthorCatalogDirectoryNodeV1 = {
    catalogScopeDigest,
    entries: [{
      bucketDigest: ZERO_DIGEST32_V1,
      bucketId: '0' as DecimalU64V1,
      byteLength: '0' as DecimalU64V1,
      rowCount: '0' as DecimalU64V1,
    }],
    era: '0' as DecimalU64V1,
    firstBucketId: '0' as DecimalU64V1,
    level: '0' as DecimalU64V1,
  };
  const root = await signDirectoryNode(rootPayload, scope.bucketCount, signer);
  const headPayload: AuthorCatalogHeadV1 = {
    networkId: scope.networkId,
    contextGraphId: scope.contextGraphId,
    governanceChainId: scope.governanceChainId,
    governanceContractAddress: scope.governanceContractAddress,
    ownershipTransitionDigest: scope.ownershipTransitionDigest,
    subGraphName: scope.subGraphName,
    authorAddress: scope.authorAddress,
    catalogIssuerDelegationDigest: delegationDigest,
    era: '0' as DecimalU64V1,
    version: '0' as DecimalU64V1,
    previousHeadDigest: null,
    bucketCount: '1' as DecimalU64V1,
    totalRows: '0' as DecimalU64V1,
    directoryHeight: '0' as DecimalU64V1,
    directoryRootDigest: root.objectDigest as Digest32V1,
    issuedAt,
  };
  const head = await signHead(headPayload, signer);

  try {
    assertAuthorCatalogHeadScopeBindingV1(head.payload, scope);
    const verifiedPath = verifyAuthorCatalogDirectoryPathV1(
      head,
      [root],
      '0' as DecimalU64V1,
    );
    const descriptor = readVerifiedAuthorCatalogBucketDescriptorV1(verifiedPath, head);
    if (descriptor.bucketDigest !== ZERO_DIGEST32_V1 || descriptor.rowCount !== '0') {
      throw new Error('empty genesis selected a non-empty descriptor');
    }
  } catch (cause) {
    fail('catalog-production-path', 'produced empty genesis is not self-consistent', cause);
  }

  return freezePublication(head, [root], null, [root, head]);
}

/**
 * Change exactly one KA row, replace its complete bucket, and rebuild only the
 * leaf-to-root path.
 * This is the ordinary same-era update path; capacity/key/ownership transitions
 * deliberately require a different producer.
 */
export async function produceSparseAuthorCatalogSuccessorV1(
  input: ProduceSparseAuthorCatalogSuccessorInputV1,
): Promise<ProducedAuthorCatalogPublicationV1> {
  try {
    return await produceSparseAuthorCatalogSuccessorUncheckedV1(input);
  } catch (cause) {
    normalizePublicError('sparse author catalog successor production failed', cause);
  }
}

async function produceSparseAuthorCatalogSuccessorUncheckedV1(
  input: ProduceSparseAuthorCatalogSuccessorInputV1,
): Promise<ProducedAuthorCatalogPublicationV1> {
  const previousHeadInput = input.previousHead;
  const previousPathInput = input.previousDirectoryPath;
  const previousBucketInput = input.previousBucket;
  const selectedBucketId = input.selectedBucketId;
  const nextRowsInput = input.nextRows;
  const issuedAt = input.issuedAt;
  const signer = snapshotSigner(input.signer);

  const previousHead = snapshotHead(previousHeadInput);
  assertEip191Issuer(previousHead, signer.issuer, 'previous head');
  await verifyExistingSignature(previousHead, 'previous head');
  const scope = deriveAuthorCatalogScopeFromHeadV1(previousHead.payload);
  const previousPath = snapshotDirectoryPath(previousPathInput, scope.bucketCount);
  for (let index = 0; index < previousPath.length; index += 1) {
    assertEip191Issuer(previousPath[index], signer.issuer, `previous path node ${index}`);
    await verifyExistingSignature(previousPath[index], `previous path node ${index}`);
  }

  let previousDescriptor: Readonly<AuthorCatalogBucketDescriptorV1>;
  try {
    const verifiedPath = verifyAuthorCatalogDirectoryPathV1(
      previousHead,
      previousPath,
      selectedBucketId,
    );
    previousDescriptor = readVerifiedAuthorCatalogBucketDescriptorV1(
      verifiedPath,
      previousHead,
    );
  } catch (cause) {
    fail('catalog-production-path', 'previous directory path is not bound to the selected bucket', cause);
  }
  const previousBucket = await snapshotPreviousBucket(
    previousBucketInput,
    previousDescriptor,
    scope,
    signer.issuer,
  );

  const preparedBucket = prepareReplacementBucket(
    scope,
    selectedBucketId,
    nextRowsInput,
    signer.issuer,
  );
  const nextDescriptor = preparedBucket.descriptor;
  if (sameBucketDescriptor(previousDescriptor, nextDescriptor)) {
    fail('catalog-production-noop', 'ordinary catalog successor must change its selected bucket');
  }
  assertOneKaBucketDelta(previousBucket, preparedBucket);

  const previousTotal = BigInt(previousHead.payload.totalRows);
  const removedRows = BigInt(previousDescriptor.rowCount);
  const addedRows = BigInt(nextDescriptor.rowCount);
  const nextTotal = previousTotal - removedRows + addedRows;
  if (nextTotal < 0n || nextTotal > MAX_DECIMAL_U64) {
    fail('catalog-production-history', 'successor totalRows is outside DecimalU64V1');
  }
  const previousVersion = BigInt(previousHead.payload.version);
  if (previousVersion >= MAX_DECIMAL_U64) {
    fail('catalog-production-history', 'ordinary catalog version cannot overflow DecimalU64V1');
  }
  const nextBucket = await signPreparedReplacementBucket(preparedBucket, signer);

  const nextPath = new Array<SignedAuthorCatalogDirectoryNodeEnvelopeV1>(
    previousPath.length,
  );
  for (let pathIndex = previousPath.length - 1; pathIndex >= 0; pathIndex -= 1) {
    const previousNode = previousPath[pathIndex].payload;
    const entries = cloneEntries(previousNode.entries);
    const entryIndex = selectedEntryIndex(previousNode, selectedBucketId);
    if (BigInt(previousNode.level) === 0n) {
      entries[entryIndex] = nextDescriptor;
    } else {
      const child = nextPath[pathIndex + 1];
      entries[entryIndex] = childDescriptor(child, scope.bucketCount);
    }
    nextPath[pathIndex] = await signDirectoryNode({
      catalogScopeDigest: previousNode.catalogScopeDigest,
      entries,
      era: previousNode.era,
      firstBucketId: previousNode.firstBucketId,
      level: previousNode.level,
    }, scope.bucketCount, signer);
  }

  const nextHead = await signHead({
    networkId: previousHead.payload.networkId,
    contextGraphId: previousHead.payload.contextGraphId,
    governanceChainId: previousHead.payload.governanceChainId,
    governanceContractAddress: previousHead.payload.governanceContractAddress,
    ownershipTransitionDigest: previousHead.payload.ownershipTransitionDigest,
    subGraphName: previousHead.payload.subGraphName,
    authorAddress: previousHead.payload.authorAddress,
    catalogIssuerDelegationDigest: previousHead.payload.catalogIssuerDelegationDigest,
    era: previousHead.payload.era,
    version: (previousVersion + 1n).toString() as DecimalU64V1,
    previousHeadDigest: previousHead.objectDigest as Digest32V1,
    bucketCount: previousHead.payload.bucketCount,
    totalRows: nextTotal.toString() as DecimalU64V1,
    directoryHeight: previousHead.payload.directoryHeight,
    directoryRootDigest: nextPath[0].objectDigest as Digest32V1,
    issuedAt,
  }, signer);

  try {
    assertAuthorCatalogHeadScopeBindingV1(nextHead.payload, scope);
    const verifiedPath = verifyAuthorCatalogDirectoryPathV1(
      nextHead,
      nextPath,
      selectedBucketId,
    );
    const producedDescriptor = readVerifiedAuthorCatalogBucketDescriptorV1(
      verifiedPath,
      nextHead,
    );
    if (!sameBucketDescriptor(producedDescriptor, nextDescriptor)) {
      throw new Error('produced directory descriptor changed during construction');
    }
    if (nextBucket !== null) {
      assertAuthorCatalogBucketScopeBindingV1(nextBucket.payload, scope);
    }
  } catch (cause) {
    fail('catalog-production-path', 'produced sparse successor is not self-consistent', cause);
  }

  const stagedObjects: SignedControlEnvelopeV1[] = [];
  if (nextBucket !== null) stagedObjects.push(nextBucket);
  for (let index = nextPath.length - 1; index >= 0; index -= 1) {
    stagedObjects.push(nextPath[index]);
  }
  stagedObjects.push(nextHead);
  return freezePublication(nextHead, nextPath, nextBucket, stagedObjects);
}

type PreparedReplacementBucketV1 =
  | {
      readonly bucket: null;
      readonly descriptor: AuthorCatalogBucketDescriptorV1;
      readonly rows: readonly AuthorCatalogRowV1[];
    }
  | {
      readonly bucket: {
        readonly unsigned: UnsignedControlEnvelopeV1;
        readonly objectDigest: Digest32V1;
      };
      readonly descriptor: AuthorCatalogBucketDescriptorV1;
      readonly rows: readonly AuthorCatalogRowV1[];
    };

function prepareReplacementBucket(
  scope: AuthorCatalogScopeV1,
  selectedBucketId: DecimalU64V1,
  rowsInput: readonly AuthorCatalogRowV1[],
  issuer: EvmAddressV1,
): PreparedReplacementBucketV1 {
  if (!Array.isArray(rowsInput) || Object.getPrototypeOf(rowsInput) !== Array.prototype) {
    fail('catalog-production-input', 'nextRows must be an ordinary dense Array');
  }
  const rows = snapshotRows(rowsInput);
  if (rows.length === 0) {
    return Object.freeze({
      bucket: null,
      descriptor: emptyBucketDescriptor(selectedBucketId),
      rows: Object.freeze([]),
    });
  }

  let payload: AuthorCatalogBucketV1;
  try {
    const candidate: AuthorCatalogBucketV1 = {
      catalogScopeDigest: computeAuthorCatalogScopeDigestV1(scope),
      era: scope.era,
      bucketCount: scope.bucketCount,
      bucketId: selectedBucketId,
      rows,
    };
    payload = parseCanonicalAuthorCatalogBucketPayloadV1(
      canonicalizeAuthorCatalogBucketPayloadBytesV1(candidate),
    );
    assertAuthorCatalogBucketScopeBindingV1(payload, scope);
  } catch (cause) {
    fail('catalog-production-input', 'replacement bucket is not canonical for this scope', cause);
  }

  const unsigned = eip191Unsigned(
    issuer,
    AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
    freezePlainSnapshot(payload),
  );
  const objectDigest = computeAuthorCatalogBucketObjectDigestV1(unsigned);
  return Object.freeze({
    bucket: Object.freeze({ unsigned, objectDigest }),
    descriptor: Object.freeze({
      bucketDigest: objectDigest,
      bucketId: selectedBucketId,
      byteLength: canonicalizeAuthorCatalogBucketPayloadBytesV1(payload)
        .byteLength.toString() as DecimalU64V1,
      rowCount: payload.rows.length.toString() as DecimalU64V1,
    }),
    rows: payload.rows,
  });
}

async function snapshotPreviousBucket(
  input: SignedAuthorCatalogBucketEnvelopeV1 | null,
  descriptor: Readonly<AuthorCatalogBucketDescriptorV1>,
  scope: AuthorCatalogScopeV1,
  issuer: EvmAddressV1,
): Promise<SignedAuthorCatalogBucketEnvelopeV1 | null> {
  if (descriptor.bucketDigest === ZERO_DIGEST32_V1) {
    if (input !== null) {
      fail('catalog-production-path', 'empty previous descriptor must not carry a bucket object');
    }
    return null;
  }
  if (input === null) {
    fail('catalog-production-path', 'non-empty previous descriptor requires its exact bucket object');
  }

  let bucket: SignedAuthorCatalogBucketEnvelopeV1;
  try {
    bucket = freezePlainSnapshot(parseCanonicalSignedAuthorCatalogBucketEnvelopeV1(
      canonicalizeSignedAuthorCatalogBucketEnvelopeBytesV1(input),
    )) as SignedAuthorCatalogBucketEnvelopeV1;
    assertAuthorCatalogBucketScopeBindingV1(bucket.payload, scope);
  } catch (cause) {
    fail('catalog-production-input', 'previous bucket is not one canonical scoped snapshot', cause);
  }
  assertEip191Issuer(bucket, issuer, 'previous bucket');
  await verifyExistingSignature(bucket, 'previous bucket');
  const byteLength = canonicalizeAuthorCatalogBucketPayloadBytesV1(bucket.payload).byteLength;
  if (
    bucket.objectDigest !== descriptor.bucketDigest
    || bucket.payload.bucketId !== descriptor.bucketId
    || bucket.payload.rows.length.toString() !== descriptor.rowCount
    || byteLength.toString() !== descriptor.byteLength
  ) {
    fail('catalog-production-path', 'previous bucket does not match its verified descriptor');
  }
  return bucket;
}

function assertOneKaBucketDelta(
  previousBucket: SignedAuthorCatalogBucketEnvelopeV1 | null,
  nextBucket: PreparedReplacementBucketV1,
): void {
  const previousRows = previousBucket?.payload.rows ?? [];
  const nextRows = nextBucket.rows;
  const previousCanonical = canonicalRows(previousRows);
  const nextCanonical = canonicalRows(nextRows);
  const lengthDelta = nextRows.length - previousRows.length;
  if (lengthDelta === 1) {
    assertSingleInsertion(previousCanonical, nextCanonical);
    return;
  }
  if (lengthDelta === -1) {
    assertSingleRemoval(previousCanonical, nextCanonical);
    return;
  }
  if (lengthDelta !== 0) {
    fail('catalog-production-delta', 'ordinary successor must change exactly one KA row');
  }

  let changedIndex = -1;
  for (let index = 0; index < previousCanonical.length; index += 1) {
    if (previousCanonical[index] === nextCanonical[index]) continue;
    if (changedIndex !== -1) {
      fail('catalog-production-delta', 'ordinary successor changed more than one KA row');
    }
    changedIndex = index;
  }
  if (changedIndex === -1) {
    fail('catalog-production-noop', 'ordinary successor did not change a KA row');
  }
  const previousRow = previousRows[changedIndex];
  const nextRow = nextRows[changedIndex];
  if (
    previousRow.kaId !== nextRow.kaId
    || previousRow.assertionCoordinate !== nextRow.assertionCoordinate
    || BigInt(nextRow.assertionVersion) !== BigInt(previousRow.assertionVersion) + 1n
  ) {
    fail(
      'catalog-production-delta',
      'one-row replacement must preserve KA/coordinate and increment assertionVersion by one',
    );
  }
}

function canonicalRows(rows: readonly AuthorCatalogRowV1[]): string[] {
  const result = new Array<string>(rows.length);
  for (let index = 0; index < rows.length; index += 1) {
    result[index] = canonicalizeAuthorCatalogRowV1(rows[index]);
  }
  return result;
}

function assertSingleInsertion(previous: readonly string[], next: readonly string[]): void {
  let insertionIndex = 0;
  while (
    insertionIndex < previous.length
    && previous[insertionIndex] === next[insertionIndex]
  ) {
    insertionIndex += 1;
  }
  for (let index = insertionIndex; index < previous.length; index += 1) {
    if (previous[index] !== next[index + 1]) {
      fail('catalog-production-delta', 'ordinary successor inserted more than one KA row');
    }
  }
}

function assertSingleRemoval(previous: readonly string[], next: readonly string[]): void {
  let removalIndex = 0;
  while (
    removalIndex < next.length
    && previous[removalIndex] === next[removalIndex]
  ) {
    removalIndex += 1;
  }
  for (let index = removalIndex; index < next.length; index += 1) {
    if (previous[index + 1] !== next[index]) {
      fail('catalog-production-delta', 'ordinary successor removed more than one KA row');
    }
  }
}

async function signPreparedReplacementBucket(
  prepared: PreparedReplacementBucketV1,
  signer: SnapshotEip191SignerV1,
): Promise<SignedAuthorCatalogBucketEnvelopeV1 | null> {
  if (prepared.bucket === null) return null;
  const signed = await signEnvelope(
    prepared.bucket.unsigned,
    prepared.bucket.objectDigest,
    signer,
    (value) => {
      assertSignedAuthorCatalogBucketEnvelopeV1(value);
    },
  );
  return freezePlainSnapshot(parseCanonicalSignedAuthorCatalogBucketEnvelopeV1(
    canonicalizeSignedAuthorCatalogBucketEnvelopeBytesV1(signed),
  )) as SignedAuthorCatalogBucketEnvelopeV1;
}

async function signDirectoryNode(
  payload: AuthorCatalogDirectoryNodeV1,
  bucketCount: AuthorCatalogScopeV1['bucketCount'],
  signer: SnapshotEip191SignerV1,
): Promise<SignedAuthorCatalogDirectoryNodeEnvelopeV1> {
  const unsigned = eip191Unsigned(
    signer.issuer,
    AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
    freezePlainSnapshot(payload),
  );
  const digest = computeAuthorCatalogDirectoryNodeObjectDigestV1(unsigned, bucketCount);
  const signed = await signEnvelope(unsigned, digest, signer, (value) => {
    assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(value, bucketCount);
  });
  return freezePlainSnapshot(parseCanonicalSignedAuthorCatalogDirectoryNodeEnvelopeV1(
    canonicalizeSignedAuthorCatalogDirectoryNodeEnvelopeBytesV1(signed, bucketCount),
    bucketCount,
  )) as SignedAuthorCatalogDirectoryNodeEnvelopeV1;
}

async function signHead(
  payload: AuthorCatalogHeadV1,
  signer: SnapshotEip191SignerV1,
): Promise<SignedAuthorCatalogHeadEnvelopeV1> {
  const unsigned = eip191Unsigned(
    signer.issuer,
    AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    freezePlainSnapshot(payload),
  );
  const digest = computeAuthorCatalogHeadObjectDigestV1(unsigned);
  const signed = await signEnvelope(unsigned, digest, signer, (value) => {
    assertSignedAuthorCatalogHeadEnvelopeV1(value);
  });
  return freezePlainSnapshot(parseCanonicalSignedAuthorCatalogHeadEnvelopeV1(
    canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1(signed),
  )) as SignedAuthorCatalogHeadEnvelopeV1;
}

async function signEnvelope(
  unsigned: UnsignedControlEnvelopeV1,
  objectDigest: Digest32V1,
  signer: SnapshotEip191SignerV1,
  assertSpecific: (value: SignedControlEnvelopeV1) => void,
): Promise<SignedControlEnvelopeV1> {
  try {
    return await signAndVerifyRfc64ControlEnvelopeV1(
      unsigned,
      objectDigest,
      signer,
      assertSpecific,
    );
  } catch (cause) {
    if (
      cause instanceof Rfc64ControlEnvelopeSigningErrorV1
      && cause.phase === 'callback'
    ) {
      fail('catalog-production-signer', `signer failed for ${unsigned.objectType}`, cause);
    }
    fail(
      'catalog-production-signer',
      `signer did not produce a canonical ${unsigned.objectType} signature for ${signer.issuer}`,
      cause,
    );
  }
}

function snapshotHead(
  input: SignedAuthorCatalogHeadEnvelopeV1,
): SignedAuthorCatalogHeadEnvelopeV1 {
  try {
    return freezePlainSnapshot(parseCanonicalSignedAuthorCatalogHeadEnvelopeV1(
      canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1(input),
    )) as SignedAuthorCatalogHeadEnvelopeV1;
  } catch (cause) {
    fail('catalog-production-input', 'previous head is not one canonical snapshot', cause);
  }
}

function snapshotDirectoryPath(
  input: readonly SignedAuthorCatalogDirectoryNodeEnvelopeV1[],
  bucketCount: AuthorCatalogScopeV1['bucketCount'],
): readonly SignedAuthorCatalogDirectoryNodeEnvelopeV1[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    fail('catalog-production-input', 'previousDirectoryPath must be an ordinary dense Array');
  }
  const length = input.length;
  if (!Number.isSafeInteger(length) || length < 1 || length > 8) {
    fail('catalog-production-input', 'previousDirectoryPath must contain 1..8 nodes');
  }
  const snapshot = new Array<SignedAuthorCatalogDirectoryNodeEnvelopeV1>(length);
  try {
    for (let index = 0; index < length; index += 1) {
      snapshot[index] = freezePlainSnapshot(
        parseCanonicalSignedAuthorCatalogDirectoryNodeEnvelopeV1(
          canonicalizeSignedAuthorCatalogDirectoryNodeEnvelopeBytesV1(
            input[index],
            bucketCount,
          ),
          bucketCount,
        ),
      ) as SignedAuthorCatalogDirectoryNodeEnvelopeV1;
    }
  } catch (cause) {
    fail('catalog-production-input', 'previous directory path is not one canonical snapshot', cause);
  }
  return Object.freeze(snapshot);
}

function snapshotRows(input: readonly AuthorCatalogRowV1[]): readonly AuthorCatalogRowV1[] {
  const length = input.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > 1024) {
    fail('catalog-production-input', 'nextRows is outside the 0..1024 bucket-row bound');
  }
  const snapshot = new Array<AuthorCatalogRowV1>(length);
  try {
    for (let index = 0; index < length; index += 1) {
      const rowInput = input[index];
      const transferInput = rowInput.transfer;
      const row = {
        kaId: rowInput.kaId,
        assertionCoordinate: rowInput.assertionCoordinate,
        assertionVersion: rowInput.assertionVersion,
        projectionId: rowInput.projectionId,
        projectionDigest: rowInput.projectionDigest,
        sealDigest: rowInput.sealDigest,
        transfer: {
          codec: transferInput.codec,
          projectionId: transferInput.projectionId,
          projectionDigest: transferInput.projectionDigest,
          byteLength: transferInput.byteLength,
          chunkSize: transferInput.chunkSize,
          chunkCount: transferInput.chunkCount,
          blobDigest: transferInput.blobDigest,
          chunkTreeRoot: transferInput.chunkTreeRoot,
        },
      } as AuthorCatalogRowV1;
      snapshot[index] = freezePlainSnapshot(parseCanonicalAuthorCatalogRowV1(
        canonicalizeAuthorCatalogRowV1(row),
      ));
    }
  } catch (cause) {
    fail('catalog-production-input', 'nextRows is not one canonical row snapshot', cause);
  }
  return Object.freeze(snapshot);
}

function snapshotSigner(input: Rfc64AuthorCatalogEip191SignerV1): SnapshotEip191SignerV1 {
  const issuer = input.issuer;
  const signDigest = input.signDigest;
  if (typeof signDigest !== 'function') {
    fail('catalog-production-input', 'catalog signer must expose signDigest');
  }
  return Object.freeze({ issuer, signDigest });
}

function assertEip191Issuer(
  envelope: SignedControlEnvelopeV1,
  issuer: EvmAddressV1,
  label: string,
): void {
  if (
    envelope.issuer !== issuer
    || envelope.signatureSuite !== 'eip191-personal-sign-digest-v1'
    || envelope.signatureEvidence.kind !== 'none'
  ) {
    fail(
      'catalog-production-history',
      `${label} must use the same EIP-191 catalog issuer as the successor signer`,
    );
  }
}

async function verifyExistingSignature(
  envelope: SignedControlEnvelopeV1,
  label: string,
): Promise<void> {
  try {
    await verifyControlEnvelopeIssuerSignatureV1(envelope);
  } catch (cause) {
    fail('catalog-production-history', `${label} signature is not valid`, cause);
  }
}

function eip191Unsigned(
  issuer: EvmAddressV1,
  objectType: string,
  payload: unknown,
): UnsignedControlEnvelopeV1 {
  return freezePlainSnapshot({
    issuer,
    objectType,
    payload: payload as UnsignedControlEnvelopeV1['payload'],
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  }) as UnsignedControlEnvelopeV1;
}

function emptyBucketDescriptor(
  bucketId: DecimalU64V1,
): AuthorCatalogBucketDescriptorV1 {
  return Object.freeze({
    bucketDigest: ZERO_DIGEST32_V1,
    bucketId,
    byteLength: '0' as DecimalU64V1,
    rowCount: '0' as DecimalU64V1,
  });
}

function cloneEntries(
  input: readonly AuthorCatalogDirectoryEntryV1[],
): AuthorCatalogDirectoryEntryV1[] {
  const result = new Array<AuthorCatalogDirectoryEntryV1>(input.length);
  for (let index = 0; index < input.length; index += 1) {
    result[index] = { ...input[index] } as AuthorCatalogDirectoryEntryV1;
  }
  return result;
}

function selectedEntryIndex(
  node: AuthorCatalogDirectoryNodeV1,
  bucketIdValue: DecimalU64V1,
): number {
  const bucketId = BigInt(bucketIdValue);
  const firstBucketId = BigInt(node.firstBucketId);
  const entryWidth = directoryPower(BigInt(node.level));
  const relative = bucketId - firstBucketId;
  if (relative < 0n) {
    fail('catalog-production-path', 'selected bucket is outside the rebuilt directory node');
  }
  const index = relative / entryWidth;
  if (index < 0n || index >= BigInt(node.entries.length)) {
    fail('catalog-production-path', 'selected bucket is outside the rebuilt directory node');
  }
  return Number(index);
}

function childDescriptor(
  child: SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  bucketCount: AuthorCatalogScopeV1['bucketCount'],
): AuthorCatalogChildDescriptorV1 {
  let rowCount = 0n;
  for (let index = 0; index < child.payload.entries.length; index += 1) {
    rowCount += BigInt(child.payload.entries[index].rowCount);
    if (rowCount > MAX_DECIMAL_U64) {
      fail('catalog-production-path', 'rebuilt child rowCount exceeds DecimalU64V1');
    }
  }
  const firstBucketId = BigInt(child.payload.firstBucketId);
  const childCoverage = directoryPower(BigInt(child.payload.level) + 1n);
  const remaining = BigInt(bucketCount) - firstBucketId;
  const bucketSpan = remaining < childCoverage ? remaining : childCoverage;
  return Object.freeze({
    firstBucketId: child.payload.firstBucketId,
    bucketSpan: bucketSpan.toString() as DecimalU64V1,
    rowCount: rowCount.toString() as DecimalU64V1,
    byteLength: canonicalizeAuthorCatalogDirectoryNodePayloadBytesV1(
      child.payload,
      bucketCount,
    ).byteLength.toString() as DecimalU64V1,
    childDigest: child.objectDigest as Digest32V1,
  });
}

function directoryPower(exponent: bigint): bigint {
  let result = 1n;
  for (let index = 0n; index < exponent; index += 1n) {
    result *= AUTHOR_CATALOG_DIRECTORY_FANOUT_V1;
  }
  return result;
}

function sameBucketDescriptor(
  left: Readonly<AuthorCatalogBucketDescriptorV1>,
  right: Readonly<AuthorCatalogBucketDescriptorV1>,
): boolean {
  return left.bucketId === right.bucketId
    && left.rowCount === right.rowCount
    && left.byteLength === right.byteLength
    && left.bucketDigest === right.bucketDigest;
}

function freezePublication(
  head: SignedAuthorCatalogHeadEnvelopeV1,
  directoryPath: readonly SignedAuthorCatalogDirectoryNodeEnvelopeV1[],
  bucket: SignedAuthorCatalogBucketEnvelopeV1 | null,
  stagedObjects: readonly SignedControlEnvelopeV1[],
): ProducedAuthorCatalogPublicationV1 {
  return Object.freeze({
    head,
    directoryPath: Object.freeze(Array.from(directoryPath)),
    bucket,
    stagedObjects: Object.freeze(Array.from(stagedObjects)),
  });
}

function snapshotScope(input: AuthorCatalogScopeV1): AuthorCatalogScopeV1 {
  const candidate = {
    networkId: input.networkId,
    contextGraphId: input.contextGraphId,
    governanceChainId: input.governanceChainId,
    governanceContractAddress: input.governanceContractAddress,
    ownershipTransitionDigest: input.ownershipTransitionDigest,
    subGraphName: input.subGraphName,
    authorAddress: input.authorAddress,
    era: input.era,
    bucketCount: input.bucketCount,
  };
  try {
    assertAuthorCatalogScopeV1(candidate);
  } catch (cause) {
    fail('catalog-production-input', 'empty genesis scope is not canonical', cause);
  }
  return freezePlainSnapshot(candidate) as AuthorCatalogScopeV1;
}

function freezePlainSnapshot<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      freezePlainSnapshot(value[index]);
    }
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) {
    freezePlainSnapshot((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

function normalizePublicError(message: string, cause: unknown): never {
  if (cause instanceof Rfc64AuthorCatalogProductionErrorV1) throw cause;
  fail('catalog-production-input', message, cause);
}

function fail(
  code: Rfc64AuthorCatalogProductionErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64AuthorCatalogProductionErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
