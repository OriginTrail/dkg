import { describe, expect, it } from 'vitest';
import { ConfirmedCatalogObligationErrorV1 } from '@origintrail-official/dkg-agent';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { confirmedCatalogObligationResponse } from '../src/daemon/routes/confirmed-catalog-obligation.js';
import { authorSealV1, assertionSealV1, AUTHOR, CONTEXT_GRAPH_ID } from '../../agent/test/support/rfc64-local-catalog-repair-fixture.js';

describe('the shared confirmed catalog HTTP response contract', () => {
  it.each([false, true])('retains JSON-safe confirmed %s update transaction identity', async update => {
    const seal = assertionSealV1(await authorSealV1(73n, update ? '2' : '1'));
    const transaction = { txHash: `0x${'ab'.repeat(32)}`, blockNumber: 71, txIndex: 2,
      batchId: seal.reservedKaId!, kaId: seal.reservedKaId!,
      ...(!update ? { startKAId: seal.reservedKaId!, endKAId: seal.reservedKaId! } : {}) };
    const error = new ConfirmedCatalogObligationErrorV1({ contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'asset', seal, assertionUri: 'urn:test:asset', ctx: createOperationContext('publish'), publicationLabel: 'publish' },
    transaction, new Error('journal refused'));
    const response = confirmedCatalogObligationResponse(error)!;
    expect(response.catalogObligationPending).toBe(true);
    expect(response.code).toBe('CONFIRMED_CATALOG_OBLIGATION_PENDING');
    expect(response.status).toBe('confirmed');
    expect(response.authorAddress).toBe(AUTHOR);
    expect(response.confirmedTransaction).toMatchObject({ txHash: transaction.txHash,
      blockNumber: 71, txIndex: 2, kaId: transaction.kaId.toString(), batchId: transaction.batchId.toString() });
    expect(response.confirmedTransaction.startKAId).toBe(update ? undefined : transaction.startKAId?.toString());
    expect(JSON.parse(JSON.stringify(response)).recovery).toEqual(error.recoveryEvidence);
    expect(response.retryAction).toBe('observe_confirmed_catalog_obligation');
    expect(response.retryUrl).toBe('/api/knowledge-assets/asset/vm/observe-confirmed');
  });
  it('cannot fabricate a confirmed response for an ordinary error or missing transaction', async () => {
    expect(confirmedCatalogObligationResponse(new Error('not confirmed'))).toBeNull();
    const seal = assertionSealV1(await authorSealV1(74n));
    expect(confirmedCatalogObligationResponse(new ConfirmedCatalogObligationErrorV1({ contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'asset', seal, assertionUri: 'urn:test:asset', ctx: createOperationContext('publish'), publicationLabel: 'publish' },
    undefined, new Error('journal refused')))).toBeNull();
  });
});
