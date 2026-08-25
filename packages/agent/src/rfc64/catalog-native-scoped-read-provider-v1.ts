// SPDX-License-Identifier: Apache-2.0

/**
 * Provider-side scope proof for RFC-64 native private content reads.
 *
 * The durable stores are intentionally digest keyed and shared by all context
 * graphs. This adapter is the only bridge from an authorized private wire
 * scope to those stores. It first closes one exact bounded signed head and then
 * exposes only the control-object and bundle digests reachable from that head.
 */

import {
  AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  ZERO_DIGEST32_V1,
  assertAuthorCatalogBucketScopeBindingV1,
  assertAuthorCatalogDirectoryNodeScopeBindingV1,
  assertAuthorCatalogHeadScopeBindingV1,
  assertSignedAuthorCatalogBucketEnvelopeV1,
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  assertSignedAuthorCatalogIssuerDelegationEnvelopeV1,
  canonicalizeAuthorCatalogBucketPayloadBytesV1,
  decodeOpaqueKaBundleV1,
  deriveAuthorCatalogScopeFromHeadV1,
  readVerifiedAuthorCatalogBucketDescriptorV1,
  verifyAuthorCatalogDirectoryPathV1,
  type AuthorCatalogScopeV1,
  type Digest32V1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedAuthorCatalogIssuerDelegationEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import {
  verifyAuthorCatalogRowAuthorshipV1,
} from './catalog-row-authorship.js';
import { mintRfc64CatalogNativeScopedReadCapabilityV1 } from './catalog-native-scoped-read-capability-v1-internal.js';
import type { Rfc64ControlObjectOperationsV1 } from './control-object-store-v1.js';
import type { Rfc64KaBundleOperationsV1 } from './ka-bundle-store-v1.js';
import {
  assertRfc64PublicCatalogExactSetBundleBytesV1,
  type ResolveRfc64CatalogNativeScopedReadCapabilityV1,
  type Rfc64CatalogNativeScopedReadCapabilityV1,
  type Rfc64PublicCatalogNativeFetchScopeV1,
} from './public-catalog-native-transport-v1.js';

export interface Rfc64CatalogNativeScopedReadProviderOptionsV1 {
  readonly controlObjects: Pick<Rfc64ControlObjectOperationsV1, 'getVerifiedObjectByDigest'>;
  readonly kaBundles: Pick<Rfc64KaBundleOperationsV1, 'readKaBundleByDigest'>;
}

/**
 * Create a resolver for the currently supported bounded root lane: one
 * directory node, zero or one bucket, and 0..1,024 exact rows.
 */
export function createRfc64CatalogNativeScopedReadProviderV1(
  options: Rfc64CatalogNativeScopedReadProviderOptionsV1,
): ResolveRfc64CatalogNativeScopedReadCapabilityV1 {
  if (
    typeof options?.controlObjects?.getVerifiedObjectByDigest !== 'function'
    || typeof options?.kaBundles?.readKaBundleByDigest !== 'function'
  ) {
    throw new TypeError('RFC-64 scoped read provider dependencies are incomplete');
  }
  return async (scope) => {
    try {
      return await resolveExactBoundedHeadCapability(options, scope);
    } catch {
      // Invalid, missing, cross-scope, or corrupt closures all have the same
      // externally observable result. Do not make the resolver a digest oracle.
      return null;
    }
  };
}

async function resolveExactBoundedHeadCapability(
  options: Rfc64CatalogNativeScopedReadProviderOptionsV1,
  requestedScope: Readonly<Rfc64PublicCatalogNativeFetchScopeV1>,
): Promise<Rfc64CatalogNativeScopedReadCapabilityV1> {
  const scope = snapshotScope(requestedScope);
  const storedHead = await readStored(options, scope.catalogHeadObjectDigest);
  if (storedHead === null) throw new Error('requested catalog head is not stored');
  assertSignedAuthorCatalogHeadEnvelopeV1(storedHead.envelope);
  const head = storedHead.envelope;
  assertExactRequestedBoundedHead(head, scope);
  const catalogScope = deriveAuthorCatalogScopeFromHeadV1(head.payload);
  assertAuthorCatalogHeadScopeBindingV1(head.payload, catalogScope);

  const storedDelegation = await readStored(
    options,
    head.payload.catalogIssuerDelegationDigest,
  );
  if (storedDelegation === null) throw new Error('catalog issuer delegation is not stored');
  assertSignedAuthorCatalogIssuerDelegationEnvelopeV1(storedDelegation.envelope);
  const delegation = storedDelegation.envelope;
  assertDirectAuthorCatalogIssuerDelegationBinding(delegation, head, catalogScope);

  const storedDirectory = await readStored(options, head.payload.directoryRootDigest);
  if (storedDirectory === null) throw new Error('catalog directory root is not stored');
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(
    storedDirectory.envelope,
    head.payload.bucketCount,
  );
  const directory = storedDirectory.envelope;
  assertAuthorCatalogDirectoryNodeScopeBindingV1(directory.payload, catalogScope);
  if (
    directory.objectDigest !== head.payload.directoryRootDigest
    || directory.issuer !== head.issuer
  ) {
    throw new Error('catalog directory identity or issuer differs from its head');
  }
  const directoryProof = verifyAuthorCatalogDirectoryPathV1(
    head,
    [directory],
    '0' as never,
  );
  const descriptor = readVerifiedAuthorCatalogBucketDescriptorV1(directoryProof, head);

  const allowedControlObjects = new Map<Digest32V1, string>([
    [head.objectDigest as Digest32V1, AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1],
    [delegation.objectDigest as Digest32V1, AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1],
    [directory.objectDigest as Digest32V1, AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1],
  ]);
  const allowedBundles = new Map<Digest32V1, number>();

  if (head.payload.totalRows === '0') {
    if (
      descriptor.bucketId !== '0'
      || descriptor.bucketDigest !== ZERO_DIGEST32_V1
      || descriptor.rowCount !== '0'
      || descriptor.byteLength !== '0'
    ) {
      throw new Error('empty head directory descriptor is not canonical');
    }
  } else {
    const storedBucket = await readStored(options, descriptor.bucketDigest);
    if (storedBucket === null) throw new Error('catalog bucket is not stored');
    assertSignedAuthorCatalogBucketEnvelopeV1(storedBucket.envelope);
    const bucket = storedBucket.envelope;
    assertExactBoundedBucket(bucket, head, directory, descriptor, catalogScope);
    assertRfc64PublicCatalogExactSetBundleBytesV1(
      bucket.payload.rows.map((row) => row.transfer.byteLength),
    );
    for (const row of bucket.payload.rows) {
      verifyAuthorCatalogRowAuthorshipV1({
        catalogIssuerDelegation: delegation,
        catalogIssuerDelegationSignature: storedDelegation.issuerSignature,
        parentAuthorAgentEvidence: null,
        catalogHead: head,
        catalogHeadSignature: storedHead.issuerSignature,
        directoryPathEnvelopes: [directory],
        directoryPathSignatures: [storedDirectory.issuerSignature],
        directoryPathProof: directoryProof,
        catalogBucket: bucket,
        catalogBucketSignature: storedBucket.issuerSignature,
        targetKaId: row.kaId,
      });
      const byteLength = Number(BigInt(row.transfer.byteLength));
      const previous = allowedBundles.get(row.transfer.blobDigest);
      if (previous !== undefined && previous !== byteLength) {
        throw new Error('one bundle digest is committed with conflicting byte lengths');
      }
      allowedBundles.set(row.transfer.blobDigest, byteLength);
    }
    allowedControlObjects.set(
      bucket.objectDigest as Digest32V1,
      AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
    );
  }

  return mintRfc64CatalogNativeScopedReadCapabilityV1({
    scope,
    readCatalogObjectByDigest: async (objectDigest) => {
      const expectedType = allowedControlObjects.get(objectDigest);
      if (expectedType === undefined) return null;
      const stored = await readStored(options, objectDigest);
      if (
        stored === null
        || stored.envelope.objectDigest !== objectDigest
        || stored.envelope.objectType !== expectedType
      ) {
        throw new Error('stored catalog closure changed after capability resolution');
      }
      return stored.envelope;
    },
    readKaBundleByDigest: async (blobDigest) => {
      const expectedByteLength = allowedBundles.get(blobDigest);
      if (expectedByteLength === undefined) return null;
      const bundle = await options.kaBundles.readKaBundleByDigest(blobDigest);
      if (bundle === null) return null;
      const decoded = decodeOpaqueKaBundleV1(bundle);
      if (
        decoded.blobDigest !== blobDigest
        || bundle.byteLength !== expectedByteLength
      ) {
        throw new Error('stored KA bundle differs from the exact signed catalog row');
      }
      return bundle;
    },
  });
}

async function readStored(
  options: Rfc64CatalogNativeScopedReadProviderOptionsV1,
  objectDigest: Digest32V1,
) {
  return options.controlObjects.getVerifiedObjectByDigest({
    objectDigest,
    verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
  });
}

function snapshotScope(
  input: Readonly<Rfc64PublicCatalogNativeFetchScopeV1>,
): Readonly<Rfc64PublicCatalogNativeFetchScopeV1> {
  return Object.freeze({
    networkId: input.networkId,
    contextGraphId: input.contextGraphId,
    subGraphName: input.subGraphName,
    authorAddress: input.authorAddress,
    catalogEra: input.catalogEra,
    catalogVersion: input.catalogVersion,
    policyDigest: input.policyDigest,
    catalogHeadObjectDigest: input.catalogHeadObjectDigest,
  });
}

function assertExactRequestedBoundedHead(
  head: SignedAuthorCatalogHeadEnvelopeV1,
  scope: Readonly<Rfc64PublicCatalogNativeFetchScopeV1>,
): void {
  const totalRows = Number(BigInt(head.payload.totalRows));
  if (
    head.objectDigest !== scope.catalogHeadObjectDigest
    || head.payload.networkId !== scope.networkId
    || head.payload.contextGraphId !== scope.contextGraphId
    || head.payload.subGraphName !== scope.subGraphName
    || head.payload.authorAddress !== scope.authorAddress
    || head.payload.era !== scope.catalogEra
    || head.payload.version !== scope.catalogVersion
    || head.payload.bucketCount !== '1'
    || head.payload.directoryHeight !== '0'
    || !Number.isSafeInteger(totalRows)
    || totalRows < 0
    || totalRows > MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1
  ) {
    throw new Error('stored head differs from the exact requested bounded catalog scope');
  }
}

function assertExactBoundedBucket(
  bucket: SignedAuthorCatalogBucketEnvelopeV1,
  head: SignedAuthorCatalogHeadEnvelopeV1,
  directory: SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  descriptor: ReturnType<typeof readVerifiedAuthorCatalogBucketDescriptorV1>,
  catalogScope: Readonly<AuthorCatalogScopeV1>,
): void {
  assertAuthorCatalogBucketScopeBindingV1(bucket.payload, catalogScope);
  if (
    directory.objectDigest !== head.payload.directoryRootDigest
    || descriptor.bucketId !== '0'
    || descriptor.bucketDigest === ZERO_DIGEST32_V1
    || bucket.objectDigest !== descriptor.bucketDigest
    || bucket.issuer !== head.issuer
    || bucket.payload.bucketId !== descriptor.bucketId
    || bucket.payload.rows.length.toString() !== descriptor.rowCount
    || bucket.payload.rows.length.toString() !== head.payload.totalRows
    || canonicalizeAuthorCatalogBucketPayloadBytesV1(bucket.payload).byteLength.toString()
      !== descriptor.byteLength
  ) {
    throw new Error('stored bucket differs from the exact signed directory/head closure');
  }
}

/** Release 1 accepts only a direct author-signed catalog issuer grant. */
function assertDirectAuthorCatalogIssuerDelegationBinding(
  delegation: SignedAuthorCatalogIssuerDelegationEnvelopeV1,
  head: SignedAuthorCatalogHeadEnvelopeV1,
  catalogScope: Readonly<AuthorCatalogScopeV1>,
): void {
  const left = delegation.payload;
  const right = head.payload;
  if (
    delegation.objectDigest !== right.catalogIssuerDelegationDigest
    || delegation.issuer !== left.authorAddress
    || left.authorAuthorityEvidenceDigest !== null
    || left.catalogIssuerKey !== head.issuer
    || left.networkId !== right.networkId
    || left.contextGraphId !== right.contextGraphId
    || left.governanceChainId !== right.governanceChainId
    || left.governanceContractAddress !== right.governanceContractAddress
    || left.ownershipTransitionDigest !== right.ownershipTransitionDigest
    || left.subGraphName !== right.subGraphName
    || left.authorAddress !== right.authorAddress
    || left.catalogEra !== right.era
    || left.networkId !== catalogScope.networkId
    || left.contextGraphId !== catalogScope.contextGraphId
    || left.governanceChainId !== catalogScope.governanceChainId
    || left.governanceContractAddress !== catalogScope.governanceContractAddress
    || left.ownershipTransitionDigest !== catalogScope.ownershipTransitionDigest
    || left.subGraphName !== catalogScope.subGraphName
    || left.authorAddress !== catalogScope.authorAddress
    || left.catalogEra !== catalogScope.era
    || (left.catalogEra === '0') !== (left.previousDelegationDigest === null)
    || BigInt(right.issuedAt) < BigInt(left.effectiveAt)
    || BigInt(right.issuedAt) >= BigInt(left.expiresAt)
  ) {
    throw new Error('catalog issuer delegation is not the exact direct-author authority for head');
  }
}
