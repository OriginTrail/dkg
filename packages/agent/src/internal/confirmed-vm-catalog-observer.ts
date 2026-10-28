// SPDX-License-Identifier: Apache-2.0
import { handoffConfirmedCatalogPlacementV1, withConfirmedCatalogTailV1 } from './confirmed-catalog-handoff.js';
import { rfc64CatalogLaneAcceptsWorkspaceHeadV1 } from './catalog-workspace-policy.js';
import type { PlacementLaneV1 } from './finalized-placement-decision.js';

import { SwmInventoryWriteFailure } from './swm-inventory-write.js';

import {
  assertAssertionCoordinateV1, assertContextGraphIdV1, assertSubGraphNameV1,
  canonicalGraphScopedAuthorSealFromAssertionSealV1, computeCanonicalGraphScopedAuthorSealDigestV1,
  type CanonicalGraphScopedAuthorSealV1, type ContextGraphIdV1, type Logger,
  type OperationContext, type SwmAuthorInventoryScopeV1,
} from '@origintrail-official/dkg-core';
import type { DKGAgent } from '../dkg-agent.js';
import type { TransferRfc64ConfirmedVmParamsV1 } from './promote/swm-handoff-types.js';
import { rfc64SwmInventoryShadowRuntimeV1 } from '../rfc64/swm-inventory-shadow-runtime-v1.js';
import {
  snapshotRfc64FinalizedPrivatePlacementRepairV1,
  type Rfc64FinalizedPrivatePlacementRepairV1,
} from '../rfc64/finalized-private-placement-repair-store-v1.js';
import { type CatalogPlacementWaiterObserverV1 } from './catalog-placement-timing.js';

export interface ConfirmedVmCatalogObserverDependencies {
  readonly owner: object;
  readonly log: Logger;
  readonly finalizedPrivateScopeBase: Readonly<Omit<SwmAuthorInventoryScopeV1, 'authorAddress'>> | null;
  storeRepair(repair: Rfc64FinalizedPrivatePlacementRepairV1): Promise<void>;
  requestPlacement(params: {
    repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>;
    seal: Readonly<CanonicalGraphScopedAuthorSealV1>;
    ctx: OperationContext;
  }, observer: CatalogPlacementWaiterObserverV1): { readonly accepted: boolean };
  readonly removeInventory: OmitThisParameter<DKGAgent['commitRfc64ConfirmedInventoryRemovalV1']>;
  readonly requestProjection: OmitThisParameter<DKGAgent['requestRfc64SwmCatalogProjectionV1']>;
}

export type ConfirmedVmOwnershipOutcome = 'owned' | 'inactive' | 'pending' | 'projection-pending';

export class ConfirmedVmOwnershipFailure extends SwmInventoryWriteFailure {
  constructor(readonly boundary: 'input' | 'authority' | 'marker' | 'removal' | 'projection', cause: unknown) {
    super(cause instanceof SwmInventoryWriteFailure ? cause.phase
      : boundary === 'authority' ? 'authority' : boundary === 'input' ? 'preparation-read' : 'inventory-maintenance',
    cause instanceof SwmInventoryWriteFailure ? cause.kaUal : null, cause instanceof SwmInventoryWriteFailure ? cause.cause : cause);
  }
}

/** Legacy observation preserves committed-removal success; only strict transfer certifies ownership. */
export async function observeConfirmedVmTransfer(
  log: Logger, params: TransferRfc64ConfirmedVmParamsV1,
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
    return boundary === 'projection';
  }
}

export async function observeConfirmedVmCatalogV1(deps: ConfirmedVmCatalogObserverDependencies, params: TransferRfc64ConfirmedVmParamsV1): Promise<boolean> {
  return observeConfirmedVmTransfer(deps.log, params, () => transferConfirmedVmCatalogV1(deps, params));
}

/**
 * Certify the catalog part only after public removal commits and projection is admitted, or
 * its private placement has a durable repair owner. Supervisor latency never delays this result.
 */
