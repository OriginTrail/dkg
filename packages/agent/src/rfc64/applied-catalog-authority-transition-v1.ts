// SPDX-License-Identifier: Apache-2.0

import {
  AUTHOR_CATALOG_DIRECTORY_FANOUT_V1,
  MAX_AUTHOR_CATALOG_DIRECTORY_HEIGHT_V1,
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
  type AuthorCatalogBucketDescriptorV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type ContextGraphIdV1,
  type DecimalU64V1,
  type Digest32V1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedAuthorCatalogIssuerDelegationEnvelopeV1,
  type SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  verifyControlEnvelopeIssuerSignatureV1,
  type VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';
import type { TripleStore } from '@origintrail-official/dkg-storage';

import { yieldMainThread } from '../main-thread-time-slice.js';

import {
  readVerifiedAuthorCatalogRowAuthorshipV1,
  verifyAuthorCatalogBucketRowAuthorshipsV1,
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
  deactivateRfc64CatalogOwnedProjectionIfStillOwnedV1,
  planRfc64CatalogOwnedRowRemovalV1,
  restoreRfc64SemanticTransitionV1,
  snapshotRfc64SemanticTransitionV1,
  transitionLocationFromRfc64RemovalV1,
  type Rfc64CatalogOwnedRowRemovalV1,
  type Rfc64SemanticTransitionPreimageV1,
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

export interface PreparedRfc64AppliedCatalogAuthorityDeactivationV1 {
  readonly contextGraphId: ContextGraphIdV1;
  readonly appliedHead: AppliedCatalogHeadSnapshotV1;
  readonly removals: readonly Readonly<Rfc64CatalogOwnedRowRemovalV1>[];
  readonly journal: readonly Readonly<Rfc64SemanticTransitionPreimageV1>[];
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
  const prepared = await prepareRfc64AppliedCatalogAuthorityDeactivationV1(input);
  return commitPreparedRfc64AppliedCatalogAuthorityDeactivationsV1({
    store: input.store,
    inventory: {
      deleteAppliedCatalogHeadsV1: (heads) => {
        for (const head of heads) input.inventory.deleteAppliedCatalogHeadV1(head);
      },
    },
    prepared: [prepared],
  });
}

/** Validate and snapshot one complete applied head before any mutation begins. */
export async function prepareRfc64AppliedCatalogAuthorityDeactivationV1(
  input: Omit<DeactivateRfc64AppliedCatalogAuthorityInputV1, 'inventory'>,
): Promise<PreparedRfc64AppliedCatalogAuthorityDeactivationV1> {
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
  return Object.freeze({
    contextGraphId: scope.contextGraphId,
    appliedHead: input.appliedHead,
    removals: Object.freeze(removals),
    journal,
  });
}

/** Commit one context graph's prepared semantic and inventory transition. */
export async function commitPreparedRfc64AppliedCatalogAuthorityDeactivationsV1(
  input: Readonly<{
    readonly store: TripleStore;
    readonly inventory: Pick<Rfc64InventoryV1OperationsV1, 'deleteAppliedCatalogHeadsV1'>;
    readonly prepared: readonly PreparedRfc64AppliedCatalogAuthorityDeactivationV1[];
  }>,
): Promise<Readonly<{ contextGraphId: ContextGraphIdV1; removedRows: number }>> {
  const contextGraphIds = new Set(input.prepared.map(({ contextGraphId }) => contextGraphId));
  if (contextGraphIds.size !== 1) {
    throw new Error('prepared catalog authority batch must contain one context graph');
  }
  const combinedJournal = Object.freeze(input.prepared.flatMap(({ journal }) => journal));
  let mutationAttempted = false;
  let removedRows = 0;
  try {
    for (const current of input.prepared) {
      for (let index = 0; index < current.removals.length; index += 1) {
        const removal = current.removals[index];
        const preimage = current.journal[index];
        if (!removal || !preimage) throw new Error('prepared semantic journal is incomplete');
        mutationAttempted = true;
        const result = await deactivateRfc64CatalogOwnedProjectionIfStillOwnedV1(
          input.store,
          removal,
          preimage,
        );
        if (result === 'removed') removedRows += 1;
      }
    }
    input.inventory.deleteAppliedCatalogHeadsV1(input.prepared.map(({ appliedHead }) => ({
      catalogScopeDigest: appliedHead.catalogScopeDigest,
      authorAddress: appliedHead.authorAddress,
      expectedCurrentCatalogHeadDigest: appliedHead.currentCatalogHeadDigest,
    })));
  } catch (cause) {
    if (mutationAttempted) {
      await restoreRfc64SemanticTransitionV1(input.store, combinedJournal);
    }
    throw new Error('RFC-64 catalog semantic authority deactivation failed', { cause });
  }
  const contextGraphId = input.prepared[0]?.contextGraphId;
  if (!contextGraphId) throw new Error('prepared catalog authority batch is empty');
  return Object.freeze({ contextGraphId, removedRows });
}

/** One bucket of a staged catalog head, read through its verified directory path. */
export interface VerifiedAppliedCatalogBucketV1 {
  readonly bucketId: DecimalU64V1;
  readonly descriptor: Readonly<AuthorCatalogBucketDescriptorV1>;
  /** The authorship verifier's frozen row snapshots, in bucket order; empty for an empty bucket. */
  readonly rows: readonly Readonly<AuthorCatalogRowV1>[];
}

type VerifyCatalogIssuerSignatureV1 = (
  envelope: SignedControlEnvelopeV1,
) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>;

export async function loadExactAppliedCatalogRowsV1(
  controlObjects: Pick<Rfc64ControlObjectOperationsV1, 'getVerifiedObjectByDigest'>,
  storedHead: StoredVerifiedControlObjectV1,
  trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
  verifyIssuerSignature: VerifyCatalogIssuerSignatureV1,
): Promise<readonly Readonly<AuthorCatalogRowV1>[]> {
  const buckets = await readAppliedCatalogBucketsV1(
    controlObjects,
    storedHead,
    trustedCatalogScope,
    verifyIssuerSignature,
  );
  return Object.freeze(buckets.flatMap((bucket) => bucket.rows));
}

/**
 * GH#3134 — the rows of the scope's applied head, bucket by bucket, without their bundles: what a
 * placement or a projection compares against. Null when nothing is applied for the scope.
 */
export async function readAppliedCatalogRowIdentitiesV1(input: Readonly<{
  inventory: Pick<Rfc64InventoryV1OperationsV1, 'readAppliedCatalogHeadV1'>;
  controlObjects: Pick<Rfc64ControlObjectOperationsV1, 'getVerifiedObjectByDigest'>;
  scope: Readonly<AuthorCatalogScopeV1>;
  /** Buckets to read; every non-empty bucket when omitted. */
  bucketIds?: readonly DecimalU64V1[];
  verifyIssuerSignature?: VerifyCatalogIssuerSignatureV1;
}>): Promise<readonly VerifiedAppliedCatalogBucketV1[] | null> {
  const appliedHead = input.inventory.readAppliedCatalogHeadV1(
    computeAuthorCatalogScopeDigestV1(input.scope),
    input.scope.authorAddress,
  );
  if (appliedHead === null) return null;
  const verifyIssuerSignature = input.verifyIssuerSignature ?? verifyControlEnvelopeIssuerSignatureV1;
  const storedHead = await readValidatedAppliedHeadV1({
    controlObjects: input.controlObjects,
    appliedHead,
    verifyIssuerSignature,
  });
  return readAppliedCatalogBucketsV1(
    input.controlObjects,
    storedHead,
    input.scope,
    verifyIssuerSignature,
    input.bucketIds,
  );
}

/**
 * GH#3134 — read buckets of a staged catalog head, each through its verified root-to-leaf directory
 * path, with every row's authorship checked. `bucketIds` names the buckets to read; without it every
 * non-empty bucket is read and their rows must add up to the head's `totalRows`.
 */
export async function readAppliedCatalogBucketsV1(
  controlObjects: Pick<Rfc64ControlObjectOperationsV1, 'getVerifiedObjectByDigest'>,
  storedHead: StoredVerifiedControlObjectV1,
  trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
  verifyIssuerSignature: VerifyCatalogIssuerSignatureV1,
  bucketIds?: readonly DecimalU64V1[],
): Promise<readonly VerifiedAppliedCatalogBucketV1[]> {
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
  const nodes = new Map<string, StoredDirectoryNodeV1>();
  const readNode = async (objectDigest: Digest32V1): Promise<StoredDirectoryNodeV1> => {
    const known = nodes.get(objectDigest);
    if (known !== undefined) return known;
    const stored = await controlObjects.getVerifiedObjectByDigest({ objectDigest, verifyIssuerSignature });
    if (stored === null) throw new Error('catalog directory node is not staged');
    assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(stored.envelope, head.payload.bucketCount);
    assertAuthorCatalogDirectoryNodeScopeBindingV1(stored.envelope.payload, trustedCatalogScope);
    if (stored.envelope.objectDigest !== objectDigest || stored.envelope.issuer !== head.issuer) {
      throw new Error('catalog directory identity or issuer differs from its head');
    }
    nodes.set(objectDigest, stored as StoredDirectoryNodeV1);
    return stored as StoredDirectoryNodeV1;
  };
  const selected = bucketIds ?? await nonEmptyBucketIdsV1(head.payload.directoryRootDigest, readNode);
  const buckets: VerifiedAppliedCatalogBucketV1[] = [];
  let totalRows = 0n;
  for (const bucketId of selected) {
    const path = await directoryPathToBucketV1(head, bucketId, readNode);
    const directoryPathProof = verifyAuthorCatalogDirectoryPathV1(
      head,
      path.map((node) => node.envelope),
      bucketId,
    );
    const descriptor = readVerifiedAuthorCatalogBucketDescriptorV1(directoryPathProof, head);
    if (descriptor.bucketDigest === ZERO_DIGEST32_V1) {
      if (descriptor.byteLength !== '0' || descriptor.rowCount !== '0') {
        throw new Error('empty catalog descriptor is not canonical');
      }
      buckets.push(Object.freeze({ bucketId, descriptor, rows: Object.freeze([]) }));
      continue;
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
    const authorships = verifyAuthorCatalogBucketRowAuthorshipsV1({
      catalogIssuerDelegation: storedDelegation.envelope,
      catalogIssuerDelegationSignature: storedDelegation.issuerSignature,
      parentAuthorAgentEvidence: null,
      catalogHead: head,
      catalogHeadSignature: storedHead.issuerSignature,
      directoryPathEnvelopes: path.map((node) => node.envelope),
      directoryPathSignatures: path.map((node) => node.issuerSignature),
      directoryPathProof,
      catalogBucket: bucket,
      catalogBucketSignature: storedBucket.issuerSignature,
    });
    totalRows += BigInt(descriptor.rowCount);
    buckets.push(Object.freeze({
      bucketId,
      descriptor,
      rows: Object.freeze(authorships.map((authorship) => (
        readVerifiedAuthorCatalogRowAuthorshipV1(authorship).row
      ))),
    }));
    // A bucket's authorship check is up to 1,024 rows of CPU work.
    await yieldMainThread();
  }
  if (bucketIds === undefined && totalRows.toString() !== head.payload.totalRows) {
    throw new Error('catalog directory row count differs from its head');
  }
  return Object.freeze(buckets);
}

type StoredDirectoryNodeV1 = StoredVerifiedControlObjectV1 & {
  readonly envelope: SignedAuthorCatalogDirectoryNodeEnvelopeV1;
};

/** Every bucket with rows, in bucket order; bucket 0 of an empty catalog, so its root is checked. */
async function nonEmptyBucketIdsV1(
  rootDigest: Digest32V1,
  readNode: (objectDigest: Digest32V1) => Promise<StoredDirectoryNodeV1>,
): Promise<DecimalU64V1[]> {
  const bucketIds: DecimalU64V1[] = [];
  const visit = async (objectDigest: Digest32V1): Promise<void> => {
    const node = (await readNode(objectDigest)).envelope.payload;
    for (const entry of node.entries) {
      if (entry.rowCount === '0') continue;
      if ('bucketId' in entry) bucketIds.push(entry.bucketId);
      else await visit(entry.childDigest);
    }
  };
  await visit(rootDigest);
  return bucketIds.length === 0 ? ['0' as DecimalU64V1] : bucketIds;
}

/** The root-to-leaf nodes over `bucketId`; the core's path verification checks them. */
async function directoryPathToBucketV1(
  head: SignedAuthorCatalogHeadEnvelopeV1,
  bucketId: DecimalU64V1,
  readNode: (objectDigest: Digest32V1) => Promise<StoredDirectoryNodeV1>,
): Promise<StoredDirectoryNodeV1[]> {
  const path: StoredDirectoryNodeV1[] = [];
  let node = await readNode(head.payload.directoryRootDigest);
  for (;;) {
    path.push(node);
    const { level, firstBucketId, entries } = node.envelope.payload;
    if (level === '0' || path.length > Number(MAX_AUTHOR_CATALOG_DIRECTORY_HEIGHT_V1)) return path;
    const entry = entries[Number(
      (BigInt(bucketId) - BigInt(firstBucketId)) / AUTHOR_CATALOG_DIRECTORY_FANOUT_V1 ** BigInt(level),
    )];
    if (entry === undefined || !('childDigest' in entry)) {
      throw new Error('catalog directory has no child over the selected bucket');
    }
    node = await readNode(entry.childDigest);
  }
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
