import { resolveFinalizedPlacementDecisionV1, type FinalizedPlacementAuthorityV1 } from '../../src/internal/finalized-placement-decision.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from '../../src/rfc64/finalized-private-placement-repair-store-v1.js';

/** Synthetic V1 fixtures use a graph authority with the same pinned scope. */
export function pinnedPrivatePlacementAuthorityV1(repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>, active = true, unavailable?: Error): FinalizedPlacementAuthorityV1 {
  if (repair.version !== 1) throw new Error('the pinned test lane requires a V1 marker');
  if (unavailable !== undefined) return { status: 'unavailable', error: unavailable };
  const { authorAddress: _author, ...scopeBase } = repair.inventoryScope;
  return active ? { status: 'active', lane: { kind: 'private', acceptsFinalizedVmRepair: true, scopeBase } } : { status: 'inactive' };
}
export function pinnedPrivatePlacementDecisionV1(repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>, active = true, unavailable?: Error) {
  return resolveFinalizedPlacementDecisionV1(repair, () => pinnedPrivatePlacementAuthorityV1(repair, active, unavailable));
}
