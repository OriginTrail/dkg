import { CatalogRepairConditionErrorV1 } from '../rfc64/catalog-repair-diagnostics-v1.js';
// SPDX-License-Identifier: Apache-2.0

import {
  computeSwmAuthorInventoryScopeDigestV1,
  type AuthorCatalogScopeV1,
  type SwmAuthorInventoryScopeV1,
} from '@origintrail-official/dkg-core';
import type { CatalogRepairRevisionHintV1 } from '../rfc64/catalog-repair-retry-v1.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from '../rfc64/finalized-private-placement-repair-store-v1.js';
import type { Rfc64CatalogAuthoringLaneDecisionV1 } from '../dkg-agent-rfc64-swm-catalog-projection.js';

export interface PlacementLaneV1 {
  readonly kind: 'private' | 'public';
  readonly acceptsFinalizedVmRepair: boolean;
  readonly scopeBase: Readonly<Omit<SwmAuthorInventoryScopeV1, 'authorAddress'>>;
}

/** Current authority owns V2 scope; a V1 marker remains pinned to its original scope. */
export type FinalizedPlacementDecisionV1<Lane = unknown> =
  | Readonly<{ status: 'inactive'; capacityScope: Readonly<AuthorCatalogScopeV1> | undefined }>
  | Readonly<{ status: 'unavailable'; error: Error; capacityScope: Readonly<AuthorCatalogScopeV1> | undefined }>
  | Readonly<{
    status: 'ready';
    lane: Lane;
    currentInventoryScope: Readonly<SwmAuthorInventoryScopeV1>;
    inventoryScope: Readonly<SwmAuthorInventoryScopeV1>;
    scope: Readonly<AuthorCatalogScopeV1>;
  } & ({ action: 'place-private-row'; capacityScope: Readonly<AuthorCatalogScopeV1> }
    | { action: 'retire-public-row'; capacityScope: undefined })>;

/** Admission and retries retain this decision for capacity parking; execution re-reads authority. */
export function resolveFinalizedPlacementDecisionV1<Lane extends PlacementLaneV1>(
  repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
  readLane: () => Rfc64CatalogAuthoringLaneDecisionV1<Lane>,
): FinalizedPlacementDecisionV1<Lane> {
  // V1 capacity remains pinned even while its lane is temporarily unavailable.
  const pinnedCapacityScope = repair.version === 1
    ? Object.freeze({ ...repair.inventoryScope, bucketCount: '1' }) as AuthorCatalogScopeV1 : undefined;
  try {
    const decision = readLane();
    if (decision.status === 'unavailable') {
      return Object.freeze({ ...decision, capacityScope: pinnedCapacityScope });
    }
    if (decision.status === 'inactive') {
      return Object.freeze({ ...decision, capacityScope: pinnedCapacityScope });
    }
    const { lane } = decision;
    if (!lane.acceptsFinalizedVmRepair && (repair.version === 1 || lane.kind !== 'public')) {
      return Object.freeze({ status: 'inactive', capacityScope: pinnedCapacityScope });
    }
    const currentInventoryScope = Object.freeze({ ...lane.scopeBase, authorAddress: repair.authorAddress });
    if (repair.version === 1 && computeSwmAuthorInventoryScopeDigestV1(currentInventoryScope)
      !== computeSwmAuthorInventoryScopeDigestV1(repair.inventoryScope)) {
      return Object.freeze({
        status: 'unavailable', capacityScope: pinnedCapacityScope,
        error: new CatalogRepairConditionErrorV1('policy_conflict', 'RFC-64 finalized-private placement repair conflicts with a policy transition'),
      });
    }
    const inventoryScope = repair.version === 1 ? repair.inventoryScope : currentInventoryScope;
    const scope = Object.freeze({ ...inventoryScope, bucketCount: '1' }) as AuthorCatalogScopeV1;
    const common = { status: 'ready' as const, lane, currentInventoryScope, inventoryScope, scope };
    return lane.acceptsFinalizedVmRepair
      ? Object.freeze({ ...common, action: 'place-private-row', capacityScope: scope })
      : Object.freeze({ ...common, action: 'retire-public-row', capacityScope: undefined });
  } catch (error) {
    return Object.freeze({ status: 'unavailable', error: error instanceof Error ? error : new Error(String(error)), capacityScope: pinnedCapacityScope });
  }
}

/** A graph transition is independent of any marker's pinned compatibility. */
export type FinalizedPlacementAuthorityV1<Lane extends PlacementLaneV1 = PlacementLaneV1> = Rfc64CatalogAuthoringLaneDecisionV1<Lane>;
export function readFinalizedPlacementAuthorityV1(read: () => FinalizedPlacementAuthorityV1): FinalizedPlacementAuthorityV1 {
  try { return read(); }
  catch (error) { return { status: 'unavailable', error: error instanceof Error ? error : new Error(String(error)) }; }
}
export function finalizedPlacementAuthorityRevisionV1(authority: FinalizedPlacementAuthorityV1): CatalogRepairRevisionHintV1 | null | undefined {
  if (authority.status === 'unavailable') return undefined;
  if (authority.status === 'inactive') return null;
  const { lane } = authority;
  const scope = lane.scopeBase;
  return { scopeIdentity: JSON.stringify([lane.kind, lane.acceptsFinalizedVmRepair,
    scope.networkId, scope.contextGraphId, scope.governanceChainId, scope.governanceContractAddress,
    scope.ownershipTransitionDigest, scope.subGraphName, scope.era]), headRevision: 'active' };
}
