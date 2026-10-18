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
describe('confirmed named KA descriptor recovery [#3362]', () => {
  it('repairs an interrupted state replacement before finalizing the original job', async () => {
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({ name: 'descriptor-recovery', store, chainAdapter: seededChain(),
      rfc64CatalogActivation: { enabled: false } });
    vi.spyOn(agent, 'peerId', 'get').mockReturnValue('12D3KooWRecoveryFixture');
    const request = { ...baseRequest(), agentAddress: AUTHOR };
    const graph = contextGraphMetaUri(request.contextGraphId);
    const subject = assertionLifecycleUri(request.contextGraphId, AUTHOR, request.name);
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
        ...Object.entries({ state: 'promoted', assertionName: request.name, kaId: '402',
          reservedUal: request.kaUal!, shareOperationId: request.shareOperationId,
          assertionVersion: request.assertionVersion!, swmCurrentAssertion: request.sealMerkleRoot.slice(2),
          wmCurrentAssertion: request.sealMerkleRoot.slice(2) }).map(([p, value]) => ({ graph, subject,
          predicate: DKG + p, object: JSON.stringify(value) + (p === 'kaId' ? '^^<http://www.w3.org/2001/XMLSchema#integer>' : '') })),
        { graph, subject, predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: `did:dkg:agent:${AUTHOR}` },
      ]);
      // Exercise the actual v10.0.24-compatible ordered writer, not a synthetic row deletion.
      const insert = store.insert.bind(store);
      const fault = vi.spyOn(store, 'insert').mockImplementation(async quads => {
        if (quads.some(q => q.subject === subject && q.predicate === DKG + 'state')) throw new Error('injected store timeout');
        await insert(quads);
      });
      await expect(applyPublishedNamedKaVmLifecycle(store, { contextGraphId: request.contextGraphId,
        agentAddress: AUTHOR, name: request.name, publishedUal: request.kaUal!,
        merkleRoot: request.sealMerkleRoot, packedKaId: BigInt(request.seal.reservedKaId!) })).rejects.toThrow('injected store timeout');
      fault.mockRestore();
      expect(await agent.assertion.history(request.contextGraphId, request.name, { agentAddress: AUTHOR })).toBeNull();
      expect(await agent.assertion.resolveByKaId(request.contextGraphId, BigInt(request.seal.reservedKaId!))).toBeNull();
      // VM is already materialized. Keep canonical evidence normalization and queue transitions real.
      vi.spyOn(agent as any, 'getOrCreateFinalizationHandler').mockReturnValue({ handleChainReconciledKC: async () => 'already-confirmed' });
      vi.spyOn(agent, 'getContextGraphOnChainId').mockResolvedValue('1');
      const jobId = await queue.enqueueKnowledgeAssetVmPublish(request);
      await queue.claimNext('wallet');
      await queue.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
      await queue.update(jobId, 'broadcast', { broadcast: { txHash: TX_HASH, walletId: 'wallet', operationKind: 'create' } });
      // A second transient failure must retain the same tx-bearing owner.
      const update = store.update.bind(store);
      const repairFault = vi.spyOn(store, 'update').mockImplementation(async (query, options) => {
        if (options?.source === 'agent.publish.namedKaVmLifecycle') throw new Error('repair temporarily unavailable');
        return update(query, options);
      });
      expect(await queue.recover()).toBe(0);
      expect((await queue.getStatus(jobId))?.status).toBe('broadcast');
      repairFault.mockRestore();
      expect(await queue.recover()).toBe(1);
      expect((await queue.getStatus(jobId))?.status).toBe('finalized');
      const descriptor = await agent.assertion.history(request.contextGraphId, request.name, { agentAddress: AUTHOR });
      expect(descriptor).toMatchObject({ state: 'published', kaNumber: '402', publishedUal: request.kaUal,
        vmCurrentAssertion: request.sealMerkleRoot.slice(2) });
      expect(await agent.assertion.resolveByKaId(request.contextGraphId, BigInt(request.seal.reservedKaId!))).toEqual(descriptor);
      expect(await queue.clearTerminalJob(jobId)).toEqual({ outcome: 'cleared' });
      expect(await agent.assertion.history(request.contextGraphId, request.name, { agentAddress: AUTHOR })).toEqual(descriptor);
      const vm = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${vmGraph}> { ?s ?p ?o } }`);
      expect(vm.type === 'quads' && vm.quads.map(q => ({ ...q, graph: vmGraph }))).toEqual(content);
      expect(executor).not.toHaveBeenCalled();
    } finally { await agent.stop(); }
  });
});
