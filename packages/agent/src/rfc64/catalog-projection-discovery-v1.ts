import type { MutableAuthorRepairStatusV1 } from '../dkg-agent-rfc64-swm-catalog-projection-supervisor.js';
import { CatalogRepairRetryV1 } from './catalog-repair-retry-v1.js';
import type { ContextGraphIdV1, EvmAddressV1 } from '@origintrail-official/dkg-core';

type Scope = Readonly<{ contextGraphId: ContextGraphIdV1; authorAddress: EvmAddressV1 }>;

/** Discover only ownership hints; the projection attempt still checks current authority. */
export function discoverDurableCatalogRepairsV1<T extends Scope>(
  listScopes: () => readonly Scope[], repairs: T[], createRepair: (cg: ContextGraphIdV1, author: EvmAddressV1) => T,
  onError: (error: unknown) => void,
): boolean {
  try {
    const scopes = listScopes();
    const keys = new Set(repairs.map(repair => `${repair.contextGraphId}\n${repair.authorAddress}`));
    for (const { contextGraphId, authorAddress } of scopes) {
      const key = `${contextGraphId}\n${authorAddress}`;
      if (keys.has(key)) continue;
      keys.add(key);
      repairs.push(createRepair(contextGraphId, authorAddress));
    }
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

export function newPendingRepairV1(
  contextGraphId: ContextGraphIdV1,
  authorAddress: EvmAddressV1,
): MutableAuthorRepairStatusV1 {
  return {
    contextGraphId,
    authorAddress,
    outcome: 'pending',
    attempts: 0,
    inventoryHeadObjectDigest: null,
    catalogVersion: null,
    inventoryRowCount: null,
    lastError: null,
    updatedAtMs: null,
    dirty: true,
    pendingMutationRequest: false,
    diagnostic: null,
    retry: new CatalogRepairRetryV1(),
  };
}

