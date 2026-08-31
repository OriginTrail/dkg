// SPDX-License-Identifier: Apache-2.0

import {
  ZERO_DIGEST32_V1,
  assertAuthorCatalogBucketScopeBindingV1,
  assertAuthorCatalogDirectoryNodeScopeBindingV1,
  assertAuthorCatalogHeadScopeBindingV1,
  assertSignedAuthorCatalogBucketEnvelopeV1,
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  assertSignedAuthorCatalogIssuerDelegationEnvelopeV1,
  canonicalizeAuthorCatalogBucketPayloadBytesV1,
  computeAuthorCatalogScopeDigestV1,
  deriveAuthorCatalogScopeFromHeadV1,
  readVerifiedAuthorCatalogBucketDescriptorV1,
  verifyAuthorCatalogDirectoryPathV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type ContextGraphIdV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedAuthorCatalogIssuerDelegationEnvelopeV1,
  type SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  verifyControlEnvelopeIssuerSignatureV1,
  type VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';
import type { TripleStore } from '@origintrail-official/dkg-storage';

import {
  verifyAuthorCatalogRowAuthorshipV1,
} from './catalog-row-authorship.js';
import type {
  Rfc64ControlObjectOperationsV1,
  StoredVerifiedControlObjectV1,
} from './control-object-store-v1.js';
import type {
  AppliedCatalogHeadSnapshotV1,
  Rfc64InventoryV1OperationsV1,
} from './inventory-v1/index.js';
import {
  deactivateRfc64CatalogOwnedProjectionV1,
  planRfc64CatalogOwnedRowRemovalV1,
  restoreRfc64SemanticTransitionV1,
  snapshotRfc64SemanticTransitionV1,
  transitionLocationFromRfc64RemovalV1,
} from './catalog-semantic-authority-transition-v1.js';

export interface DeactivateRfc64AppliedCatalogAuthorityInputV1 {
  readonly store: TripleStore;
  readonly controlObjects: Pick<
    Rfc64ControlObjectOperationsV1,
    'getVerifiedObjectByDigest'
  >;
  readonly inventory: Pick<Rfc64InventoryV1OperationsV1, 'deleteAppliedCatalogHeadV1'>;
  readonly appliedHead: AppliedCatalogHeadSnapshotV1;
  readonly verifyIssuerSignature?: (
    envelope: SignedControlEnvelopeV1,
  ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>;
}

/** Gate 1 accepts only an author-signed issuer grant with no parent-agent hop. */
export function assertDirectAuthorCatalogIssuerDelegationBindingV1(
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
    throw new Error('delegation differs from the locally trusted bounded public root catalog scope');
  }
  if (
    (left.catalogEra === '0') !== (left.previousDelegationDigest === null)
    || BigInt(right.issuedAt) < BigInt(left.effectiveAt)
    || BigInt(right.issuedAt) >= BigInt(left.expiresAt)
  ) {
    throw new Error('delegation history or half-open validity interval does not authorize head');
  }
}

export async function readRfc64AppliedCatalogContextGraphIdV1(
  input: Pick<
    DeactivateRfc64AppliedCatalogAuthorityInputV1,
    'controlObjects' | 'appliedHead' | 'verifyIssuerSignature'
  >,
): Promise<ContextGraphIdV1> {
  const storedHead = await readValidatedAppliedHeadV1(input);
  return deriveAuthorCatalogScopeFromHeadV1(storedHead.envelope.payload).contextGraphId;
}

/**
 * Remove one exact catalog-owned semantic closure before yielding authority.
 * Semantic deletion precedes applied-ref deletion; rollback restores the exact
 * preimage for every returned failure.
 */
export async function deactivateRfc64AppliedCatalogAuthorityV1(
  input: DeactivateRfc64AppliedCatalogAuthorityInputV1,
): Promise<Readonly<{ contextGraphId: ContextGraphIdV1; removedRows: number }>> {
  const verifyIssuerSignature = input.verifyIssuerSignature
    ?? verifyControlEnvelopeIssuerSignatureV1;
  const storedHead = await readValidatedAppliedHeadV1({
    ...input,
    verifyIssuerSignature,
  });
  const scope = deriveAuthorCatalogScopeFromHeadV1(storedHead.envelope.payload);
  const rows = await loadExactAppliedCatalogRowsV1(
    input.controlObjects,
    storedHead,
    scope,
    verifyIssuerSignature,
  );
  const removals = rows.map((row) => planRfc64CatalogOwnedRowRemovalV1(scope, row));
  const journal = await snapshotRfc64SemanticTransitionV1(
    input.store,
    removals.map(transitionLocationFromRfc64RemovalV1),
  );
  let mutationAttempted = false;
  try {
    for (const removal of removals) {
      mutationAttempted = true;
      await deactivateRfc64CatalogOwnedProjectionV1(input.store, removal);
    }
    input.inventory.deleteAppliedCatalogHeadV1({
      catalogScopeDigest: input.appliedHead.catalogScopeDigest,
      authorAddress: input.appliedHead.authorAddress,
      expectedCurrentCatalogHeadDigest: input.appliedHead.currentCatalogHeadDigest,
    });
  } catch (cause) {
    if (mutationAttempted) await restoreRfc64SemanticTransitionV1(input.store, journal);
    throw new Error('RFC-64 catalog semantic authority deactivation failed', { cause });
  }
  return Object.freeze({ contextGraphId: scope.contextGraphId, removedRows: removals.length });
}

export async function loadExactAppliedCatalogRowsV1(
  controlObjects: Pick<Rfc64ControlObjectOperationsV1, 'getVerifiedObjectByDigest'>,
  storedHead: StoredVerifiedControlObjectV1,
  trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
  verifyIssuerSignature: (
    envelope: SignedControlEnvelopeV1,
  ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>,
): Promise<readonly Readonly<AuthorCatalogRowV1>[]> {
  assertSignedAuthorCatalogHeadEnvelopeV1(storedHead.envelope);
  const head = storedHead.envelope;
  assertAuthorCatalogHeadScopeBindingV1(head.payload, trustedCatalogScope);
  const storedDelegation = await controlObjects.getVerifiedObjectByDigest({
    objectDigest: head.payload.catalogIssuerDelegationDigest,
    verifyIssuerSignature,
  });
  if (storedDelegation === null) throw new Error('catalog delegation is not staged');
  assertSignedAuthorCatalogIssuerDelegationEnvelopeV1(storedDelegation.envelope);
  assertDirectAuthorCatalogIssuerDelegationBindingV1(
    storedDelegation.envelope,
    head,
    trustedCatalogScope,
  );
  const storedDirectory = await controlObjects.getVerifiedObjectByDigest({
    objectDigest: head.payload.directoryRootDigest,
    verifyIssuerSignature,
  });
  if (storedDirectory === null) throw new Error('catalog directory root is not staged');
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(
    storedDirectory.envelope,
    head.payload.bucketCount,
  );
  const directory = storedDirectory.envelope;
  assertAuthorCatalogDirectoryNodeScopeBindingV1(directory.payload, trustedCatalogScope);
  if (directory.objectDigest !== head.payload.directoryRootDigest || directory.issuer !== head.issuer) {
    throw new Error('catalog directory identity or issuer differs from its head');
  }
  const directoryPathProof = verifyAuthorCatalogDirectoryPathV1(head, [directory], '0' as never);
  const descriptor = readVerifiedAuthorCatalogBucketDescriptorV1(directoryPathProof, head);
  if (descriptor.rowCount !== head.payload.totalRows) {
    throw new Error('catalog directory row count differs from its head');
  }
  if (head.payload.totalRows === '0') {
    if (
      descriptor.bucketDigest !== ZERO_DIGEST32_V1
      || descriptor.byteLength !== '0'
      || descriptor.rowCount !== '0'
    ) throw new Error('empty catalog descriptor is not canonical');
    return Object.freeze([]);
  }
  if (descriptor.bucketDigest === ZERO_DIGEST32_V1) {
    throw new Error('non-empty catalog has an empty bucket digest');
  }
  const storedBucket = await controlObjects.getVerifiedObjectByDigest({
    objectDigest: descriptor.bucketDigest,
    verifyIssuerSignature,
  });
  if (storedBucket === null) throw new Error('catalog bucket is not staged');
  assertSignedAuthorCatalogBucketEnvelopeV1(storedBucket.envelope);
  const bucket = storedBucket.envelope;
  assertAuthorCatalogBucketScopeBindingV1(bucket.payload, trustedCatalogScope);
  if (
    bucket.objectDigest !== descriptor.bucketDigest
    || bucket.issuer !== head.issuer
    || bucket.payload.bucketId !== descriptor.bucketId
    || bucket.payload.rows.length.toString() !== descriptor.rowCount
    || canonicalizeAuthorCatalogBucketPayloadBytesV1(bucket.payload).byteLength.toString()
      !== descriptor.byteLength
  ) throw new Error('catalog bucket differs from its verified descriptor');
  for (const row of bucket.payload.rows) {
    verifyAuthorCatalogRowAuthorshipV1({
      catalogIssuerDelegation: storedDelegation.envelope,
      catalogIssuerDelegationSignature: storedDelegation.issuerSignature,
      parentAuthorAgentEvidence: null,
      catalogHead: head,
      catalogHeadSignature: storedHead.issuerSignature,
      directoryPathEnvelopes: [directory],
      directoryPathSignatures: [storedDirectory.issuerSignature],
      directoryPathProof,
      catalogBucket: bucket,
      catalogBucketSignature: storedBucket.issuerSignature,
      targetKaId: row.kaId,
    });
  }
  return Object.freeze(bucket.payload.rows.map((row) => Object.freeze({ ...row })));
}

async function readValidatedAppliedHeadV1(input: Pick<
  DeactivateRfc64AppliedCatalogAuthorityInputV1,
  'controlObjects' | 'appliedHead' | 'verifyIssuerSignature'
>): Promise<StoredVerifiedControlObjectV1 & {
  readonly envelope: SignedAuthorCatalogHeadEnvelopeV1;
}> {
  const storedHead = await input.controlObjects.getVerifiedObjectByDigest({
    objectDigest: input.appliedHead.currentCatalogHeadDigest,
    verifyIssuerSignature: input.verifyIssuerSignature
      ?? verifyControlEnvelopeIssuerSignatureV1,
  });
  if (storedHead === null) {
    throw new Error('durable applied catalog head is missing its staged signed object');
  }
  assertSignedAuthorCatalogHeadEnvelopeV1(storedHead.envelope);
  const head = storedHead.envelope;
  const scope = deriveAuthorCatalogScopeFromHeadV1(head.payload);
  if (
    head.objectDigest !== input.appliedHead.currentCatalogHeadDigest
    || computeAuthorCatalogScopeDigestV1(scope) !== input.appliedHead.catalogScopeDigest
    || scope.authorAddress !== input.appliedHead.authorAddress
    || head.payload.version !== input.appliedHead.catalogVersion
    || head.payload.totalRows !== input.appliedHead.inventoryRowCount
  ) throw new Error('durable applied catalog head differs from its signed catalog closure');
  return storedHead as never;
}
