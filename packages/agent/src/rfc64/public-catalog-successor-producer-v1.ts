// SPDX-License-Identifier: Apache-2.0

/**
 * Production boundary for the Gate-1 public/open one-row successor slice.
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
  ZERO_DIGEST32_V1,
  canonicalizeAuthorCatalogRowV1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeKaChunkTreeRootV1,
  encodeOpaqueKaBundleV1,
  parseCanonicalAuthorCatalogRowV1,
  parseCanonicalGraphScopedAuthorSealV1,
  readVerifiedCatalogSealBindingV1,
  readVerifiedCgSharedProjectionMetadataV1,
  readVerifiedTransferredCatalogBundleMetadataV1,
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
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type TimestampMsV1,
  type VerifiedCatalogSealBindingSnapshotV1,
  type VerifiedCgSharedProjectionMetadataV1,
  type VerifiedTransferredCatalogBundleMetadataV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import {
  produceSparseAuthorCatalogSuccessorV1,
  type ProducedAuthorCatalogPublicationV1,
  type Rfc64AuthorCatalogEip191SignerV1,
} from './author-catalog-producer.js';
import type {
  Rfc64ControlObjectOperationsV1,
  StageVerifiedControlObjectsResultV1,
} from './control-object-store-v1.js';
import { assertRecoverableAuthorAttestationV1 } from './public-catalog-native-receiver-v1.js';

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

export interface Rfc64PublicCatalogSuccessorProducerOptionsV1 {
  readonly controlObjects: Pick<Rfc64ControlObjectOperationsV1, 'stageVerifiedObjects'>;
  /** Must resolve only after the immutable bundle is durably available by digest. */
  readonly stageKaBundle: (input: StageRfc64PublicCatalogBundleV1) => Promise<void>;
}

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
  readonly stagedControlObjects: StageVerifiedControlObjectsResultV1;
}

/**
 * Build, authenticate, fully verify, and durably stage one public/open
 * root-lane successor. Bundle-first staging prevents a served head from
 * referring to an unavailable bundle; a later control-stage failure can leave
 * only an unreferenced immutable bundle.
 */
export class Rfc64PublicCatalogSuccessorProducerV1 {
  readonly #stageVerifiedObjects: Rfc64ControlObjectOperationsV1['stageVerifiedObjects'];
  readonly #stageKaBundle: Rfc64PublicCatalogSuccessorProducerOptionsV1['stageKaBundle'];

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
  }

  async produceAndStage(
    input: ProduceAndStagePublicOpenOneRowSuccessorInputV1,
  ): Promise<ProducedAndStagedPublicOpenOneRowSuccessorV1> {
    const prepared = prepareRowAndBundle(input);
    assertSupportedPreviousSlice(input.previousHead, input.previousBucket);

    // PR #1780's strict typed-row reconstruction, exact deployment binding,
    // and recoverable EOA author proof all run before catalog signing or I/O.
    let initialSealBinding: ReturnType<typeof verifyCatalogSealBindingV1>;
    try {
      initialSealBinding = verifyCatalogSealBindingV1(
        prepared.scope,
        prepared.row,
        prepared.sealBytes,
        prepared.deployment,
      );
      assertRecoverableAuthorAttestationV1(
        readVerifiedCatalogSealBindingV1(initialSealBinding),
      );
    } catch (cause) {
      fail(
        'catalog-successor-producer-binding',
        'author seal does not bind to the exact public catalog row',
        cause,
      );
    }

    let publication: ProducedAuthorCatalogPublicationV1;
    try {
      publication = await produceSparseAuthorCatalogSuccessorV1({
        previousHead: input.previousHead,
        previousDirectoryPath: input.previousDirectoryPath,
        previousBucket: input.previousBucket,
        selectedBucketId: '0' as DecimalU64V1,
        nextRows: [prepared.row],
        issuedAt: input.issuedAt,
        signer: input.catalogSigner,
      });
    } catch (cause) {
      fail(
        'catalog-successor-producer-history',
        'one-row successor could not be built from the supplied history',
        cause,
      );
    }

    const producedBucket = publication.bucket;
    if (
      publication.head.payload.subGraphName !== null
      || publication.head.payload.bucketCount !== '1'
      || publication.head.payload.directoryHeight !== '0'
      || publication.head.payload.totalRows !== '1'
      || publication.head.payload.version === '0'
      || publication.head.payload.previousHeadDigest === null
      || producedBucket === null
      || producedBucket.payload.rows.length !== 1
    ) {
      fail(
        'catalog-successor-producer-verification',
        'produced catalog is outside the public/open one-row successor slice',
      );
    }
    const producedRow = producedBucket.payload.rows[0];
    if (producedRow === undefined) {
      fail(
        'catalog-successor-producer-verification',
        'produced one-row bucket did not retain its catalog row',
      );
    }

    let transferred: ReturnType<typeof verifyTransferredCatalogBundleV1>;
    let transfer: VerifiedTransferredCatalogBundleMetadataV1;
    let projection: VerifiedCgSharedProjectionMetadataV1;
    let sealBinding: VerifiedCatalogSealBindingSnapshotV1;
    try {
      transferred = verifyTransferredCatalogBundleV1(
        publication.head,
        producedRow,
        prepared.bundleBytes,
        prepared.deployment,
      );
      transfer = readVerifiedTransferredCatalogBundleMetadataV1(
        transferred,
        publication.head,
        producedRow,
        prepared.deployment,
      );
      sealBinding = readVerifiedCatalogSealBindingV1(transfer.catalogSealBinding);
      assertRecoverableAuthorAttestationV1(sealBinding);
      const verifiedProjection = verifyCgSharedProjectionV1(
        transferred,
        publication.head,
        producedRow,
        prepared.deployment,
      );
      projection = readVerifiedCgSharedProjectionMetadataV1(
        verifiedProjection,
        transferred,
        publication.head,
        producedRow,
        prepared.deployment,
      );
    } catch (cause) {
      fail(
        'catalog-successor-producer-verification',
        'produced successor failed exact bundle, seal, or shared-projection verification',
        cause,
      );
    }

    let verifiedObjects;
    try {
      verifiedObjects = await Promise.all(publication.stagedObjects.map(async (envelope) => ({
        envelope,
        issuerSignature: await verifyControlEnvelopeIssuerSignatureV1(envelope),
      })));
    } catch (cause) {
      fail(
        'catalog-successor-producer-verification',
        'produced control-object signature verification failed',
        cause,
      );
    }

    try {
      await this.#stageKaBundle(Object.freeze({
        blobDigest: prepared.encoded.blobDigest,
        bundleBytes: new Uint8Array(prepared.bundleBytes),
      }));
    } catch (cause) {
      fail(
        'catalog-successor-producer-bundle-stage',
        'verified opaque KA bundle could not be staged',
        cause,
      );
    }

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

    return Object.freeze({
      publication,
      row: producedRow,
      bundleDigest: prepared.encoded.blobDigest,
      bundleBytes: new Uint8Array(prepared.bundleBytes),
      sealBinding,
      transfer,
      projection,
      stagedControlObjects,
    });
  }
}

