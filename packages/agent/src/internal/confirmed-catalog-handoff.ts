// SPDX-License-Identifier: Apache-2.0
import type { CanonicalGraphScopedAuthorSealV1, Logger } from '@origintrail-official/dkg-core';
import type { ConfirmedVmIdentityAndTimingV1 } from './confirmed-catalog-handoff-types.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from '../rfc64/finalized-private-placement-repair-store-v1.js';
import { rfc64SwmInventoryAssetKeyV1, rfc64SwmInventoryShadowRuntimeV1 } from '../rfc64/swm-inventory-shadow-runtime-v1.js';
import { catalogPlacementTimingV1, type CatalogPlacementWaiterObserverV1 } from './catalog-placement-timing.js';

type PlacementWait = ReturnType<ReturnType<typeof catalogPlacementTimingV1>['beginWait']>;
/** Timing and confirmation fencing have one lifetime for either marker format. */
export async function withConfirmedCatalogTailV1<T>(owner: object, log: Logger,
  params: ConfirmedVmIdentityAndTimingV1, seal: CanonicalGraphScopedAuthorSealV1,
  run: (wait: PlacementWait) => Promise<T>): Promise<T> {
  const wait = catalogPlacementTimingV1(owner).beginWait(seal, params.ctx);
  try {
    if (params.shareOperationId !== undefined) rfc64SwmInventoryShadowRuntimeV1(owner).markVmConfirmed(
      rfc64SwmInventoryAssetKeyV1({ contextGraphId: params.contextGraphId, subGraphName: params.subGraphName ?? null,
        authorAddress: seal.authorAddress, assertionCoordinate: params.assertionCoordinate }),
      seal.assertionVersion, params.shareOperationId);
    return await run(wait);
  }
  finally { wait.end(log); }
}

/** Durable ownership precedes best-effort nonblocking placement notification. */
export async function handoffConfirmedCatalogPlacementV1(params: ConfirmedVmIdentityAndTimingV1,
  repair: Rfc64FinalizedPrivatePlacementRepairV1, wait: PlacementWait, ports: {
    log: Logger;
    persist(repair: Rfc64FinalizedPrivatePlacementRepairV1): Promise<void>;
    request(observer: CatalogPlacementWaiterObserverV1): boolean;
    persistenceFailure(cause: unknown): Error;
  }): Promise<void> {
  try { await ports.persist(repair); }
  catch (cause) { wait.observer.released(); throw ports.persistenceFailure(cause); }
  wait.requested();
  try {
    if (!ports.request(wait.observer)) ports.log.warn(params.ctx,
      `Confirmed ${params.publicationLabel} for <${params.assertionUri}>: the RFC-64 catalog supervisor did not accept its placement now; the durable marker stays for its next pass or start`);
  } catch (cause) {
    wait.observer.released();
    ports.log.warn(params.ctx, `Confirmed ${params.publicationLabel} but RFC-64 finalized-private placement could not be requested; its durable marker stays for the next pass or start: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
