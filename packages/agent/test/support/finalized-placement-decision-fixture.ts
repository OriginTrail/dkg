import { resolveFinalizedPlacementDecisionV1 } from '../../src/internal/finalized-placement-decision.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from '../../src/rfc64/finalized-private-placement-repair-store-v1.js';

/** Synthetic V1 owner fixtures have a pinned lane; real V2 tests use the agent's current policy. */
export function pinnedPrivatePlacementDecisionV1(repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>, active = true, unavailable?: Error) {
  if (repair.version !== 1) throw new Error('the pinned test lane requires a V1 marker');
  return resolveFinalizedPlacementDecisionV1(repair, () => {
    if (unavailable !== undefined) return { status: 'unavailable', error: unavailable };
    return active ? { status: 'active', lane: {
      kind: 'private' as const, acceptsFinalizedVmRepair: true, scopeBase: repair.inventoryScope,
    } } : { status: 'inactive' };
  });
}
