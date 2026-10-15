// SPDX-License-Identifier: Apache-2.0

import {
  assertSignedAuthorCatalogHeadEnvelopeV1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  catalogKeyToBucketIdV1,
  computeAuthorCatalogScopeDigestV1,
  encodeOpaqueKaBundleV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type CountV1,
  type DecimalU64V1,
  type KaIdV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import type { Rfc64CatalogSuccessorAssetInputV1 } from '../dkg-agent-rfc64-catalog.js';
import {
  readAppliedCatalogBucketIdsWithRowsV1,
  readAppliedCatalogBucketsV1,
} from '../rfc64/applied-catalog-authority-transition-v1.js';
import type { AppliedCatalogHeadSnapshotV1 } from '../rfc64/inventory-v1/index.js';
import type { Rfc64PersistenceV1 } from '../rfc64/persistence-v1.js';
import { MAX_AUTHOR_CATALOG_ROWS_V1 } from './author-catalog-capacity.js';
import type { Rfc64CatalogMutationStateV1 } from './catalog-mutation-memory.js';
import {
  assertReplacementHistoryIsContiguousV1,
  planNextRfc64CatalogExactSetV1,
  planRfc64CatalogProjectionTargetV1,
  sameRfc64SuccessorAssetSetsV1,
  type Rfc64CatalogProjectionTargetPolicyV1,
} from './catalog-exact-set-plan.js';

/** What reconciling one catalog of more than one bucket reads and writes, bucket by bucket. */
export interface CatalogBucketReconciliationV1 {
  readonly bucketCount: CountV1;
  /** The target, in KA order. */
  readonly requested: readonly Rfc64CatalogSuccessorAssetInputV1[];
  readonly policy: Rfc64CatalogProjectionTargetPolicyV1;
  /** The buckets of the applied head that hold rows, from its directory. */
  readonly bucketsWithRows: readonly DecimalU64V1[];
  /** A bucket's signed rows, without their bundles. */
  readonly readBucketRows: (bucketId: DecimalU64V1) => Promise<readonly AuthorCatalogRowV1[]>;
  /** A bucket's verified state, bundles and all. */
  readonly readBucketState: (bucketId: DecimalU64V1) => Promise<Rfc64CatalogMutationStateV1>;
  /** One successor of the bucket `state` is about; the state after it. */
  readonly applySuccessor: (
    state: Rfc64CatalogMutationStateV1,
    assets: readonly Rfc64CatalogSuccessorAssetInputV1[],
  ) => Promise<Readonly<{ next: Rfc64CatalogMutationStateV1; sourceCurrent: boolean }>>;
  /** The most successors one reconciliation applies. */
  readonly successorLimit: number;
  readonly throwIfAborted: () => void;
}

export interface CatalogBucketReconciliationResultV1 {
  readonly successorsApplied: number;
  /** The state after the last successor, or null when nothing was signed. */
  readonly last: Rfc64CatalogMutationStateV1 | null;
  readonly sourceCurrent: boolean;
}

/**
 * GH#3134 — reconcile a catalog of more than one bucket with a complete target, bucket by bucket.
 * The target is split by the bucket each asset belongs to; a bucket whose signed rows already place
 * exactly its part of the target is left alone without reading a bundle. Every other bucket is read
 * with its bundles and brought to its part through one-KA successors, as a one-bucket catalog is.
 * With an exact replacement, a bucket that holds rows and none of the target loses them; with a
 * monotonic union, rows the target does not name stay.
 */
export async function reconcileCatalogBucketsV1(
  input: CatalogBucketReconciliationV1,
): Promise<CatalogBucketReconciliationResultV1> {
  const requested = groupCatalogAssetsByBucketV1(input.requested, input.bucketCount);
  const bucketIds = new Set<string>(requested.keys());
  if (input.policy === 'exact-replacement') {
    for (const bucketId of input.bucketsWithRows) bucketIds.add(bucketId);
  }
  let successorsApplied = 0;
  let last: Rfc64CatalogMutationStateV1 | null = null;
  for (const bucketId of [...bucketIds].sort(compareBucketIdsV1) as DecimalU64V1[]) {
    input.throwIfAborted();
    const part = requested.get(bucketId) ?? [];
    const rows = await input.readBucketRows(bucketId);
    const placed = input.policy === 'exact-replacement'
      ? bucketRowsPlaceAssetsV1(rows, part)
      : bucketRowsHoldAssetsV1(rows, part);
    if (placed) continue;
    let state = await input.readBucketState(bucketId);
    const target = planRfc64CatalogProjectionTargetV1(state.assets, part, input.policy);
    assertReplacementHistoryIsContiguousV1(state.assets, target);
    while (!sameRfc64SuccessorAssetSetsV1(state.assets, target)) {
      input.throwIfAborted();
      if (successorsApplied >= input.successorLimit) {
        throw new Error('RFC-64 exact-set reconciliation exceeded its bounded successor limit');
      }
      const committed = await input.applySuccessor(state, planNextRfc64CatalogExactSetV1(state.assets, target));
      successorsApplied += 1;
      state = committed.next;
      last = state;
      if (!committed.sourceCurrent) return Object.freeze({ successorsApplied, last, sourceCurrent: false });
    }
  }
  return Object.freeze({ successorsApplied, last, sourceCurrent: true });
}

/**
 * {@link reconcileCatalogBucketsV1} on the applied head of `scope`, a catalog of more than one
 * bucket: its buckets that hold rows from its directory, their rows from that head. A successor
 * changes only the bucket being reconciled, so every bucket not yet visited is still that head's.
 */
export async function reconcileMovedCatalogV1(input: Readonly<{
  persistence: Rfc64PersistenceV1;
  scope: Readonly<AuthorCatalogScopeV1>;
  requested: readonly Rfc64CatalogSuccessorAssetInputV1[];
  policy: CatalogBucketReconciliationV1['policy'];
  readBucketState: CatalogBucketReconciliationV1['readBucketState'];
  applySuccessor: CatalogBucketReconciliationV1['applySuccessor'];
  throwIfAborted: () => void;
}>): Promise<Readonly<{
  status: 'existing' | 'advanced';
  appliedHead: AppliedCatalogHeadSnapshotV1;
  successorsApplied: number;
  targetAssetCount: number;
  sourceCurrent: boolean;
}>> {
  const { persistence, scope } = input;
  const verify = verifyControlEnvelopeIssuerSignatureV1;
  const applied = persistence.inventory.readAppliedCatalogHeadV1(
    computeAuthorCatalogScopeDigestV1(scope),
    scope.authorAddress,
  );
  if (applied === null) throw new Error('RFC-64 moved author catalog has no applied head');
  const storedHead = await persistence.controlObjects.getVerifiedObjectByDigest({
    objectDigest: applied.currentCatalogHeadDigest,
    verifyIssuerSignature: verify,
  });
  if (storedHead === null) throw new Error('RFC-64 applied author head is not durably staged');
  assertSignedAuthorCatalogHeadEnvelopeV1(storedHead.envelope);
  const result = await reconcileCatalogBucketsV1({
    bucketCount: scope.bucketCount,
    requested: input.requested,
    policy: input.policy,
    bucketsWithRows: await readAppliedCatalogBucketIdsWithRowsV1(
      persistence.controlObjects,
      storedHead.envelope,
      scope,
      verify,
    ),
    readBucketRows: async (bucketId) => (await readAppliedCatalogBucketsV1(
      persistence.controlObjects,
      storedHead,
      scope,
      verify,
      [bucketId],
    ))[0]!.rows,
    readBucketState: input.readBucketState,
    applySuccessor: input.applySuccessor,
    successorLimit: 2 * MAX_AUTHOR_CATALOG_ROWS_V1,
    throwIfAborted: input.throwIfAborted,
  });
  const appliedHead = result.last?.current ?? applied;
  return Object.freeze({
    status: result.successorsApplied === 0 ? 'existing' as const : 'advanced' as const,
    appliedHead,
    successorsApplied: result.successorsApplied,
    targetAssetCount: input.policy === 'exact-replacement'
      ? input.requested.length
      : Number(appliedHead.inventoryRowCount),
    sourceCurrent: result.sourceCurrent,
  });
}

/** `assets` (in KA order) by the bucket each belongs to at `bucketCount`, each part in KA order. */
export function groupCatalogAssetsByBucketV1(
  assets: readonly Rfc64CatalogSuccessorAssetInputV1[],
  bucketCount: CountV1,
): Map<string, Rfc64CatalogSuccessorAssetInputV1[]> {
  const groups = new Map<string, Rfc64CatalogSuccessorAssetInputV1[]>();
  for (const asset of assets) {
    const bucketId = catalogKeyToBucketIdV1(asset.seal.reservedKaId as KaIdV1, bucketCount);
    const group = groups.get(bucketId);
    if (group === undefined) groups.set(bucketId, [asset]);
    else group.push(asset);
  }
  return groups;
}

/**
 * Whether a bucket's signed rows (in KA order) place exactly `assets` (in KA order): the same KAs
 * on the same coordinates with the same bundles. The bundle digest covers the projection and the
 * seal, which names the KA and its version, so the same digest is the same row.
 */
export function bucketRowsPlaceAssetsV1(
  rows: readonly Pick<AuthorCatalogRowV1, 'kaId' | 'assertionCoordinate' | 'transfer'>[],
  assets: readonly Rfc64CatalogSuccessorAssetInputV1[],
): boolean {
  return rows.length === assets.length && assets.every((asset, index) => {
    const row = rows[index]!;
    return row.kaId === asset.seal.reservedKaId
      && row.assertionCoordinate === asset.assertionCoordinate
      && row.transfer.blobDigest === encodeOpaqueKaBundleV1(
        asset.projectionBytes,
        canonicalizeCanonicalGraphScopedAuthorSealBytesV1(asset.seal),
      ).blobDigest;
  });
}

/** Whether a bucket's signed rows place every one of `assets` as it is, whatever else they hold. */
export function bucketRowsHoldAssetsV1(
  rows: readonly Pick<AuthorCatalogRowV1, 'kaId' | 'assertionCoordinate' | 'transfer'>[],
  assets: readonly Rfc64CatalogSuccessorAssetInputV1[],
): boolean {
  const byKaId = new Map(rows.map((row) => [row.kaId, row]));
  return assets.every((asset) => {
    const row = byKaId.get(asset.seal.reservedKaId as KaIdV1);
    return row !== undefined && bucketRowsPlaceAssetsV1([row], [asset]);
  });
}

function compareBucketIdsV1(left: string, right: string): number {
  const difference = BigInt(left) - BigInt(right);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
