import { CatalogPublicationAdmissionError } from '../catalog-publication-admission-error.js';
// SPDX-License-Identifier: Apache-2.0
import {
  assertAssertionCoordinateV1, assertContextGraphIdV1,
  canonicalGraphScopedAuthorSealFromAssertionSealV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  type OperationContext, type Logger, type AssertionSeal,
} from '@origintrail-official/dkg-core';
import {
  snapshotRfc64FinalizedPrivatePlacementRepairV1,
  type Rfc64FinalizedPrivatePlacementRepairV1,
  type Rfc64FinalizedPrivatePlacementRepairStoreV1,
} from '../rfc64/finalized-private-placement-repair-store-v1.js';
import type { DKGAgent } from '../dkg-agent.js';
import { selectRfc64ConfirmedCatalogObligationV1 } from '../rfc64/catalog-rollout-authority-v1.js';
import type { ObserveRfc64ConfirmedVmParamsV1, RequiredConfirmedPublicationV1 } from './confirmed-publication-types.js';
import { type CatalogPlacementWaiterObserverV1 } from './catalog-placement-timing.js';

import { handoffConfirmedCatalogPlacementV1, withConfirmedCatalogTailV1 } from './confirmed-catalog-handoff.js';

type CatalogPublicationIdentityV1 = Readonly<{ contextGraphId: string; assertionCoordinate: string; subGraphName?: string | null; catalogObligationRequired?: boolean }>;
type CatalogAdmissionConfigurationV1 = Pick<Parameters<typeof selectRfc64ConfirmedCatalogObligationV1>[0], 'plan' | 'authoring'>;
type CatalogAdmissionHostV1 = {
  readonly [Key in 'readRfc64CatalogResponsibilityV1' | 'resolveRfc64CatalogServingAuthorityV1' | 'readAcceptedRfc64CatalogAccessSnapshotV1']:
    OmitThisParameter<DKGAgent[Key]>;
};

/** Publication admission and confirmation share the exact desired-work selection. */
export function selectConfirmedCatalogObligationForAgentV1(
  host: CatalogAdmissionHostV1, config: CatalogAdmissionConfigurationV1, params: Pick<CatalogPublicationIdentityV1, 'contextGraphId' | 'subGraphName'>,
): 'required' | 'excluded' {
  // Validate at lazy authority-read boundaries: excluded legacy lanes remain untouched,
  // while identity errors cannot escape through responsibility/policy selection.
  const read = <T>(operation: () => T): T => {
    try { assertContextGraphIdV1(params.contextGraphId); }
    catch (error) { throw new CatalogPublicationAdmissionError(error); }
    return operation(); // Preserve authority/provider failures verbatim.
  };
  return selectRfc64ConfirmedCatalogObligationV1({
    plan: config.plan, contextGraphId: params.contextGraphId,
    subGraphName: params.subGraphName ?? null, authoring: config.authoring,
    readResponsibility: () => read(() => host.readRfc64CatalogResponsibilityV1(params.contextGraphId)),
    readAcceptedAccessPolicy: () => read(() => host.readAcceptedRfc64CatalogAccessSnapshotV1(params.contextGraphId)?.policy.accessPolicy),
    readServingAuthority: () => read(() => host.resolveRfc64CatalogServingAuthorityV1(params.contextGraphId)),
  });
}

/** Refuse incompatible immutable identities before any publication preparation or submission. */
export function assertConfirmedCatalogPublicationAdmissionV1(host: CatalogAdmissionHostV1, config: CatalogAdmissionConfigurationV1, params: CatalogPublicationIdentityV1): boolean {
  // Persisted selection wins; older requests without evidence use current applicability.
  const required = params.catalogObligationRequired
    ?? (selectConfirmedCatalogObligationForAgentV1(host, config, params) === 'required');
  if (!required) return false;
  try {
    if (params.subGraphName != null) throw new Error('Confirmed publication catalog obligations require a root graph identity');
    assertContextGraphIdV1(params.contextGraphId);
    assertAssertionCoordinateV1(params.assertionCoordinate);
  } catch (error) { throw new CatalogPublicationAdmissionError(error); }
  return true;
}

/** Catalog-selected publications must have representable recovery evidence before a send. */
export function assertConfirmedCatalogSealAdmissionV1(required: boolean, seal: AssertionSeal): void {
  if (!required) return; // Preserve legacy publication on excluded lanes.
  try { canonicalGraphScopedAuthorSealFromAssertionSealV1(seal); }
  catch (cause) { throw new CatalogPublicationAdmissionError(cause); }
}

interface ConfirmationObserverPortsV1 {
  select(): 'required' | 'excluded';
  readonly persistence: { finalizedPrivatePlacementRepairs: Rfc64FinalizedPrivatePlacementRepairStoreV1 } | undefined;
  readonly owner: object;
  request(repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>, ctx: OperationContext,
    observer: CatalogPlacementWaiterObserverV1): boolean;
  readonly log: Logger;
}

/** Resolve legacy selection once and narrow the durable writer to validated root identities. */
export function normalizeConfirmedPublicationV1(params: ObserveRfc64ConfirmedVmParamsV1,
  select: () => 'required' | 'excluded'): RequiredConfirmedPublicationV1 | undefined {
  const required = params.catalogObligationRequired ?? (select() === 'required');
  if (!required) return undefined;
  if (params.subGraphName != null) throw new CatalogPublicationAdmissionError(
    new Error('Confirmed publication catalog obligations require a root graph identity'));
  const { contextGraphId, assertionCoordinate } = params;
  assertContextGraphIdV1(contextGraphId, 'confirmed publish contextGraphId');
  assertAssertionCoordinateV1(assertionCoordinate, 'confirmed publish assertionCoordinate');
  return { ...params, contextGraphId, assertionCoordinate, subGraphName: null, catalogObligationRequired: true };
}

/** Own the durable confirmation tail separately from transaction submission. */
export async function observeConfirmedCatalogObligationV1(
  input: ObserveRfc64ConfirmedVmParamsV1, ports: ConfirmationObserverPortsV1,
): Promise<void> {
  const params = normalizeConfirmedPublicationV1(input, ports.select);
  if (params === undefined) return;
  const { contextGraphId } = params;
  const confirmedSeal = canonicalGraphScopedAuthorSealFromAssertionSealV1(params.seal);
  const repair = snapshotRfc64FinalizedPrivatePlacementRepairV1({
    version: 2, contextGraphId,
    authorAddress: confirmedSeal.authorAddress, inventoryScope: null, subGraphName: null,
    assertionCoordinate: params.assertionCoordinate,
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
