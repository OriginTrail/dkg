// SPDX-License-Identifier: Apache-2.0

/**
 * Production boundary for the bounded one-bucket catalog successor slice.
 *
 * The adapter deliberately delegates catalog construction and every bundle,
 * seal, and projection codec check to the canonical RFC-64 helpers. Neither
 * the immutable bundle nor the signed control objects are exposed to durable
 * provider storage until the complete successor has passed those checks.
 */

import {
  KA_TRANSFER_CHUNK_SIZE_BYTES_V1,
  KA_TRANSFER_CHUNK_SIZE_V1,
  KA_TRANSFER_CODEC_V1,
  KA_TRANSFER_PROJECTION_V1,
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  MIN_KA_BUNDLE_BYTES_V1,
  ZERO_DIGEST32_V1,
  calculateOpaqueKaBundleByteLengthV1,
  canonicalizeAuthorCatalogRowV1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeKaChunkTreeRootV1,
  encodeOpaqueKaBundleV1,
  parseCanonicalAuthorCatalogRowV1,
  readVerifiedCatalogSealBindingV1,
  readVerifiedCgSharedProjectionMetadataV1,
  readVerifiedTransferredCatalogBundleMetadataV1,
  verifyAuthorCatalogDirectoryPathV1,
  verifyCatalogSealBindingV1,
  verifyCgSharedProjectionV1,
  verifyTransferredCatalogBundleV1,
  type AssertionCoordinateV1,
  type AuthorCatalogRowV1,
  type ByteLengthV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type CountV1,
  type DecimalU64V1,
  type Digest32V1,
  type SignedAuthorCatalogIssuerDelegationEnvelopeV1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type TimestampMsV1,
  type VerifiedCatalogSealBindingSnapshotV1,
  type VerifiedCgSharedProjectionMetadataV1,
  type VerifiedTransferredCatalogBundleMetadataV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import { mapWithConcurrency } from '../map-with-concurrency.js';
import {
  deriveVerifiedAuthorCatalogBucketRowAuthorshipsV1,
  readVerifiedAuthorCatalogRowAuthorshipV1,
  verifyAuthorCatalogRowAuthorshipV1,
  type AuthorAgentDelegationEvidenceV1,
  type VerifiedAuthorCatalogRowAuthorshipSnapshotV1,
} from './catalog-row-authorship.js';
import {
  produceSparseAuthorCatalogSuccessorV1,
  type ProducedAuthorCatalogPublicationV1,
  type Rfc64AuthorCatalogEip191SignerV1,
} from './author-catalog-producer.js';
import type {
  Rfc64ControlObjectOperationsV1,
  StageVerifiedControlObjectsResultV1,
} from './control-object-store-v1.js';
import { assertRecoverableAuthorAttestationCapabilityV1 } from './recoverable-author-attestation-v1.js';
import {
  RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_RESPONSE_MAX_BYTES_V1,
  addRfc64PublicCatalogExactSetBundleBytesV1,
} from './public-catalog-native-transport-v1.js';
import {
  snapshotAndSortRfc64PublicCatalogSuccessorAssetsV1,
  type Rfc64PublicCatalogSuccessorAssetInputV1,
} from './public-catalog-successor-asset-v1.js';

export type { Rfc64PublicCatalogSuccessorAssetInputV1 } from
  './public-catalog-successor-asset-v1.js';

export type Rfc64PublicCatalogSuccessorProducerErrorCodeV1 =
  | 'catalog-successor-producer-input'
  | 'catalog-successor-producer-history'
  | 'catalog-successor-producer-binding'
  | 'catalog-successor-producer-verification'
  | 'catalog-successor-producer-bundle-stage'
  | 'catalog-successor-producer-control-stage';

export class Rfc64PublicCatalogSuccessorProducerErrorV1 extends Error {
  constructor(
    readonly code: Rfc64PublicCatalogSuccessorProducerErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64PublicCatalogSuccessorProducerErrorV1';
  }
}

export interface StageRfc64PublicCatalogBundleV1 {
  readonly blobDigest: Digest32V1;
  /** Independently backed exact opaque bundle bytes. */
  readonly bundleBytes: Uint8Array;
}

/** Exact durable provider receipt for the immutable bundle write. */
export interface StagedRfc64PublicCatalogBundleReceiptV1 {
  readonly durable: true;
  readonly blobDigest: Digest32V1;
  readonly byteLength: number;
}

export interface Rfc64PublicCatalogIssuerAuthorizationV1 {
  readonly catalogIssuerDelegation: SignedAuthorCatalogIssuerDelegationEnvelopeV1;
  readonly parentAuthorAgentEvidence: AuthorAgentDelegationEvidenceV1 | null;
}

export interface Rfc64PublicCatalogSuccessorProducerOptionsV1 {
  readonly controlObjects: Pick<Rfc64ControlObjectOperationsV1, 'stageVerifiedObjects'>;
  /** Must return an exact receipt only after the immutable bytes are durably available. */
  readonly stageKaBundle: (
    input: StageRfc64PublicCatalogBundleV1,
  ) => Promise<StagedRfc64PublicCatalogBundleReceiptV1>;
  /**
   * Optional durable-cache read used to avoid re-fsyncing unchanged bundles
   * already referenced by the verified predecessor bucket.
   */
  readonly readKaBundleByDigest?: (blobDigest: Digest32V1) => Promise<Uint8Array | null>;
}

/** Bound independent immutable-bundle reads/writes without serializing an entire successor. */
const RFC64_SUCCESSOR_BUNDLE_IO_CONCURRENCY_V1 = 8;

export interface ProduceAndStagePublicOpenOneRowSuccessorInputV1 {
  readonly previousHead: SignedAuthorCatalogHeadEnvelopeV1;
  readonly previousDirectoryPath: readonly SignedAuthorCatalogDirectoryNodeEnvelopeV1[];
  readonly previousBucket: SignedAuthorCatalogBucketEnvelopeV1 | null;
  readonly assertionCoordinate: AssertionCoordinateV1;
  readonly projectionBytes: Uint8Array;
  readonly seal: CanonicalGraphScopedAuthorSealV1;
  readonly deployment: CatalogSealDeploymentProfileV1;
  readonly issuedAt: TimestampMsV1;
  readonly catalogSigner: Rfc64AuthorCatalogEip191SignerV1;
  /** Exact author/delegation closure authorizing the catalog signer for this lane. */
  readonly catalogIssuerAuthorization: Rfc64PublicCatalogIssuerAuthorizationV1;
}

/**
 * Complete replacement set for the root-lane bucket. The producer sorts the
 * caller-owned set by mathematical KA ID before signing it. The canonical
 * catalog producer still enforces the RFC-64 ordinary-successor invariant:
 * exactly one KA may be added, removed, or changed per successor.
 */
export interface ProduceAndStagePublicOpenExactSetSuccessorInputV1 {
  readonly previousHead: SignedAuthorCatalogHeadEnvelopeV1;
  readonly previousDirectoryPath: readonly SignedAuthorCatalogDirectoryNodeEnvelopeV1[];
  readonly previousBucket: SignedAuthorCatalogBucketEnvelopeV1 | null;
  /** Complete 0..1024-row live set; zero rows is the canonical final removal. */
  readonly assets: readonly Rfc64PublicCatalogSuccessorAssetInputV1[];
  readonly deployment: CatalogSealDeploymentProfileV1;
  readonly issuedAt: TimestampMsV1;
  readonly catalogSigner: Rfc64AuthorCatalogEip191SignerV1;
  readonly catalogIssuerAuthorization: Rfc64PublicCatalogIssuerAuthorizationV1;
}

export interface ProducedAndStagedPublicOpenOneRowSuccessorV1 {
  readonly publication: ProducedAuthorCatalogPublicationV1;
  readonly row: Readonly<AuthorCatalogRowV1>;
  readonly bundleDigest: Digest32V1;
  /** Fresh caller-owned copy; provider storage retains its own staged bytes. */
  readonly bundleBytes: Uint8Array;
  readonly sealBinding: VerifiedCatalogSealBindingSnapshotV1;
  readonly transfer: VerifiedTransferredCatalogBundleMetadataV1;
  readonly projection: VerifiedCgSharedProjectionMetadataV1;
  readonly authorship: VerifiedAuthorCatalogRowAuthorshipSnapshotV1;
  readonly stagedControlObjects: StageVerifiedControlObjectsResultV1;
}

export interface ProducedAndStagedPublicOpenSuccessorAssetV1 {
  readonly row: Readonly<AuthorCatalogRowV1>;
  readonly bundleDigest: Digest32V1;
  /** Fresh caller-owned copy; provider storage retains its own staged bytes. */
  readonly bundleBytes: Uint8Array;
  readonly sealBinding: VerifiedCatalogSealBindingSnapshotV1;
  readonly transfer: VerifiedTransferredCatalogBundleMetadataV1;
  readonly projection: VerifiedCgSharedProjectionMetadataV1;
  readonly authorship: VerifiedAuthorCatalogRowAuthorshipSnapshotV1;
}

export interface ProducedAndStagedPublicOpenExactSetSuccessorV1 {
  readonly publication: ProducedAuthorCatalogPublicationV1;
  /** Strictly increasing by mathematical KA ID. */
  readonly assets: readonly Readonly<ProducedAndStagedPublicOpenSuccessorAssetV1>[];
  readonly stagedControlObjects: StageVerifiedControlObjectsResultV1;
}

/**
 * Build, authenticate, fully verify, and durably stage one
 * root-lane successor. Bundle-first staging prevents a served head from
 * referring to an unavailable bundle; a later control-stage failure can leave
 * only an unreferenced immutable bundle.
 */
export class Rfc64PublicCatalogSuccessorProducerV1 {
  readonly #stageVerifiedObjects: Rfc64ControlObjectOperationsV1['stageVerifiedObjects'];
  readonly #stageKaBundle: Rfc64PublicCatalogSuccessorProducerOptionsV1['stageKaBundle'];
  readonly #readKaBundleByDigest:
    Rfc64PublicCatalogSuccessorProducerOptionsV1['readKaBundleByDigest'];

  constructor(options: Rfc64PublicCatalogSuccessorProducerOptionsV1) {
    if (
      typeof options?.controlObjects?.stageVerifiedObjects !== 'function'
      || typeof options?.stageKaBundle !== 'function'
    ) {
      fail('catalog-successor-producer-input', 'producer staging dependencies are incomplete');
    }
    this.#stageVerifiedObjects = options.controlObjects.stageVerifiedObjects
      .bind(options.controlObjects);
    this.#stageKaBundle = options.stageKaBundle;
    this.#readKaBundleByDigest = options.readKaBundleByDigest;
  }

  async produceAndStage(
    input: ProduceAndStagePublicOpenOneRowSuccessorInputV1,
  ): Promise<ProducedAndStagedPublicOpenOneRowSuccessorV1> {
    const result = await this.produceAndStageExactSet({
      previousHead: input.previousHead,
      previousDirectoryPath: input.previousDirectoryPath,
      previousBucket: input.previousBucket,
      assets: [{
        assertionCoordinate: input.assertionCoordinate,
        projectionBytes: input.projectionBytes,
        seal: input.seal,
      }],
      deployment: input.deployment,
      issuedAt: input.issuedAt,
      catalogSigner: input.catalogSigner,
      catalogIssuerAuthorization: input.catalogIssuerAuthorization,
    });
    const asset = result.assets[0];
    if (asset === undefined) {
      fail(
        'catalog-successor-producer-verification',
        'one-row compatibility result did not retain its catalog asset',
      );
    }
    return Object.freeze({
      publication: result.publication,
      row: asset.row,
      bundleDigest: asset.bundleDigest,
      bundleBytes: new Uint8Array(asset.bundleBytes),
      sealBinding: asset.sealBinding,
      transfer: asset.transfer,
      projection: asset.projection,
      authorship: asset.authorship,
      stagedControlObjects: result.stagedControlObjects,
    });
  }

  /** Build and durably stage one complete, canonical 0..1024-row live set. */
  async produceAndStageExactSet(
    input: ProduceAndStagePublicOpenExactSetSuccessorInputV1,
  ): Promise<ProducedAndStagedPublicOpenExactSetSuccessorV1> {
    const preparedAssets = prepareExactSet(input);
    assertSupportedPreviousSlice(input.previousHead, input.previousBucket);

    // Strict typed-row reconstruction, exact deployment binding, and the
    // recoverable EOA author proof all run for the complete set before signing
    // a catalog object or performing I/O.
    for (const prepared of preparedAssets) {
      try {
        const initialSealBinding = verifyCatalogSealBindingV1(
          prepared.scope,
          prepared.row,
          prepared.sealBytes,
          prepared.deployment,
        );
        assertRecoverableAuthorAttestationCapabilityV1(
          readVerifiedCatalogSealBindingV1(initialSealBinding),
        );
      } catch (cause) {
        fail(
          'catalog-successor-producer-binding',
          `author seal does not bind to exact public catalog row ${prepared.row.kaId}`,
          cause,
        );
      }
    }

    let publication: ProducedAuthorCatalogPublicationV1;
    try {
      publication = await produceSparseAuthorCatalogSuccessorV1({
        previousHead: input.previousHead,
        previousDirectoryPath: input.previousDirectoryPath,
        previousBucket: input.previousBucket,
        selectedBucketId: '0' as DecimalU64V1,
        nextRows: preparedAssets.map(({ row }) => row),
        issuedAt: input.issuedAt,
        signer: input.catalogSigner,
      });
    } catch (cause) {
      fail(
        'catalog-successor-producer-history',
        'bounded exact-set successor could not be built from the supplied history',
        cause,
      );
    }

    const producedBucket = publication.bucket;
    const producedRows = producedBucket?.payload.rows ?? [];
    if (
      publication.head.payload.bucketCount !== '1'
      || publication.head.payload.directoryHeight !== '0'
      || publication.head.payload.totalRows !== String(preparedAssets.length)
      || publication.head.payload.version === '0'
      || publication.head.payload.previousHeadDigest === null
      || (preparedAssets.length === 0 && producedBucket !== null)
      || (preparedAssets.length > 0 && producedBucket === null)
      || producedRows.length !== preparedAssets.length
    ) {
      fail(
        'catalog-successor-producer-verification',
        'produced catalog is outside the bounded exact-set successor slice',
      );
    }

    const verifiedAssets = producedRows.map((producedRow, index) => {
      const prepared = preparedAssets[index];
      if (prepared === undefined || producedRow.kaId !== prepared.row.kaId) {
        fail(
          'catalog-successor-producer-verification',
          'produced bucket did not retain the canonical exact-set row order',
        );
      }
      try {
        const transferred = verifyTransferredCatalogBundleV1(
          publication.head,
          producedRow,
          prepared.bundleBytes,
          prepared.deployment,
        );
        const transfer = readVerifiedTransferredCatalogBundleMetadataV1(
          transferred,
          publication.head,
          producedRow,
          prepared.deployment,
        );
        const sealBinding = readVerifiedCatalogSealBindingV1(transfer.catalogSealBinding);
        assertRecoverableAuthorAttestationCapabilityV1(sealBinding);
        const verifiedProjection = verifyCgSharedProjectionV1(
          transferred,
          publication.head,
          producedRow,
          prepared.deployment,
        );
        const projection = readVerifiedCgSharedProjectionMetadataV1(
          verifiedProjection,
          transferred,
          publication.head,
          producedRow,
          prepared.deployment,
        );
        return { prepared, row: producedRow, sealBinding, transfer, projection };
      } catch (cause) {
        fail(
          'catalog-successor-producer-verification',
          `produced successor failed exact verification for row ${producedRow.kaId}`,
          cause,
        );
      }
    });

    let verifiedObjects;
    let authorship: readonly VerifiedAuthorCatalogRowAuthorshipSnapshotV1[];
    try {
      const authorization = input.catalogIssuerAuthorization;
      const catalogIssuerDelegationSignature = await verifyControlEnvelopeIssuerSignatureV1(
        authorization.catalogIssuerDelegation,
      );
      verifiedObjects = await Promise.all(
        publication.stagedObjects.map(async (envelope) => ({
          envelope,
          issuerSignature: await verifyControlEnvelopeIssuerSignatureV1(envelope),
        })),
      );
      const signaturesByDigest = new Map(
        verifiedObjects.map(({ envelope, issuerSignature }) => [
          envelope.objectDigest,
          issuerSignature,
        ] as const),
      );
      const directoryPathProof = verifyAuthorCatalogDirectoryPathV1(
        publication.head,
        publication.directoryPath,
        '0' as DecimalU64V1,
      );
      const headSignature = requiredSignature(
        signaturesByDigest,
        publication.head.objectDigest,
        'catalog head',
      );
      const directoryPathSignatures = publication.directoryPath.map((envelope, index) =>
        requiredSignature(
          signaturesByDigest,
          envelope.objectDigest,
          `directory path node ${index}`,
        ));
      if (producedBucket === null) {
        authorship = Object.freeze([]);
      } else {
        const bucketSignature = requiredSignature(
          signaturesByDigest,
          producedBucket.objectDigest,
          'catalog bucket',
        );
        const anchorRow = producedBucket.payload.rows[0];
        if (anchorRow === undefined) {
          fail(
            'catalog-successor-producer-verification',
            'a non-empty produced bucket has no authorship anchor row',
          );
        }
        const anchor = verifyAuthorCatalogRowAuthorshipV1({
          catalogIssuerDelegation: authorization.catalogIssuerDelegation,
          catalogIssuerDelegationSignature,
          parentAuthorAgentEvidence: authorization.parentAuthorAgentEvidence,
          catalogHead: publication.head,
          catalogHeadSignature: headSignature,
          directoryPathEnvelopes: publication.directoryPath,
          directoryPathSignatures,
          directoryPathProof,
          catalogBucket: producedBucket,
          catalogBucketSignature: bucketSignature,
          targetKaId: anchorRow.kaId,
        });
        authorship = deriveVerifiedAuthorCatalogBucketRowAuthorshipsV1(
          anchor,
          producedBucket,
        ).map(readVerifiedAuthorCatalogRowAuthorshipV1);
      }
    } catch (cause) {
      fail(
        'catalog-successor-producer-verification',
        'produced control objects failed signature or author-catalog authorship verification',
        cause,
      );
    }

    const previousBundleByKaId = new Map(
      (input.previousBucket?.payload.rows ?? []).map((row) => [
        row.kaId,
        row.transfer.blobDigest,
      ] as const),
    );
    await mapWithConcurrency(
      verifiedAssets,
      RFC64_SUCCESSOR_BUNDLE_IO_CONCURRENCY_V1,
      async ({ prepared, row }): Promise<void> => {
        try {
          if (
            previousBundleByKaId.get(row.kaId) === prepared.encoded.blobDigest
            && this.#readKaBundleByDigest !== undefined
          ) {
            const existing = await this.#readKaBundleByDigest(prepared.encoded.blobDigest);
            if (existing !== null && bytesEqualV1(existing, prepared.bundleBytes)) return;
          }
          const bundleReceipt = await this.#stageKaBundle(Object.freeze({
            blobDigest: prepared.encoded.blobDigest,
            bundleBytes: new Uint8Array(prepared.bundleBytes),
          }));
          assertExactDurableBundleReceipt(
            bundleReceipt,
            prepared.encoded.blobDigest,
            prepared.bundleBytes.byteLength,
          );
        } catch (cause) {
          fail(
            'catalog-successor-producer-bundle-stage',
            `verified opaque KA bundle ${prepared.row.kaId} could not be staged`,
            cause,
          );
        }
      },
    );

    let stagedControlObjects: StageVerifiedControlObjectsResultV1;
    try {
      stagedControlObjects = await this.#stageVerifiedObjects(verifiedObjects);
    } catch (cause) {
      fail(
        'catalog-successor-producer-control-stage',
        'verified successor control objects could not be staged',
        cause,
      );
    }

    const assets = verifiedAssets.map((verified, index) => {
      const rowAuthorship = authorship[index];
      if (rowAuthorship === undefined) {
        fail(
          'catalog-successor-producer-verification',
          `verified authorship is unavailable for row ${verified.row.kaId}`,
        );
      }
      return Object.freeze({
        row: verified.row,
        bundleDigest: verified.prepared.encoded.blobDigest,
        bundleBytes: new Uint8Array(verified.prepared.bundleBytes),
        sealBinding: verified.sealBinding,
        transfer: verified.transfer,
        projection: verified.projection,
        authorship: rowAuthorship,
      });
    });
    return Object.freeze({
      publication,
      assets: Object.freeze(assets),
      stagedControlObjects,
    });
  }
}

