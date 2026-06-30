import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/index.js';
import { MockChainAdapter, NoChainAdapter, PcaUnavailableError } from '@origintrail-official/dkg-chain';

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

  it('supportsPublishingConvictionRpc reflects the adapter bridge capability', async () => {
    const chain = new MockChainAdapter('mock:31337', ethers.Wallet.createRandom().address);
    const agent = await makeAgent(chain);
    expect(agent.supportsPublishingConvictionRpc).toBe(true);

    const noChainAgent = await makeAgent(new NoChainAdapter());
    expect(noChainAgent.supportsPublishingConvictionRpc).toBe(false);
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

  it('listPublishingConvictionAccountsForWallets delegates (owned/agent/both); null when unsupported', async () => {
    const owner = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', owner.address);
    const agent = await makeAgent(chain);
    const created = await agent.createPublishingConvictionAccount(1_000n, 42n);
    const w = ethers.Wallet.createRandom().address;
    await agent.registerPublishingConvictionAgent(created!.accountId, w);

    const mine = await agent.listPublishingConvictionAccountsForWallets([owner.address, w]);
    const m = new Map(mine!.map((e) => [e.accountId, e.relation]));
    expect(m.get(created!.accountId)).toBe('both'); // owner holds it + w is its agent

    const none = await makeAgent(new NoChainAdapter());
    expect(await none.listPublishingConvictionAccountsForWallets([owner.address])).toBeNull();
  });

  it('listDesignatableNodes delegates to the adapter; null when unsupported', async () => {
    const chain = new MockChainAdapter('mock:31337', ethers.Wallet.createRandom().address);
    const agent = await makeAgent(chain);
    const nodes = await agent.listDesignatableNodes();
    expect(nodes).not.toBeNull();
    expect(nodes!.map((n) => n.identityId)).toEqual([42n, 57n, 61n]);

    const none = await makeAgent(new NoChainAdapter());
    expect(await none.listDesignatableNodes()).toBeNull();
  });

  it('listDesignatableNodes forwards { fresh } through the facade bridge (TfJ)', async () => {
    const chain = new MockChainAdapter('mock:31337', ethers.Wallet.createRandom().address);
    const spy = vi.spyOn(chain, 'listDesignatableNodes');
    const agent = await makeAgent(chain);

    await agent.listDesignatableNodes({ fresh: true });
    expect(spy).toHaveBeenLastCalledWith({ fresh: true }); // ?fresh propagates to the adapter

    await agent.listDesignatableNodes();
    expect(spy).toHaveBeenLastCalledWith(undefined); // no opts → undefined (adapter uses its cache)
    spy.mockRestore();

    // Unsupported adapter still short-circuits to null even with opts.
    const none = await makeAgent(new NoChainAdapter());
    expect(await none.listDesignatableNodes({ fresh: true })).toBeNull();
  });

  it('getPublishingConvictionContracts delegates to the adapter; null when unsupported (sub-PR #2)', async () => {
    const chain = new MockChainAdapter('mock:31337', ethers.Wallet.createRandom().address);
    const getContracts = vi.spyOn(chain, 'getPublishingConvictionContracts').mockResolvedValue({
      nft: ethers.Wallet.createRandom().address,
      token: ethers.Wallet.createRandom().address,
      chainId: 'mock:31337',
      rpcUrls: [],
      walletRpcUrls: [],
    });
    const agent = await makeAgent(chain);
    const c = await agent.getPublishingConvictionContracts();
    expect(c).not.toBeNull();
    expect(getContracts).toHaveBeenCalledOnce();
    expect(c!.chainId).toBe('mock:31337');
    expect(c!.nft).toBe(ethers.getAddress(c!.nft)); // EIP-55 surfaced through the facade
    expect(c!.rpcUrls).toEqual([]);
    expect(c!.walletRpcUrls).toEqual([]);

    const none = await makeAgent(new NoChainAdapter());
    expect(await none.getPublishingConvictionContracts()).toBeNull();
  });

  it('requestPublishingConvictionRpc delegates to the adapter; unavailable when unsupported', async () => {
    const chain = new MockChainAdapter('mock:31337', ethers.Wallet.createRandom().address);
    const rpc = vi.fn(async () => '0x7a69');
    (chain as any).requestPublishingConvictionRpc = rpc;
    const agent = await makeAgent(chain);
    await expect(agent.requestPublishingConvictionRpc('eth_chainId', [])).resolves.toBe('0x7a69');
    expect(rpc).toHaveBeenCalledWith('eth_chainId', []);

    const none = await makeAgent(new NoChainAdapter());
    await expect(none.requestPublishingConvictionRpc('eth_chainId', [])).rejects.toBeInstanceOf(PcaUnavailableError);
  });
});
