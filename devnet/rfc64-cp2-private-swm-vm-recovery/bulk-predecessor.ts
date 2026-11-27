import {
  AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  KA_TRANSFER_CHUNK_SIZE_BYTES_V1,
  KA_TRANSFER_CHUNK_SIZE_V1,
  KA_TRANSFER_CODEC_V1,
  KA_TRANSFER_PROJECTION_V1,
  assertAssertionCoordinateV1,
  assertAuthorCatalogScopeV1,
  assertCanonicalGraphScopedAuthorSealV1,
  assertCanonicalTimestampMs,
  assertSignedAuthorCatalogBucketEnvelopeV1,
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  assertSignedAuthorCatalogIssuerDelegationEnvelopeV1,
  canonicalizeAuthorCatalogBucketPayloadBytesV1,
  canonicalizeAuthorCatalogRowV1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  compareAuthorCatalogKaIdsV1,
  computeAuthorCatalogBucketObjectDigestV1,
  computeAuthorCatalogDirectoryNodeObjectDigestV1,
  computeAuthorCatalogHeadObjectDigestV1,
  computeAuthorCatalogScopeDigestV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeControlSignatureVariantDigestHex,
  computeKaChunkTreeRootV1,
  encodeOpaqueKaBundleV1,
  parseCanonicalAuthorCatalogRowV1,
  verifyAuthorCatalogDirectoryPathV1,
  type AssertionCoordinateV1,
  type AuthorCatalogBucketV1,
  type AuthorCatalogDirectoryNodeV1,
  type AuthorCatalogHeadV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type ByteLengthV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CountV1,
  type DecimalU64V1,
  type Digest32V1,
  type SignedAuthorCatalogIssuerDelegationEnvelopeV1,
  type SignedControlEnvelopeV1,
  type TimestampMsV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

import {
  PRIVATE_CATALOG_FIXTURE_STAGE_BATCH_SIZE_V1,
  planPrivateCatalogConstructionV1,
} from './batch-plan.ts';

interface HarnessPersistenceV1 {
  readonly controlObjects: {
    stageVerifiedObjects(input: readonly {
      readonly envelope: SignedControlEnvelopeV1;
      readonly issuerSignature: unknown;
    }[]): Promise<{
      readonly objects: readonly {
        readonly objectDigest: Digest32V1;
        readonly signatureVariantDigest: Digest32V1;
      }[];
    }>;
  };
  readonly kaBundles: {
    putKaBundle(input: {
      readonly blobDigest: Digest32V1;
      readonly bundleBytes: Uint8Array;
    }): Promise<{
      readonly durable: true;
      readonly blobDigest: Digest32V1;
      readonly byteLength: number;
    }>;
  };
}

interface PreparedFixtureAssetV1 {
  readonly row: AuthorCatalogRowV1;
  readonly bundleDigest: Digest32V1;
  readonly bundleBytes: Uint8Array;
}

/**
 * Test-only linear seed for the scale gate. This does not add a product API.
 * The returned head is used only as the immediate predecessor of one real
 * product successor that adds exactly one row.
 */
export async function stagePrivateCatalogBulkPredecessorV1(
  currentAgent: object,
  rawInput: unknown,
  verifyIssuerSignature: (envelope: SignedControlEnvelopeV1) => Promise<unknown>,
): Promise<Readonly<Record<string, unknown>>> {
  const input = record(rawInput, 'bulk predecessor input');
  const finalAssetCount = boundedInteger(input.finalAssetCount, 1, 500, 'finalAssetCount');
  const batchSize = input.fixtureStageBatchSize === undefined
    ? PRIVATE_CATALOG_FIXTURE_STAGE_BATCH_SIZE_V1
    : boundedInteger(input.fixtureStageBatchSize, 1, 128, 'fixtureStageBatchSize');
  const plan = planPrivateCatalogConstructionV1(finalAssetCount, batchSize);
  const assets = denseArray(input.assets, 'bulk predecessor assets');
  if (assets.length !== plan.fixturePredecessorAssetCount) {
    throw new Error('bulk predecessor asset count differs from the deterministic plan');
  }
  if (assets.length === 0) {
    throw new Error('bulk predecessor is unnecessary for a one-asset final catalog');
  }
  assertAuthorCatalogScopeV1(input.scope);
  const scope = input.scope as AuthorCatalogScopeV1;
  const authorPrivateKey = requiredString(input.authorPrivateKey, 'authorPrivateKey');
  const wallet = new ethers.Wallet(authorPrivateKey);
  if (wallet.address.toLowerCase() !== scope.authorAddress) {
    throw new Error('bulk predecessor signer differs from catalog author');
  }
  const previousHead = record(input.previousHead, 'previousHead');
  const previousHeadDigest = requiredDigest(previousHead.objectDigest, 'previousHead.objectDigest');
  requiredDigest(previousHead.signatureVariantDigest, 'previousHead.signatureVariantDigest');
  const authorization = record(input.catalogIssuerAuthorization, 'catalogIssuerAuthorization');
  const delegation = authorization.catalogIssuerDelegation as
    SignedAuthorCatalogIssuerDelegationEnvelopeV1;
  assertSignedAuthorCatalogIssuerDelegationEnvelopeV1(delegation);
  if (authorization.parentAuthorAgentEvidence !== null) {
    throw new Error('bulk predecessor requires direct-author catalog authorization');
  }
  assertCanonicalTimestampMs(input.issuedAt, 'issuedAt');
  const issuedAt = input.issuedAt as TimestampMsV1;
  const persistence = (
    currentAgent as unknown as { rfc64PersistenceV1?: HarnessPersistenceV1 }
  ).rfc64PersistenceV1;
  if (persistence === undefined) throw new Error('RFC-64 persistence is unavailable');

  const prepared: PreparedFixtureAssetV1[] = [];
  let offset = 0;
  for (const plannedBatchSize of plan.fixtureStageBatchSizes) {
    const batch = assets.slice(offset, offset + plannedBatchSize).map((value, index) =>
      prepareAsset(value, `bulk predecessor assets[${offset + index}]`));
    const receipts = await Promise.all(batch.map((asset) => persistence.kaBundles.putKaBundle({
      blobDigest: asset.bundleDigest,
      bundleBytes: new Uint8Array(asset.bundleBytes),
    })));
    for (let index = 0; index < batch.length; index += 1) {
      const asset = batch[index]!;
      const receipt = receipts[index]!;
      if (
        receipt.durable !== true
        || receipt.blobDigest !== asset.bundleDigest
        || receipt.byteLength !== asset.bundleBytes.byteLength
      ) {
        throw new Error('bulk predecessor bundle store returned a different durable receipt');
      }
    }
    prepared.push(...batch);
    offset += plannedBatchSize;
  }
  if (offset !== assets.length) throw new Error('bulk predecessor batch plan was not exhaustive');
  prepared.sort((left, right) => compareAuthorCatalogKaIdsV1(left.row.kaId, right.row.kaId));
  for (let index = 1; index < prepared.length; index += 1) {
    if (prepared[index - 1]!.row.kaId === prepared[index]!.row.kaId) {
      throw new Error(`bulk predecessor contains duplicate KA ${prepared[index]!.row.kaId}`);
    }
  }

  const signer = {
    issuer: scope.authorAddress,
    signDigest: (digest: Digest32V1) => wallet.signMessage(ethers.getBytes(digest)),
  };
  const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(scope);
  const bucketPayload: AuthorCatalogBucketV1 = {
    catalogScopeDigest,
    era: scope.era,
    bucketCount: scope.bucketCount,
    bucketId: '0' as DecimalU64V1,
    rows: prepared.map(({ row }) => row),
  };
  const bucket = await signEnvelope(
    unsigned(scope.authorAddress, AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1, bucketPayload),
    computeAuthorCatalogBucketObjectDigestV1,
    signer.signDigest,
    verifyIssuerSignature,
  );
  assertSignedAuthorCatalogBucketEnvelopeV1(bucket.envelope);
  const directoryPayload: AuthorCatalogDirectoryNodeV1 = {
    catalogScopeDigest,
    era: scope.era,
    level: '0' as DecimalU64V1,
    firstBucketId: '0' as DecimalU64V1,
    entries: [{
      bucketId: '0' as DecimalU64V1,
      bucketDigest: bucket.envelope.objectDigest as Digest32V1,
      rowCount: String(prepared.length) as CountV1,
      byteLength: String(
        canonicalizeAuthorCatalogBucketPayloadBytesV1(bucketPayload).byteLength,
      ) as ByteLengthV1,
    }],
  };
  const directory = await signEnvelope(
    unsigned(
      scope.authorAddress,
      AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
      directoryPayload,
    ),
    (value) => computeAuthorCatalogDirectoryNodeObjectDigestV1(value, scope.bucketCount),
    signer.signDigest,
    verifyIssuerSignature,
  );
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(directory.envelope, scope.bucketCount);
  const headPayload: AuthorCatalogHeadV1 = {
    networkId: scope.networkId,
    contextGraphId: scope.contextGraphId,
    governanceChainId: scope.governanceChainId,
    governanceContractAddress: scope.governanceContractAddress,
    ownershipTransitionDigest: scope.ownershipTransitionDigest,
    subGraphName: scope.subGraphName,
    authorAddress: scope.authorAddress,
    catalogIssuerDelegationDigest: delegation.objectDigest as Digest32V1,
    era: scope.era,
    version: '1' as DecimalU64V1,
    previousHeadDigest,
    bucketCount: scope.bucketCount,
    totalRows: String(prepared.length) as CountV1,
    directoryHeight: '0' as DecimalU64V1,
    directoryRootDigest: directory.envelope.objectDigest as Digest32V1,
    issuedAt,
  };
  const head = await signEnvelope(
    unsigned(scope.authorAddress, AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1, headPayload),
    computeAuthorCatalogHeadObjectDigestV1,
    signer.signDigest,
    verifyIssuerSignature,
  );
  assertSignedAuthorCatalogHeadEnvelopeV1(head.envelope);
  verifyAuthorCatalogDirectoryPathV1(
    head.envelope as never,
    [directory.envelope as never],
    '0' as DecimalU64V1,
  );
  const staged = await persistence.controlObjects.stageVerifiedObjects([
    bucket,
    directory,
    head,
  ]);
  const headReceipt = staged.objects.find(
    ({ objectDigest }) => objectDigest === head.envelope.objectDigest,
  );
  const expectedVariant = computeControlSignatureVariantDigestHex(
    head.envelope.objectDigest,
    head.envelope.signature,
  );
  if (headReceipt?.signatureVariantDigest !== expectedVariant) {
    throw new Error('bulk predecessor head did not receive an exact durable stage receipt');
  }
  return Object.freeze({
    headObjectDigest: head.envelope.objectDigest,
    signatureVariantDigest: headReceipt.signatureVariantDigest,
    catalogVersion: headPayload.version,
    inventoryRowCount: headPayload.totalRows,
    fixtureStageBatchSizes: plan.fixtureStageBatchSizes,
    stagedBundleCount: prepared.length,
  });
}

function prepareAsset(value: unknown, label: string): PreparedFixtureAssetV1 {
  const asset = record(value, label);
  assertAssertionCoordinateV1(asset.assertionCoordinate, `${label}.assertionCoordinate`);
  assertCanonicalGraphScopedAuthorSealV1(asset.seal);
  const projectionNQuads = requiredString(asset.projectionNQuads, `${label}.projectionNQuads`);
  const seal = asset.seal as CanonicalGraphScopedAuthorSealV1;
  const sealBytes = canonicalizeCanonicalGraphScopedAuthorSealBytesV1(seal);
  const encoded = encodeOpaqueKaBundleV1(new TextEncoder().encode(projectionNQuads), sealBytes);
  const byteLength = BigInt(encoded.bundleBytes.byteLength);
  const chunkCount = ((byteLength - 1n) / KA_TRANSFER_CHUNK_SIZE_BYTES_V1) + 1n;
  const row = parseCanonicalAuthorCatalogRowV1(canonicalizeAuthorCatalogRowV1({
    kaId: seal.reservedKaId,
    assertionCoordinate: asset.assertionCoordinate as AssertionCoordinateV1,
    assertionVersion: seal.assertionVersion,
    projectionId: KA_TRANSFER_PROJECTION_V1,
    projectionDigest: encoded.projectionDigest,
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal),
    transfer: {
      codec: KA_TRANSFER_CODEC_V1,
      projectionId: KA_TRANSFER_PROJECTION_V1,
      projectionDigest: encoded.projectionDigest,
      byteLength: byteLength.toString() as ByteLengthV1,
      chunkSize: KA_TRANSFER_CHUNK_SIZE_V1,
      chunkCount: chunkCount.toString() as CountV1,
      blobDigest: encoded.blobDigest,
      chunkTreeRoot: computeKaChunkTreeRootV1(encoded.bundleBytes),
    },
  }));
  return Object.freeze({
    row,
    bundleDigest: encoded.blobDigest,
    bundleBytes: new Uint8Array(encoded.bundleBytes),
  });
}

