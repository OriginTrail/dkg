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
  MIN_KA_BUNDLE_BYTES_V1,
  ZERO_DIGEST32_V1,
  calculateOpaqueKaBundleByteLengthV1,
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

import {
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
import { assertRecoverableAuthorAttestationV1 } from './public-catalog-native-receiver-v1.js';
import { RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_RESPONSE_MAX_BYTES_V1 } from './public-catalog-native-transport-v1.js';

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
  /** Exact author/delegation closure authorizing the catalog signer for this lane. */
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
    let authorship: VerifiedAuthorCatalogRowAuthorshipSnapshotV1;
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
      const authorshipToken = verifyAuthorCatalogRowAuthorshipV1({
        catalogIssuerDelegation: authorization.catalogIssuerDelegation,
        catalogIssuerDelegationSignature,
        parentAuthorAgentEvidence: authorization.parentAuthorAgentEvidence,
        catalogHead: publication.head,
        catalogHeadSignature: requiredSignature(
          signaturesByDigest,
          publication.head.objectDigest,
          'catalog head',
        ),
        directoryPathEnvelopes: publication.directoryPath,
        directoryPathSignatures: publication.directoryPath.map((envelope, index) =>
          requiredSignature(
            signaturesByDigest,
            envelope.objectDigest,
            `directory path node ${index}`,
          )),
        directoryPathProof,
        catalogBucket: producedBucket,
        catalogBucketSignature: requiredSignature(
          signaturesByDigest,
          producedBucket.objectDigest,
          'catalog bucket',
        ),
        targetKaId: producedRow.kaId,
      });
      authorship = readVerifiedAuthorCatalogRowAuthorshipV1(authorshipToken);
    } catch (cause) {
      fail(
        'catalog-successor-producer-verification',
        'produced control objects failed signature or author-catalog authorship verification',
        cause,
      );
    }

    try {
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
      authorship,
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
    if (!(input?.projectionBytes instanceof Uint8Array)) {
      throw new TypeError('projectionBytes must be a Uint8Array');
    }
    // Reject a projection that cannot possibly fit the Gate-1 transport before
    // canonicalizing the seal or allocating/copying a complete bundle.
    if (
      BigInt(input.projectionBytes.byteLength)
      > BigInt(RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_RESPONSE_MAX_BYTES_V1)
        - MIN_KA_BUNDLE_BYTES_V1
    ) {
      throw new RangeError('projection exceeds the Gate-1 complete-bundle ceiling');
    }
    const assertionCoordinate = input?.assertionCoordinate;
    const previousHead = input?.previousHead;
    sealBytes = canonicalizeCanonicalGraphScopedAuthorSealBytesV1(input.seal);
    seal = parseCanonicalGraphScopedAuthorSealV1(sealBytes);
    const bundleByteLength = calculateOpaqueKaBundleByteLengthV1(
      BigInt(input.projectionBytes.byteLength),
      BigInt(sealBytes.byteLength),
    );
    if (bundleByteLength > BigInt(RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_RESPONSE_MAX_BYTES_V1)) {
      throw new RangeError('bundle exceeds the Gate-1 complete-bundle ceiling');
    }
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
