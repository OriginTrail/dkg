// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded Gate-1 receiver for one public/open root-lane catalog row.
 *
 * The supported first vertical slice is intentionally narrow: one successor
 * head, one bucket, one row, root context-graph lane, and one complete bundle.
 * Every network hop is RFC-64 catalog-native. Activation happens only after
 * signed head/path/bucket verification, transfer verification, canonical
 * projection verification, one atomic SWM graph replace, and exact post-read.
 */

import {
  AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  ZERO_DIGEST32_V1,
  assertAuthorCatalogBucketScopeBindingV1,
  assertAuthorCatalogDirectoryNodeScopeBindingV1,
  assertSignedAuthorCatalogBucketEnvelopeV1,
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  canonicalizeAuthorCatalogBucketPayloadBytesV1,
  computeControlSignatureVariantDigestHex,
  contextGraphWorkspaceGraphUri,
  deriveAuthorCatalogScopeFromHeadV1,
  readVerifiedAuthorCatalogBucketDescriptorV1,
  readVerifiedCgSharedProjectionBytesV1,
  readVerifiedCgSharedProjectionMetadataV1,
  verifyAuthorCatalogDirectoryPathV1,
  verifyCgSharedProjectionV1,
  verifyTransferredCatalogBundleV1,
  type AuthorCatalogRowV1,
  type CatalogSealDeploymentProfileV1,
  type Digest32V1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  quadsToNQuads,
  readExactGraphPaged,
  tryReplaceGraphAtomically,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

import { parseNQuads } from '../dkg-agent-utils.js';
import { unpackKnowledgeAssetId } from '../ka-identity.js';
import type { Rfc64ControlObjectOperationsV1 } from './control-object-store-v1.js';
import {
  RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1,
  RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
  type Rfc64PublicCatalogNativeFetchScopeV1,
  type Rfc64PublicCatalogNativeTransportV1,
} from './public-catalog-native-transport-v1.js';
import type {
  Rfc64PublicCatalogHeadAnnouncementV1,
  Rfc64PublicCatalogTransportV1,
} from './public-catalog-transport-v1.js';

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export interface Rfc64PublicCatalogNativeReceiverOptionsV1 {
  readonly headTransport: Rfc64PublicCatalogTransportV1;
  readonly contentTransport: Rfc64PublicCatalogNativeTransportV1;
  readonly controlObjects: Pick<Rfc64ControlObjectOperationsV1, 'stageVerifiedObjects'>;
  readonly store: TripleStore;
  readonly transportTimeoutMs?: number;
}

export interface Rfc64PublicCatalogNativeActivationEvidenceV1 {
  /** Exact signed successor head digest: the complete one-row inventory commitment. */
  readonly inventoryDigest: Digest32V1;
  readonly catalogRowDigest: Digest32V1;
  readonly contentDigest: Digest32V1;
  readonly bundleDigest: Digest32V1;
  readonly kaUal: string;
  readonly inventoryRowCount: 1;
  readonly activatedTripleCount: number;
  readonly swmGraph: string;
}

export type Rfc64PublicCatalogNativeReceiverErrorCodeV1 =
  | 'catalog-native-receiver-input'
  | 'catalog-native-receiver-not-found'
  | 'catalog-native-receiver-slice'
  | 'catalog-native-receiver-catalog'
  | 'catalog-native-receiver-transfer'
  | 'catalog-native-receiver-activation';

export class Rfc64PublicCatalogNativeReceiverErrorV1 extends Error {
  constructor(
    readonly code: Rfc64PublicCatalogNativeReceiverErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64PublicCatalogNativeReceiverErrorV1';
  }
}

export class Rfc64PublicCatalogNativeReceiverV1 {
  readonly #timeoutMs: number;

  constructor(private readonly options: Rfc64PublicCatalogNativeReceiverOptionsV1) {
    if (
      typeof options?.headTransport?.fetchCatalogHead !== 'function'
      || typeof options?.contentTransport?.fetchCatalogObject !== 'function'
      || typeof options.controlObjects?.stageVerifiedObjects !== 'function'
      || typeof options.store?.query !== 'function'
    ) {
      fail('catalog-native-receiver-input', 'receiver dependencies are incomplete');
    }
    const timeoutMs = options.transportTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      fail('catalog-native-receiver-input', 'transportTimeoutMs must be a positive safe integer');
    }
    this.#timeoutMs = timeoutMs;
  }

  async synchronizeOnePublicOpenRow(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    deployment: CatalogSealDeploymentProfileV1,
  ): Promise<Rfc64PublicCatalogNativeActivationEvidenceV1> {
    const fetchedHead = await this.options.headTransport.fetchCatalogHead(
      remotePeerId,
      announcement,
      { timeoutMs: this.#timeoutMs },
    );
    if (fetchedHead === null) {
      fail('catalog-native-receiver-not-found', 'announced successor head was not found');
    }
    const head = fetchedHead.envelope;
    assertFirstSliceHead(head);
    const scope = nativeScope(announcement, head);

    const fetchedDirectory = await this.options.contentTransport.fetchCatalogObject(
      remotePeerId,
      {
        ...scope,
        kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
        targetObjectType: AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
        targetObjectDigest: head.payload.directoryRootDigest,
      },
      { timeoutMs: this.#timeoutMs },
    );
    if (fetchedDirectory === null) {
      fail('catalog-native-receiver-not-found', 'successor directory root was not found');
    }
    let directory: SignedAuthorCatalogDirectoryNodeEnvelopeV1;
    try {
      assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(
        fetchedDirectory.envelope,
        head.payload.bucketCount,
      );
      directory = fetchedDirectory.envelope;
      assertAuthorCatalogDirectoryNodeScopeBindingV1(
        directory.payload,
        deriveAuthorCatalogScopeFromHeadV1(head.payload),
      );
      if (directory.issuer !== head.issuer) throw new Error('directory issuer differs from head');
    } catch (cause) {
      fail('catalog-native-receiver-catalog', 'directory root is not bound to the successor head', cause);
    }

    let descriptor: ReturnType<typeof readVerifiedAuthorCatalogBucketDescriptorV1>;
    try {
      const path = verifyAuthorCatalogDirectoryPathV1(head, [directory], '0' as never);
      descriptor = readVerifiedAuthorCatalogBucketDescriptorV1(path, head);
    } catch (cause) {
      fail('catalog-native-receiver-catalog', 'successor directory path is invalid', cause);
    }
    if (descriptor.rowCount !== '1' || descriptor.bucketDigest === ZERO_DIGEST32_V1) {
      fail('catalog-native-receiver-slice', 'first receiver slice requires one non-empty bucket row');
    }

    const fetchedBucket = await this.options.contentTransport.fetchCatalogObject(
      remotePeerId,
      {
        ...scope,
        kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
        targetObjectType: AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
        targetObjectDigest: descriptor.bucketDigest,
      },
      { timeoutMs: this.#timeoutMs },
    );
    if (fetchedBucket === null) {
      fail('catalog-native-receiver-not-found', 'successor catalog bucket was not found');
    }
    let bucket: SignedAuthorCatalogBucketEnvelopeV1;
    try {
      assertSignedAuthorCatalogBucketEnvelopeV1(fetchedBucket.envelope);
      bucket = fetchedBucket.envelope;
      assertAuthorCatalogBucketScopeBindingV1(
        bucket.payload,
        deriveAuthorCatalogScopeFromHeadV1(head.payload),
      );
      if (
        bucket.issuer !== head.issuer
        || bucket.objectDigest !== descriptor.bucketDigest
        || bucket.payload.bucketId !== descriptor.bucketId
        || bucket.payload.rows.length !== 1
        || bucket.payload.rows.length.toString() !== descriptor.rowCount
        || canonicalizeAuthorCatalogBucketPayloadBytesV1(bucket.payload).byteLength.toString()
          !== descriptor.byteLength
      ) {
        throw new Error('bucket differs from its verified directory descriptor');
      }
    } catch (cause) {
      fail('catalog-native-receiver-catalog', 'catalog bucket is not bound to its directory', cause);
    }
    const row = bucket.payload.rows[0];
    if (row === undefined) {
      fail('catalog-native-receiver-catalog', 'verified one-row bucket did not contain its row');
    }

    const bundle = await this.options.contentTransport.fetchKaBundle(
      remotePeerId,
      {
        ...scope,
        kind: RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1,
        blobDigest: row.transfer.blobDigest,
        byteLength: row.transfer.byteLength as never,
      },
      { timeoutMs: this.#timeoutMs },
    );
    if (bundle === null) {
      fail('catalog-native-receiver-not-found', 'catalog row KA bundle was not found');
    }

    let projectionMetadata: ReturnType<typeof readVerifiedCgSharedProjectionMetadataV1>;
    let projectionBytes: Uint8Array;
    try {
      const transferred = verifyTransferredCatalogBundleV1(head, row, bundle, deployment);
      const projection = verifyCgSharedProjectionV1(transferred, head, row, deployment);
      projectionMetadata = readVerifiedCgSharedProjectionMetadataV1(
        projection,
        transferred,
        head,
        row,
        deployment,
      );
      projectionBytes = readVerifiedCgSharedProjectionBytesV1(
        projection,
        transferred,
        head,
        row,
        deployment,
      );
    } catch (cause) {
      fail('catalog-native-receiver-transfer', 'KA bundle or shared projection verification failed', cause);
    }

    try {
      await this.options.controlObjects.stageVerifiedObjects([
        fetchedHead,
        fetchedDirectory,
        fetchedBucket,
      ]);
    } catch (cause) {
      fail('catalog-native-receiver-catalog', 'verified catalog objects could not be staged', cause);
    }

    const swmGraph = await activateExactPublicProjection(
      this.options.store,
      head,
      row,
      projectionMetadata.kaUal,
      projectionBytes,
      Number(projectionMetadata.publicTripleCount),
    );

    return Object.freeze({
      inventoryDigest: head.objectDigest as Digest32V1,
      catalogRowDigest: projectionMetadata.catalogRowDigest,
      contentDigest: projectionMetadata.projectionDigest,
      bundleDigest: row.transfer.blobDigest,
      kaUal: projectionMetadata.kaUal,
      inventoryRowCount: 1 as const,
      activatedTripleCount: Number(projectionMetadata.publicTripleCount),
      swmGraph,
    });
  }
}

function assertFirstSliceHead(head: SignedAuthorCatalogHeadEnvelopeV1): void {
  if (
    head.payload.subGraphName !== null
    || head.payload.bucketCount !== '1'
    || head.payload.directoryHeight !== '0'
    || head.payload.totalRows !== '1'
    || head.payload.version === '0'
    || head.payload.previousHeadDigest === null
  ) {
    fail(
      'catalog-native-receiver-slice',
      'first receiver slice requires one root-lane row in a non-genesis successor',
    );
  }
}

function nativeScope(
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  head: SignedAuthorCatalogHeadEnvelopeV1,
): Rfc64PublicCatalogNativeFetchScopeV1 {
  return Object.freeze({
    networkId: head.payload.networkId,
    contextGraphId: head.payload.contextGraphId,
    subGraphName: head.payload.subGraphName,
    authorAddress: head.payload.authorAddress,
    catalogEra: head.payload.era,
    catalogVersion: head.payload.version,
    policyDigest: announcement.policyDigest,
    catalogHeadObjectDigest: head.objectDigest as Digest32V1,
  });
}

async function activateExactPublicProjection(
  store: TripleStore,
  head: SignedAuthorCatalogHeadEnvelopeV1,
  row: AuthorCatalogRowV1,
  kaUal: string,
  projectionBytes: Uint8Array,
  expectedTripleCount: number,
): Promise<string> {
  let projectionText: string;
  let quads;
  try {
    projectionText = UTF8.decode(projectionBytes);
    quads = parseNQuads(projectionText);
  } catch (cause) {
    fail('catalog-native-receiver-activation', 'verified projection could not be materialized', cause);
  }
  if (
    !Number.isSafeInteger(expectedTripleCount)
    || expectedTripleCount < 1
    || quads.length !== expectedTripleCount
    || quads.some((quad) => quad.graph !== '')
  ) {
    fail('catalog-native-receiver-activation', 'projection/parser triple count or graph scope changed');
  }
  const identity = unpackKnowledgeAssetId(BigInt(row.kaId));
  const swmGraph = `${contextGraphWorkspaceGraphUri(head.payload.contextGraphId)}`
    + `/${identity.agentAddress}/${identity.kaNumber.toString()}`;
  const graphQuads = quads.map((quad) => ({ ...quad, graph: swmGraph }));
  let replaced: boolean;
  try {
    replaced = await tryReplaceGraphAtomically(store, swmGraph, graphQuads, {
      source: 'rfc64-public-catalog-native-activation',
    });
  } catch (cause) {
    fail('catalog-native-receiver-activation', `atomic SWM replace failed for ${kaUal}`, cause);
  }
  if (!replaced) {
    fail('catalog-native-receiver-activation', 'store lacks atomic named-graph replacement');
  }

  let readBack;
  try {
    readBack = await readExactGraphPaged(store, swmGraph, {
      expectedQuadCount: expectedTripleCount,
      maxQuadCount: expectedTripleCount,
      maxNQuadsBytes: projectionBytes.byteLength,
      outputGraph: '',
      queryOptions: { source: 'rfc64-public-catalog-native-post-read' },
    });
  } catch (cause) {
    fail('catalog-native-receiver-activation', 'exact SWM post-read failed', cause);
  }
  if (`${quadsToNQuads(readBack)}\n` !== projectionText) {
    fail('catalog-native-receiver-activation', 'exact SWM post-read differs from verified projection');
  }
  return swmGraph;
}

export function rfc64CatalogSignatureVariantDigestV1(
  envelope: SignedAuthorCatalogHeadEnvelopeV1,
): Digest32V1 {
  return computeControlSignatureVariantDigestHex(
    envelope.objectDigest,
    envelope.signature,
  ) as Digest32V1;
}

function fail(
  code: Rfc64PublicCatalogNativeReceiverErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64PublicCatalogNativeReceiverErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