export async function transferConfirmedVmCatalogV1(
  deps: ConfirmedVmCatalogObserverDependencies,
  params: TransferRfc64ConfirmedVmParamsV1,
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
  const shadowRuntime = rfc64SwmInventoryShadowRuntimeV1(deps.owner);
  return withConfirmedCatalogTailV1(deps.owner, deps.log, params, confirmedSeal, async placementWait => {
    const finalizedPrivateScopeBase = deps.finalizedPrivateScopeBase;
    if (finalizedPrivateScopeBase !== null) {
      let repair: Rfc64FinalizedPrivatePlacementRepairV1;
      try {
        repair = snapshotRfc64FinalizedPrivatePlacementRepairV1({
          version: 1,
          contextGraphId: contextGraphId as ContextGraphIdV1,
          authorAddress: confirmedSeal.authorAddress,
          inventoryScope: Object.freeze({ ...finalizedPrivateScopeBase, authorAddress: confirmedSeal.authorAddress }),
          assertionCoordinate,
          assertionVersion: confirmedSeal.assertionVersion,
          kaUal: confirmedSeal.kaUal,
          sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(confirmedSeal),
        });
      } catch (cause) {
        placementWait.observer.released();
        throw new ConfirmedVmOwnershipFailure('input', cause);
      }
      await handoffConfirmedCatalogPlacementV1(params, repair, placementWait, {
        log: deps.log, persist: record => deps.storeRepair(record),
        request: observer => deps.requestPlacement({ repair, seal: confirmedSeal, ctx: params.ctx }, observer).accepted,
        persistenceFailure: cause => new ConfirmedVmOwnershipFailure('marker', cause),
      });
      return 'owned';
    }
    try {
      return await shadowRuntime.runInventoryWriteExclusive({
        contextGraphId, subGraphName, authorAddress: confirmedSeal.authorAddress, assertionCoordinate,
      }, async () => {
        const result = await deps.removeInventory({ contextGraphId, subGraphName, seal: params.seal });
        switch (result.status) {
          case 'applied':
          case 'absent':
            // Public removal has no separate repair marker: strict recovery retains its owner
            // until projection accepts. Legacy observation still reports committed removal.
            try {
              return deps.requestProjection({
                contextGraphId: contextGraphId as ContextGraphIdV1,
                authorAddress: confirmedSeal.authorAddress,
                ctx: params.ctx,
              }) ? 'owned' : 'projection-pending';
            } catch (cause) { throw new ConfirmedVmOwnershipFailure('projection', cause); }
          case 'inactive':
            return 'inactive';
        }
      });
    } catch (cause) {
      placementWait.observer.released();
      if (cause instanceof ConfirmedVmOwnershipFailure) throw cause;
      throw new ConfirmedVmOwnershipFailure('removal', cause);
    }
  });
}

// Preserve the helper's existing dist-subpath export while sharing the canonical inventory key.
export { rfc64SwmInventoryAssetKeyV1 } from '../rfc64/swm-inventory-shadow-runtime-v1.js';

/** Resolve the current lane once before strict ownership transfer. */
export async function transferSelectedConfirmedVmCatalogV1(
  ports: Omit<ConfirmedVmCatalogObserverDependencies, 'finalizedPrivateScopeBase'> & {
    resolveLane(): PlacementLaneV1 | null;
  }, params: TransferRfc64ConfirmedVmParamsV1,
): Promise<ConfirmedVmOwnershipOutcome> {
    let lane: PlacementLaneV1 | null;
    try {
      lane = ports.resolveLane();
    } catch (cause) { throw new ConfirmedVmOwnershipFailure('authority', cause); }
    if (lane === null) return 'inactive';
    if (params.expectedWorkspaceAccessPolicy !== undefined) {
      if (!rfc64CatalogLaneAcceptsWorkspaceHeadV1(lane, params.expectedWorkspaceAccessPolicy)) {
        throw Object.assign(new Error('Confirmed share catalog policy differs from its binding'), { code: 'KA_PROMOTE_RECOVERY_BINDING_CONFLICT' });
      }
      if (lane.kind === 'private' && !lane.acceptsFinalizedVmRepair) return 'pending';
    }
  return transferConfirmedVmCatalogV1({ ...ports,
    finalizedPrivateScopeBase: lane.acceptsFinalizedVmRepair ? lane.scopeBase : null }, params);
}
