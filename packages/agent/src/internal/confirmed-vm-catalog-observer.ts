// SPDX-License-Identifier: Apache-2.0

import {
  assertAssertionCoordinateV1, assertContextGraphIdV1, assertSubGraphNameV1,
  canonicalGraphScopedAuthorSealFromAssertionSealV1, computeCanonicalGraphScopedAuthorSealDigestV1,
  type CanonicalGraphScopedAuthorSealV1, type ContextGraphIdV1, type Logger,
  type OperationContext, type SwmAuthorInventoryScopeV1,
} from '@origintrail-official/dkg-core';
import type { DKGAgent } from '../dkg-agent.js';
import type { ObserveRfc64ConfirmedVmParamsV1 } from '../dkg-agent-rfc64-catalog-auto-publish.js';
import { rfc64SwmInventoryShadowRuntimeV1 } from '../rfc64/swm-inventory-shadow-runtime-v1.js';
import {
  snapshotRfc64FinalizedPrivatePlacementRepairV1,
  type Rfc64FinalizedPrivatePlacementRepairV1,
} from '../rfc64/finalized-private-placement-repair-store-v1.js';
import { catalogPlacementTimingV1, type CatalogPlacementWaiterObserverV1 } from './catalog-placement-timing.js';

interface ConfirmedVmCatalogObserverDependencies {
  readonly owner: object;
  readonly log: Logger;
  finalizedPrivateScope(contextGraphId: string, subGraphName: string | null, authorAddress: string): SwmAuthorInventoryScopeV1 | null;
  storeRepair(repair: Rfc64FinalizedPrivatePlacementRepairV1): Promise<void>;
  requestPlacement(params: {
    repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>;
    seal: Readonly<CanonicalGraphScopedAuthorSealV1>;
    ctx: OperationContext;
  }, observer: CatalogPlacementWaiterObserverV1): { readonly accepted: boolean };
  readonly removeShadow: OmitThisParameter<DKGAgent['removeRfc64SwmAuthorInventoryShadowV1']>;
  readonly requestProjection: OmitThisParameter<DKGAgent['requestRfc64SwmCatalogProjectionV1']>;
}

/**
 * Certify the catalog part of a confirmed publication only after its public removal commits or
 * its private placement has a durable repair owner. Supervisor latency never delays this result.
 */
