// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '@origintrail-official/dkg-publisher';
import { assertionLifecycleUri, contextGraphMetaUri, contextGraphLayerUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/dkg-agent.js';
import { applyPublishedNamedKaVmLifecycle } from '../src/named-ka-vm-lifecycle.js';
import { KA_VM_VALIDATION } from '../../../scripts/testing/ka-vm-publish.js';
import { AUTHOR, TX_HASH, baseRequest, legacyEvidence, seededChain } from './_helpers/named-ka-recovery-fixture.js';

const DKG = 'http://dkg.io/ontology/';
async function promptly<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('queue blocked behind lifecycle writer')), 1_000);
    })]);
  } finally { clearTimeout(timer); }
}
describe('confirmed named KA descriptor recovery [#3362]', () => {
  it.each([AUTHOR, '12D3KooWJqhnnfouiNRUyJBEREpuKtV4A448LUbS6JiVCe8Q82bZ'])('repairs an interrupted state replacement for lifecycle owner %s before finalizing the original job', async lifecycleOwner => {
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({ name: 'descriptor-recovery', store, chainAdapter: seededChain(),
      rfc64CatalogActivation: { enabled: false } });
    vi.spyOn(agent, 'peerId', 'get').mockReturnValue('12D3KooWRecoveryFixture');
    const request = { ...baseRequest(), agentAddress: lifecycleOwner };
    const graph = contextGraphMetaUri(request.contextGraphId);
    const subject = assertionLifecycleUri(request.contextGraphId, lifecycleOwner, request.name);
    const vmGraph = contextGraphLayerUri(request.contextGraphId, MemoryLayer.VerifiableMemory, AUTHOR, 402n);
    const content = [{ graph: vmGraph, subject: 'urn:receipt:document', predicate: 'urn:content', object: '"accepted revision"' }];
    const executor = vi.fn(async () => { throw new Error('must never publish again'); });
    const queue = new TripleStoreAsyncLiftPublisher(store, {
      chainProofResolver: async () => ({ status: 'recovered', recovery: legacyEvidence() }),
      knowledgeAssetVmPublishRecoveryResolver: async () => legacyEvidence(),
      knowledgeAssetVmPublishHandler: { execute: executor,
        finalizeRecovered: input => agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish(input) },
    });
    try {
      await store.insert([
        ...content,
        { graph, subject, predicate: DKG + 'assertionGraph', object: vmGraph },
        ...Object.entries({ state: 'promoted', assertionName: request.name, kaId: '402',
          reservedUal: request.kaUal!, shareOperationId: request.shareOperationId,
          assertionVersion: request.assertionVersion!, swmCurrentAssertion: request.sealMerkleRoot.slice(2),
          wmCurrentAssertion: request.sealMerkleRoot.slice(2) }).map(([p, value]) => ({ graph, subject,
          predicate: DKG + p, object: JSON.stringify(value) + (p === 'kaId' ? '^^<http://www.w3.org/2001/XMLSchema#integer>' : '') })),
        { graph, subject, predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: `did:dkg:agent:${lifecycleOwner}` },
      ]);
      // Existing packed-ID lookup filters lifecycle owners to the wallet namespace.
      // Establish its pre-fault behavior for a peer-owned lifecycle independently
      // of recovery; the owner-scoped history API is the supported lookup here.
      let peerLookupBefore: Awaited<ReturnType<typeof agent.assertion.resolveByKaId>>;
      if (lifecycleOwner !== AUTHOR) {
        await applyPublishedNamedKaVmLifecycle(store, { contextGraphId: request.contextGraphId,
          agentAddress: lifecycleOwner, name: request.name, publishedUal: request.kaUal!,
          merkleRoot: request.sealMerkleRoot, packedKaId: BigInt(request.seal.reservedKaId!) });
        expect(await agent.assertion.history(request.contextGraphId, request.name, { agentAddress: lifecycleOwner }))
          .toMatchObject({ state: 'published' });
        peerLookupBefore = await agent.assertion.resolveByKaId(request.contextGraphId, BigInt(request.seal.reservedKaId!));
        expect(peerLookupBefore).toBeNull();
      }
      // Exercise the actual v10.0.24-compatible ordered writer, not a synthetic row deletion.
      const insert = store.insert.bind(store);
      const fault = vi.spyOn(store, 'insert').mockImplementation(async quads => {
        if (quads.some(q => q.subject === subject && q.predicate === DKG + 'state')) throw new Error('injected store timeout');
        await insert(quads);
      });
      await expect(applyPublishedNamedKaVmLifecycle(store, { contextGraphId: request.contextGraphId,
        agentAddress: lifecycleOwner, name: request.name, publishedUal: request.kaUal!,
        merkleRoot: request.sealMerkleRoot, packedKaId: BigInt(request.seal.reservedKaId!) })).rejects.toThrow('injected store timeout');
      fault.mockRestore();
      expect(await agent.assertion.history(request.contextGraphId, request.name, { agentAddress: lifecycleOwner })).toBeNull();
      expect(await agent.assertion.resolveByKaId(request.contextGraphId, BigInt(request.seal.reservedKaId!))).toBeNull();
      // VM is already materialized. Keep canonical evidence normalization and queue transitions real.
      vi.spyOn(agent as any, 'getOrCreateFinalizationHandler').mockReturnValue({ handleChainReconciledKC: async () => 'already-confirmed' });
      vi.spyOn(agent, 'getContextGraphOnChainId').mockResolvedValue('1');
      const jobId = await queue.enqueueKnowledgeAssetVmPublish(request);
      await queue.claimNext('wallet');
      await queue.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
      await queue.update(jobId, 'broadcast', { broadcast: { txHash: TX_HASH, walletId: 'wallet', operationKind: 'create' } });
      // The real seal-preparation entry holds the same lock as user finalization.
      // Recovery must release the global queue lock without queuing a late stamp.
      let entered!: () => void; let release!: () => void;
      const writerEntered = new Promise<void>(resolve => { entered = resolve; });
      const writerHeld = new Promise<void>(resolve => { release = resolve; });
      const writer = (agent as any).publisher.prepareAssertionShareSeal(
        request.contextGraphId, request.name, lifecycleOwner, undefined,
        async () => { entered(); await writerHeld; },
      ) as Promise<void>;
      let recovery: Promise<number> | undefined;
      try {
        await writerEntered;
        recovery = queue.recover();
        expect(await promptly(recovery)).toBe(0);
        expect((await queue.getStatus(jobId))?.status).toBe('broadcast');
        const otherId = await promptly(queue.enqueueKnowledgeAssetVmPublish({ ...request,
          name: 'unrelated', shareOperationId: 'unrelated', intentKey: `sha256:${'cd'.repeat(32)}` }));
        expect((await promptly(queue.claimNext('other-wallet')))?.jobId).toBe(otherId);
      } finally {
        release(); await writer; await recovery;
      }
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(await agent.assertion.history(request.contextGraphId, request.name, { agentAddress: lifecycleOwner })).toBeNull();
      expect((await queue.getStatus(jobId))?.status).toBe('broadcast');
      // A second transient failure must retain the same tx-bearing owner.
      // Force the supported ordered fallback. Arm the original destructive-proof fault;
      // an incomplete repair must never reach either deletion, even on repeated attempts.
      (agent as any).publishedNamedKaVmLifecycleWriter = (input: Parameters<typeof applyPublishedNamedKaVmLifecycle>[1]) =>
        applyPublishedNamedKaVmLifecycle(store, input);
      const remove = store.deleteByPatternWithoutCount.bind(store);
      let proofDeletes = 0;
      vi.spyOn(store, 'deleteByPatternWithoutCount').mockImplementation(async pattern => {
        await remove(pattern);
        if (pattern.subject === subject && ['vmCurrentAssertion', 'memoryLayer'].some(p => pattern.predicate === DKG + p)) {
          proofDeletes++; throw new Error('failure after required recovery proof deletion');
        }
      });
      const repairFault = vi.spyOn(store, 'insert').mockImplementation(async quads => {
        if (quads.some(q => q.predicate === DKG + 'state')) throw new Error('repair temporarily unavailable');
        return insert(quads);
      });
      expect(await queue.recover()).toBe(0);
      expect((await queue.getStatus(jobId))?.status).toBe('broadcast');
      expect(proofDeletes).toBe(0);
      repairFault.mockRestore();
      expect(await queue.recover()).toBe(1);
      expect((await queue.getStatus(jobId))?.status).toBe('finalized');
      expect(proofDeletes).toBe(0);
      const descriptor = await agent.assertion.history(request.contextGraphId, request.name, { agentAddress: lifecycleOwner });
      expect(descriptor).toMatchObject({ state: 'published', kaNumber: '402', publishedUal: request.kaUal,
        vmCurrentAssertion: request.sealMerkleRoot.slice(2) });
      expect(await agent.assertion.resolveByKaId(request.contextGraphId, BigInt(request.seal.reservedKaId!)))
        .toEqual(lifecycleOwner === AUTHOR ? descriptor : peerLookupBefore!);
      expect(await queue.clearTerminalJob(jobId)).toEqual({ outcome: 'cleared' });
      expect(await agent.assertion.history(request.contextGraphId, request.name, { agentAddress: lifecycleOwner })).toEqual(descriptor);
      const vm = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${vmGraph}> { ?s ?p ?o } }`);
      expect(vm.type === 'quads' && vm.quads.map(q => ({ ...q, graph: vmGraph }))).toEqual(content);
      expect(executor).not.toHaveBeenCalled();
    } finally { await agent.stop(); }
  });
});