function prepareRowAndBundle(input: ProduceAndStagePublicOpenOneRowSuccessorInputV1) {
  let sealBytes: Uint8Array;
  let seal: CanonicalGraphScopedAuthorSealV1;
  let encoded: ReturnType<typeof encodeOpaqueKaBundleV1>;
  let row: AuthorCatalogRowV1;
  try {
    const assertionCoordinate = input?.assertionCoordinate;
    const previousHead = input?.previousHead;
    sealBytes = canonicalizeCanonicalGraphScopedAuthorSealBytesV1(input.seal);
    seal = parseCanonicalGraphScopedAuthorSealV1(sealBytes);
    encoded = encodeOpaqueKaBundleV1(input.projectionBytes, sealBytes);
    const byteLength = BigInt(encoded.bundleBytes.byteLength);
    const chunkCount = ((byteLength - 1n) / KA_TRANSFER_CHUNK_SIZE_BYTES_V1) + 1n;
    row = parseCanonicalAuthorCatalogRowV1(canonicalizeAuthorCatalogRowV1({
      kaId: seal.reservedKaId,
      assertionCoordinate,
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
    const deployment = Object.freeze({
      networkId: input.deployment.networkId,
      assertedAtChainId: input.deployment.assertedAtChainId,
      assertedAtKav10Address: input.deployment.assertedAtKav10Address,
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
      sealBytes,
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

function assertSupportedPreviousSlice(
  head: SignedAuthorCatalogHeadEnvelopeV1,
  bucket: SignedAuthorCatalogBucketEnvelopeV1 | null,
): void {
  if (
    head.payload.subGraphName !== null
    || head.payload.bucketCount !== '1'
    || head.payload.directoryHeight !== '0'
    || (head.payload.totalRows !== '0' && head.payload.totalRows !== '1')
    || (head.payload.totalRows === '0' && bucket !== null)
    || (head.payload.totalRows === '1' && bucket?.payload.rows.length !== 1)
    || head.payload.directoryRootDigest === ZERO_DIGEST32_V1
  ) {
    fail(
      'catalog-successor-producer-history',
      'previous catalog is outside the public/open one-row root-lane slice',
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
