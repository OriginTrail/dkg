// SPDX-License-Identifier: Apache-2.0

import type { TripleStore } from '@origintrail-official/dkg-storage';

import {
  resolveRfc64CatalogExecutionPlanAuthorityV1,
  type Rfc64CatalogExecutionPlanV1,
} from './catalog-rollout-authority-v1.js';
import type { Rfc64PersistenceV1 } from './persistence-v1.js';
import {
  commitPreparedRfc64AppliedCatalogAuthorityDeactivationsV1,
  prepareRfc64AppliedCatalogAuthorityDeactivationV1,
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
  executionPlan: Rfc64CatalogExecutionPlanV1,
): Promise<void> {
  const nextCatalogSet = new Set(Object.entries(executionPlan.selectedAuthority)
    .filter(([, authority]) => authority.mode === 'catalog')
    .map(([contextGraphId]) => contextGraphId));
  const appliedHeads = persistence.inventory.listAppliedCatalogHeadsV1();
  const pendingByContextGraph = new Map<
    string,
    Array<(typeof appliedHeads)[number]>
  >();
  for (const appliedHead of appliedHeads) {
    const contextGraphId = await readRfc64AppliedCatalogContextGraphIdV1({
      controlObjects: persistence.controlObjects,
      appliedHead,
    });
    const authority = resolveRfc64CatalogExecutionPlanAuthorityV1(
      executionPlan,
      contextGraphId,
    );
    // A shadow author stages discovery metadata alongside legacy authority.
    // Only a receiver-applied row can own catalog semantic material, so never
    // infer relinquishment from the generic applied-head table alone.
    if (
      authority.reconciliationLane === 'shadow-stage'
      && persistence.inventory.isStagedCatalogHeadV1(
        appliedHead.catalogScopeDigest,
        appliedHead.authorAddress,
        appliedHead.currentCatalogHeadDigest,
      )
    ) continue;
    // Preserve the pre-activation standalone catalog API when no selected-CG
    // rollout block is enabled.
    if (executionPlan.standaloneTrack2Enabled) nextCatalogSet.add(contextGraphId);
    if (nextCatalogSet.has(contextGraphId)) continue;
    const pending = pendingByContextGraph.get(contextGraphId) ?? [];
    pending.push(appliedHead);
    pendingByContextGraph.set(contextGraphId, pending);
  }
  for (const pending of pendingByContextGraph.values()) {
    // Prepare every author closure first. A corrupt or unavailable later head
    // cannot leave this Context Graph half transitioned.
    const prepared = [];
    for (const appliedHead of pending) {
      prepared.push(await prepareRfc64AppliedCatalogAuthorityDeactivationV1({
        store,
        controlObjects: persistence.controlObjects,
        appliedHead,
      }));
    }
    await commitPreparedRfc64AppliedCatalogAuthorityDeactivationsV1({
      store,
      inventory: persistence.inventory,
      prepared,
    });
  }
}