async function signEnvelope(
  unsignedEnvelope: UnsignedControlEnvelopeV1,
  computeDigest: (value: UnsignedControlEnvelopeV1) => Digest32V1,
  signDigest: (digest: Digest32V1) => Promise<string>,
  verifyIssuerSignature: (envelope: SignedControlEnvelopeV1) => Promise<unknown>,
): Promise<{
  readonly envelope: SignedControlEnvelopeV1;
  readonly issuerSignature: unknown;
}> {
  const objectDigest = computeDigest(unsignedEnvelope);
  const envelope = {
    ...unsignedEnvelope,
    objectDigest,
    signature: await signDigest(objectDigest),
  } as SignedControlEnvelopeV1;
  return Object.freeze({
    envelope,
    issuerSignature: await verifyIssuerSignature(envelope),
  });
}

function unsigned(
  issuer: AuthorCatalogScopeV1['authorAddress'],
  objectType: string,
  payload: unknown,
): UnsignedControlEnvelopeV1 {
  return {
    issuer,
    objectType,
    payload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as UnsignedControlEnvelopeV1;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function denseArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be an ordinary array`);
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) {
    throw new TypeError(`${label} must be a dense array without properties`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_000_000) {
    throw new TypeError(`${label} is missing or too long`);
  }
  return value;
}

function requiredDigest(value: unknown, label: string): Digest32V1 {
  const result = requiredString(value, label);
  if (!/^0x[0-9a-f]{64}$/u.test(result)) throw new TypeError(`${label} is not a digest`);
  return result as Digest32V1;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}
