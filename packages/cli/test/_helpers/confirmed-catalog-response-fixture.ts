import { ConfirmedCatalogObligationErrorV1, parseConfirmedCatalogObligationRecoveryV1 } from '@origintrail-official/dkg-agent';
import { contextGraphAssertionUri, createOperationContext } from '@origintrail-official/dkg-core';
import { confirmedCatalogObligationResponse } from '../../src/daemon/routes/confirmed-catalog-obligation.js';

/** A JSON wire response produced by a confirmed transaction whose local marker write refused. */
export function confirmedCatalogPendingFixture() {
  const author = `0x${'11'.repeat(20)}`, contextGraphId = `${author}/response`;
  const id = (BigInt(author) << 96n) | 75n;
  const error = new ConfirmedCatalogObligationErrorV1({ contextGraphId, assertionCoordinate: 'asset',
    assertionUri: contextGraphAssertionUri(contextGraphId, author, 'asset'),
    ctx: createOperationContext('publish'), publicationLabel: 'publish',
    seal: { merkleRoot: new Uint8Array(32).fill(0xab), authorAddress: author,
      authorAttestationR: new Uint8Array(32).fill(1), authorAttestationVS: new Uint8Array(32).fill(2),
      authorSchemeVersion: 1, chainId: 31337n, kav10Address: `0x${'22'.repeat(20)}`, reservedKaId: id,
      finalizedAtIso: '2026-01-01T00:00:00.000Z', contentScopeVersion: 2,
      kaUal: `did:dkg:evm:31337/${author}/75`, assertionVersion: '1', publicTripleCount: 1, privateTripleCount: 0, rootEntities: [] },
  }, { txHash: `0x${'ab'.repeat(32)}`, blockNumber: 71, txIndex: 2, batchId: id }, new Error('marker write refused'));
  const response = confirmedCatalogObligationResponse(error)!;
  parseConfirmedCatalogObligationRecoveryV1(response.recovery);
  return JSON.parse(JSON.stringify(response)) as typeof response;
}
