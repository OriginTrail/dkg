import type { KnowledgeAssetPublishResponse, ConfirmedCatalogObligationPendingResponseV1 } from '../src/api-client.js';
import { confirmedCatalogObligationResponse } from '../src/daemon/routes/confirmed-catalog-obligation.js';

declare const response: KnowledgeAssetPublishResponse;
if (response.catalogObligationPending === true) {
  const pending: ConfirmedCatalogObligationPendingResponseV1 = response;
  if (pending.retryAction === 'observe_confirmed_catalog_obligation') {
    const version: '1' | '2' = pending.recovery.seal.contentScopeVersion;
    void version;
  }
  const id: string = pending.confirmedTransaction.batchId;
  void [id, pending.retryUrl, pending.retryAction];
}
const produced: ConfirmedCatalogObligationPendingResponseV1 | null = confirmedCatalogObligationResponse(new Error());
void produced;
// @ts-expect-error A pending response must retain authenticated recovery and explicit retry fields.
const incomplete: KnowledgeAssetPublishResponse = { status: 'confirmed', catalogObligationPending: true, code: 'CONFIRMED_CATALOG_OBLIGATION_PENDING' };
// @ts-expect-error The client transaction identity is JSON, not raw bigint.
const rawTransactionId: ConfirmedCatalogObligationPendingResponseV1['confirmedTransaction']['batchId'] = 1n;
void [incomplete, rawTransactionId];
