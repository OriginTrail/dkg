// SPDX-License-Identifier: Apache-2.0
import {
  assertAssertionCoordinateV1, assertContextGraphIdV1,
  canonicalGraphScopedAuthorSealFromAssertionSealV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  type ContextGraphIdV1, type AssertionCoordinateV1, type OperationContext, type Logger,
  type CanonicalGraphScopedAuthorSealV1,
} from '@origintrail-official/dkg-core';
import {
  snapshotRfc64FinalizedPrivatePlacementRepairV1,
  type Rfc64FinalizedPrivatePlacementRepairV1,
  type Rfc64FinalizedPrivatePlacementRepairStoreV1,
} from '../rfc64/finalized-private-placement-repair-store-v1.js';
import type { ObserveRfc64ConfirmedVmParamsV1 } from '../dkg-agent-rfc64-catalog-auto-publish.js';
import type { CatalogPlacementWaitV1, CatalogPlacementWaiterObserverV1 } from './catalog-placement-timing.js';

interface ConfirmationObserverPortsV1 {
  select(): 'required' | 'excluded';
  readonly persistence: { finalizedPrivatePlacementRepairs: Rfc64FinalizedPrivatePlacementRepairStoreV1 } | undefined;
  beginWait(seal: Readonly<CanonicalGraphScopedAuthorSealV1>, ctx: OperationContext): CatalogPlacementWaitV1;
  confirmed(seal: Readonly<CanonicalGraphScopedAuthorSealV1>): void;
  request(repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>, ctx: OperationContext,
    observer: CatalogPlacementWaiterObserverV1): boolean;
  readonly log: Logger;
}

/** Own the durable confirmation tail separately from transaction submission. */
export async function observeConfirmedCatalogObligationV1(
  params: ObserveRfc64ConfirmedVmParamsV1, ports: ConfirmationObserverPortsV1,
): Promise<void> {
  const contextGraphId = params.contextGraphId;
  if (ports.select() === 'excluded') return;
  assertContextGraphIdV1(contextGraphId, 'confirmed publish contextGraphId');
  assertAssertionCoordinateV1(params.assertionCoordinate, 'confirmed publish assertionCoordinate');
  const confirmedSeal = canonicalGraphScopedAuthorSealFromAssertionSealV1(params.seal);
  const repair = snapshotRfc64FinalizedPrivatePlacementRepairV1({
    version: 2, contextGraphId: contextGraphId as ContextGraphIdV1,
    authorAddress: confirmedSeal.authorAddress, inventoryScope: null, subGraphName: null,
    assertionCoordinate: params.assertionCoordinate as AssertionCoordinateV1,
    assertionVersion: confirmedSeal.assertionVersion, kaUal: confirmedSeal.kaUal,
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(confirmedSeal), seal: confirmedSeal,
  });
  const placementWait = ports.beginWait(confirmedSeal, params.ctx);
  ports.confirmed(confirmedSeal);
  // No lane lookup precedes this atomic write. A write refusal must cross the completion
  // boundary: the queue retains its confirmed transaction and immutable request for recovery.
  try {
    const persistence = ports.persistence;
    if (persistence === undefined) throw new Error('RFC-64 persistence is unavailable');
    await persistence.finalizedPrivatePlacementRepairs.put(repair);
  } catch (cause) {
    placementWait.observer.released();
    placementWait.end(ports.log);
    throw new Error('Confirmed publication catalog obligation was not durably recorded; recovery is required', { cause });
  }
  placementWait.requested();
  try {
    const request = ports.request(repair, params.ctx, placementWait.observer);
    if (!request) ports.log.warn(params.ctx, `Confirmed ${params.publicationLabel} for <${params.assertionUri}>: the RFC-64 catalog supervisor did not accept its placement now; the durable marker stays for its next pass or start`);
  } catch (cause) {
    placementWait.observer.released();
    ports.log.warn(params.ctx, `Confirmed ${params.publicationLabel} but RFC-64 finalized-private placement could not be requested; its durable marker stays for the next pass or start: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  placementWait.end(ports.log);
}
