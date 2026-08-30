// SPDX-License-Identifier: Apache-2.0

import type { TripleStore } from '@origintrail-official/dkg-storage';

import type { ResolvedRfc64CatalogRolloutConfigV1 } from
  './catalog-rollout-authority-v1.js';
import type { Rfc64PersistenceV1 } from './persistence-v1.js';
import {
  deactivateRfc64AppliedCatalogAuthorityV1,
  readRfc64AppliedCatalogContextGraphIdV1,
} from './applied-catalog-authority-transition-v1.js';

/**
 * Reconcile resolved operator authority against durable applied inventory
 * before any network worker starts. Inventory is the sole durable truth: no
 * parallel authority sidecar can become stale or block startup independently.
 */
export async function reconcileRfc64CatalogAuthorityPlanV1(
  persistence: Rfc64PersistenceV1,
  store: TripleStore,
  activation: Readonly<{
    readonly enabled: boolean;
    readonly selectedContextGraphs: readonly string[];
    readonly rollout: ResolvedRfc64CatalogRolloutConfigV1;
  }>,
): Promise<void> {
  const nextCatalogSet = new Set(activation.selectedContextGraphs.filter(
    (contextGraphId) => activation.rollout.contextGraphModes[contextGraphId] === 'catalog',
  ));
  for (const appliedHead of persistence.inventory.listAppliedCatalogHeadsV1()) {
    const contextGraphId = await readRfc64AppliedCatalogContextGraphIdV1({
      controlObjects: persistence.controlObjects,
      appliedHead,
    });
    // Preserve the pre-activation standalone catalog API when no selected-CG
    // rollout block is enabled.
    if (!activation.enabled) nextCatalogSet.add(contextGraphId);
    if (nextCatalogSet.has(contextGraphId)) continue;
    await deactivateRfc64AppliedCatalogAuthorityV1({
      store,
      controlObjects: persistence.controlObjects,
      inventory: persistence.inventory,
      appliedHead,
    });
  }
}