export async function observeConfirmedVmCatalogV1(
  deps: ConfirmedVmCatalogObserverDependencies,
  params: ObserveRfc64ConfirmedVmParamsV1,
): Promise<boolean> {
  const subGraphName = params.subGraphName ?? null;
  const contextGraphId = params.contextGraphId;
  const assertionCoordinate = params.assertionCoordinate;
  let confirmedSeal: ReturnType<typeof canonicalGraphScopedAuthorSealFromAssertionSealV1>;
  try {
    assertContextGraphIdV1(contextGraphId, 'confirmed publish contextGraphId');
    assertAssertionCoordinateV1(
      assertionCoordinate,
      'confirmed publish assertionCoordinate',
    );
    if (subGraphName !== null) {
      assertSubGraphNameV1(subGraphName, 'confirmed publish subGraphName');
    }
    confirmedSeal = canonicalGraphScopedAuthorSealFromAssertionSealV1(params.seal);
  } catch (cause) {
    deps.log.warn(
      params.ctx,
      `Confirmed ${params.publicationLabel} for <${params.assertionUri}> but RFC-64 post-confirmation observer input was invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return false;
  }
  const placementWait = catalogPlacementTimingV1(deps.owner).beginWait(confirmedSeal, params.ctx);
  const shadowRuntime = rfc64SwmInventoryShadowRuntimeV1(deps.owner);
  const assetKey = rfc64SwmInventoryAssetKeyV1({
    contextGraphId,
    subGraphName,
    authorAddress: confirmedSeal.authorAddress,
    assertionCoordinate,
  });
  let finalizedPrivateInventoryScope: SwmAuthorInventoryScopeV1 | null = null;
  try {
    finalizedPrivateInventoryScope = deps.finalizedPrivateScope(contextGraphId, subGraphName, confirmedSeal.authorAddress);
  } catch (cause) {
    deps.log.warn(
      params.ctx,
      `Confirmed ${params.publicationLabel} but RFC-64 catalog authority was unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return false;
  }
  // Fence every confirmed version, including confirmation-gated finalized
  // private repairs, until the asset-tail repair and queued observers drain.
  // Newer assertion versions use distinct fence entries and remain eligible.
  // The fence is set before the first await and outlives this call.
  if (params.shareOperationId !== undefined) {
    shadowRuntime.markVmConfirmed(
      assetKey,
      confirmedSeal.assertionVersion,
      params.shareOperationId,
    );
  }
  let markerStored = false;
  let completed = false;
  try {
    if (finalizedPrivateInventoryScope !== null) {
      const repair = snapshotRfc64FinalizedPrivatePlacementRepairV1({
        version: 1,
        contextGraphId: contextGraphId as ContextGraphIdV1,
        authorAddress: confirmedSeal.authorAddress,
        inventoryScope: finalizedPrivateInventoryScope,
        assertionCoordinate,
        assertionVersion: confirmedSeal.assertionVersion,
        kaUal: confirmedSeal.kaUal,
        sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(confirmedSeal),
      });
      // GH#3081 — the terminal boundary of a confirmed private publication.
      // This durable marker is the restart boundary: pre-confirmation rows
      // have none, while every post-confirmation placement survives a crash
      // or transient signing/catalog failure. The supervisor alone owns the
      // attempt, its retries and its drain: nothing here waits for it, or
      // queues on the asset tail that a running placement holds.
      await deps.storeRepair(repair);
      markerStored = true;
      // The supervisor durably owes placement now. Its availability or latency does not
      // gate publication completion; restart also resumes this exact marker.
      completed = true;
      placementWait.requested();
      const request = deps.requestPlacement({ repair, seal: confirmedSeal, ctx: params.ctx }, placementWait.observer);
      if (!request.accepted) deps.log.warn(params.ctx, `Confirmed ${params.publicationLabel} for <${params.assertionUri}>: the RFC-64 catalog supervisor did not accept its placement now; the durable marker stays for its next pass or start`);
    } else {
      await shadowRuntime.runExclusive(assetKey, async () => {
        const result = await deps.removeShadow({
          contextGraphId,
          subGraphName,
          seal: params.seal,
        });
        completed = result.status === 'applied' || result.status === 'absent'
          || result.status === 'dormant';
        if (result.status === 'applied' || result.status === 'absent') {
          deps.requestProjection({
            contextGraphId: contextGraphId as ContextGraphIdV1,
            authorAddress: confirmedSeal.authorAddress,
            ctx: params.ctx,
          });
        }
      });
    }
  } catch (cause) {
    placementWait.observer.released(); // A request that threw has no waiter to release it later.
    const failed = finalizedPrivateInventoryScope === null ? 'SWM inventory shadow removal escaped its failure boundary'
      : markerStored ? 'finalized-private placement could not be requested; its durable marker stays for the next pass or start'
        : 'finalized-private placement was not recorded, so nothing owes it';
    deps.log.warn(params.ctx, `Confirmed ${params.publicationLabel} but RFC-64 ${failed}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  placementWait.end(deps.log);
  return completed;
}

export function rfc64SwmInventoryAssetKeyV1(input: Readonly<{
  contextGraphId: string;
  subGraphName?: string | null;
  authorAddress: string;
  assertionCoordinate: string;
}>): string {
  return JSON.stringify([
    input.contextGraphId,
    input.subGraphName ?? null,
    input.authorAddress.toLowerCase(),
    input.assertionCoordinate,
  ]);
}
