// SPDX-License-Identifier: Apache-2.0

import { SwmInventoryWriteFailure } from './swm-inventory-write.js';

import {
  assertAssertionCoordinateV1, assertContextGraphIdV1, assertSubGraphNameV1,
  canonicalGraphScopedAuthorSealFromAssertionSealV1, computeCanonicalGraphScopedAuthorSealDigestV1,
  type CanonicalGraphScopedAuthorSealV1, type ContextGraphIdV1, type Logger,
  type OperationContext, type SwmAuthorInventoryScopeV1,
} from '@origintrail-official/dkg-core';
import type { DKGAgent } from '../dkg-agent.js';
import type { ObserveRfc64ConfirmedVmParamsV1 } from '../dkg-agent-rfc64-catalog-auto-publish.js';
import { rfc64SwmInventoryAssetKeyV1, rfc64SwmInventoryShadowRuntimeV1 } from '../rfc64/swm-inventory-shadow-runtime-v1.js';
import {
  snapshotRfc64FinalizedPrivatePlacementRepairV1,
  type Rfc64FinalizedPrivatePlacementRepairV1,
} from '../rfc64/finalized-private-placement-repair-store-v1.js';
import { catalogPlacementTimingV1, type CatalogPlacementWaiterObserverV1 } from './catalog-placement-timing.js';

export interface ConfirmedVmCatalogObserverDependencies {
  readonly owner: object;
  readonly log: Logger;
  finalizedPrivateScope(contextGraphId: string, subGraphName: string | null, authorAddress: string): SwmAuthorInventoryScopeV1 | null;
  storeRepair(repair: Rfc64FinalizedPrivatePlacementRepairV1): Promise<void>;
  requestPlacement(params: {
    repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>;
    seal: Readonly<CanonicalGraphScopedAuthorSealV1>;
    ctx: OperationContext;
  }, observer: CatalogPlacementWaiterObserverV1): { readonly accepted: boolean };
  readonly removeShadow: OmitThisParameter<DKGAgent['commitRfc64ConfirmedInventoryRemovalV1']>;
  readonly requestProjection: OmitThisParameter<DKGAgent['requestRfc64SwmCatalogProjectionV1']>;
}

export type ConfirmedVmOwnershipOutcome = 'owned' | 'inactive' | 'pending';

export class ConfirmedVmOwnershipFailure extends SwmInventoryWriteFailure {
  constructor(readonly boundary: 'input' | 'authority' | 'marker' | 'removal', cause: unknown) {
    super(cause instanceof SwmInventoryWriteFailure ? cause.phase
      : boundary === 'authority' ? 'authority' : boundary === 'input' ? 'preparation-read' : 'inventory-commit',
    cause instanceof SwmInventoryWriteFailure ? cause.kaUal : null, cause instanceof SwmInventoryWriteFailure ? cause.cause : cause);
  }
}

/** The legacy observer owns logging only; a failed transfer never claims ownership. */
export async function observeConfirmedVmTransfer(
  log: Logger, params: ObserveRfc64ConfirmedVmParamsV1,
  transfer: () => Promise<ConfirmedVmOwnershipOutcome>,
): Promise<boolean> {
  try { return await transfer() !== 'pending'; } catch (error) {
    const cause = error instanceof SwmInventoryWriteFailure ? error.cause : error;
    const boundary = error instanceof ConfirmedVmOwnershipFailure ? error.boundary : 'authority';
    const detail = cause instanceof Error ? cause.message : String(cause);
    const message = boundary === 'input'
      ? `Confirmed ${params.publicationLabel} for <${params.assertionUri}> but RFC-64 post-confirmation observer input was invalid: ${detail}`
      : boundary === 'authority'
        ? `Confirmed ${params.publicationLabel} but RFC-64 catalog authority was unavailable: ${detail}`
        : boundary === 'marker'
          ? `Confirmed ${params.publicationLabel} but RFC-64 finalized-private placement was not recorded, so nothing owes it: ${detail}`
          : `Confirmed ${params.publicationLabel} but RFC-64 SWM inventory shadow removal escaped its failure boundary: ${detail}`;
    log.warn(params.ctx, message);
    return false;
  }
}

export async function observeConfirmedVmCatalogV1(deps: ConfirmedVmCatalogObserverDependencies, params: ObserveRfc64ConfirmedVmParamsV1): Promise<boolean> {
  return observeConfirmedVmTransfer(deps.log, params, () => transferConfirmedVmCatalogV1(deps, params));
}

/**
 * Certify the catalog part of a confirmed publication only after its public removal commits or
 * its private placement has a durable repair owner. Supervisor latency never delays this result.
 */
