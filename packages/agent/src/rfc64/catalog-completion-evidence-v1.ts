// SPDX-License-Identifier: Apache-2.0

import type { Digest32V1 } from '@origintrail-official/dkg-core';
import type { Rfc64OperationalAppliedHeadV1 } from './catalog-operational-applied-heads-v1.js';
import { rfc64CatalogTargetScopeKeyV1 } from './catalog-operational-applied-heads-v1.js';
import { aggregateRfc64DigestV1, projectRfc64OperationalRowCountsV1, rfc64CatalogTargetExactIdentityKeyV1, sumDecimalCountsV1 } from './catalog-operational-targets-v1.js';
import type { Rfc64CatalogReplayRecoveryStatusV1 } from './catalog-replay-recovery-runtime-v1.js';
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from './public-catalog-transport-v1.js';

/** Per-graph facts shared by operator projection and strict readiness. */
export interface Rfc64CatalogCompletionFactsV1 {
  readonly heads: readonly Readonly<Rfc64OperationalAppliedHeadV1>[];
  readonly targets: readonly Rfc64PublicCatalogHeadAnnouncementV1[];
  readonly promisedTargets: readonly Rfc64PublicCatalogHeadAnnouncementV1[] | null;
  readonly promisedRowCounts: ReadonlyMap<string, string | null>;
  readonly replay: Readonly<Rfc64CatalogReplayRecoveryStatusV1> | null;
  readonly replaySnapshotUnstable?: boolean;
  readonly targetCapacityExceeded: boolean;
  readonly localCuratedOwnerHeads?: boolean;
}

export interface Rfc64CatalogCompletionEvidenceV1 {
  readonly replayActive: boolean;
  readonly replayFailed: boolean;
  readonly replayUnverified: boolean;
  readonly replayUnsettled: boolean;
  readonly pendingTargets: readonly Rfc64PublicCatalogHeadAnnouncementV1[];
  readonly catalogHeadDigest: Digest32V1 | null;
  readonly expectedCatalogHeadDigest: Digest32V1 | null;
  readonly inventoryDigest: Digest32V1 | null;
  readonly rowCount: string | null;
  readonly rowProjection: Readonly<{ expectedRowCount: string | null; missingRowCount: string | null }>;
  readonly corroborated: boolean;
}

/**
 * A diagnostic can describe retained heads without proving that recovery
 * finished. `corroborated` additionally requires a provider's settled promise
 * set. Restart, an empty peer walk and local authority acceptance cannot supply it.
 */
export function evaluateRfc64CatalogCompletionV1(input: Rfc64CatalogCompletionFactsV1): Rfc64CatalogCompletionEvidenceV1 {
  const { heads, targets, promisedTargets, promisedRowCounts, replay, targetCapacityExceeded } = input;
  const replayActive = input.replaySnapshotUnstable === true || replay?.active === true;
  const replayFailed = replay?.failed === true;
  const replayUnverified = replay?.unverified === true && heads.length > 0
    && input.localCuratedOwnerHeads !== true;
  const replayUnsettled = replayActive || replayFailed || replayUnverified;
  const authoritativeTargets = [...new Map([
    ...targets, ...promisedTargets ?? [],
  ].map((target) => [rfc64CatalogTargetExactIdentityKeyV1(target), target])).values()];
  const appliedByScope = new Map(heads.map((head) => [head.scopeKey, head]));
  const isPending = (target: Rfc64PublicCatalogHeadAnnouncementV1) => {
    const applied = appliedByScope.get(rfc64CatalogTargetScopeKeyV1(target));
    return applied === undefined || BigInt(target.catalogVersion) > BigInt(applied.snapshot.catalogVersion)
      || (target.catalogVersion === applied.snapshot.catalogVersion
        && target.catalogHeadObjectDigest !== applied.snapshot.currentCatalogHeadDigest);
  };
  const pendingTargets = targets.filter(isPending);
  const catalogHeadDigest = aggregateRfc64DigestV1(heads.map(({ snapshot }) => snapshot.currentCatalogHeadDigest));
  const expectedHeadDigests = new Map(heads.map(({ scopeKey, snapshot }) => [scopeKey, snapshot.currentCatalogHeadDigest]));
  for (const target of pendingTargets) expectedHeadDigests.set(rfc64CatalogTargetScopeKeyV1(target), target.catalogHeadObjectDigest);
  const expectedCatalogHeadDigest = aggregateRfc64DigestV1([...expectedHeadDigests.values()]);
  const inventoryDigest = aggregateRfc64DigestV1(heads.map(({ snapshot }) => snapshot.appliedInventoryDigest));
  const rowCount = heads.length === 0 ? null : sumDecimalCountsV1(heads.map(({ snapshot }) => snapshot.inventoryRowCount));
  const rowProjectionUnavailable = targetCapacityExceeded || replayActive || replayUnverified
    || (replayFailed && promisedTargets === null);
  const rowProjection = rowProjectionUnavailable
    ? Object.freeze({ expectedRowCount: null, missingRowCount: null })
    : projectRfc64OperationalRowCountsV1(heads, authoritativeTargets, promisedRowCounts);
  const corroborated = replay !== null && !replayUnsettled && !targetCapacityExceeded
    && promisedTargets !== null && promisedTargets.length > 0
    && !authoritativeTargets.some(isPending)
    && rowCount !== null && BigInt(rowCount) > 0n
    && rowProjection.missingRowCount === '0' && rowProjection.expectedRowCount === rowCount;
  return Object.freeze({
    replayActive, replayFailed, replayUnverified, replayUnsettled, pendingTargets,
    catalogHeadDigest, expectedCatalogHeadDigest, inventoryDigest, rowCount, rowProjection, corroborated,
  });
}
