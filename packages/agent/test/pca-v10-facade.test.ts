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

  it('listPublishingConvictionAccountsForWallets delegates owned/agent/both and returns null when unsupported', async () => {
    const owner = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', owner.address);
    const agent = await makeAgent(chain);
    const created = await agent.createPublishingConvictionAccount(1_000n, 42n);
    const wallet = ethers.Wallet.createRandom().address;
    await agent.registerPublishingConvictionAgent(created!.accountId, wallet);

    const mine = await agent.listPublishingConvictionAccountsForWallets([owner.address, wallet]);
    const relations = new Map(mine!.map((entry) => [entry.accountId, entry.relation]));
    expect(relations.get(created!.accountId)).toBe('both');

    const none = await makeAgent(new NoChainAdapter());
    expect(await none.listPublishingConvictionAccountsForWallets([owner.address])).toBeNull();
  });

  it('listDesignatableNodes delegates to the adapter and returns null when unsupported', async () => {
    const chain = new MockChainAdapter('mock:31337', ethers.Wallet.createRandom().address);
    const agent = await makeAgent(chain);
    const nodes = await agent.listDesignatableNodes();
    expect(nodes).not.toBeNull();
    expect(nodes!.map((node) => node.identityId)).toEqual([42n, 57n, 61n]);

    const none = await makeAgent(new NoChainAdapter());
    expect(await none.listDesignatableNodes()).toBeNull();
  });

  it('listDesignatableNodes forwards { fresh } through the facade bridge', async () => {
    const chain = new MockChainAdapter('mock:31337', ethers.Wallet.createRandom().address);
    const spy = vi.spyOn(chain, 'listDesignatableNodes');
    const agent = await makeAgent(chain);

    await agent.listDesignatableNodes({ fresh: true });
    expect(spy).toHaveBeenLastCalledWith({ fresh: true });

    await agent.listDesignatableNodes();
    expect(spy).toHaveBeenLastCalledWith(undefined);
    spy.mockRestore();

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

// PR #1423 R2-B/R2-C — the register-agent confirmation (retry/probe/capability)
// logic moved OUT of the daemon route INTO the typed facade. These tests pin the
// full advisory matrix, driven by a FAKE `chain.isPublishingConvictionAgent`, so
// the route can stay a thin serializer. `backoffMs` is tiny (1ms) for speed.
describe('DKGAgent.confirmPublishingConvictionAgentRegistration (PR #1423 R2)', () => {
  const ACCOUNT_ID = 1n;
  const AGENT_ADDR = ethers.Wallet.createRandom().address;

  // Build an agent whose `chain.isPublishingConvictionAgent` replays `script`
  // (one entry per probe; the last entry is repeated for any further probes):
  // a boolean/null is returned, `'throw'` raises an RPC-style error. The
  // facade propagates a chain-level `null` as the "no probe surface" signal —
  // identical to an adapter that omits the method entirely.
  async function makeProbeAgent(
    script: Array<boolean | null | 'throw'>,
  ): Promise<{ agent: DKGAgent; probes: () => number }> {
    const chain = new MockChainAdapter('mock:31337', ethers.Wallet.createRandom().address);
    let calls = 0;
    (chain as any).isPublishingConvictionAgent = async () => {
      const action = script[Math.min(calls, script.length - 1)];
      calls += 1;
      if (action === 'throw') throw new Error('probe RPC blip');
      return action;
    };
    const agent = await makeAgent(chain);
    return { agent, probes: () => calls };
  }

  it('probe true → { verified:true, adapterSupported:true } in a single probe', async () => {
    const { agent, probes } = await makeProbeAgent([true]);
    const r = await agent.confirmPublishingConvictionAgentRegistration(ACCOUNT_ID, AGENT_ADDR, { backoffMs: 1 });
    expect(r).toEqual({ verified: true, adapterSupported: true });
    expect(probes()).toBe(1); // confirms on the first read — no retry
  });

  it('probe false then true → { verified:true, adapterSupported:true } (backoff retry confirms)', async () => {
    const { agent, probes } = await makeProbeAgent([false, true]);
    const r = await agent.confirmPublishingConvictionAgentRegistration(ACCOUNT_ID, AGENT_ADDR, { backoffMs: 1 });
    expect(r).toEqual({ verified: true, adapterSupported: true });
    expect(probes()).toBeGreaterThanOrEqual(2);
  });

  // R2-C — the missing case: a THROWN probe (RPC blip) followed by a healthy
  // read must recover to a confirmed result, not stay inconclusive.
  it('probe throw then true → { verified:true, adapterSupported:true } (throw→true retry recovery, R2-C)', async () => {
    const { agent, probes } = await makeProbeAgent(['throw', true]);
    const r = await agent.confirmPublishingConvictionAgentRegistration(ACCOUNT_ID, AGENT_ADDR, { backoffMs: 1 });
    expect(r).toEqual({ verified: true, adapterSupported: true });
    expect(probes()).toBeGreaterThanOrEqual(2);
  });

  it('probe false ×3 (default attempts) → { verified:false, adapterSupported:true } (advisory-false, surface exists)', async () => {
    const { agent, probes } = await makeProbeAgent([false]);
    const r = await agent.confirmPublishingConvictionAgentRegistration(ACCOUNT_ID, AGENT_ADDR, { backoffMs: 1 });
    expect(r).toEqual({ verified: false, adapterSupported: true });
    expect(probes()).toBe(3); // exhausts the default 3 attempts
  });

  it('probe throw ×3 → { verified:null, adapterSupported:true } (inconclusive, surface exists)', async () => {
    const { agent, probes } = await makeProbeAgent(['throw']);
    const r = await agent.confirmPublishingConvictionAgentRegistration(ACCOUNT_ID, AGENT_ADDR, { backoffMs: 1 });
    expect(r).toEqual({ verified: null, adapterSupported: true });
    expect(probes()).toBe(3);
  });

  it('probe null (no probe surface) → { verified:null, adapterSupported:false } in a single probe, no retry', async () => {
    const { agent, probes } = await makeProbeAgent([null]);
    const r = await agent.confirmPublishingConvictionAgentRegistration(ACCOUNT_ID, AGENT_ADDR, { backoffMs: 1 });
    expect(r).toEqual({ verified: null, adapterSupported: false });
    expect(probes()).toBe(1); // unsupported signal short-circuits — no retry
  });
});
