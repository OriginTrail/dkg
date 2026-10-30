import { afterEach, describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { MemoryLayer } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/dkg-agent.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';

const agents: DKGAgent[] = [];
afterEach(async () => { await Promise.all(agents.splice(0).map((agent) => agent.stop())); });

describe('write activities in assertion history', () => {
  it.each([undefined, 'science'])('returns a supported WM activity without changing lifecycle state: %s', async (subGraphName) => {
    const wallet = Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    chain.setMockACKSigner(wallet);
    const agent = await DKGAgent.create({
      name: 'WriteHistory', listenHost: '127.0.0.1', listenPort: 0, nodeRole: 'edge',
      chainAdapter: chain, kaNumberAllocator: makeTestKaNumberAllocator(),
      rfc64CatalogActivation: { enabled: false },
    });
    agents.push(agent);
    await agent.start();
    const cg = 'write-history';
    await agent.createContextGraph({ id: cg, name: cg });
    if (subGraphName) await agent.createSubGraph(cg, subGraphName);
    await agent.assertion.create(cg, 'draft', { subGraphName });
    await agent.assertion.write(cg, 'draft', [{ subject: 'urn:history:item', predicate: 'http://schema.org/name', object: '"Written"' }], { subGraphName });
    const history = await agent.assertion.history(cg, 'draft', { subGraphName });
    expect(history).toMatchObject({ state: 'created', memoryLayer: MemoryLayer.WorkingMemory });
    expect(history?.events.map((event) => event.type).sort()).toEqual(['created', 'written']);
    expect(history?.events.find((event) => event.type === 'written')).toMatchObject({
      fromLayer: MemoryLayer.WorkingMemory, toLayer: MemoryLayer.WorkingMemory,
    });
    expect(await agent.assertion.query(cg, 'draft', { subGraphName })).toHaveLength(1);
  });
});
