// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { GRAPH_KA_CONTENT_SCOPE_VERSION, contextGraphLayerUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/dkg-agent.js';
import { descriptorRepairFixture } from './_helpers/descriptor-repair-fixture.js';
import { AUTHOR, seededChain } from './_helpers/named-ka-recovery-fixture.js';

const DKG = 'http://dkg.io/ontology/';
function gate() {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  return { held, release };
}

describe('repair and the real agent draft writer share their lifecycle lock', () => {
  it.each(['repair', 'writer'].flatMap(first => ['wallet', 'peer'].map(owner => ({ first, owner }))))(
    'preserves a new draft with $first entering first and $owner lifecycle ownership', async ({ first, owner }) => {
    const peerOwner = '12D3KooWJqhnnfouiNRUyJBEREpuKtV4A448LUbS6JiVCe8Q82bZ';
    const h = await descriptorRepairFixture(1, AUTHOR, owner === 'peer' ? peerOwner : undefined);
    await h.store.deleteByPattern({ graph: h.graph, subject: h.subject, predicate: DKG + 'kaId' });
    await h.store.insert([{ ...h.row('kaId', '402'), object: '"402"^^<http://www.w3.org/2001/XMLSchema#integer>' },
      h.row('contentScopeVersion', String(GRAPH_KA_CONTENT_SCOPE_VERSION))]);
    const chain = Object.assign(seededChain(), h.chain);
    const agent = await DKGAgent.create({ name: 'repair-serialization', store: h.store, chainAdapter: chain,
      rfc64CatalogActivation: { enabled: false } });
    vi.spyOn(agent, 'peerId', 'get').mockReturnValue('12D3KooWRepairSerialization');
    vi.spyOn(agent, 'getContextGraphOnChainId').mockResolvedValue('1');
    // UAL author is lowercase; the production writer uses the retained checksummed subject.
    const author = owner === 'peer' ? peerOwner : ethers.getAddress(AUTHOR);
    const input = { ...h.input, ...(owner === 'peer' ? { lifecycleOwner: author } : {}) };
    expect(author).not.toBe(AUTHOR);
    const entered = gate(); const release = gate();
    const before = await h.all();
    const read = h.chain.readKnowledgeAssetVersionSnapshot;
    const insert = h.store.insert.bind(h.store);
    let writerReachedStore = false;
    let proofReachedChain = false;
    read.mockImplementation(async () => {
      proofReachedChain = true;
      if (first === 'repair') { entered.release(); await release.held; }
      return h.snapshot;
    });
    vi.spyOn(h.store, 'insert').mockImplementation(async quads => {
      if (quads.some(q => q.subject === h.subject && q.predicate === DKG + 'state' && q.object === '"created"')) {
        writerReachedStore = true;
        if (first === 'writer') { entered.release(); await release.held; }
      }
      return insert(quads);
    });
    const repair = () => agent.repairPublishedKnowledgeAssetDescriptor({ ...input, dryRun: false });
    const create = () => agent.assertion.create(h.input.contextGraphId, h.input.name, { agentAddress: author });
    let pendingRepair: ReturnType<typeof repair> | undefined;
    let pendingCreate: ReturnType<typeof create> | undefined;
    try {
      if (first === 'repair') pendingRepair = repair(); else pendingCreate = create();
      await entered.held;
      if (first === 'repair') pendingCreate = create(); else pendingRepair = repair();
      // Give the competing public API a complete event-loop turn to acquire its lock.
      await new Promise<void>(resolve => setImmediate(resolve));
      if (first === 'repair') { expect(writerReachedStore).toBe(false); expect(await h.all()).toEqual(before); }
      else expect(proofReachedChain).toBe(false);
      const checkedRepair = first === 'repair'
        ? expect(pendingRepair).resolves.toMatchObject({ status: 'repaired' })
        : expect(pendingRepair).rejects.toThrow('state exists');
      release.release();
      await Promise.all([checkedRepair, pendingCreate]);
      const wm = contextGraphLayerUri(h.input.contextGraphId, MemoryLayer.WorkingMemory, AUTHOR, 402n);
      const draft = [{ graph: wm, subject: 'urn:new:draft', predicate: 'urn:body', object: '"newer draft must survive"' }];
      await agent.assertion.write(h.input.contextGraphId, h.input.name, draft, { agentAddress: author });
      const history = await agent.assertion.history(h.input.contextGraphId, h.input.name, { agentAddress: owner === 'peer' ? author : AUTHOR });
      expect(history).toMatchObject({ state: 'created', kaNumber: '402', vmCurrentAssertion: h.snapshot.latestRoot.slice(2) });
      const rows = await h.all();
      const refused = agent.repairPublishedKnowledgeAssetDescriptor({ ...input, dryRun: false });
      await expect(refused).rejects.toThrow('state exists');
      expect(await h.all()).toEqual(rows);
      const content = await h.store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${wm}> { ?s ?p ?o } }`);
      expect(content.type === 'quads' && content.quads.map(q => ({ ...q, graph: wm }))).toEqual(draft);
    } finally {
      release.release();
      await Promise.allSettled([pendingRepair, pendingCreate]);
      vi.restoreAllMocks(); await agent.stop();
    }
  });
});


it('waits behind real finalization and preserves its newer root and version', async () => {
  const wallet = new ethers.Wallet(`0x${'11'.repeat(32)}`);
  const author = wallet.address;
  const h = await descriptorRepairFixture(1, author.toLowerCase());
  await h.store.deleteByPattern({ graph: h.graph, subject: h.subject, predicate: DKG + 'kaId' });
  await h.store.insert([{ ...h.row('kaId', '402'), object: '"402"^^<http://www.w3.org/2001/XMLSchema#integer>' },
    h.row('contentScopeVersion', String(GRAPH_KA_CONTENT_SCOPE_VERSION))]);
  const agent = await DKGAgent.create({ name: 'finalize-repair-serialization', store: h.store,
    chainAdapter: Object.assign(seededChain(), h.chain), rfc64CatalogActivation: { enabled: false } });
  vi.spyOn(agent, 'peerId', 'get').mockReturnValue('12D3KooWRepairSerialization');
  vi.spyOn(agent, 'getContextGraphOnChainId').mockResolvedValue('1');
  const entered = gate(); const release = gate();
  let pendingFinalize: ReturnType<typeof agent.assertion.finalize> | undefined;
  let pendingRepair: ReturnType<typeof agent.repairPublishedKnowledgeAssetDescriptor> | undefined;
  try {
    await agent.assertion.create(h.input.contextGraphId, h.input.name, { agentAddress: author });
    await agent.assertion.write(h.input.contextGraphId, h.input.name,
      [{ graph: '', subject: 'urn:new:draft', predicate: 'urn:body', object: '"new root"' }], { agentAddress: author });
    pendingFinalize = agent.assertion.finalize(h.input.contextGraphId, h.input.name, {
      agentAddress: author, authorAgentAddress: author, authorSignTypedData: async data => {
        entered.release(); await release.held;
        const sig = ethers.Signature.from(await wallet.signTypedData(data.domain, data.types, data.message));
        return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
      },
    });
    await Promise.race([entered.held, pendingFinalize.then(() => { throw new Error('finalize never reached signer'); })]);
    h.chain.readKnowledgeAssetVersionSnapshot.mockClear();
    pendingRepair = agent.repairPublishedKnowledgeAssetDescriptor({ ...h.input, dryRun: false });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.chain.readKnowledgeAssetVersionSnapshot).not.toHaveBeenCalled();
    const refused = expect(pendingRepair).rejects.toThrow('state exists');
    release.release();
    const finalized = await pendingFinalize; await refused;
    const history = await agent.assertion.history(h.input.contextGraphId, h.input.name, { agentAddress: author.toLowerCase() });
    expect(finalized.assertionVersion).toBe('2');
    expect(history).toMatchObject({ state: 'created', wmCurrentAssertion: ethers.hexlify(finalized.merkleRoot).slice(2),
      vmCurrentAssertion: h.snapshot.latestRoot.slice(2) });
    expect(history?.wmCurrentAssertion).not.toBe(history?.vmCurrentAssertion);
    const rows = await h.all();
    await expect(agent.repairPublishedKnowledgeAssetDescriptor({ ...h.input, dryRun: false })).rejects.toThrow('state exists');
    expect(await h.all()).toEqual(rows);
  } finally {
    release.release(); await Promise.allSettled([pendingFinalize, pendingRepair]);
    vi.restoreAllMocks(); await agent.stop();
  }
});
