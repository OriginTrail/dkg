// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded receiver for one public/open root-lane catalog bucket.
 *
 * The supported vertical slice is intentionally narrow: one successor head,
 * one bucket with 1..1,024 rows, the root context-graph lane, and complete
 * bundles for every signed row.
 * Every network hop is RFC-64 catalog-native. Activation happens only after
 * signed head/path/bucket verification, transfer verification, canonical
 * projection verification, one atomic projection-plus-seal replace, exact
 * post-read, and a durable applied-head compare-and-swap.
 */

import {
  AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
  AUTHOR_SCHEME_VERSION_V1,
  AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  ZERO_DIGEST32_V1,
  assertAuthorCatalogHeadScopeBindingV1,
  assertAuthorCatalogScopeV1,
  assertAuthorCatalogBucketScopeBindingV1,
  assertAuthorCatalogDirectoryNodeScopeBindingV1,
  assertCanonicalChainId,
  assertNetworkIdV1,
  assertSignedAuthorCatalogBucketEnvelopeV1,
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  assertSignedAuthorCatalogIssuerDelegationEnvelopeV1,
  buildAuthorAttestationTypedData,
  canonicalizeAuthorCatalogBucketPayloadBytesV1,
  computeAuthorCatalogScopeDigestV1,
  computeControlSignatureVariantDigestHex,
  contextGraphWorkspaceGraphUri,
  deriveAuthorCatalogScopeFromHeadV1,
  readVerifiedCatalogSealBindingV1,
  readVerifiedAuthorCatalogBucketDescriptorV1,
  readVerifiedCgSharedProjectionBytesV1,
  readVerifiedCgSharedProjectionMetadataV1,
  readVerifiedTransferredCatalogBundleMetadataV1,
  verifyAuthorCatalogDirectoryPathV1,
  verifyCgSharedProjectionV1,
  verifyTransferredCatalogBundleV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type CatalogSealDeploymentProfileV1,
  type CountV1,
  type Digest32V1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedAuthorCatalogIssuerDelegationEnvelopeV1,
  type VerifiedCatalogSealBindingSnapshotV1,
} from '@origintrail-official/dkg-core';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  quadsToNQuads,
  readExactGraphPaged,
  tryReplaceGraphAndSubjectAtomically,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';

import { parseNQuads } from '../dkg-agent-utils.js';
import { unpackKnowledgeAssetId } from '../ka-identity.js';
import {
  readVerifiedAuthorCatalogRowAuthorshipV1,
  verifyAuthorCatalogRowAuthorshipV1,
  type VerifiedAuthorCatalogRowAuthorshipSnapshotV1,
} from './catalog-row-authorship.js';
import { readBoundedPublicOpenRootLaneHeadV1 } from './bounded-public-open-root-lane-head-v1.js';
import type { Rfc64ControlObjectOperationsV1 } from './control-object-store-v1.js';
import type {
  AppliedCatalogHeadSnapshotV1,
  Rfc64InventoryV1OperationsV1,
} from './inventory-v1/index.js';
import {
  verifyRfc64PublicCatalogInventoryCompletenessV1,
  type Rfc64PublicCatalogInventoryEvidenceRowV1,
} from './public-catalog-inventory-completeness-v1.js';
import {
  RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1,
  RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
  type FetchedRfc64PublicCatalogObjectV1,
  type Rfc64PublicCatalogNativeFetchScopeV1,
  type Rfc64PublicCatalogNativeTransportV1,
} from './public-catalog-native-transport-v1.js';
import type {
  FetchedRfc64PublicCatalogHeadV1,
  Rfc64PublicCatalogHeadAnnouncementV1,
  Rfc64PublicCatalogTransportV1,
} from './public-catalog-transport-v1.js';

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const UTF8_ENCODER = new TextEncoder();
const APPLIED_INVENTORY_DIGEST_DOMAIN_V1 = 'dkg-rfc64-applied-inventory-v1\n';

export interface Rfc64PublicCatalogNativeReceiverOptionsV1 {
  /** Fetch-only capability; lifecycle ownership remains with the catalog service. */
  readonly headTransport: Pick<Rfc64PublicCatalogTransportV1, 'fetchCatalogHead'>;
  /** Fetch-only capability; lifecycle ownership remains with the catalog service. */
  readonly contentTransport: Pick<
    Rfc64PublicCatalogNativeTransportV1,
    'fetchCatalogObject' | 'fetchKaBundle'
  >;
  readonly controlObjects: Pick<Rfc64ControlObjectOperationsV1, 'stageVerifiedObjects'>;
  readonly inventory: Pick<
    Rfc64InventoryV1OperationsV1,
    'readAppliedCatalogHeadV1' | 'compareAndSwapAppliedCatalogHeadV1'
  >;
  readonly store: TripleStore;
  readonly transportTimeoutMs?: number;
}

export interface Rfc64PublicCatalogNativeActivationEvidenceV1 {
  /** Digest computed from the exact semantic projection+seal post-read. */
  readonly inventoryDigest: Digest32V1;
  readonly catalogHeadDigest: Digest32V1;
  readonly catalogRowDigest: Digest32V1;
  readonly contentDigest: Digest32V1;
  readonly bundleDigest: Digest32V1;
  readonly kaUal: string;
  readonly inventoryRowCount: 1;
  readonly activatedTripleCount: number;
  readonly swmGraph: string;
  /** Exact signed delegation/head/path/bucket/row authorization closure. */
  readonly authorship: VerifiedAuthorCatalogRowAuthorshipSnapshotV1;
  readonly appliedHeadStatus: 'applied' | 'existing';
}

export interface Rfc64PublicCatalogNativeActivatedRowEvidenceV1
  extends Rfc64PublicCatalogInventoryEvidenceRowV1 {
  readonly swmGraph: string;
  /** Exact signed delegation/head/path/bucket/row authorization closure. */
  readonly authorship: VerifiedAuthorCatalogRowAuthorshipSnapshotV1;
}

