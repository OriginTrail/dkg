// SPDX-License-Identifier: Apache-2.0

import {
  computeSwmAuthorInventoryScopeDigestV1,
  type AuthorCatalogScopeV1,
  type SwmAuthorInventoryScopeV1,
} from '@origintrail-official/dkg-core';
import type { CatalogRepairRevisionHintV1 } from '../rfc64/catalog-repair-retry-v1.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from '../rfc64/finalized-private-placement-repair-store-v1.js';

interface PlacementLaneV1 {
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

/** The same decision is re-read at admission, execution, retry and capacity parking. */
export function resolveFinalizedPlacementDecisionV1<Lane extends PlacementLaneV1>(
  repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
  readLane: () => Lane | null,
): FinalizedPlacementDecisionV1<Lane> {
  // V1 capacity remains pinned even while its lane is temporarily unavailable.
  const pinnedCapacityScope = repair.version === 1
    ? Object.freeze({ ...repair.inventoryScope, bucketCount: '1' }) as AuthorCatalogScopeV1 : undefined;
  try {
    const lane = readLane();
    if (lane === null || (!lane.acceptsFinalizedVmRepair && (repair.version === 1 || lane.kind !== 'public'))) {
      return Object.freeze({ status: 'inactive', capacityScope: pinnedCapacityScope });
    }
    const currentInventoryScope = Object.freeze({ ...lane.scopeBase, authorAddress: repair.authorAddress });
    if (repair.version === 1 && computeSwmAuthorInventoryScopeDigestV1(currentInventoryScope)
      !== computeSwmAuthorInventoryScopeDigestV1(repair.inventoryScope)) {
      throw new Error('RFC-64 finalized-private placement repair conflicts with a policy transition');
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

/** Scope changes wake a repair; unrelated inventory edits do not reset its backoff. */
export function finalizedPlacementRevisionV1(decision: FinalizedPlacementDecisionV1): CatalogRepairRevisionHintV1 | null | undefined {
  if (decision.status === 'unavailable') return undefined;
  return decision.status === 'ready' ? {
    scopeIdentity: JSON.stringify([decision.action, computeSwmAuthorInventoryScopeDigestV1(decision.inventoryScope)]), headRevision: 'active',
  } : null;
}
