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

// PR #1423 R2-B/R2-C/R4/R7/R8 — the register-agent confirmation state machine is
// a MODULE-PRIVATE helper returning a single `PcaConfirmationOutcome`; the ONLY
// public surface is the facade method `confirmPublishingConvictionAgentRegistration`,
// so the retry policy is never a deep-importable knob. The full advisory matrix
// is exercised THROUGH the facade with a scripted `chain.isPublishingConvictionAgent`.
// Retry cases pay the real (private, bounded ~300ms) backoff; `confirmed` /
// `unsupported` short-circuit with no wait. Each probe records its (accountId,
// agent) so the matrix also pins that the EXACT request args flow through.
describe('DKGAgent.confirmPublishingConvictionAgentRegistration (advisory outcome matrix, via facade)', () => {
  const ACCOUNT_ID = 7n;
  const AGENT_ADDR = ethers.Wallet.createRandom().address;

  // Build an agent whose chain probe replays `script` (one entry per call; the
  // last entry repeats) and records the (accountId, agent) of every call. A
  // boolean is returned; 'throw' raises an RPC-style error. (The no-surface
  // `unsupported` case is NOT modeled here — a mocked method returning null is
  // an impossible adapter shape; it is tested via a real NoChainAdapter below.)
  async function makeProbeAgent(
    script: Array<boolean | 'throw'>,
  ): Promise<{ agent: DKGAgent; probes: () => number; calls: () => Array<[bigint, string]> }> {
    const chain = new MockChainAdapter('mock:31337', ethers.Wallet.createRandom().address);
    let n = 0;
    const calls: Array<[bigint, string]> = [];
    (chain as any).isPublishingConvictionAgent = async (accountId: bigint, agent: string) => {
      calls.push([accountId, agent]);
      const action = script[Math.min(n, script.length - 1)];
      n += 1;
      if (action === 'throw') throw new Error('probe RPC blip');
      return action;
    };
    return { agent: await makeAgent(chain), probes: () => n, calls: () => calls };
  }

  // R9 (9-C) — drive the confirm through FAKE timers so the private bounded
  // backoff (300ms) doesn't add real wall-clock: the outcome transition matrix
  // is exercised with controlled time, while the facade still exposes no timing
  // knobs. The agent is created (real timers) before we fake, so only the
  // confirm's own setTimeout is advanced; a `confirmed`/`unsupported` outcome
  // returns on the first probe (no pending timer → the advance is a no-op).
  const confirm = async (agent: DKGAgent): Promise<string> => {
    vi.useFakeTimers();
    try {
      const p = agent.confirmPublishingConvictionAgentRegistration(ACCOUNT_ID, AGENT_ADDR);
      await vi.advanceTimersByTimeAsync(1000); // flush the ≤2 bounded backoffs + interleaved microtasks
      return await p;
    } finally {
      vi.useRealTimers();
    }
  };

  it('probe true → "confirmed" in a single probe, with the EXACT (accountId, agent)', async () => {
    const { agent, probes, calls } = await makeProbeAgent([true]);
    expect(await confirm(agent)).toBe('confirmed');
    expect(probes()).toBe(1); // confirms on the first read — no retry
    expect(calls()).toEqual([[ACCOUNT_ID, AGENT_ADDR]]); // no hard-coded 0n / swapped args
  });

  // R12 (12-C) — a confirmed probe must SHORT-CIRCUIT: resolve without waiting
  // through any backoff. Prove it by NOT advancing fake time — flush only
  // microtasks; a regression that slept before returning `confirmed` would
  // leave the promise pending here.
  it('probe true → resolves "confirmed" WITHOUT advancing the backoff timer', async () => {
    const { agent, probes } = await makeProbeAgent([true]);
    vi.useFakeTimers();
    try {
      let resolved = false;
      const p = agent
        .confirmPublishingConvictionAgentRegistration(ACCOUNT_ID, AGENT_ADDR)
        .then((r) => { resolved = true; return r; });
      await vi.advanceTimersByTimeAsync(0); // flush microtasks only — do NOT advance the 300ms backoff
      expect(resolved).toBe(true);
      expect(await p).toBe('confirmed');
      expect(probes()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('probe false then true → "confirmed" in EXACTLY 2 probes (no extra probing after confirmation)', async () => {
    const { agent, probes } = await makeProbeAgent([false, true]);
    expect(await confirm(agent)).toBe('confirmed');
    expect(probes()).toBe(2);
  });

  // R2-C — a THROWN probe (RPC blip) then a healthy read must recover to confirmed.
  it('probe throw then true → "confirmed" in EXACTLY 2 probes (throw→true recovery, stops on confirm)', async () => {
    const { agent, probes } = await makeProbeAgent(['throw', true]);
    expect(await confirm(agent)).toBe('confirmed');
    expect(probes()).toBe(2);
  });

  it('probe false ×3 → "not_observed" (surface exists, never observed)', async () => {
    const { agent, probes } = await makeProbeAgent([false]);
    expect(await confirm(agent)).toBe('not_observed');
    expect(probes()).toBe(3);
  });

  it('probe throw ×3 → "inconclusive" (surface exists, every read threw)', async () => {
    const { agent, probes } = await makeProbeAgent(['throw']);
    expect(await confirm(agent)).toBe('inconclusive');
    expect(probes()).toBe(3);
  });

  // T5-B — a definitive `not_observed` is NOT downgraded by a later throw
  // (contrast throw×3 → inconclusive above).
  it('probe false then throw ×2 → "not_observed" (a later throw does NOT downgrade a prior false)', async () => {
    const { agent, probes } = await makeProbeAgent([false, 'throw', 'throw']);
    expect(await confirm(agent)).toBe('not_observed');
    expect(probes()).toBe(3);
  });

  it('probe throw then false → "not_observed" (a false after a throw is still definitive)', async () => {
    const { agent } = await makeProbeAgent(['throw', false]);
    expect(await confirm(agent)).toBe('not_observed');
  });

  // R8 (8-A) — the UNSUPPORTED outcome must come from a REAL no-surface adapter
  // (the facade's typeof-guard on a chain that lacks the method), not a mocked
  // method returning null. NoChainAdapter has no isPublishingConvictionAgent, so
  // this exercises the true capability-gap path end-to-end.
  it('no probe surface (real NoChainAdapter) → "unsupported"', async () => {
    const agent = await makeAgent(new NoChainAdapter());
    expect(await agent.confirmPublishingConvictionAgentRegistration(ACCOUNT_ID, AGENT_ADDR)).toBe('unsupported');
  });

  // OS373 — the shared `pcaRegisteredProbe` boundary extracts the adapter method
  // before invoking it, so preserving the adapter's `this` binding (via
  // `.call(chain, …)`) is real behavior to pin. The scripted probes above use
  // ARROW functions, which can't detect an unbound call; this uses a NORMAL
  // method that reads a marker off `this`, so a regression to an unbound
  // `read(accountId, agent)` would make `this` undefined and fail here. Covers
  // both facade readers that route through the shared boundary.
  it('preserves the adapter `this` binding through the shared capability probe', async () => {
    const chain = new MockChainAdapter('mock:31337', ethers.Wallet.createRandom().address);
    (chain as any).__pcaMarker = true;
    (chain as any).isPublishingConvictionAgent = async function (this: any, _accountId: bigint, _agent: string) {
      // A real adapter method reads adapter state off `this`; an unbound call
      // makes `this` undefined and throws, failing this test.
      if (this?.__pcaMarker !== true) throw new Error('lost adapter this-binding');
      return true;
    };
    const agent = await makeAgent(chain);
    expect(await agent.isPublishingConvictionAgent(ACCOUNT_ID, AGENT_ADDR)).toBe(true);
    expect(await agent.confirmPublishingConvictionAgentRegistration(ACCOUNT_ID, AGENT_ADDR)).toBe('confirmed');
  });
});
