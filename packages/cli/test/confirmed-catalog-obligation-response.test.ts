import { describe, expect, it, vi } from 'vitest';
import { ConfirmedCatalogObligationErrorV1, type DKGAgent } from '@origintrail-official/dkg-agent';
import { createOperationContext, type AssertionSeal } from '@origintrail-official/dkg-core';
import { confirmedCatalogObligationResponse, handleConfirmedCatalogObligationRecovery } from '../src/daemon/routes/confirmed-catalog-obligation.js';
import { createRequestActor, type RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const AUTHOR = `0x${'11'.repeat(20)}`;
const CONTEXT_GRAPH_ID = `${AUTHOR}/response`;
function sealFor(kaNumber: bigint, assertionVersion = '1'): AssertionSeal {
  return { merkleRoot: new Uint8Array(32).fill(0xab), authorAddress: AUTHOR,
    authorAttestationR: new Uint8Array(32).fill(1), authorAttestationVS: new Uint8Array(32).fill(2),
    authorSchemeVersion: 1, chainId: 31337n, kav10Address: `0x${'22'.repeat(20)}`,
    reservedKaId: (BigInt(AUTHOR) << 96n) | kaNumber, finalizedAtIso: '2026-01-01T00:00:00.000Z',
    contentScopeVersion: 2, kaUal: `did:dkg:evm:31337/${AUTHOR}/${kaNumber}`,
    assertionVersion, publicTripleCount: 1, privateTripleCount: 0, rootEntities: [] };
}

function recoveryEvidence() {
  return new ConfirmedCatalogObligationErrorV1({ contextGraphId: CONTEXT_GRAPH_ID,
    assertionCoordinate: 'asset', seal: sealFor(75n), assertionUri: 'urn:test:asset',
    ctx: createOperationContext('publish'), publicationLabel: 'publish' },
  { txHash: `0x${'ab'.repeat(32)}`, blockNumber: 71, txIndex: 2, batchId: 75n },
  new Error('journal refused')).recoveryEvidence!;
}

function recoveryContext(authentication: Parameters<typeof requestAuthentication>[0]) {
  const owner = vi.fn(async () => {});
  const observe = vi.fn(async () => {});
  const agent: Pick<DKGAgent, 'assertContextGraphOwner' | 'recoverRfc64ConfirmedCatalogObligationV1'> = {
    assertContextGraphOwner: owner, recoverRfc64ConfirmedCatalogObligationV1: observe,
  };
  const response = { writeHead: vi.fn(), end: vi.fn() };
  // Only the transport context is isolated; authentication and evidence use their canonical factories.
  const ctx = { actor: createRequestActor(requestAuthentication(authentication), () => AUTHOR),
    agent, res: response } as unknown as RequestContext;
  return { ctx, owner, observe, status: () => response.writeHead.mock.calls[0][0],
    body: () => JSON.parse(response.end.mock.calls[0][0]) as Record<string, unknown> };
}

describe('the shared confirmed catalog HTTP response contract', () => {
  it.each([false, true])('retains JSON-safe confirmed %s update transaction identity', async update => {
    const seal = sealFor(73n, update ? '2' : '1');
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
    const seal = sealFor(74n);
    expect(confirmedCatalogObligationResponse(new ConfirmedCatalogObligationErrorV1({ contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'asset', seal, assertionUri: 'urn:test:asset', ctx: createOperationContext('publish'), publicationLabel: 'publish' },
    undefined, new Error('journal refused')))).toBeNull();
  });
  it.each(['author', 'curator'] as const)('preserves %s recovery authorization and observer-only success', async role => {
    const caller = role === 'author' ? AUTHOR : `0x${'33'.repeat(20)}`;
    const f = recoveryContext({ kind: 'agent', agentAddress: caller });
    const evidence = recoveryEvidence();
    await handleConfirmedCatalogObligationRecovery(f.ctx, CONTEXT_GRAPH_ID, 'asset', { recovery: evidence });
    expect(f.status()).toBe(200); expect(f.body()).toMatchObject({ status: 'confirmed', catalogObligationPending: false });
    expect(f.observe).toHaveBeenCalledExactlyOnceWith(evidence);
    if (role === 'curator') expect(f.owner).toHaveBeenCalledExactlyOnceWith(CONTEXT_GRAPH_ID, caller, 'recover a confirmed member publication');
    else expect(f.owner).not.toHaveBeenCalled();
  });
  it('refuses anonymous public and unavailable non-author ownership before observation', async () => {
    const evidence = recoveryEvidence();
    const anonymous = recoveryContext({ kind: 'anonymous', mode: 'public' });
    await handleConfirmedCatalogObligationRecovery(anonymous.ctx, CONTEXT_GRAPH_ID, 'asset', { recovery: evidence });
    expect(anonymous.status()).toBe(403); expect(anonymous.observe).not.toHaveBeenCalled();
    const foreign = recoveryContext({ kind: 'agent', agentAddress: `0x${'33'.repeat(20)}` });
    foreign.owner.mockRejectedValueOnce(new Error('ownership unavailable'));
    await handleConfirmedCatalogObligationRecovery(foreign.ctx, CONTEXT_GRAPH_ID, 'asset', { recovery: evidence });
    expect(foreign.status()).toBe(403); expect(foreign.observe).not.toHaveBeenCalled();
  });
  it.each([
    { name: 'missing evidence', value: undefined, status: 400 },
    { name: 'malformed seal', value: { ...recoveryEvidence(), seal: {} }, status: 409 },
    { name: 'another graph', value: { ...recoveryEvidence(), contextGraphId: `${AUTHOR}/other` }, status: 400 },
  ])('preserves $name refusal before observer execution', async ({ value, status }) => {
    const f = recoveryContext({ kind: 'agent', agentAddress: AUTHOR });
    await handleConfirmedCatalogObligationRecovery(f.ctx, CONTEXT_GRAPH_ID, 'asset', { recovery: value });
    expect(f.status()).toBe(status); expect(f.observe).not.toHaveBeenCalled();
  });
  it.each([false, true])('preserves observer refusal status and retry evidence (invalid=%s)', async invalid => {
    const f = recoveryContext({ kind: 'agent', agentAddress: AUTHOR }); const evidence = recoveryEvidence();
    f.observe.mockRejectedValueOnce(Object.assign(new Error('observation refused'),
      invalid ? { code: 'CONFIRMED_CATALOG_RECOVERY_INVALID' } : {}));
    await handleConfirmedCatalogObligationRecovery(f.ctx, CONTEXT_GRAPH_ID, 'asset', { recovery: evidence });
    expect(f.status()).toBe(invalid ? 409 : 503);
    expect(f.body()).toMatchObject({ recovery: evidence, retryAction: 'observe_confirmed_catalog_obligation' });
  });
});
