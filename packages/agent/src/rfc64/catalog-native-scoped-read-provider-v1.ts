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
  type SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import type {
  VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';

import {
  verifyAuthorCatalogRowAuthorshipV1,
} from './catalog-row-authorship.js';
import type { AcceptedRfc64CatalogAccessSnapshotV1 } from './catalog-access-policy-v1.js';
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
  /** The exact verifier configured for every other catalog service path. */
  readonly verifyIssuerSignature: (
    envelope: SignedControlEnvelopeV1,
  ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>;
  /** Accepted-current authority; never derive policy scope from the request. */
  readonly resolveAcceptedPolicySnapshot: (
    networkId: Rfc64PublicCatalogNativeFetchScopeV1['networkId'],
    contextGraphId: Rfc64PublicCatalogNativeFetchScopeV1['contextGraphId'],
  ) => AcceptedRfc64CatalogAccessSnapshotV1 | null
    | Promise<AcceptedRfc64CatalogAccessSnapshotV1 | null>;
  /** Optional diagnostics hook after one successful whole-bucket proof. */
  readonly onAuthorCatalogBucketProof?: () => void;
}

type Rfc64CatalogNativePrivateAuthorityScopeV1 = Pick<
  Rfc64PublicCatalogNativeFetchScopeV1,
  'networkId' | 'contextGraphId' | 'authorAddress' | 'catalogEra' | 'policyDigest'
>;

interface ResolvedRfc64CatalogNativeScopedReadCapabilityV1 {
  readonly capability: Rfc64CatalogNativeScopedReadCapabilityV1;
  readonly catalogScope: Readonly<AuthorCatalogScopeV1>;
}

/** Hard process-memory bound for verified exact-head private read capabilities. */
const RFC64_CATALOG_NATIVE_SCOPED_READ_CAPABILITY_CACHE_MAX_ENTRIES_V1 = 128;

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
    || typeof options?.verifyIssuerSignature !== 'function'
    || typeof options?.resolveAcceptedPolicySnapshot !== 'function'
    || (
      options.onAuthorCatalogBucketProof !== undefined
      && typeof options.onAuthorCatalogBucketProof !== 'function'
    )
  ) {
    throw new TypeError('RFC-64 scoped read provider dependencies are incomplete');
  }
  const capabilities = new Map<string, ResolvedRfc64CatalogNativeScopedReadCapabilityV1>();
  const constructions = new Map<
    string,
    Promise<ResolvedRfc64CatalogNativeScopedReadCapabilityV1>
  >();
  return async (untrustedScope) => {
    try {
      const scope = snapshotScope(untrustedScope);
      const cacheKey = exactScopeCacheKey(scope);
      const cached = capabilities.get(cacheKey);
      if (cached !== undefined) {
        // Do not let a cached cryptographic closure outlive its accepted-current
        // private policy or author membership. The capability repeats the full
        // policy/scope check before every object or bundle read as well.
        try {
          await requireAcceptedCurrentPrivateCatalogScope(
            options,
            cached.catalogScope,
            scope.policyDigest,
          );
        } catch (cause) {
          capabilities.delete(cacheKey);
          throw cause;
        }
        return cached.capability;
      }
      let construction = constructions.get(cacheKey);
      if (construction === undefined) {
        if (
          constructions.size
          >= RFC64_CATALOG_NATIVE_SCOPED_READ_CAPABILITY_CACHE_MAX_ENTRIES_V1
        ) {
          throw new Error('RFC-64 scoped read capability construction limit reached');
        }
        construction = resolveExactBoundedHeadCapability(options, scope);
        constructions.set(cacheKey, construction);
      }
      let resolved: ResolvedRfc64CatalogNativeScopedReadCapabilityV1;
      try {
        resolved = await construction;
      } finally {
        if (constructions.get(cacheKey) === construction) constructions.delete(cacheKey);
      }
      rememberSuccessfulCapability(capabilities, cacheKey, resolved);
      return resolved.capability;
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
): Promise<ResolvedRfc64CatalogNativeScopedReadCapabilityV1> {
  const scope = snapshotScope(requestedScope);
  const accepted = await requireAcceptedCurrentPrivateScope(options, scope);
  const storedHead = await readStored(options, scope.catalogHeadObjectDigest);
  if (storedHead === null) throw new Error('requested catalog head is not stored');
  assertSignedAuthorCatalogHeadEnvelopeV1(storedHead.envelope);
  const head = storedHead.envelope;
  assertExactRequestedBoundedHead(head, scope);
  const catalogScope = deriveAuthorCatalogScopeFromHeadV1(head.payload);
  assertAuthorCatalogHeadScopeBindingV1(head.payload, catalogScope);
  assertAcceptedPolicyMatchesCatalogScope(accepted, catalogScope, scope.policyDigest);

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
    const firstRow = bucket.payload.rows[0];
    if (firstRow === undefined) throw new Error('non-empty catalog bucket has no first row');
    // One exact authorship proof authenticates the common delegation, head,
    // directory path, bucket signature, and complete signed bucket bytes. The
    // preceding canonical bucket/scope assertion has already validated every
    // row, including ordering, uniqueness, bucket mapping, and packed author.
    // Repeating the same whole-bucket proof for each target row made a bounded
    // N-row capability construction O(N^2) without adding authorization.
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
      targetKaId: firstRow.kaId,
    });
    options.onAuthorCatalogBucketProof?.();
    for (const row of bucket.payload.rows) {
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

  await requireAcceptedCurrentPrivateCatalogScope(options, catalogScope, scope.policyDigest);
  const capability = mintRfc64CatalogNativeScopedReadCapabilityV1({
    scope,
    readCatalogObjectByDigest: async (objectDigest) => {
      await requireAcceptedCurrentPrivateCatalogScope(options, catalogScope, scope.policyDigest);
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
      await requireAcceptedCurrentPrivateCatalogScope(options, catalogScope, scope.policyDigest);
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
  return Object.freeze({ capability, catalogScope });
}

function exactScopeCacheKey(
  scope: Readonly<Rfc64PublicCatalogNativeFetchScopeV1>,
): string {
  return JSON.stringify([
    scope.networkId,
    scope.contextGraphId,
    scope.subGraphName,
    scope.authorAddress,
    scope.catalogEra,
    scope.catalogVersion,
    scope.policyDigest,
    scope.catalogHeadObjectDigest,
  ]);
}

function rememberSuccessfulCapability(
  capabilities: Map<string, ResolvedRfc64CatalogNativeScopedReadCapabilityV1>,
  cacheKey: string,
  resolved: ResolvedRfc64CatalogNativeScopedReadCapabilityV1,
): void {
  if (
    !capabilities.has(cacheKey)
    && capabilities.size >= RFC64_CATALOG_NATIVE_SCOPED_READ_CAPABILITY_CACHE_MAX_ENTRIES_V1
  ) {
    const oldest = capabilities.keys().next().value as string | undefined;
    if (oldest !== undefined) capabilities.delete(oldest);
  }
  capabilities.set(cacheKey, resolved);
}

async function requireAcceptedCurrentPrivateScope(
  options: Rfc64CatalogNativeScopedReadProviderOptionsV1,
  scope: Readonly<Rfc64CatalogNativePrivateAuthorityScopeV1>,
): Promise<Readonly<AcceptedRfc64CatalogAccessSnapshotV1>> {
  const accepted = await options.resolveAcceptedPolicySnapshot(
    scope.networkId,
    scope.contextGraphId,
  );
  if (
    accepted === null
    || accepted.policyDigest !== scope.policyDigest
    || accepted.policy.accessPolicy !== 1
    || accepted.policy.networkId !== scope.networkId
    || accepted.policy.contextGraphId !== scope.contextGraphId
    || accepted.policy.era !== scope.catalogEra
    || accepted.roster === null
    || accepted.roster.networkId !== accepted.policy.networkId
    || accepted.roster.contextGraphId !== accepted.policy.contextGraphId
    || accepted.roster.ownershipTransitionDigest
      !== accepted.policy.ownershipTransitionDigest
    || accepted.roster.era !== accepted.policy.era
    || accepted.roster.policyDigest !== accepted.policyDigest
    || accepted.roster.administrativeDelegationDigest
      !== accepted.policy.administrativeDelegationDigest
    || !accepted.roster.members.some(
      (member) => member.agentAddress === scope.authorAddress,
    )
  ) {
    throw new Error('requested private catalog scope is not accepted-current authority');
  }
  return accepted;
}

async function requireAcceptedCurrentPrivateCatalogScope(
  options: Rfc64CatalogNativeScopedReadProviderOptionsV1,
  catalogScope: Readonly<AuthorCatalogScopeV1>,
  policyDigest: Digest32V1,
): Promise<void> {
  const accepted = await requireAcceptedCurrentPrivateScope(options, {
    networkId: catalogScope.networkId,
    contextGraphId: catalogScope.contextGraphId,
    authorAddress: catalogScope.authorAddress,
    catalogEra: catalogScope.era,
    policyDigest,
  });
  assertAcceptedPolicyMatchesCatalogScope(accepted, catalogScope, policyDigest);
}

function assertAcceptedPolicyMatchesCatalogScope(
  accepted: Readonly<AcceptedRfc64CatalogAccessSnapshotV1>,
  catalogScope: Readonly<AuthorCatalogScopeV1>,
  policyDigest: Digest32V1,
): void {
  const policy = accepted.policy;
  if (
    accepted.policyDigest !== policyDigest
    || policy.networkId !== catalogScope.networkId
    || policy.contextGraphId !== catalogScope.contextGraphId
    || policy.governanceChainId !== catalogScope.governanceChainId
    || policy.governanceContractAddress !== catalogScope.governanceContractAddress
    || policy.ownershipTransitionDigest !== catalogScope.ownershipTransitionDigest
    || policy.era !== catalogScope.era
  ) {
    throw new Error('accepted-current policy differs from the exact private catalog scope');
  }
}

async function readStored(
  options: Rfc64CatalogNativeScopedReadProviderOptionsV1,
  objectDigest: Digest32V1,
) {
  return options.controlObjects.getVerifiedObjectByDigest({
    objectDigest,
    verifyIssuerSignature: options.verifyIssuerSignature,
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
