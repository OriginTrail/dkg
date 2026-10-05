import type { KnowledgeAssetVmPublishRequest } from '@origintrail-official/dkg-publisher';
import { assertionSealFromQueuedKnowledgeAssetVmPublishRequest, isGraphScopedKnowledgeAssetVmPublishRequest } from
  '../src/internal/knowledge-asset-vm-publish-request.js';

declare const persistedRequest: KnowledgeAssetVmPublishRequest;
// The persisted format also represents legacy jobs and incomplete envelopes.
// @ts-expect-error A seal requires the validated graph-scoped envelope.
assertionSealFromQueuedKnowledgeAssetVmPublishRequest(persistedRequest);

if (isGraphScopedKnowledgeAssetVmPublishRequest(persistedRequest)) {
  assertionSealFromQueuedKnowledgeAssetVmPublishRequest(persistedRequest);
}
