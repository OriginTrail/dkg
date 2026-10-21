import { expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { MemoryLayer, assertionLifecycleUri, contextGraphAssertionUri, contextGraphMetaUri, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { DKGAgent } from '../src/dkg-agent.js';
import { NamedKaVmLifecycleRepair } from '../src/named-ka-vm-lifecycle-repair.js';
import { applyPublishedNamedKaVmLifecycle } from '../src/named-ka-vm-lifecycle.js';

it('repairs graph markers produced by real create, finalize and promote without resurrecting WM metadata', async () => {
  const wallet = new ethers.Wallet(`0x${'11'.repeat(32)}`), author = wallet.address;
  const store = new OxigraphStore(), chain = new MockChainAdapter();
  const agent = await DKGAgent.create({ name: 'lifecycle-markers', kaNumberAllocator: makeTestKaNumberAllocator(), store, chainAdapter: chain, rfc64CatalogActivation: { enabled: false } });
  const cg = 'lifecycle-markers', name = 'asset', ontology = 'http://dkg.io/ontology/';
  vi.spyOn(agent, 'peerId', 'get').mockReturnValue('12D3KooWLifecycleMarkers');
  vi.spyOn(agent, 'getContextGraphOnChainId').mockResolvedValue('1');
  let repair: NamedKaVmLifecycleRepair | undefined;
  try {
    await agent.assertion.create(cg, name, { agentAddress: author });
    await agent.assertion.write(cg, name, [{ subject: 'urn:markers', predicate: 'urn:value', object: '"payload"' }], { agentAddress: author });
    const seal = await agent.assertion.finalize(cg, name, {
      agentAddress: author, authorAgentAddress: author, authorSignTypedData: async data => {
        const signature = ethers.Signature.from(await wallet.signTypedData(data.domain, data.types, data.message));
        return { r: ethers.getBytes(signature.r), vs: ethers.getBytes(signature.yParityAndS) };
      },
    });
    await agent.publisher.assertionPromote(cg, name, author);
    const scope = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion);
    const wm = knowledgeAssetLayerGraphUri(cg, MemoryLayer.WorkingMemory, scope);
    const swm = knowledgeAssetLayerGraphUri(cg, MemoryLayer.SharedWorkingMemory, scope);
    const vm = knowledgeAssetLayerGraphUri(cg, MemoryLayer.VerifiableMemory, scope);
    const meta = contextGraphMetaUri(cg);
    const layers = async () => {
      const result = await store.query(`SELECT ?s ?layer WHERE { GRAPH <${meta}> { ?s <${ontology}memoryLayer> ?layer } }`);
      if (result.type !== 'bindings') throw new Error('expected bindings');
      return result.bindings.map(row => [row.s, row.layer]).sort();
    };
    expect(await layers()).toContainEqual([swm, '"SWM"']);
    let fail = true, now = 1000;
    const update = store.atomicUpdate.bind(store);
    vi.spyOn(store, 'atomicUpdate').mockImplementation(async (...args) => {
      if (fail) throw new Error('injected lifecycle write timeout');
      return update(...args);
    });
    repair = new NamedKaVmLifecycleRepair({ writeLocks: agent.writeLocks, now: () => now,
      apply: input => applyPublishedNamedKaVmLifecycle(store, input, { persistence: 'process-local' }),
      isCurrent: async () => true, warn: () => {} });
    expect(await repair.submit({ contextGraphId: cg, name, agentAddress: author,
      packedKaId: seal.reservedKaId, publishedUal: seal.kaUal, assertionVersion: seal.assertionVersion,
      merkleRoot: ethers.hexlify(seal.merkleRoot), publicationDeployment: { chainId: seal.chainId.toString(), lifecycleAddress: seal.kav10Address },
    })).toBe('pending');
    fail = false; now += 6000; await repair.runDue();
    expect(await layers()).toEqual([
      [assertionLifecycleUri(cg, author, name), '"VM"'],
      [contextGraphAssertionUri(cg, author, name), '"VM"'], [vm, '"VM"'],
    ].sort());
    expect(await layers()).not.toContainEqual([wm, '"VM"']);
    expect(await agent.assertion.history(cg, name, { agentAddress: author })).toMatchObject({ state: 'published', publishedUal: seal.kaUal });
  } finally { await repair?.stop(); vi.restoreAllMocks(); await agent.stop(); }
});
