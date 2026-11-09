import type { KnowledgeAssetVmPublishRequest } from '@origintrail-official/dkg-publisher';
import { LegacyKnowledgeAssetReadOnlyError } from '@origintrail-official/dkg-core';
import type { DKGAgent } from '../dkg-agent.js';
import { assertConfirmedCatalogSealAdmissionV1 } from './confirmed-catalog-obligation.js';
import { assertionSealFromQueuedKnowledgeAssetVmPublishRequest, isGraphScopedKnowledgeAssetVmPublishRequest } from './knowledge-asset-vm-publish-request.js';

/** One queued boundary owns identity mapping, persisted selection and seal admission.
 * Return the checked envelope so callers retain their own legacy error ordering
 * without decoding it again. Excluded legacy lanes never reconstruct a seal.
 */
export function admitQueuedCatalogPublicationV1(
  host: { admitConfirmedCatalogPublicationV1: OmitThisParameter<DKGAgent['admitConfirmedCatalogPublicationV1']> },
  request: KnowledgeAssetVmPublishRequest,
) {
  const catalogObligationRequired = host.admitConfirmedCatalogPublicationV1({
    contextGraphId: request.contextGraphId, assertionCoordinate: request.name,
    subGraphName: request.subGraphName, catalogObligationRequired: request.catalogObligationRequired,
  });
  const graphScopedRequest = isGraphScopedKnowledgeAssetVmPublishRequest(request) ? request : undefined;
  if (catalogObligationRequired) {
    if (!graphScopedRequest) throw new LegacyKnowledgeAssetReadOnlyError();
    assertConfirmedCatalogSealAdmissionV1(true, assertionSealFromQueuedKnowledgeAssetVmPublishRequest(graphScopedRequest));
  }
  return { catalogObligationRequired, graphScopedRequest };
}
