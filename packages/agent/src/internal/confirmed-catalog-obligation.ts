import { CatalogPublicationAdmissionError } from '../catalog-publication-admission-error.js';
// SPDX-License-Identifier: Apache-2.0
import {
  assertAssertionCoordinateV1, assertContextGraphIdV1,
  canonicalGraphScopedAuthorSealFromAssertionSealV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  type ContextGraphIdV1, type AssertionCoordinateV1, type OperationContext, type Logger,
} from '@origintrail-official/dkg-core';
import {
  snapshotRfc64FinalizedPrivatePlacementRepairV1,
  type Rfc64FinalizedPrivatePlacementRepairV1,
  type Rfc64FinalizedPrivatePlacementRepairStoreV1,
} from '../rfc64/finalized-private-placement-repair-store-v1.js';
import type { DKGAgent } from '../dkg-agent.js';
import { selectRfc64ConfirmedCatalogObligationV1 } from '../rfc64/catalog-rollout-authority-v1.js';
import type { ObserveRfc64ConfirmedVmParamsV1 } from '../dkg-agent-rfc64-catalog-auto-publish.js';
import { type CatalogPlacementWaiterObserverV1 } from './catalog-placement-timing.js';

import { handoffConfirmedCatalogPlacementV1, withConfirmedCatalogTailV1 } from './confirmed-catalog-handoff.js';

type CatalogPublicationIdentityV1 = Readonly<{ contextGraphId: string; assertionCoordinate: string; subGraphName?: string | null; catalogObligationRequired?: boolean }>;
type CatalogAdmissionConfigurationV1 = Pick<Parameters<typeof selectRfc64ConfirmedCatalogObligationV1>[0], 'plan' | 'authoring'>;
type CatalogAdmissionHostV1 = {
  readonly [Key in 'readRfc64CatalogResponsibilitiesV1' | 'resolveRfc64CatalogServingAuthorityV1' | 'readAcceptedRfc64CatalogAccessSnapshotV1']:
    OmitThisParameter<DKGAgent[Key]>;
};

/** Publication admission and confirmation share the exact desired-work selection. */
export function selectConfirmedCatalogObligationForAgentV1(
  host: CatalogAdmissionHostV1, config: CatalogAdmissionConfigurationV1, params: Pick<CatalogPublicationIdentityV1, 'contextGraphId' | 'subGraphName'>,
): 'required' | 'excluded' {
  return selectRfc64ConfirmedCatalogObligationV1({
    plan: config.plan, contextGraphId: params.contextGraphId,
    subGraphName: params.subGraphName ?? null, authoring: config.authoring,
    readResponsibilities: () => host.readRfc64CatalogResponsibilitiesV1(),
    readAcceptedAccessPolicy: () => host.readAcceptedRfc64CatalogAccessSnapshotV1(params.contextGraphId)?.policy.accessPolicy,
    readServingAuthority: () => host.resolveRfc64CatalogServingAuthorityV1(params.contextGraphId),
  });
}

/** Refuse incompatible immutable identities before any publication preparation or submission. */
export function assertConfirmedCatalogPublicationAdmissionV1(host: CatalogAdmissionHostV1, config: CatalogAdmissionConfigurationV1, params: CatalogPublicationIdentityV1): boolean {
  // Persisted selection wins; older requests without evidence use current applicability.
  const required = params.catalogObligationRequired
    ?? (selectConfirmedCatalogObligationForAgentV1(host, config, params) === 'required');
  if (!required) return false;
  try {
    assertContextGraphIdV1(params.contextGraphId);
    assertAssertionCoordinateV1(params.assertionCoordinate);
  } catch (error) { throw new CatalogPublicationAdmissionError(error); }
  return true;
}

interface ConfirmationObserverPortsV1 {
  select(): 'required' | 'excluded';
  readonly persistence: { finalizedPrivatePlacementRepairs: Rfc64FinalizedPrivatePlacementRepairStoreV1 } | undefined;
  readonly owner: object;
  request(repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>, ctx: OperationContext,
    observer: CatalogPlacementWaiterObserverV1): boolean;
  readonly log: Logger;
}

/** Own the durable confirmation tail separately from transaction submission. */
export async function observeConfirmedCatalogObligationV1(
  params: ObserveRfc64ConfirmedVmParamsV1, ports: ConfirmationObserverPortsV1,
): Promise<void> {
  const contextGraphId = params.contextGraphId;
  if (params.catalogObligationRequired === false
    || (params.catalogObligationRequired === undefined && ports.select() === 'excluded')) return;
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
  await withConfirmedCatalogTailV1(ports.owner, ports.log, params, confirmedSeal, wait =>
    handoffConfirmedCatalogPlacementV1(params, repair, wait, {
      log: ports.log,
      persist: async record => {
        if (!ports.persistence) throw new Error('RFC-64 persistence is unavailable');
        await ports.persistence.finalizedPrivatePlacementRepairs.put(record);
      },
      request: observer => ports.request(repair, params.ctx, observer),
      persistenceFailure: cause => new Error('Confirmed publication catalog obligation was not durably recorded; recovery is required', { cause }),
    }));
}