export async function transferConfirmedVmCatalogV1(
  deps: ConfirmedVmCatalogObserverDependencies,
  params: ObserveRfc64ConfirmedVmParamsV1,
): Promise<ConfirmedVmOwnershipOutcome> {
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
    throw new ConfirmedVmOwnershipFailure('input', cause);
  }
  const placementWait = catalogPlacementTimingV1(deps.owner).beginWait(confirmedSeal, params.ctx);
  const shadowRuntime = rfc64SwmInventoryShadowRuntimeV1(deps.owner);
  const assetKey = rfc64SwmInventoryAssetKeyV1({
    contextGraphId,
    subGraphName,
    authorAddress: confirmedSeal.authorAddress,
    assertionCoordinate,
  });
  try {
    let finalizedPrivateInventoryScope: SwmAuthorInventoryScopeV1 | null;
    try {
      finalizedPrivateInventoryScope = deps.finalizedPrivateScope(contextGraphId, subGraphName, confirmedSeal.authorAddress);
    } catch (cause) {
      throw new ConfirmedVmOwnershipFailure('authority', cause);
    }
    // Fence every confirmed version before the first await; newer versions have distinct entries.
    // The fence outlives this call until the asset-tail repair and queued observers drain.
    if (params.shareOperationId !== undefined) {
      shadowRuntime.markVmConfirmed(assetKey, confirmedSeal.assertionVersion, params.shareOperationId);
    }
    if (finalizedPrivateInventoryScope !== null) {
      let repair: Rfc64FinalizedPrivatePlacementRepairV1;
      try {
        repair = snapshotRfc64FinalizedPrivatePlacementRepairV1({
          version: 1,
          contextGraphId: contextGraphId as ContextGraphIdV1,
          authorAddress: confirmedSeal.authorAddress,
          inventoryScope: finalizedPrivateInventoryScope,
          assertionCoordinate,
          assertionVersion: confirmedSeal.assertionVersion,
          kaUal: confirmedSeal.kaUal,
          sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(confirmedSeal),
        });
      } catch (cause) {
        placementWait.observer.released();
        throw new ConfirmedVmOwnershipFailure('input', cause);
      }
      try {
        // This committed marker owns placement across restart and transient catalog failures.
        // Nothing here waits for the supervisor or queues behind its running asset-tail repair.
        await deps.storeRepair(repair);
      } catch (cause) {
        placementWait.observer.released();
        throw new ConfirmedVmOwnershipFailure('marker', cause);
      }
      // Notification is best-effort after the durable obligation has committed.
      try {
        placementWait.requested();
        const request = deps.requestPlacement({ repair, seal: confirmedSeal, ctx: params.ctx }, placementWait.observer);
        if (!request.accepted) deps.log.warn(params.ctx, `Confirmed ${params.publicationLabel} for <${params.assertionUri}>: the RFC-64 catalog supervisor did not accept its placement now; the durable marker stays for its next pass or start`);
      } catch (cause) {
        placementWait.observer.released(); // A request that threw has no waiter to release it later.
        deps.log.warn(params.ctx, `Confirmed ${params.publicationLabel} but RFC-64 finalized-private placement could not be requested; its durable marker stays for the next pass or start: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      return 'owned';
    }
    try {
      return await shadowRuntime.runInventoryWriteExclusive({
        contextGraphId, subGraphName, authorAddress: confirmedSeal.authorAddress, assertionCoordinate,
      }, async () => {
        const result = await deps.removeShadow({ contextGraphId, subGraphName, seal: params.seal });
        switch (result.status) {
          case 'applied':
          case 'absent':
            // Keep notification within the asset lock, but do not revoke the committed removal.
            try {
              deps.requestProjection({
                contextGraphId: contextGraphId as ContextGraphIdV1,
                authorAddress: confirmedSeal.authorAddress,
                ctx: params.ctx,
              });
            } catch (cause) {
              placementWait.observer.released();
              deps.log.warn(params.ctx, `Confirmed ${params.publicationLabel} but RFC-64 SWM inventory shadow removal escaped its failure boundary: ${cause instanceof Error ? cause.message : String(cause)}`);
            }
            return 'owned';
          case 'dormant':
            return 'inactive';
          default:
            return 'pending';
        }
      });
    } catch (cause) {
      placementWait.observer.released();
      throw new ConfirmedVmOwnershipFailure('removal', cause);
    }
  } finally {
    placementWait.end(deps.log);
  }
}

// Preserve the helper's existing dist-subpath export while sharing the canonical inventory key.
export { rfc64SwmInventoryAssetKeyV1 } from '../rfc64/swm-inventory-shadow-runtime-v1.js';