function bytesEqualV1(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function prepareExactSet(input: ProduceAndStagePublicOpenExactSetSuccessorInputV1) {
  let assets: readonly Readonly<Rfc64PublicCatalogSuccessorAssetInputV1>[];
  try {
    assets = snapshotAndSortRfc64PublicCatalogSuccessorAssetsV1(
      input?.assets,
      'RFC-64 successor assets',
    );
  } catch (cause) {
    fail('catalog-successor-producer-input', 'assets are not one canonical exact set', cause);
  }
  const snapshots: PreparedRfc64PublicCatalogSuccessorAssetSnapshotV1[] = [];
  let aggregateBundleBytes = 0n;
  for (const asset of assets) {
    try {
      // Reject a projection that cannot possibly fit the Gate-1 transport
      // before allocating its detached snapshot.
      if (
        BigInt(asset.projectionBytes.byteLength)
        > BigInt(RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_RESPONSE_MAX_BYTES_V1)
          - MIN_KA_BUNDLE_BYTES_V1
      ) {
        throw new RangeError('projection exceeds the Gate-1 complete-bundle ceiling');
      }
      const sealBytes = canonicalizeCanonicalGraphScopedAuthorSealBytesV1(asset.seal);
      const bundleByteLength = calculateOpaqueKaBundleByteLengthV1(
        BigInt(asset.projectionBytes.byteLength),
        BigInt(sealBytes.byteLength),
      );
      if (bundleByteLength > BigInt(RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_RESPONSE_MAX_BYTES_V1)) {
        throw new RangeError('bundle exceeds the Gate-1 complete-bundle ceiling');
      }
      const canonicalBundleByteLength = bundleByteLength.toString() as ByteLengthV1;
      aggregateBundleBytes = addRfc64PublicCatalogExactSetBundleBytesV1(
        aggregateBundleBytes,
        canonicalBundleByteLength,
      );
      snapshots.push(Object.freeze({
        assertionCoordinate: asset.assertionCoordinate,
        projectionBytes: new Uint8Array(asset.projectionBytes),
        seal: asset.seal,
        sealBytes,
        bundleByteLength,
      }));
    } catch (cause) {
      fail(
        'catalog-successor-producer-input',
        'projection, seal, or exact-set bundle-byte budget is not canonical',
        cause,
      );
    }
  }
  const prepared = snapshots.map((snapshot) => prepareRowAndBundle(
    snapshot,
    input.previousHead,
    input.deployment,
  ));
  return Object.freeze(prepared);
}

interface PreparedRfc64PublicCatalogSuccessorAssetSnapshotV1 {
  readonly assertionCoordinate: AssertionCoordinateV1;
  readonly projectionBytes: Uint8Array;
  readonly seal: CanonicalGraphScopedAuthorSealV1;
  readonly sealBytes: Uint8Array;
  readonly bundleByteLength: bigint;
}

function prepareRowAndBundle(
  asset: PreparedRfc64PublicCatalogSuccessorAssetSnapshotV1,
  previousHead: SignedAuthorCatalogHeadEnvelopeV1,
  deploymentInput: CatalogSealDeploymentProfileV1,
) {
  let encoded: ReturnType<typeof encodeOpaqueKaBundleV1>;
  let row: AuthorCatalogRowV1;
  try {
    encoded = encodeOpaqueKaBundleV1(asset.projectionBytes, asset.sealBytes);
    const byteLength = BigInt(encoded.bundleBytes.byteLength);
    if (byteLength !== asset.bundleByteLength) {
      throw new Error('encoded bundle length differs from its exact-set budget snapshot');
    }
    const chunkCount = ((byteLength - 1n) / KA_TRANSFER_CHUNK_SIZE_BYTES_V1) + 1n;
    row = parseCanonicalAuthorCatalogRowV1(canonicalizeAuthorCatalogRowV1({
      kaId: asset.seal.reservedKaId,
      assertionCoordinate: asset.assertionCoordinate,
      assertionVersion: asset.seal.assertionVersion,
      projectionId: KA_TRANSFER_PROJECTION_V1,
      projectionDigest: encoded.projectionDigest,
      sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(asset.seal),
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
    const deployment = Object.freeze({
      networkId: deploymentInput.networkId,
      assertedAtChainId: deploymentInput.assertedAtChainId,
      assertedAtKav10Address: deploymentInput.assertedAtKav10Address,
    });
    const scope = Object.freeze({
      networkId: previousHead.payload.networkId,
      contextGraphId: previousHead.payload.contextGraphId,
      governanceChainId: previousHead.payload.governanceChainId,
      governanceContractAddress: previousHead.payload.governanceContractAddress,
      ownershipTransitionDigest: previousHead.payload.ownershipTransitionDigest,
      subGraphName: previousHead.payload.subGraphName,
      authorAddress: previousHead.payload.authorAddress,
      era: previousHead.payload.era,
      bucketCount: previousHead.payload.bucketCount,
    });
    return Object.freeze({
      deployment,
      scope,
      row: Object.freeze(row),
      sealBytes: asset.sealBytes,
      encoded,
      bundleBytes: new Uint8Array(encoded.bundleBytes),
    });
  } catch (cause) {
    fail(
      'catalog-successor-producer-input',
      'projection, seal, or catalog-row input is not canonical',
      cause,
    );
  }
}

function requiredSignature(
  signaturesByDigest: ReadonlyMap<
    string,
    Awaited<ReturnType<typeof verifyControlEnvelopeIssuerSignatureV1>>
  >,
  objectDigest: string,
  label: string,
): Awaited<ReturnType<typeof verifyControlEnvelopeIssuerSignatureV1>> {
  const signature = signaturesByDigest.get(objectDigest);
  if (signature === undefined) {
    throw new Error(`verified signature for ${label} is unavailable`);
  }
  return signature;
}

function assertExactDurableBundleReceipt(
  receipt: StagedRfc64PublicCatalogBundleReceiptV1,
  expectedBlobDigest: Digest32V1,
  expectedByteLength: number,
): void {
  if (
    (typeof receipt !== 'object' || receipt === null)
    || receipt.durable !== true
    || receipt.blobDigest !== expectedBlobDigest
    || receipt.byteLength !== expectedByteLength
  ) {
    throw new Error('bundle provider did not return the exact durable digest/length receipt');
  }
}

function assertSupportedPreviousSlice(
  head: SignedAuthorCatalogHeadEnvelopeV1,
  bucket: SignedAuthorCatalogBucketEnvelopeV1 | null,
): void {
  if (
    head.payload.bucketCount !== '1'
    || head.payload.directoryHeight !== '0'
    || BigInt(head.payload.totalRows) > BigInt(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1)
    || (head.payload.totalRows === '0' && bucket !== null)
    || (head.payload.totalRows !== '0'
      && bucket?.payload.rows.length !== Number(head.payload.totalRows))
    || head.payload.directoryRootDigest === ZERO_DIGEST32_V1
  ) {
    fail(
      'catalog-successor-producer-history',
      'previous catalog is outside the bounded one-bucket successor slice',
    );
  }
}

function fail(
  code: Rfc64PublicCatalogSuccessorProducerErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64PublicCatalogSuccessorProducerErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