/** Exact evidence for one bounded multi-asset successor inventory. */
export interface Rfc64PublicCatalogNativeMultiAssetActivationEvidenceV1 {
  readonly inventoryDigest: Digest32V1;
  readonly catalogHeadDigest: Digest32V1;
  readonly inventoryRowCount: number;
  readonly activatedTripleCount: number;
  /** Strictly increasing by mathematical KA ID. */
  readonly rows: readonly Readonly<Rfc64PublicCatalogNativeActivatedRowEvidenceV1>[];
  readonly appliedHeadStatus: 'applied' | 'existing';
}

export type Rfc64PublicCatalogNativeSuccessorEvidenceV1 =
  | Rfc64PublicCatalogNativeActivationEvidenceV1
  | Rfc64PublicCatalogNativeMultiAssetActivationEvidenceV1;

/** Exact durable evidence for the canonical empty catalog bootstrap. */
export interface Rfc64PublicCatalogNativeGenesisEvidenceV1 {
  /** Digest of the exact empty applied inventory (zero rows). */
  readonly inventoryDigest: Digest32V1;
  readonly catalogHeadDigest: Digest32V1;
  readonly inventoryRowCount: 0;
  readonly activatedTripleCount: 0;
  readonly stagedObjectCount: 3;
  readonly appliedHeadStatus: 'applied' | 'existing';
}

export type Rfc64PublicCatalogNativeSynchronizationEvidenceV1 =
  | Rfc64PublicCatalogNativeGenesisEvidenceV1
  | Rfc64PublicCatalogNativeSuccessorEvidenceV1;

