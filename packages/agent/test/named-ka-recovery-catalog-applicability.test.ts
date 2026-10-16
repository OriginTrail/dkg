// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher, type AsyncKnowledgeAssetVmPublishRecoveryEvidence } from '@origintrail-official/dkg-publisher';
import { contextGraphAssertionUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/dkg-agent.js';
import type { FinalizationHandler } from '../src/finalization-handler.js';
import { KA_VM_VALIDATION } from '../../../scripts/testing/ka-vm-publish.js';
import { AUTHOR, TX_HASH, baseRequest, legacyEvidence, seededChain } from './_helpers/named-ka-recovery-fixture.js';

type RecoveryInternals = {
  getOrCreateFinalizationHandler(): Pick<FinalizationHandler, 'handleChainReconciledKC'>;
  _canStampRecoveredKnowledgeAssetVmLifecycle(): Promise<boolean>;
};

async function fixture(legacy: boolean, evidence: AsyncKnowledgeAssetVmPublishRecoveryEvidence = legacyEvidence()) {
  const store = new OxigraphStore();
  const chain = seededChain();
  const agent = await DKGAgent.create({
    name: 'legacy-catalog-recovery', store, chainAdapter: chain,
    rfc64CatalogActivation: { enabled: false },
  });
  // Recovery records this local identity, but the test does not start networking.
  vi.spyOn(agent, 'peerId', 'get').mockReturnValue('12D3KooWRecoveryFixture');
  const original = baseRequest();
  const request = { ...original, contextGraphId: '0x1111111111111111111111111111111111111111/legacy-recovery', agentAddress: AUTHOR,
    seal: { ...original.seal, ...(legacy ? { reservedKaId: undefined } : {}) } };
  // Model already-materialized VM data: the regression is the required catalog tail,
  // not the separate chain-to-VM materializer. Normalization and observer remain real.
  const materialize = vi.fn<FinalizationHandler['handleChainReconciledKC']>(async () => 'already-confirmed');
  vi.spyOn(agent as unknown as RecoveryInternals, 'getOrCreateFinalizationHandler')
    .mockReturnValue({ handleChainReconciledKC: materialize });
  vi.spyOn(agent as unknown as RecoveryInternals, '_canStampRecoveredKnowledgeAssetVmLifecycle')
    .mockResolvedValue(false);
  vi.spyOn(agent, 'getContextGraphOnChainId').mockResolvedValue('1');
  const observer = vi.spyOn(agent, 'observeRfc64ConfirmedVmV1'); // call through; never mock true
  const executor = vi.fn(async () => { throw new Error('recovery must never execute another publication'); });
  const queue = new TripleStoreAsyncLiftPublisher(store, {
    chainProofResolver: async () => ({ status: 'recovered', recovery: evidence }),
    knowledgeAssetVmPublishRecoveryResolver: async () => evidence,
    knowledgeAssetVmPublishHandler: {
      execute: executor,
      finalizeRecovered: input => agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish(input),
    },
  });
  const jobId = await queue.enqueueKnowledgeAssetVmPublish(request);
  expect((await queue.claimNext('legacy-wallet'))?.jobId).toBe(jobId);
  await queue.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
  await queue.update(jobId, 'broadcast', { broadcast: { txHash: TX_HASH, walletId: 'legacy-wallet', operationKind: 'create' } });
  return { agent, store, queue, request, jobId, materialize, observer, executor };
}

describe('named KA recovery catalog applicability', () => {
  it.each([true, false])('finalizes the original confirmed job with catalog disabled (legacy seal=%s)', async legacy => {
    const h = await fixture(legacy);
    try {
      expect(h.request.seal.reservedKaId === undefined).toBe(legacy);
      expect(h.request.kaNumber).toBe('402');
      expect(await h.queue.recover()).toBe(1);
      const finalized = await h.queue.getStatus(h.jobId);
      expect(finalized?.status).toBe('finalized');
      expect(finalized?.jobId).toBe(h.jobId);
      expect(h.materialize).toHaveBeenCalledOnce();
      expect(h.materialize.mock.calls[0]?.[0]).toMatchObject({
        kaId: (BigInt(AUTHOR) << 96n) | 402n,
        ual: h.request.kaUal,
        trustedAssertionEvidence: { transactionHash: TX_HASH, authorAddress: expect.stringMatching(new RegExp(`^${AUTHOR}$`, 'i')) },
      });
      expect(h.observer).toHaveBeenCalledOnce();
      expect(h.observer.mock.calls[0]?.[0].seal.reservedKaId === undefined).toBe(legacy);
      expect(h.executor).not.toHaveBeenCalled();
      const receipt = await h.store.query(`SELECT ?p ?o WHERE { GRAPH <${contextGraphMetaUri(h.request.contextGraphId)}> { <${contextGraphAssertionUri(h.request.contextGraphId, AUTHOR, h.request.name)}> ?p ?o } }`);
      expect(receipt.type).toBe('bindings');
      if (receipt.type !== 'bindings') throw new Error('Expected receipt bindings');
      expect(receipt.bindings.some(row => row.o === `"${TX_HASH}"`)).toBe(true);
      expect(await h.queue.recover()).toBe(0);
      expect(h.materialize).toHaveBeenCalledOnce();
    } finally { await h.agent.stop(); }
  });

  it('keeps a transaction with mismatched canonical evidence held even when catalog is disabled', async () => {
    const evidence = legacyEvidence();
    const h = await fixture(true, { ...evidence, inclusion: { ...evidence.inclusion, txHash: `0x${'99'.repeat(32)}` } });
    try {
      expect(await h.queue.recover()).toBe(0);
      const held = await h.queue.getStatus(h.jobId);
      expect(held?.status).toBe('broadcast');
      expect(held && 'broadcast' in held ? held.broadcast?.txHash : undefined).toBe(TX_HASH);
      expect(h.materialize).not.toHaveBeenCalled();
      expect(h.observer).not.toHaveBeenCalled();
      expect(h.executor).not.toHaveBeenCalled();
    } finally { await h.agent.stop(); }
  });

  it.each(['authority-unavailable', 'active-legacy-seal', 'public-removal-failure', 'private-marker-failure'] as const)(
    'keeps the canonical transaction held for an actual catalog failure (%s)', async failure => {
      const h = await fixture(failure === 'active-legacy-seal');
      const markerFailure = new Error('durable marker write failed');
      const put = vi.fn(async () => { throw markerFailure; });
      const originalPersistence = Reflect.get(h.agent, 'rfc64PersistenceV1');
      type CatalogLaneHost = {
        resolveRfc64CatalogAuthoringLaneV1: DKGAgent['resolveRfc64CatalogAuthoringLaneV1'];
      };
      const resolveLane = vi.spyOn(h.agent as unknown as CatalogLaneHost, 'resolveRfc64CatalogAuthoringLaneV1');
      const remove = vi.spyOn(h.agent, 'commitRfc64ConfirmedInventoryRemovalV1');
      const warn = vi.spyOn(h.agent.log, 'warn');
      try {
        if (failure === 'authority-unavailable') {
          resolveLane.mockImplementation(() => { throw new Error('catalog authority unavailable'); });
        } else {
          // Active-lane selection is the seam here; the facade and canonical observer stay real.
          // Only the fields the observer consumes are needed; no signing authority is fabricated.
          resolveLane.mockReturnValue({
            acceptsFinalizedVmRepair: failure === 'private-marker-failure',
            scopeBase: { networkId: 'otp:20430', contextGraphId: h.request.contextGraphId,
              governanceChainId: null, governanceContractAddress: null,
              ownershipTransitionDigest: null, subGraphName: null, era: '1' },
          } as ReturnType<CatalogLaneHost['resolveRfc64CatalogAuthoringLaneV1']>);
        }
        if (failure === 'public-removal-failure') {
          remove.mockRejectedValue(new Error('inventory removal unavailable'));
        }
        if (failure === 'private-marker-failure') {
          expect(Reflect.set(h.agent, 'rfc64PersistenceV1', { finalizedPrivatePlacementRepairs: { put } })).toBe(true);
        }
        expect(await h.queue.recover()).toBe(0);
        const held = await h.queue.getStatus(h.jobId);
        expect(held?.status).toBe('broadcast');
        expect(held && 'broadcast' in held ? held.broadcast?.txHash : undefined).toBe(TX_HASH);
        expect(h.materialize).toHaveBeenCalledOnce();
        expect(h.observer).toHaveBeenCalledOnce();
        expect(await h.observer.mock.results[0]?.value).toBe(false);
        expect(h.executor).not.toHaveBeenCalled();
        if (failure === 'public-removal-failure') expect(remove).toHaveBeenCalledOnce();
        else expect(remove).not.toHaveBeenCalled();
        if (failure === 'private-marker-failure') {
          expect(put).toHaveBeenCalledOnce();
          expect(warn.mock.calls.some(([, line]) => line.includes(markerFailure.message))).toBe(true);
        } else expect(put).not.toHaveBeenCalled();
      } finally {
        Reflect.set(h.agent, 'rfc64PersistenceV1', originalPersistence);
        await h.agent.stop();
      }
    },
  );
});