// SPDX-License-Identifier: Apache-2.0

import {
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  assertAuthorCatalogHeadScopeBindingV1,
  assertAuthorCatalogScopeV1,
  catalogKeyDigestToBucketIdV1,
  compareAuthorCatalogKaIdsV1,
  computeAuthorCatalogDirectoryHeightV1,
  computeAuthorCatalogKeyDigestV1,
  computeAuthorCatalogScopeDigestV1,
  deriveAuthorCatalogScopeFromHeadV1,
  readVerifiedAuthorCatalogBucketDescriptorV1,
  verifyAuthorCatalogDirectoryPathV1,
  type AuthorCatalogBucketDescriptorV1,
  type AuthorCatalogDirectoryEntryV1,
  type AuthorCatalogHeadV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type CountV1,
  type DecimalU64V1,
  type Digest32V1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedControlEnvelopeV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';

import { yieldMainThread } from '../main-thread-time-slice.js';
import {
  assertEip191Issuer,
  childDescriptor,
  fail,
  freezePlainSnapshot,
  normalizePublicError,
  prepareReplacementBucket,
  signDirectoryNode,
  signHead,
  signPreparedReplacementBucket,
  snapshotHead,
  snapshotRows,
  snapshotSigner,
  verifyExistingSignature,
} from './author-catalog-production-steps-v1.js';
import type { Rfc64AuthorCatalogEip191SignerV1 } from './author-catalog-producer.js';

/**
 * GH#3134 — an author catalog that has outgrown its bucket count moves to a larger one.
 *
 * The bucket count is part of the catalog scope, so this is not an ordinary successor in the same
 * scope: it is the first head of the scope with the larger count. It keeps the author lane of its
 * predecessor, has `version` one above it and `previousHeadDigest` naming it, and holds every row
 * of the catalog, spread over the new buckets by {@link catalogKeyDigestToBucketIdV1}. A receiver
 * that applied the predecessor can tell that this head replaces it and check that no row is lost.
 *
 * {@link produceAuthorCatalogInOneStepV1} builds a catalog of any size the same way without a
 * predecessor (`version` 0): an offline fixture for large catalogs, never announced.
 */

/** A bucket is filled to at most this many rows when a catalog moves to a larger bucket count. */
export const AUTHOR_CATALOG_TRANSITION_FILL_ROWS_V1 = MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 / 2;
/** The largest bucket count chosen automatically: a directory of height 1, 33 million rows at the fill. */
export const MAX_AUTHOR_CATALOG_CHOSEN_BUCKET_COUNT_V1 = 65_536n;

export interface ProduceAuthorCatalogCapacityTransitionInputV1 {
  /** The last head of the catalog being replaced. */
  readonly previousHead: SignedAuthorCatalogHeadEnvelopeV1;
  /** A power of two above the bucket count of `previousHead`. */
  readonly bucketCount: CountV1;
  /** Every live row of the catalog: those of `previousHead` and any that did not fit there. */
  readonly rows: readonly AuthorCatalogRowV1[];
  readonly issuedAt: TimestampMsV1;
  readonly signer: Rfc64AuthorCatalogEip191SignerV1;
}

export interface ProduceAuthorCatalogInOneStepInputV1 {
  readonly scope: AuthorCatalogScopeV1;
  readonly catalogIssuerDelegationDigest: Digest32V1;
  readonly rows: readonly AuthorCatalogRowV1[];
  readonly issuedAt: TimestampMsV1;
  readonly signer: Rfc64AuthorCatalogEip191SignerV1;
}

export interface ProducedAuthorCatalogV1 {
  readonly head: SignedAuthorCatalogHeadEnvelopeV1;
  /** Every directory node: the root first, then each lower level in bucket order. */
  readonly directoryNodes: readonly SignedAuthorCatalogDirectoryNodeEnvelopeV1[];
  /** The non-empty buckets, in bucket order. */
  readonly buckets: readonly SignedAuthorCatalogBucketEnvelopeV1[];
  /** Immutable objects in staging order: buckets, directory nodes from the leaves up, the head. */
  readonly stagedObjects: readonly SignedControlEnvelopeV1[];
}

/**
 * The smallest bucket count above `current` at which no bucket holds more than
 * {@link AUTHOR_CATALOG_TRANSITION_FILL_ROWS_V1} of `rows`, so that the next move is far away.
 */
export function chooseAuthorCatalogBucketCountV1(
  rows: readonly Pick<AuthorCatalogRowV1, 'kaId'>[],
  current: CountV1,
): CountV1 {
  const keys = rows.map(({ kaId }) => computeAuthorCatalogKeyDigestV1(kaId));
  for (let count = BigInt(current) * 2n; count <= MAX_AUTHOR_CATALOG_CHOSEN_BUCKET_COUNT_V1; count *= 2n) {
    const loads = new Map<string, number>();
    let fullest = 0;
    for (const key of keys) {
      const bucketId = catalogKeyDigestToBucketIdV1(key, count.toString() as CountV1);
      const load = (loads.get(bucketId) ?? 0) + 1;
      loads.set(bucketId, load);
      if (load > fullest) fullest = load;
    }
    if (fullest <= AUTHOR_CATALOG_TRANSITION_FILL_ROWS_V1) return count.toString() as CountV1;
  }
  fail('catalog-production-input', `no bucket count up to ${MAX_AUTHOR_CATALOG_CHOSEN_BUCKET_COUNT_V1} fits ${rows.length} rows`);
}

export async function produceAuthorCatalogCapacityTransitionV1(
  input: ProduceAuthorCatalogCapacityTransitionInputV1,
): Promise<ProducedAuthorCatalogV1> {
  try {
    const signer = snapshotSigner(input.signer);
    const previousHead = snapshotHead(input.previousHead);
    assertEip191Issuer(previousHead, signer.issuer, 'previous head');
    await verifyExistingSignature(previousHead, 'previous head');
    const previousScope = deriveAuthorCatalogScopeFromHeadV1(previousHead.payload);
    const scope = { ...previousScope, bucketCount: input.bucketCount } as AuthorCatalogScopeV1;
    try {
      assertAuthorCatalogScopeV1(scope);
    } catch (cause) {
      fail('catalog-production-input', 'the new bucket count is not a power of two in range', cause);
    }
    if (BigInt(scope.bucketCount) <= BigInt(previousScope.bucketCount)) {
      fail('catalog-production-history', 'a capacity transition must move to a larger bucket count');
    }
    const rows = catalogRowsInput(input.rows);
    if (BigInt(rows.length) < BigInt(previousHead.payload.totalRows)) {
      fail('catalog-production-delta', 'a capacity transition must not hold fewer rows than its predecessor');
    }
    const previousVersion = BigInt(previousHead.payload.version);
    return await produceCatalog({
      scope,
      catalogIssuerDelegationDigest: previousHead.payload.catalogIssuerDelegationDigest,
      version: (previousVersion + 1n).toString() as DecimalU64V1,
      previousHeadDigest: previousHead.objectDigest as Digest32V1,
      rows,
      issuedAt: input.issuedAt,
      signer,
    });
  } catch (cause) {
    normalizePublicError('author catalog capacity transition failed', cause);
  }
}

export async function produceAuthorCatalogInOneStepV1(
  input: ProduceAuthorCatalogInOneStepInputV1,
): Promise<ProducedAuthorCatalogV1> {
  try {
    const signer = snapshotSigner(input.signer);
    const scope = { ...input.scope } as AuthorCatalogScopeV1;
    try {
      assertAuthorCatalogScopeV1(scope);
    } catch (cause) {
      fail('catalog-production-input', 'catalog scope is not canonical', cause);
    }
    return await produceCatalog({
      scope,
      catalogIssuerDelegationDigest: input.catalogIssuerDelegationDigest,
      version: '0' as DecimalU64V1,
      previousHeadDigest: null,
      rows: catalogRowsInput(input.rows),
      issuedAt: input.issuedAt,
      signer,
    });
  } catch (cause) {
    normalizePublicError('author catalog production in one step failed', cause);
  }
}

interface CatalogProductionV1 {
  readonly scope: AuthorCatalogScopeV1;
  readonly catalogIssuerDelegationDigest: Digest32V1;
  readonly version: DecimalU64V1;
  readonly previousHeadDigest: Digest32V1 | null;
  readonly rows: readonly AuthorCatalogRowV1[];
  readonly issuedAt: TimestampMsV1;
  readonly signer: ReturnType<typeof snapshotSigner>;
}

const DIRECTORY_FANOUT = 256n;

async function produceCatalog(production: CatalogProductionV1): Promise<ProducedAuthorCatalogV1> {
  const { scope, signer } = production;
  const bucketCount = BigInt(scope.bucketCount);
  const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(scope);

  // Every row goes to the bucket its key digest names; each bucket is then snapshotted in KA order.
  const byBucket = new Map<bigint, AuthorCatalogRowV1[]>();
  const seen = new Set<string>();
  for (const row of production.rows) {
    let key: Digest32V1;
    try {
      key = computeAuthorCatalogKeyDigestV1(row.kaId);
    } catch (cause) {
      fail('catalog-production-input', 'a row does not name a canonical KA id', cause);
    }
    if (seen.has(row.kaId)) fail('catalog-production-input', `rows name KA ${row.kaId} twice`);
    seen.add(row.kaId);
    const bucketId = BigInt(catalogKeyDigestToBucketIdV1(key, scope.bucketCount));
    const rows = byBucket.get(bucketId);
    if (rows === undefined) byBucket.set(bucketId, [row]);
    else rows.push(row);
  }
  for (const [bucketId, rows] of byBucket) {
    if (rows.length > MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1) {
      fail(
        'catalog-production-input',
        `bucket ${bucketId} would hold ${rows.length} rows, above ${MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1}: choose a larger bucket count`,
      );
    }
    rows.sort((left, right) => compareAuthorCatalogKaIdsV1(left.kaId, right.kaId));
    byBucket.set(bucketId, snapshotRows(rows) as AuthorCatalogRowV1[]);
  }

  const descriptors: AuthorCatalogBucketDescriptorV1[] = [];
  const buckets: SignedAuthorCatalogBucketEnvelopeV1[] = [];
  for (let bucketId = 0n; bucketId < bucketCount; bucketId += 1n) {
    const prepared = prepareReplacementBucket(
      scope,
      bucketId.toString() as DecimalU64V1,
      byBucket.get(bucketId) ?? [],
      signer.issuer,
    );
    descriptors.push(prepared.descriptor);
    const signed = await signPreparedReplacementBucket(prepared, signer);
    if (signed !== null) buckets.push(signed);
    // Bucket encoding and signing are CPU work; let timers and I/O run between buckets.
    if (bucketId % 16n === 15n) await yieldMainThread();
  }

  // Level 0 covers the buckets, 256 to a node; each level above covers 256 nodes of the one below.
  const height = BigInt(computeAuthorCatalogDirectoryHeightV1(scope.bucketCount));
  const levels: SignedAuthorCatalogDirectoryNodeEnvelopeV1[][] = [];
  let entries: AuthorCatalogDirectoryEntryV1[] = descriptors;
  for (let level = 0n; level <= height; level += 1n) {
    const nodes: SignedAuthorCatalogDirectoryNodeEnvelopeV1[] = [];
    const span = directoryPower(level + 1n);
    for (let index = 0; index < entries.length; index += Number(DIRECTORY_FANOUT)) {
      nodes.push(await signDirectoryNode({
        catalogScopeDigest,
        entries: entries.slice(index, index + Number(DIRECTORY_FANOUT)),
        era: scope.era,
        firstBucketId: (BigInt(index / Number(DIRECTORY_FANOUT)) * span).toString() as DecimalU64V1,
        level: level.toString() as DecimalU64V1,
      }, scope.bucketCount, signer));
    }
    levels.push(nodes);
    entries = nodes.map((node) => childDescriptor(node, scope.bucketCount));
  }
  const root = levels[levels.length - 1]!;
  if (root.length !== 1) fail('catalog-production-path', 'the directory did not end in one root');

  const headPayload: AuthorCatalogHeadV1 = {
    networkId: scope.networkId,
    contextGraphId: scope.contextGraphId,
    governanceChainId: scope.governanceChainId,
    governanceContractAddress: scope.governanceContractAddress,
    ownershipTransitionDigest: scope.ownershipTransitionDigest,
    subGraphName: scope.subGraphName,
    authorAddress: scope.authorAddress,
    catalogIssuerDelegationDigest: production.catalogIssuerDelegationDigest,
    era: scope.era,
    version: production.version,
    previousHeadDigest: production.previousHeadDigest,
    bucketCount: scope.bucketCount,
    totalRows: production.rows.length.toString() as DecimalU64V1,
    directoryHeight: height.toString() as DecimalU64V1,
    directoryRootDigest: root[0]!.objectDigest as Digest32V1,
    issuedAt: production.issuedAt,
  };
  const head = await signHead(headPayload, signer);

  // Every non-empty bucket is reachable under the head by a verified root-to-leaf path.
  try {
    assertAuthorCatalogHeadScopeBindingV1(head.payload, scope);
    for (const bucket of buckets) {
      const bucketId = BigInt(bucket.payload.bucketId);
      const path = levels.map((nodes, level) => nodes[Number(bucketId / directoryPower(BigInt(level) + 1n))]!).reverse();
      const verified = verifyAuthorCatalogDirectoryPathV1(head, path, bucket.payload.bucketId);
      const descriptor = readVerifiedAuthorCatalogBucketDescriptorV1(verified, head);
      if (descriptor.bucketDigest !== bucket.objectDigest) {
        throw new Error(`bucket ${bucketId} is not the one its directory path names`);
      }
    }
  } catch (cause) {
    fail('catalog-production-path', 'produced catalog is not self-consistent', cause);
  }

  const directoryNodes = levels.slice().reverse().flat();
  return freezePlainSnapshot({
    head,
    directoryNodes,
    buckets,
    stagedObjects: [...buckets, ...levels.flat(), head],
  });
}

/** The rows of a whole catalog: an ordinary array, at most what the largest chosen bucket count holds. */
function catalogRowsInput(input: readonly AuthorCatalogRowV1[]): readonly AuthorCatalogRowV1[] {
  if (
    !Array.isArray(input)
    || input.length > Number(MAX_AUTHOR_CATALOG_CHOSEN_BUCKET_COUNT_V1) * MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1
  ) {
    fail('catalog-production-input', 'catalog rows must be an ordinary array within the chosen bucket bound');
  }
  return input;
}

function directoryPower(exponent: bigint): bigint {
  let result = 1n;
  for (let index = 0n; index < exponent; index += 1n) result *= DIRECTORY_FANOUT;
  return result;
}