export type Rfc64PublicCatalogNativeReceiverErrorCodeV1 =
  | 'catalog-native-receiver-input'
  | 'catalog-native-receiver-not-found'
  | 'catalog-native-receiver-slice'
  | 'catalog-native-receiver-catalog'
  | 'catalog-native-receiver-authorization'
  | 'catalog-native-receiver-transfer'
  | 'catalog-native-receiver-activation'
  | 'catalog-native-receiver-history';

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
  readonly #scopeSynchronizations = new Map<string, Promise<void>>();

  constructor(private readonly options: Rfc64PublicCatalogNativeReceiverOptionsV1) {
    if (
      typeof options?.headTransport?.fetchCatalogHead !== 'function'
      || typeof options?.contentTransport?.fetchCatalogObject !== 'function'
      || typeof options?.contentTransport?.fetchKaBundle !== 'function'
      || typeof options.controlObjects?.stageVerifiedObjects !== 'function'
      || typeof options.inventory?.readAppliedCatalogHeadV1 !== 'function'
      || typeof options.inventory?.compareAndSwapAppliedCatalogHeadV1 !== 'function'
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
    trustedCatalogScope: AuthorCatalogScopeV1,
    deployment: CatalogSealDeploymentProfileV1,
    signal?: AbortSignal,
  ): Promise<Rfc64PublicCatalogNativeActivationEvidenceV1> {
    const trustedScope = snapshotTrustedPublicOpenScope(
      trustedCatalogScope,
      announcement,
    );
    const trustedDeployment = snapshotTrustedDeployment(deployment, trustedScope);
    return this.withScopeSerialization(
      computeAuthorCatalogScopeDigestV1(trustedScope),
      async () => {
        const evidence = await this.synchronizePublicOpenCatalogSerialized(
          remotePeerId,
          announcement,
          trustedScope,
          trustedDeployment,
          'one-successor',
          signal,
        );
        if (evidence.inventoryRowCount !== 1 || !('catalogRowDigest' in evidence)) {
          fail('catalog-native-receiver-slice', 'one-row synchronization returned non-one-row evidence');
        }
        return evidence;
      },
    );
  }

  /**
   * Fetch and apply either the canonical empty genesis or one bounded
   * 1..1,024-row successor. This is the production-facing entrypoint for a fresh receiver:
   * callers do not need to seed durable history out of band.
   */
  async synchronizePublicOpenCatalog(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    trustedCatalogScope: AuthorCatalogScopeV1,
    deployment: CatalogSealDeploymentProfileV1,
    signal?: AbortSignal,
  ): Promise<Rfc64PublicCatalogNativeSynchronizationEvidenceV1> {
    const trustedScope = snapshotTrustedPublicOpenScope(
      trustedCatalogScope,
      announcement,
    );
    const trustedDeployment = snapshotTrustedDeployment(deployment, trustedScope);
    return this.withScopeSerialization(
      computeAuthorCatalogScopeDigestV1(trustedScope),
      () => this.synchronizePublicOpenCatalogSerialized(
        remotePeerId,
        announcement,
        trustedScope,
        trustedDeployment,
        'any',
        signal,
      ),
    );
  }

  /** Fetch, fully verify, and durably initialize exactly one empty genesis. */
  async bootstrapEmptyPublicOpenCatalog(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    trustedCatalogScope: AuthorCatalogScopeV1,
    deployment: CatalogSealDeploymentProfileV1,
    signal?: AbortSignal,
  ): Promise<Rfc64PublicCatalogNativeGenesisEvidenceV1> {
    const trustedScope = snapshotTrustedPublicOpenScope(
      trustedCatalogScope,
      announcement,
    );
    const trustedDeployment = snapshotTrustedDeployment(deployment, trustedScope);
    return this.withScopeSerialization(
      computeAuthorCatalogScopeDigestV1(trustedScope),
      async () => {
        const evidence = await this.synchronizePublicOpenCatalogSerialized(
          remotePeerId,
          announcement,
          trustedScope,
          trustedDeployment,
          'genesis',
          signal,
        );
        if (evidence.inventoryRowCount !== 0 || !('stagedObjectCount' in evidence)) {
          fail('catalog-native-receiver-slice', 'genesis bootstrap returned successor evidence');
        }
        return evidence;
      },
    );
  }

  private async synchronizePublicOpenCatalogSerialized(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
    deployment: CatalogSealDeploymentProfileV1,
    expected: 'any' | 'genesis' | 'one-successor',
    signal: AbortSignal | undefined,
  ): Promise<Rfc64PublicCatalogNativeSynchronizationEvidenceV1> {
    throwIfAborted(signal);
    const fetchedHead = await this.options.headTransport.fetchCatalogHead(
      remotePeerId,
      announcement,
      { timeoutMs: this.#timeoutMs, signal },
    );
    if (fetchedHead === null) {
      fail('catalog-native-receiver-not-found', 'announced catalog head was not found');
    }
    const head = fetchedHead.envelope;
    assertFetchedHeadMatchesTrustedScope(head, trustedCatalogScope);
    if (expected === 'genesis' || (expected === 'any' && claimsGenesisHistory(head))) {
      return this.bootstrapEmptyPublicOpenCatalogFetched(
        remotePeerId,
        announcement,
        trustedCatalogScope,
        fetchedHead,
        signal,
      );
    }
    if (expected === 'one-successor' && claimsGenesisHistory(head)) {
      fail('catalog-native-receiver-slice', 'one-row synchronization does not accept genesis');
    }
    if (expected === 'one-successor' && head.payload.totalRows !== '1') {
      fail('catalog-native-receiver-slice', 'one-row synchronization does not accept multi-row heads');
    }
    return this.synchronizeBoundedPublicOpenCatalogFetched(
      remotePeerId,
      announcement,
      trustedCatalogScope,
      deployment,
      fetchedHead,
      signal,
    );
  }

  private async bootstrapEmptyPublicOpenCatalogFetched(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
    fetchedHead: FetchedRfc64PublicCatalogHeadV1,
    signal: AbortSignal | undefined,
  ): Promise<Rfc64PublicCatalogNativeGenesisEvidenceV1> {
    const head = fetchedHead.envelope;
    assertEmptyGenesisHead(head);
    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(trustedCatalogScope);
    const inventoryDigest = computeRfc64AppliedInventoryDigestV1({
      catalogScopeDigest,
      rows: [],
    });
    const current = this.options.inventory.readAppliedCatalogHeadV1(
      catalogScopeDigest,
      head.payload.authorAddress,
    );
    const replay = assertEmptyGenesisHistory(current, head, inventoryDigest);
    const scope = nativeScope(announcement, trustedCatalogScope, head);
    const fetchedDelegation = await this.fetchDirectAuthorCatalogIssuerDelegation(
      remotePeerId,
      scope,
      head,
      trustedCatalogScope,
      signal,
    );
    const fetchedDirectory = await this.options.contentTransport.fetchCatalogObject(
      remotePeerId,
      {
        ...scope,
        kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
        targetObjectType: AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
        targetObjectDigest: head.payload.directoryRootDigest,
      },
      { timeoutMs: this.#timeoutMs, signal },
    );
    if (fetchedDirectory === null) {
      fail('catalog-native-receiver-not-found', 'genesis directory root was not found');
    }
    try {
      assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(
        fetchedDirectory.envelope,
        head.payload.bucketCount,
      );
      const directory = fetchedDirectory.envelope;
      assertAuthorCatalogDirectoryNodeScopeBindingV1(
        directory.payload,
        deriveAuthorCatalogScopeFromHeadV1(head.payload),
      );
      if (directory.issuer !== head.issuer) {
        throw new Error('genesis directory issuer differs from head');
      }
      const path = verifyAuthorCatalogDirectoryPathV1(head, [directory], '0' as never);
      const descriptor = readVerifiedAuthorCatalogBucketDescriptorV1(path, head);
      if (
        descriptor.bucketId !== '0'
        || descriptor.bucketDigest !== ZERO_DIGEST32_V1
        || descriptor.rowCount !== '0'
        || descriptor.byteLength !== '0'
      ) {
        throw new Error('genesis directory descriptor is not canonically empty');
      }
    } catch (cause) {
      fail('catalog-native-receiver-catalog', 'empty genesis directory is invalid', cause);
    }

    try {
      await this.options.controlObjects.stageVerifiedObjects([
        fetchedDelegation,
        fetchedDirectory,
        fetchedHead,
      ]);
    } catch (cause) {
      fail('catalog-native-receiver-catalog', 'verified genesis objects could not be staged', cause);
    }

    let appliedHeadStatus: 'applied' | 'existing';
    if (replay) {
      appliedHeadStatus = 'existing';
    } else {
      try {
        appliedHeadStatus = this.options.inventory.compareAndSwapAppliedCatalogHeadV1({
          catalogScopeDigest,
          authorAddress: head.payload.authorAddress,
          expectedCurrentCatalogHeadDigest: null,
          currentCatalogHeadDigest: head.objectDigest as Digest32V1,
          appliedInventoryDigest: inventoryDigest,
          catalogVersion: head.payload.version,
          inventoryRowCount: '0' as never,
        }).status;
      } catch (cause) {
        const reconciled = this.options.inventory.readAppliedCatalogHeadV1(
          catalogScopeDigest,
          head.payload.authorAddress,
        );
        if (!isExactEmptyGenesisSnapshot(reconciled, head, inventoryDigest)) {
          fail(
            'catalog-native-receiver-history',
            'genesis applied-head CAS lost to a different durable history',
            cause,
          );
        }
        appliedHeadStatus = 'existing';
      }
    }
    const postRead = this.options.inventory.readAppliedCatalogHeadV1(
      catalogScopeDigest,
      head.payload.authorAddress,
    );
    if (!isExactEmptyGenesisSnapshot(postRead, head, inventoryDigest)) {
      fail(
        'catalog-native-receiver-history',
        'empty genesis durable post-read differs in head, digest, version, or row count',
      );
    }
    return Object.freeze({
      inventoryDigest,
      catalogHeadDigest: head.objectDigest as Digest32V1,
      inventoryRowCount: 0 as const,
      activatedTripleCount: 0 as const,
      stagedObjectCount: 3 as const,
      appliedHeadStatus,
    });
  }

  private async synchronizeBoundedPublicOpenCatalogFetched(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
    deployment: CatalogSealDeploymentProfileV1,
    fetchedHead: FetchedRfc64PublicCatalogHeadV1,
    signal: AbortSignal | undefined,
  ): Promise<Rfc64PublicCatalogNativeSuccessorEvidenceV1> {
    const head = fetchedHead.envelope;
    const expectedRowCount = assertBoundedSuccessorHead(head);
    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(trustedCatalogScope);
    const currentAppliedHead = this.options.inventory.readAppliedCatalogHeadV1(
      catalogScopeDigest,
      head.payload.authorAddress,
    );
    const replay = assertMonotonicSuccessorHistory(currentAppliedHead, head, expectedRowCount);
    const scope = nativeScope(announcement, trustedCatalogScope, head);
    const fetchedDelegation = await this.fetchDirectAuthorCatalogIssuerDelegation(
      remotePeerId,
      scope,
      head,
      trustedCatalogScope,
      signal,
    );

    const fetchedDirectory = await this.options.contentTransport.fetchCatalogObject(
      remotePeerId,
      {
        ...scope,
        kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
        targetObjectType: AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
        targetObjectDigest: head.payload.directoryRootDigest,
      },
      { timeoutMs: this.#timeoutMs, signal },
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

    let directoryPathProof: ReturnType<typeof verifyAuthorCatalogDirectoryPathV1>;
    let descriptor: ReturnType<typeof readVerifiedAuthorCatalogBucketDescriptorV1>;
    try {
      directoryPathProof = verifyAuthorCatalogDirectoryPathV1(head, [directory], '0' as never);
      descriptor = readVerifiedAuthorCatalogBucketDescriptorV1(directoryPathProof, head);
    } catch (cause) {
      fail('catalog-native-receiver-catalog', 'successor directory path is invalid', cause);
    }
    if (
      descriptor.rowCount !== head.payload.totalRows
      || descriptor.bucketDigest === ZERO_DIGEST32_V1
    ) {
      fail(
        'catalog-native-receiver-slice',
        'bounded receiver requires one non-empty bucket containing the exact head row count',
      );
    }

    const fetchedBucket = await this.options.contentTransport.fetchCatalogObject(
      remotePeerId,
      {
        ...scope,
        kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
        targetObjectType: AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
        targetObjectDigest: descriptor.bucketDigest,
      },
      { timeoutMs: this.#timeoutMs, signal },
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
        || bucket.payload.rows.length !== expectedRowCount
        || bucket.payload.rows.length.toString() !== descriptor.rowCount
        || canonicalizeAuthorCatalogBucketPayloadBytesV1(bucket.payload).byteLength.toString()
          !== descriptor.byteLength
      ) {
        throw new Error('bucket differs from its verified directory descriptor');
      }
    } catch (cause) {
      fail('catalog-native-receiver-catalog', 'catalog bucket is not bound to its directory', cause);
    }
    const preparedRows: Array<{
      readonly row: AuthorCatalogRowV1;
      readonly authorship: VerifiedAuthorCatalogRowAuthorshipSnapshotV1;
      readonly projectionMetadata: ReturnType<typeof readVerifiedCgSharedProjectionMetadataV1>;
      readonly sealBinding: VerifiedCatalogSealBindingSnapshotV1;
      readonly projectionBytes: Uint8Array;
      readonly expectedEvidence: Rfc64PublicCatalogInventoryEvidenceRowV1;
    }> = [];
    for (const row of bucket.payload.rows) {
      throwIfAborted(signal);
      let authorship: VerifiedAuthorCatalogRowAuthorshipSnapshotV1;
      try {
        const authorshipToken = verifyAuthorCatalogRowAuthorshipV1({
          catalogIssuerDelegation: fetchedDelegation.envelope,
          catalogIssuerDelegationSignature: fetchedDelegation.issuerSignature,
          parentAuthorAgentEvidence: null,
          catalogHead: head,
          catalogHeadSignature: fetchedHead.issuerSignature,
          directoryPathEnvelopes: [directory],
          directoryPathSignatures: [fetchedDirectory.issuerSignature],
          directoryPathProof,
          catalogBucket: bucket,
          catalogBucketSignature: fetchedBucket.issuerSignature,
          targetKaId: row.kaId,
        });
        authorship = readVerifiedAuthorCatalogRowAuthorshipV1(authorshipToken);
      } catch (cause) {
        fail(
          'catalog-native-receiver-authorization',
          `catalog row ${row.kaId} is not authorized by the exact direct-author delegation closure`,
          cause,
        );
      }

      const bundle = await this.options.contentTransport.fetchKaBundle(
        remotePeerId,
        {
          ...scope,
          kind: RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1,
          blobDigest: row.transfer.blobDigest,
          byteLength: row.transfer.byteLength as never,
        },
        { timeoutMs: this.#timeoutMs, signal },
      );
      if (bundle === null) {
        fail('catalog-native-receiver-not-found', `catalog row ${row.kaId} KA bundle was not found`);
      }

      let projectionMetadata: ReturnType<typeof readVerifiedCgSharedProjectionMetadataV1>;
      let sealBinding: VerifiedCatalogSealBindingSnapshotV1;
      let projectionBytes: Uint8Array;
      try {
        const transferred = verifyTransferredCatalogBundleV1(head, row, bundle, deployment);
        const transferredMetadata = readVerifiedTransferredCatalogBundleMetadataV1(
          transferred,
          head,
          row,
          deployment,
        );
        sealBinding = readVerifiedCatalogSealBindingV1(
          transferredMetadata.catalogSealBinding,
        );
        assertRecoverableAuthorAttestationV1(sealBinding);
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
        fail(
          'catalog-native-receiver-transfer',
          `KA bundle or shared projection verification failed for row ${row.kaId}`,
          cause,
        );
      }
      const expectedEvidence = Object.freeze({
        kaId: row.kaId,
        catalogRowDigest: projectionMetadata.catalogRowDigest,
        contentDigest: projectionMetadata.projectionDigest,
        sealDigest: sealBinding.sealDigest,
        bundleDigest: row.transfer.blobDigest,
        kaUal: projectionMetadata.kaUal,
        activatedTripleCount: Number(projectionMetadata.publicTripleCount),
      }) satisfies Rfc64PublicCatalogInventoryEvidenceRowV1;
      preparedRows.push(Object.freeze({
        row,
        authorship,
        projectionMetadata,
        sealBinding,
        projectionBytes,
        expectedEvidence,
      }));
    }

    const expectedRows = preparedRows.map((prepared) => prepared.expectedEvidence);
    // Fail closed on exact count/order/UAL/content evidence before the first
    // semantic mutation. The second call below joins these expectations to
    // independent exact post-reads.
    try {
      verifyRfc64PublicCatalogInventoryCompletenessV1({
        catalogScope: trustedCatalogScope,
        expectedTotalRows: head.payload.totalRows as CountV1,
        expectedRows,
        observedRows: expectedRows,
      });
    } catch (cause) {
      fail(
        'catalog-native-receiver-catalog',
        'signed catalog rows do not form one exact bounded inventory',
        cause,
      );
    }

    try {
      await this.options.controlObjects.stageVerifiedObjects([
        fetchedDelegation,
        fetchedHead,
        fetchedDirectory,
        fetchedBucket,
      ]);
    } catch (cause) {
      fail('catalog-native-receiver-catalog', 'verified catalog objects could not be staged', cause);
    }

    const activatedRows: Rfc64PublicCatalogNativeActivatedRowEvidenceV1[] = [];
    for (const prepared of preparedRows) {
      throwIfAborted(signal);
      const activation = await activateExactPublicProjection(
        this.options.store,
        head,
        prepared.row,
        prepared.projectionMetadata.kaUal,
        prepared.projectionBytes,
        Number(prepared.projectionMetadata.publicTripleCount),
        prepared.sealBinding,
      );
      activatedRows.push(Object.freeze({
        ...activation.evidence,
        swmGraph: activation.swmGraph,
        authorship: prepared.authorship,
      }));
    }
    let completion: ReturnType<typeof verifyRfc64PublicCatalogInventoryCompletenessV1>;
    try {
      completion = verifyRfc64PublicCatalogInventoryCompletenessV1({
        catalogScope: trustedCatalogScope,
        expectedTotalRows: head.payload.totalRows as CountV1,
        expectedRows,
        observedRows: activatedRows.map((row) => ({
          kaId: row.kaId,
          catalogRowDigest: row.catalogRowDigest,
          contentDigest: row.contentDigest,
          sealDigest: row.sealDigest,
          bundleDigest: row.bundleDigest,
          kaUal: row.kaUal,
          activatedTripleCount: row.activatedTripleCount,
        })),
      });
    } catch (cause) {
      fail(
        'catalog-native-receiver-activation',
        'semantic post-reads do not equal the exact signed inventory',
        cause,
      );
    }
    const activatedTripleCount = activatedRows.reduce(
      (total, row) => total + row.activatedTripleCount,
      0,
    );
    if (!Number.isSafeInteger(activatedTripleCount)) {
      fail('catalog-native-receiver-activation', 'total activated triple count is not a safe integer');
    }

    let appliedHeadStatus: 'applied' | 'existing';
    if (replay) {
      if (currentAppliedHead!.appliedInventoryDigest !== completion.inventoryDigest) {
        fail(
          'catalog-native-receiver-history',
          'durable applied-head digest differs from exact semantic post-read',
        );
      }
      appliedHeadStatus = 'existing';
    } else {
      try {
        appliedHeadStatus = this.options.inventory.compareAndSwapAppliedCatalogHeadV1({
          catalogScopeDigest,
          authorAddress: head.payload.authorAddress,
          expectedCurrentCatalogHeadDigest: head.payload.previousHeadDigest,
          currentCatalogHeadDigest: head.objectDigest as Digest32V1,
          appliedInventoryDigest: completion.inventoryDigest,
          catalogVersion: head.payload.version,
          inventoryRowCount: head.payload.totalRows,
        }).status;
      } catch (cause) {
        const reconciled = this.options.inventory.readAppliedCatalogHeadV1(
          catalogScopeDigest,
          head.payload.authorAddress,
        );
        if (
          reconciled === null
          || reconciled.currentCatalogHeadDigest !== head.objectDigest
          || !isExactAppliedSuccessorSnapshot(
            reconciled,
            head,
            completion.inventoryDigest,
          )
        ) {
          fail(
            'catalog-native-receiver-history',
            'applied-head CAS lost outside the serialized receiver; semantic state requires repair',
            cause,
          );
        }
        appliedHeadStatus = 'existing';
      }
    }

    const durablePostRead = this.options.inventory.readAppliedCatalogHeadV1(
      catalogScopeDigest,
      head.payload.authorAddress,
    );
    if (!isExactAppliedSuccessorSnapshot(
      durablePostRead,
      head,
      completion.inventoryDigest,
    )) {
      fail(
        'catalog-native-receiver-history',
        'successor durable post-read differs in head, digest, version, or exact row count',
      );
    }

    if (activatedRows.length === 1) {
      const [only] = activatedRows;
      if (only === undefined) {
        fail('catalog-native-receiver-activation', 'one-row completion lost its activation row');
      }
      return Object.freeze({
        inventoryDigest: completion.inventoryDigest,
        catalogHeadDigest: head.objectDigest as Digest32V1,
        catalogRowDigest: only.catalogRowDigest,
        contentDigest: only.contentDigest,
        bundleDigest: only.bundleDigest,
        kaUal: only.kaUal,
        inventoryRowCount: 1 as const,
        activatedTripleCount: only.activatedTripleCount,
        swmGraph: only.swmGraph,
        authorship: only.authorship,
        appliedHeadStatus,
      });
    }
    return Object.freeze({
      inventoryDigest: completion.inventoryDigest,
      catalogHeadDigest: head.objectDigest as Digest32V1,
      inventoryRowCount: activatedRows.length,
      activatedTripleCount,
      rows: Object.freeze(activatedRows),
      appliedHeadStatus,
    });
  }

  private async fetchDirectAuthorCatalogIssuerDelegation(
    remotePeerId: string,
    scope: Rfc64PublicCatalogNativeFetchScopeV1,
    head: SignedAuthorCatalogHeadEnvelopeV1,
    trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
    signal: AbortSignal | undefined,
  ): Promise<FetchedRfc64PublicCatalogObjectV1 & {
    readonly envelope: SignedAuthorCatalogIssuerDelegationEnvelopeV1;
  }> {
    let fetched: FetchedRfc64PublicCatalogObjectV1 | null;
    try {
      fetched = await this.options.contentTransport.fetchCatalogObject(
        remotePeerId,
        {
          ...scope,
          kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
          targetObjectType: AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
          targetObjectDigest: head.payload.catalogIssuerDelegationDigest,
        },
        { timeoutMs: this.#timeoutMs, signal },
      );
    } catch (cause) {
      if (signal?.aborted) throw signal.reason;
      fail(
        'catalog-native-receiver-authorization',
        'catalog issuer delegation fetch or generic signature verification failed',
        cause,
      );
    }
    if (fetched === null) {
      fail('catalog-native-receiver-not-found', 'catalog issuer delegation was not found');
    }
    throwIfAborted(signal);
    try {
      assertSignedAuthorCatalogIssuerDelegationEnvelopeV1(fetched.envelope);
      assertDirectAuthorCatalogIssuerDelegationBindingV1(
        fetched.envelope,
        head,
        trustedCatalogScope,
      );
    } catch (cause) {
      fail(
        'catalog-native-receiver-authorization',
        'catalog issuer delegation is not the exact direct-author authority for this head',
        cause,
      );
    }
    return Object.freeze({
      envelope: fetched.envelope,
      issuerSignature: fetched.issuerSignature,
    });
  }

  private async withScopeSerialization<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#scopeSynchronizations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#scopeSynchronizations.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#scopeSynchronizations.get(key) === tail) {
        this.#scopeSynchronizations.delete(key);
      }
    }
  }
}

function snapshotTrustedPublicOpenScope(
  input: AuthorCatalogScopeV1,
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
): Readonly<AuthorCatalogScopeV1> {
  const scope = Object.freeze({
    networkId: input.networkId,
    contextGraphId: input.contextGraphId,
    governanceChainId: input.governanceChainId,
    governanceContractAddress: input.governanceContractAddress,
    ownershipTransitionDigest: input.ownershipTransitionDigest,
    subGraphName: input.subGraphName,
    authorAddress: input.authorAddress,
    era: input.era,
    bucketCount: input.bucketCount,
  });
  try {
    assertAuthorCatalogScopeV1(scope);
    if (
      scope.governanceChainId !== null
      || scope.governanceContractAddress !== null
      || scope.ownershipTransitionDigest !== null
      || scope.subGraphName !== null
      || scope.bucketCount !== '1'
    ) {
      throw new Error('Gate 1 requires the public/open null-governance root scope');
    }
    if (
      announcement.networkId !== scope.networkId
      || announcement.contextGraphId !== scope.contextGraphId
      || announcement.subGraphName !== scope.subGraphName
      || announcement.authorAddress !== scope.authorAddress
      || announcement.catalogEra !== scope.era
    ) {
      throw new Error('announcement differs from the locally trusted catalog scope');
    }
  } catch (cause) {
    fail(
      'catalog-native-receiver-authorization',
      'catalog request is not bound to the locally accepted public/open policy scope',
      cause,
    );
  }
  return scope;
}

function snapshotTrustedDeployment(
  input: CatalogSealDeploymentProfileV1,
  trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
): Readonly<CatalogSealDeploymentProfileV1> {
  const deployment = Object.freeze({
    networkId: input.networkId,
    assertedAtChainId: input.assertedAtChainId,
    assertedAtKav10Address: input.assertedAtKav10Address,
  });
  try {
    assertNetworkIdV1(deployment.networkId);
    assertCanonicalChainId(deployment.assertedAtChainId, 'assertedAtChainId');
    if (
      !ethers.isAddress(deployment.assertedAtKav10Address)
      || deployment.assertedAtKav10Address !== deployment.assertedAtKav10Address.toLowerCase()
    ) {
      throw new Error('assertedAtKav10Address is not a canonical EVM address');
    }
    if (deployment.networkId !== trustedCatalogScope.networkId) {
      throw new Error('deployment network differs from the locally trusted catalog scope');
    }
  } catch (cause) {
    fail(
      'catalog-native-receiver-authorization',
      'locally resolved deployment is not bound to the accepted catalog scope',
      cause,
    );
  }
  return deployment;
}

function assertFetchedHeadMatchesTrustedScope(
  head: SignedAuthorCatalogHeadEnvelopeV1,
  trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
): void {
  try {
    assertAuthorCatalogHeadScopeBindingV1(head.payload, trustedCatalogScope);
  } catch (cause) {
    fail(
      'catalog-native-receiver-authorization',
      'fetched catalog head differs from the locally accepted public/open policy scope',
      cause,
    );
  }
}

function claimsGenesisHistory(head: SignedAuthorCatalogHeadEnvelopeV1): boolean {
  return head.payload.version === '0' || head.payload.previousHeadDigest === null;
}

function assertEmptyGenesisHead(head: SignedAuthorCatalogHeadEnvelopeV1): void {
  try {
    const boundedHead = readBoundedPublicOpenRootLaneHeadV1(head, {
      allowGenesis: true,
    });
    if (
      head.payload.era !== '0'
      || boundedHead.rowCount !== 0
      || !boundedHead.isGenesis
      || head.payload.version !== '0'
      || head.payload.previousHeadDigest !== null
    ) {
      throw new Error('head is not the canonical empty genesis');
    }
  } catch {
    fail(
      'catalog-native-receiver-slice',
      'genesis bootstrap requires the canonical empty public/open root catalog',
    );
  }
}

function assertEmptyGenesisHistory(
  current: AppliedCatalogHeadSnapshotV1 | null,
  head: SignedAuthorCatalogHeadEnvelopeV1,
  inventoryDigest: Digest32V1,
): boolean {
  if (current === null) return false;
  if (!isExactEmptyGenesisSnapshot(current, head, inventoryDigest)) {
    fail(
      'catalog-native-receiver-history',
      'genesis cannot replace or diverge from existing durable applied history',
    );
  }
  return true;
}

function isExactEmptyGenesisSnapshot(
  current: AppliedCatalogHeadSnapshotV1 | null,
  head: SignedAuthorCatalogHeadEnvelopeV1,
  inventoryDigest: Digest32V1,
): boolean {
  return current !== null
    && current.catalogScopeDigest === computeAuthorCatalogScopeDigestV1(
      deriveAuthorCatalogScopeFromHeadV1(head.payload),
    )
    && current.authorAddress === head.payload.authorAddress
    && current.currentCatalogHeadDigest === head.objectDigest
    && current.appliedInventoryDigest === inventoryDigest
    && current.catalogVersion === '0'
    && current.inventoryRowCount === '0';
}

function assertMonotonicSuccessorHistory(
  current: AppliedCatalogHeadSnapshotV1 | null,
  head: SignedAuthorCatalogHeadEnvelopeV1,
  expectedRowCount: number,
): boolean {
  if (current === null) {
    fail(
      'catalog-native-receiver-history',
      'successor requires a durable initialized predecessor head',
    );
  }
  if (current.currentCatalogHeadDigest === head.objectDigest) {
    if (
      current.catalogVersion !== head.payload.version
      || current.inventoryRowCount !== expectedRowCount.toString()
    ) {
      fail('catalog-native-receiver-history', 'replayed head differs from its durable applied state');
    }
    return true;
  }
  if (
    current.currentCatalogHeadDigest !== head.payload.previousHeadDigest
    || BigInt(current.catalogVersion) + 1n !== BigInt(head.payload.version)
  ) {
    fail(
      'catalog-native-receiver-history',
      'successor does not monotonically extend the durable current head',
    );
  }
  return false;
}

function assertBoundedSuccessorHead(head: SignedAuthorCatalogHeadEnvelopeV1): number {
  try {
    const boundedHead = readBoundedPublicOpenRootLaneHeadV1(head, {
      allowGenesis: false,
    });
    if (boundedHead.rowCount < 1) {
      throw new RangeError('bounded successor is empty');
    }
    return boundedHead.rowCount;
  } catch {
    fail(
      'catalog-native-receiver-slice',
      `bounded receiver requires 1..${MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1} root-lane rows in one non-genesis successor bucket`,
    );
  }
}

function isExactAppliedSuccessorSnapshot(
  current: AppliedCatalogHeadSnapshotV1 | null,
  head: SignedAuthorCatalogHeadEnvelopeV1,
  inventoryDigest: Digest32V1,
): boolean {
  return current !== null
    && current.catalogScopeDigest === computeAuthorCatalogScopeDigestV1(
      deriveAuthorCatalogScopeFromHeadV1(head.payload),
    )
    && current.authorAddress === head.payload.authorAddress
    && current.currentCatalogHeadDigest === head.objectDigest
    && current.appliedInventoryDigest === inventoryDigest
    && current.catalogVersion === head.payload.version
    && current.inventoryRowCount === head.payload.totalRows;
}

function nativeScope(
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
  head: SignedAuthorCatalogHeadEnvelopeV1,
): Rfc64PublicCatalogNativeFetchScopeV1 {
  return Object.freeze({
    networkId: trustedCatalogScope.networkId,
    contextGraphId: trustedCatalogScope.contextGraphId,
    subGraphName: trustedCatalogScope.subGraphName,
    authorAddress: trustedCatalogScope.authorAddress,
    catalogEra: trustedCatalogScope.era,
    catalogVersion: head.payload.version,
    policyDigest: announcement.policyDigest,
    catalogHeadObjectDigest: head.objectDigest as Digest32V1,
  });
}

/** Gate 1 accepts only an author-signed issuer grant with no parent-agent hop. */
function assertDirectAuthorCatalogIssuerDelegationBindingV1(
  delegation: SignedAuthorCatalogIssuerDelegationEnvelopeV1,
  head: SignedAuthorCatalogHeadEnvelopeV1,
  trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
): void {
  const left = delegation.payload;
  const right = head.payload;
  if (
    delegation.objectDigest !== right.catalogIssuerDelegationDigest
    || delegation.issuer !== left.authorAddress
    || left.authorAuthorityEvidenceDigest !== null
    || left.catalogIssuerKey !== head.issuer
  ) {
    throw new Error(
      'delegation digest, direct author issuer, null parent evidence, or catalog issuer key differs',
    );
  }
  if (
    left.networkId !== right.networkId
    || left.contextGraphId !== right.contextGraphId
    || left.governanceChainId !== right.governanceChainId
    || left.governanceContractAddress !== right.governanceContractAddress
    || left.ownershipTransitionDigest !== right.ownershipTransitionDigest
    || left.subGraphName !== right.subGraphName
    || left.authorAddress !== right.authorAddress
    || left.catalogEra !== right.era
  ) {
    throw new Error('delegation scope, governance tuple, author, lane, or era differs from head');
  }
  if (
    left.networkId !== trustedCatalogScope.networkId
    || left.contextGraphId !== trustedCatalogScope.contextGraphId
    || left.governanceChainId !== trustedCatalogScope.governanceChainId
    || left.governanceContractAddress !== trustedCatalogScope.governanceContractAddress
    || left.ownershipTransitionDigest !== trustedCatalogScope.ownershipTransitionDigest
    || left.subGraphName !== trustedCatalogScope.subGraphName
    || left.authorAddress !== trustedCatalogScope.authorAddress
    || left.catalogEra !== trustedCatalogScope.era
  ) {
    throw new Error('delegation differs from the locally trusted public/open catalog scope');
  }
  if (
    (left.catalogEra === '0') !== (left.previousDelegationDigest === null)
    || BigInt(right.issuedAt) < BigInt(left.effectiveAt)
    || BigInt(right.issuedAt) >= BigInt(left.expiresAt)
  ) {
    throw new Error('delegation history or half-open validity interval does not authorize head');
  }
}

async function activateExactPublicProjection(
  store: TripleStore,
  head: SignedAuthorCatalogHeadEnvelopeV1,
  row: AuthorCatalogRowV1,
  kaUal: string,
  projectionBytes: Uint8Array,
  expectedTripleCount: number,
  sealBinding: VerifiedCatalogSealBindingSnapshotV1,
): Promise<{
  readonly swmGraph: string;
  readonly evidence: Rfc64PublicCatalogInventoryEvidenceRowV1;
}> {
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
    replaced = await tryReplaceGraphAndSubjectAtomically(
      store,
      swmGraph,
      graphQuads,
      sealBinding.placement.metaGraph,
      sealBinding.placement.subject,
      [...sealBinding.sealRows],
      {
        source: 'rfc64-public-catalog-native-activation',
      },
    );
  } catch (cause) {
    fail(
      'catalog-native-receiver-activation',
      `atomic SWM projection and author-seal replace failed for ${kaUal}`,
      cause,
    );
  }
  if (!replaced) {
    fail(
      'catalog-native-receiver-activation',
      'store lacks atomic named-graph and author-seal replacement',
    );
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
  await assertExactAuthorSealPostRead(store, sealBinding);
  return {
    swmGraph,
    evidence: Object.freeze({
      kaId: row.kaId,
      catalogRowDigest: sealBinding.catalogRowDigest,
      contentDigest: row.projectionDigest,
      sealDigest: sealBinding.sealDigest,
      bundleDigest: row.transfer.blobDigest,
      kaUal,
      activatedTripleCount: expectedTripleCount,
    }),
  };
}

export interface Rfc64AppliedInventoryDigestRowV1 {
  readonly catalogRowDigest: Digest32V1;
  readonly contentDigest: Digest32V1;
  readonly sealDigest: Digest32V1;
  readonly kaUal: string;
  readonly activatedTripleCount: number;
}

/** Compute an applied inventory commitment from exact semantic post-read evidence. */
export function computeRfc64AppliedInventoryDigestV1(input: {
  readonly catalogScopeDigest: Digest32V1;
  readonly rows: readonly Rfc64AppliedInventoryDigestRowV1[];
}): Digest32V1 {
  const hasher = sha256.create();
  hasher.update(UTF8_ENCODER.encode(APPLIED_INVENTORY_DIGEST_DOMAIN_V1));
  hasher.update(ethers.getBytes(input.catalogScopeDigest));
  hasher.update(encodeU64(input.rows.length, 'inventory row count'));
  for (const row of [...input.rows].sort((left, right) => left.kaUal.localeCompare(right.kaUal))) {
    hasher.update(ethers.getBytes(row.catalogRowDigest));
    hasher.update(ethers.getBytes(row.contentDigest));
    hasher.update(ethers.getBytes(row.sealDigest));
    const ual = UTF8_ENCODER.encode(row.kaUal);
    hasher.update(encodeU64(ual.byteLength, 'KA UAL byte length'));
    hasher.update(ual);
    hasher.update(encodeU64(row.activatedTripleCount, 'activated triple count'));
  }
  return ethers.hexlify(hasher.digest()) as Digest32V1;
}

function encodeU64(value: number, label: string): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('catalog-native-receiver-activation', `${label} is not a safe unsigned integer`);
  }
  const result = new Uint8Array(8);
  let remaining = BigInt(value);
  for (let index = result.length - 1; index >= 0; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

/**
 * Require the transferred v1 AuthorAttestation to recover the catalog author.
 * This first receiver slice intentionally supports the recoverable EOA scheme;
 * EIP-1271 contract-author admission needs a separately pinned chain verifier.
 */
export function assertRecoverableAuthorAttestationV1(
  binding: VerifiedCatalogSealBindingSnapshotV1,
): void {
  const { seal } = binding;
  if (seal.authorSchemeVersion !== String(AUTHOR_SCHEME_VERSION_V1)) {
    fail('catalog-native-receiver-transfer', 'unsupported author attestation scheme');
  }
  try {
    const typedData = buildAuthorAttestationTypedData({
      chainId: BigInt(seal.assertedAtChainId),
      kav10Address: seal.assertedAtKav10Address,
      merkleRoot: ethers.getBytes(seal.assertionMerkleRoot),
      authorAddress: seal.authorAddress,
      reservedKaId: BigInt(seal.reservedKaId),
      schemeVersion: AUTHOR_SCHEME_VERSION_V1,
    });
    const digest = ethers.TypedDataEncoder.hash(
      typedData.domain,
      typedData.types,
      typedData.message,
    );
    const signature = ethers.Signature.from({
      r: seal.authorAttestationR,
      yParityAndS: seal.authorAttestationVS,
    });
    const recovered = ethers.recoverAddress(digest, signature);
    if (recovered.toLowerCase() !== seal.authorAddress) {
      throw new Error(
        `signature recovers ${recovered.toLowerCase()} instead of ${seal.authorAddress}`,
      );
    }
  } catch (cause) {
    fail(
      'catalog-native-receiver-transfer',
      'author attestation does not recover the catalog author',
      cause,
    );
  }
}

async function assertExactAuthorSealPostRead(
  store: TripleStore,
  binding: VerifiedCatalogSealBindingSnapshotV1,
): Promise<void> {
  const expected = [...binding.sealRows].sort(compareQuads);
  let result;
  try {
    result = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${binding.placement.metaGraph}> { `
        + `<${binding.placement.subject}> ?p ?o } } ORDER BY ?p ?o `
        + `LIMIT ${expected.length + 1}`,
      {
        source: 'rfc64-public-catalog-native-seal-post-read',
        maxResponseBytes: 64 * 1024,
      },
    );
  } catch (cause) {
    fail('catalog-native-receiver-activation', 'exact author-seal post-read failed', cause);
  }
  if (result.type !== 'bindings' || result.bindings.length !== expected.length) {
    fail('catalog-native-receiver-activation', 'author-seal post-read cardinality changed');
  }
  const actual = result.bindings.map((row) => {
    if (typeof row.p !== 'string' || typeof row.o !== 'string') {
      fail('catalog-native-receiver-activation', 'author-seal post-read row is incomplete');
    }
    return {
      subject: binding.placement.subject,
      predicate: row.p,
      object: row.o,
      graph: binding.placement.metaGraph,
    };
  }).sort(compareQuads);
  if (quadsToNQuads(actual) !== quadsToNQuads(expected)) {
    fail('catalog-native-receiver-activation', 'author-seal post-read differs from verified seal');
  }
}

function compareQuads(
  left: { subject: string; predicate: string; object: string; graph: string },
  right: { subject: string; predicate: string; object: string; graph: string },
): number {
  return left.predicate.localeCompare(right.predicate)
    || left.object.localeCompare(right.object)
    || left.subject.localeCompare(right.subject)
    || left.graph.localeCompare(right.graph);
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}
