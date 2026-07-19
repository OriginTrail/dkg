// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded Gate-1 receiver for one public/open root-lane catalog row.
 *
 * The supported first vertical slice is intentionally narrow: one successor
 * head, one bucket, one row, root context-graph lane, and one complete bundle.
 * Every network hop is RFC-64 catalog-native. Activation happens only after
 * signed head/path/bucket verification, transfer verification, canonical
 * projection verification, one atomic projection-plus-seal replace, exact
 * post-read, and a durable applied-head compare-and-swap.
 */

import {
  AUTHOR_SCHEME_VERSION_V1,
  AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  ZERO_DIGEST32_V1,
  assertAuthorCatalogBucketScopeBindingV1,
  assertAuthorCatalogDirectoryNodeScopeBindingV1,
  assertSignedAuthorCatalogBucketEnvelopeV1,
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1,
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
  type CatalogSealDeploymentProfileV1,
  type Digest32V1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
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
import type { Rfc64ControlObjectOperationsV1 } from './control-object-store-v1.js';
import type {
  AppliedCatalogHeadSnapshotV1,
  Rfc64InventoryV1OperationsV1,
} from './inventory-v1/index.js';
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
const UTF8_ENCODER = new TextEncoder();
const APPLIED_INVENTORY_DIGEST_DOMAIN_V1 = 'dkg-rfc64-applied-inventory-v1\n';

export interface Rfc64PublicCatalogNativeReceiverOptionsV1 {
  readonly headTransport: Rfc64PublicCatalogTransportV1;
  readonly contentTransport: Rfc64PublicCatalogNativeTransportV1;
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
  readonly appliedHeadStatus: 'applied' | 'existing';
}

export type Rfc64PublicCatalogNativeReceiverErrorCodeV1 =
  | 'catalog-native-receiver-input'
  | 'catalog-native-receiver-not-found'
  | 'catalog-native-receiver-slice'
  | 'catalog-native-receiver-catalog'
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
    deployment: CatalogSealDeploymentProfileV1,
  ): Promise<Rfc64PublicCatalogNativeActivationEvidenceV1> {
    return this.withScopeSerialization(
      catalogScopeLockKey(announcement),
      () => this.synchronizeOnePublicOpenRowSerialized(remotePeerId, announcement, deployment),
    );
  }

  private async synchronizeOnePublicOpenRowSerialized(
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
    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(
      deriveAuthorCatalogScopeFromHeadV1(head.payload),
    );
    const currentAppliedHead = this.options.inventory.readAppliedCatalogHeadV1(
      catalogScopeDigest,
      head.payload.authorAddress,
    );
    const replay = assertMonotonicSuccessorHistory(currentAppliedHead, head);
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

    const activation = await activateExactPublicProjection(
      this.options.store,
      head,
      row,
      projectionMetadata.kaUal,
      projectionBytes,
      Number(projectionMetadata.publicTripleCount),
      sealBinding,
    );

    let appliedHeadStatus: 'applied' | 'existing';
    if (replay) {
      if (currentAppliedHead!.appliedInventoryDigest !== activation.inventoryDigest) {
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
          appliedInventoryDigest: activation.inventoryDigest,
          catalogVersion: head.payload.version,
          inventoryRowCount: '1' as never,
        }).status;
      } catch (cause) {
        const reconciled = this.options.inventory.readAppliedCatalogHeadV1(
          catalogScopeDigest,
          head.payload.authorAddress,
        );
        if (
          reconciled?.currentCatalogHeadDigest !== head.objectDigest
          || reconciled.appliedInventoryDigest !== activation.inventoryDigest
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

    return Object.freeze({
      inventoryDigest: activation.inventoryDigest,
      catalogHeadDigest: head.objectDigest as Digest32V1,
      catalogRowDigest: projectionMetadata.catalogRowDigest,
      contentDigest: projectionMetadata.projectionDigest,
      bundleDigest: row.transfer.blobDigest,
      kaUal: projectionMetadata.kaUal,
      inventoryRowCount: 1 as const,
      activatedTripleCount: Number(projectionMetadata.publicTripleCount),
      swmGraph: activation.swmGraph,
      appliedHeadStatus,
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

function catalogScopeLockKey(announcement: Rfc64PublicCatalogHeadAnnouncementV1): string {
  return JSON.stringify([
    announcement.networkId,
    announcement.contextGraphId,
    announcement.subGraphName,
    announcement.authorAddress,
  ]);
}

function assertMonotonicSuccessorHistory(
  current: AppliedCatalogHeadSnapshotV1 | null,
  head: SignedAuthorCatalogHeadEnvelopeV1,
): boolean {
  if (current === null) {
    fail(
      'catalog-native-receiver-history',
      'successor requires a durable initialized predecessor head',
    );
  }
  if (current.currentCatalogHeadDigest === head.objectDigest) {
    if (current.catalogVersion !== head.payload.version || current.inventoryRowCount !== '1') {
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
  sealBinding: VerifiedCatalogSealBindingSnapshotV1,
): Promise<{ swmGraph: string; inventoryDigest: Digest32V1 }> {
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
    inventoryDigest: computeRfc64AppliedInventoryDigestV1({
      catalogScopeDigest: sealBinding.catalogScopeDigest,
      rows: [{
        catalogRowDigest: sealBinding.catalogRowDigest,
        contentDigest: row.projectionDigest,
        sealDigest: sealBinding.sealDigest,
        kaUal,
        activatedTripleCount: expectedTripleCount,
      }],
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
