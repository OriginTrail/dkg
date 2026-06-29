import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/index.js';
import { MockChainAdapter, NoChainAdapter } from '@origintrail-official/dkg-chain';

async function makeAgent(chain: MockChainAdapter | NoChainAdapter): Promise<DKGAgent> {
  return DKGAgent.create({
    name: 'PcaV10Facade',
    listenHost: '127.0.0.1',
    listenPort: 0,
    chainAdapter: chain,
    nodeRole: 'core',
  });
}

describe('DKGAgent V10 PCA facade', () => {
  it('createPublishingConvictionAccount delegates to the chain adapter and getPublishingConvictionAccountInfo reflects it', async () => {
    const owner = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', owner.address);
    const agent = await makeAgent(chain);

    // OT-RFC-51: primaryNode is now required (no silent 0n default). The mock
    // adapter accepts it for parity but doesn't model per-node allocation.
    const created = await agent.createPublishingConvictionAccount(1_000n, 42n);
    expect(created).not.toBeNull();
    expect(created!.accountId).toBeGreaterThan(0n);
    expect(created!.hash).toMatch(/^0x/);

    const info = await agent.getPublishingConvictionAccountInfo(created!.accountId);
    expect(info).not.toBeNull();
    expect(info!.owner.toLowerCase()).toBe(owner.address.toLowerCase());
    expect(info!.committedTRAC).toBe(1_000n);
  });

  it('supportsPublishingConvictionNft is true when the adapter exposes the V10 surface', async () => {
    const chain = new MockChainAdapter('mock:31337', ethers.Wallet.createRandom().address);
    const agent = await makeAgent(chain);
    expect(agent.supportsPublishingConvictionNft).toBe(true);
  });

  it('supportsPublishingConvictionNft is false when the adapter lacks the V10 surface', async () => {
    const agent = await makeAgent(new NoChainAdapter());
    expect(agent.supportsPublishingConvictionNft).toBe(false);
  });

  it('getPublishingConvictionAgents delegates to the adapter (checksummed list)', async () => {
    const owner = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', owner.address);
    const agent = await makeAgent(chain);
    const created = await agent.createPublishingConvictionAccount(1_000n, 42n);
    const wallet = ethers.Wallet.createRandom().address;
    await agent.registerPublishingConvictionAgent(created!.accountId, wallet);
    expect(await agent.getPublishingConvictionAgents(created!.accountId)).toEqual([ethers.getAddress(wallet)]);
  });

  it('getPublishingConvictionAgents returns null when the adapter lacks the surface', async () => {
    const agent = await makeAgent(new NoChainAdapter());
    expect(await agent.getPublishingConvictionAgents(1n)).toBeNull();
  });

  it('getConvictionAgentAccountId delegates: registered wallet → its account id, unregistered → 0n', async () => {
    const owner = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', owner.address);
    const agent = await makeAgent(chain);
    const created = await agent.createPublishingConvictionAccount(1_000n, 42n);
    const wallet = ethers.Wallet.createRandom().address;
    await agent.registerPublishingConvictionAgent(created!.accountId, wallet);
    expect(await agent.getConvictionAgentAccountId(wallet)).toBe(created!.accountId);
    // Unregistered wallet → 0n (the chain "not registered" sentinel), not null.
    expect(await agent.getConvictionAgentAccountId(ethers.Wallet.createRandom().address)).toBe(0n);
  });

  it('getConvictionAgentAccountId returns null when the adapter lacks the surface', async () => {
    const agent = await makeAgent(new NoChainAdapter());
    expect(await agent.getConvictionAgentAccountId(ethers.Wallet.createRandom().address)).toBeNull();
  });

  it('getPublishingConvictionAccountInfo threads { extended } through to the adapter (GAP-4/5)', async () => {
    const owner = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', owner.address);
    const agent = await makeAgent(chain);
    const created = await agent.createPublishingConvictionAccount(1_000n, 42n);
    // Default delegation omits the extended fields.
    const base = (await agent.getPublishingConvictionAccountInfo(created!.accountId))!;
    expect(base.primaryNode).toBeUndefined();
    expect(base.remainingAllowance).toBeUndefined();
    // Extended delegation surfaces them (mock stubs).
    const ext = (await agent.getPublishingConvictionAccountInfo(created!.accountId, { extended: true }))!;
    expect(ext.primaryNode).toBe(0n);
    expect(typeof ext.currentEpoch).toBe('number');
    expect(ext.remainingAllowance).toBe(ext.baseEpochAllowance + ext.topUpBuffer);
  });
});
