import { afterEach, describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import { NoChainAdapter, ChainRpcTransportError } from '@origintrail-official/dkg-chain';
import { handlePcaRoutes } from '../src/daemon/routes/pca.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

function fakeRes() {
  const res: any = { statusCode: 0, body: '' };
  res.writeHead = (status: number) => { res.statusCode = status; };
  res.end = (body: string) => { res.body = body; };
  return res;
}

function fakeReq(method: string, path: string, body?: unknown) {
  const req: any = { method, url: path };
  if (body !== undefined) {
    req.__dkgPrebufferedBody = Buffer.from(JSON.stringify(body));
  }
  return req;
}

function runCtx(
  method: string,
  rawPath: string,
  agent: any,
  body?: unknown,
  auth?: { authEnabled?: boolean; requestToken?: string; validTokens?: Set<string> },
  opWallets?: { wallets: Array<{ address: string }>; adminWallet?: { address: string } },
) {
  const res = fakeRes();
  // Mirror handle-request.ts: route on url.pathname, query lives on url.
  const url = new URL(`http://127.0.0.1${rawPath}`);
  const ctx = {
    req: fakeReq(method, rawPath, body),
    res,
    agent,
    path: url.pathname,
    url,
    // opWallets is read at handler entry to compute PCA ownership; an empty
    // pool is fine for most tests (no looked-up PCA is "owned by this node").
    // The owned-flag describe block passes a populated pool to exercise it.
    opWallets: opWallets ?? { wallets: [] },
    // Default: auth disabled → isNodeAdminCaller short-circuits true, so the
    // existing route-logic tests below exercise the handler without an admin
    // token. The node-admin gating itself is covered by its own describe block.
    config: { auth: { enabled: auth?.authEnabled ?? false } },
    requestToken: auth?.requestToken,
    validTokens: auth?.validTokens ?? new Set<string>(),
  } as unknown as RequestContext;
  return { res, done: handlePcaRoutes(ctx) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('daemon /api/pca V10 caller contract', () => {
  it('POST /api/pca with tokens + primaryNode → 200 and forwards the node (OT-RFC-51)', async () => {
    const calls: Array<[bigint, bigint]> = [];
    const agent = {
      createPublishingConvictionAccount: async (committedTRAC: bigint, primaryNode: bigint) => {
        calls.push([committedTRAC, primaryNode]);
        return { accountId: 1n, hash: '0xabc', blockNumber: 7, success: true };
      },
    };
    const { res, done } = runCtx('POST', '/api/pca', agent, { tokens: '100', primaryNode: '42' });
    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).accountId).toBe('1');
    // The node identityId must reach the facade — otherwise the PCA seeds nobody.
    expect(calls).toEqual([[ethers.parseEther('100'), 42n]]);
  });

  // Route-level coverage of the shared transport-status mapping (#1329 review):
  // every PCA write catch routes through the SAME respondPcaTransportError /
  // classifyChainRpcTransportStatus, placed after the feature-unavailable
  // (503) branch and BEFORE the deterministic-revert / generic-500 branches.
  // createPublishingConvictionAccount is the representative write path.
  it('POST /api/pca → 503 when the on-chain create exhausts every configured RPC endpoint', async () => {
    const agent = {
      createPublishingConvictionAccount: async () => {
        const err: any = new Error(
          'createPublishingConvictionAccount transaction preparation failed on all configured ' +
          'RPC endpoints (https://rpc.example/v2/SECRETKEY, https://backup.example): boom',
        );
        err.code = 'RPC_ENDPOINTS_EXHAUSTED';
        err.rpcUrls = ['https://rpc.example/v2/SECRETKEY', 'https://backup.example'];
        throw err;
      },
    };
    const { res, done } = runCtx('POST', '/api/pca', agent, { tokens: '100', primaryNode: '42' });
    await done;
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('RPC_ENDPOINTS_EXHAUSTED');
    // Sanitized: no RPC URL or embedded key leaks into the response body (R-2).
    expect(res.body).not.toContain('://');
    expect(res.body).not.toContain('SECRETKEY');
  });

  it('POST /api/pca → 504 when the on-chain create reports a bounded chain timeout', async () => {
    const agent = {
      createPublishingConvictionAccount: async () => {
        // The adapter throws a ChainRpcTransportError instance for a receipt-wait
        // timeout; the guard recognises TIMEOUT via the instance, not a bare code.
        throw new ChainRpcTransportError('RPC_TIMEOUT', 'tx 0xabc timed out waiting for a receipt after 180000ms');
      },
    };
    const { res, done } = runCtx('POST', '/api/pca', agent, { tokens: '100', primaryNode: '42' });
    await done;
    expect(res.statusCode).toBe(504);
  });

  it('POST /api/pca → 500 (NOT down-classified) for a genuine on-chain revert', async () => {
    // The transport branch is strictly code-keyed, so a CALL_EXCEPTION revert
    // (no transport code) must fall through to the deterministic/500 mapping.
    const agent = {
      createPublishingConvictionAccount: async () => {
        const err: any = new Error('execution reverted');
        err.code = 'CALL_EXCEPTION';
        throw err;
      },
    };
    const { res, done } = runCtx('POST', '/api/pca', agent, { tokens: '100', primaryNode: '42' });
    await done;
    expect(res.statusCode).toBe(500);
  });

  it('POST /api/pca WITHOUT primaryNode → 400, facade not called (no silently-inert PCA)', async () => {
    let called = false;
    const agent = { createPublishingConvictionAccount: async () => { called = true; return { accountId: 9n, hash: '0x', blockNumber: 1, success: true }; } };
    const { res, done } = runCtx('POST', '/api/pca', agent, { tokens: '100' });
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/primaryNode is required/);
    expect(called).toBe(false);
  });

  it('POST /api/pca with primaryNode 0 (the no-node sentinel) → 400, facade not called', async () => {
    let called = false;
    const agent = { createPublishingConvictionAccount: async () => { called = true; return { accountId: 9n, hash: '0x', blockNumber: 1, success: true }; } };
    const { res, done } = runCtx('POST', '/api/pca', agent, { tokens: '100', primaryNode: '0' });
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/must be > 0/);
    expect(called).toBe(false);
  });

  it('POST /api/pca with a non-integer primaryNode → 400, facade not called', async () => {
    let called = false;
    const agent = { createPublishingConvictionAccount: async () => { called = true; return { accountId: 9n, hash: '0x', blockNumber: 1, success: true }; } };
    const { res, done } = runCtx('POST', '/api/pca', agent, { tokens: '100', primaryNode: 'not-a-node' });
    await done;
    expect(res.statusCode).toBe(400);
    expect(called).toBe(false);
  });

  it('POST /api/pca with a numeric primaryNode beyond JSON safe-integer → 400, facade not called', async () => {
    // A uint72 id can exceed 2^53-1; as a JSON *number* it is already rounded by
    // JSON.parse, so it must be rejected (caller should pass it as a string).
    let called = false;
    const agent = { createPublishingConvictionAccount: async () => { called = true; return { accountId: 9n, hash: '0x', blockNumber: 1, success: true }; } };
    // 2**53 is the first non-safe integer (MAX_SAFE_INTEGER is 2**53 - 1).
    const { res, done } = runCtx('POST', '/api/pca', agent, { tokens: '100', primaryNode: 2 ** 53 });
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/safe-integer/);
    expect(called).toBe(false);
  });

  it('POST /api/pca with a large string primaryNode (beyond safe-integer) is accepted losslessly', async () => {
    // The string path must preserve a uint72 id exactly (no rounding).
    const big = '4722366482869645213695'; // 2**72 - 1 (max uint72)
    const calls: Array<[bigint, bigint]> = [];
    const agent = {
      createPublishingConvictionAccount: async (committedTRAC: bigint, primaryNode: bigint) => {
        calls.push([committedTRAC, primaryNode]);
        return { accountId: 5n, hash: '0xabc', blockNumber: 1, success: true };
      },
    };
    const { res, done } = runCtx('POST', '/api/pca', agent, { tokens: '100', primaryNode: big });
    await done;
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([[ethers.parseEther('100'), BigInt(big)]]);
  });

  it('POST /api/pca with primaryNode above uint72 returns 400 and does not call facade', async () => {
    let called = false;
    const agent = {
      createPublishingConvictionAccount: async () => {
        called = true;
        return { accountId: 9n, hash: '0x', blockNumber: 1, success: true };
      },
    };
    const { res, done } = runCtx('POST', '/api/pca', agent, {
      tokens: '100',
      primaryNode: '4722366482869645213696',
    });
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/uint72/);
    expect(called).toBe(false);
  });

  it('POST /api/pca/:id/agent registers an agent → 200 with txHash', async () => {
    let registered: { id: bigint; agent: string } | null = null;
    const addr = '0x' + '1'.repeat(40);
    const agent = {
      registerPublishingConvictionAgent: async (id: bigint, a: string) => {
        registered = { id, agent: a };
        return { hash: '0xreg', blockNumber: 9, success: true };
      },
      isPublishingConvictionAgent: async () => true,
    };
    const { res, done } = runCtx('POST', '/api/pca/1/agent', agent, { agent: addr });
    await done;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.txHash).toBe('0xreg');
    expect(body.registered).toBe(true);
    expect(registered).toEqual({ id: 1n, agent: addr });
  });

  it('register: mined tx authoritative even if the verification probe throws → 200, not 500', async () => {
    const addr = '0x' + '1'.repeat(40);
    const agent = {
      registerPublishingConvictionAgent: async () => ({ hash: '0xreg', blockNumber: 9, success: true }),
      isPublishingConvictionAgent: async () => { throw new Error('probe RPC blip'); },
    };
    const { res, done } = runCtx('POST', '/api/pca/1/agent', agent, { agent: addr });
    await done;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.txHash).toBe('0xreg');
    expect(body.blockNumber).toBe(9);
    expect(body.registered).toBe(false);
    expect(body.adapterSupported).toBe(false);
  });

  it('register: probe returns null (adapter has no probe) → 200, registered:false, adapterSupported:false', async () => {
    const addr = '0x' + '1'.repeat(40);
    const agent = {
      registerPublishingConvictionAgent: async () => ({ hash: '0xreg', blockNumber: 9, success: true }),
      isPublishingConvictionAgent: async () => null,
    };
    const { res, done } = runCtx('POST', '/api/pca/1/agent', agent, { agent: addr });
    await done;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.txHash).toBe('0xreg');
    expect(body.registered).toBe(false);
    expect(body.adapterSupported).toBe(false);
  });

  it('register: probe returns true → 200, registered:true, adapterSupported:true', async () => {
    const addr = '0x' + '1'.repeat(40);
    const agent = {
      registerPublishingConvictionAgent: async () => ({ hash: '0xreg', blockNumber: 9, success: true }),
      isPublishingConvictionAgent: async () => true,
    };
    const { res, done } = runCtx('POST', '/api/pca/1/agent', agent, { agent: addr });
    await done;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.registered).toBe(true);
    expect(body.adapterSupported).toBe(true);
  });

  it('DELETE /api/pca/:id/agent/:address deregisters an agent → 200', async () => {
    let deregistered: { id: bigint; agent: string } | null = null;
    const addr = '0x' + '2'.repeat(40);
    const agent = {
      deregisterPublishingConvictionAgent: async (id: bigint, a: string) => {
        deregistered = { id, agent: a };
        return { hash: '0xdereg', blockNumber: 11, success: true };
      },
    };
    const { res, done } = runCtx('DELETE', `/api/pca/1/agent/${addr}`, agent);
    await done;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.txHash).toBe('0xdereg');
    expect(body.deregistered).toBe(true);
    expect(deregistered).toEqual({ id: 1n, agent: addr });
  });

  it('maps an owner-gated NotAccountOwner revert on agent deregister to HTTP 403', async () => {
    const agent = {
      deregisterPublishingConvictionAgent: async () => {
        throw new Error('Mock: NotAccountOwner(1, 0xdeadbeef)');
      },
    };
    const addr = '0x' + '2'.repeat(40);
    const { res, done } = runCtx('DELETE', `/api/pca/1/agent/${addr}`, agent);
    await done;
    expect(res.statusCode).toBe(403);
  });

  it('maps an owner-gated NotAccountOwner revert on agent register to HTTP 403', async () => {
    const agent = {
      registerPublishingConvictionAgent: async () => {
        throw new Error('Mock: NotAccountOwner(1, 0xdeadbeef)');
      },
    };
    const addr = '0x' + '1'.repeat(40);
    const { res, done } = runCtx('POST', '/api/pca/1/agent', agent, { agent: addr });
    await done;
    expect(res.statusCode).toBe(403);
  });

  it('POST /api/pca/:id/settle runs settle() → 200', async () => {
    let settledId: bigint | null = null;
    const agent = {
      settlePublishingConvictionAccount: async (id: bigint) => {
        settledId = id;
        return { hash: '0xsettle', blockNumber: 13, success: true };
      },
    };
    const { res, done } = runCtx('POST', '/api/pca/2/settle', agent);
    await done;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.txHash).toBe('0xsettle');
    expect(settledId).toBe(2n);
  });

  it('maps a NoChainAdapter noChain() throw on settle to HTTP 503', async () => {
    const agent = {
      settlePublishingConvictionAccount: async () => {
        throw new Error('No blockchain configured. To use on-chain operations, provide chainConfig');
      },
    };
    const { res, done } = runCtx('POST', '/api/pca/2/settle', agent);
    await done;
    expect(res.statusCode).toBe(503);
  });

  it('maps an owner-gated NotAccountOwner revert on funds top-up to HTTP 403', async () => {
    const agent = {
      topUpPublishingConvictionAccount: async () => {
        throw new Error('Mock: NotAccountOwner(1, 0xdeadbeef)');
      },
    };
    const { res, done } = runCtx('POST', '/api/pca/1/funds', agent, { tokens: '50' });
    await done;
    expect(res.statusCode).toBe(403);
  });

  it('round-trips register/funds → GET reflects agentCount and topUpBuffer', async () => {
    const state = { agents: new Set<string>(), topUp: 0n };
    const agent = {
      registerPublishingConvictionAgent: async (_id: bigint, a: string) => {
        state.agents.add(a.toLowerCase());
        return { hash: '0xr', blockNumber: 1, success: true };
      },
      deregisterPublishingConvictionAgent: async (_id: bigint, a: string) => {
        state.agents.delete(a.toLowerCase());
        return { hash: '0xd', blockNumber: 2, success: true };
      },
      isPublishingConvictionAgent: async (_id: bigint, a: string) => state.agents.has(a.toLowerCase()),
      topUpPublishingConvictionAccount: async (_id: bigint, amount: bigint) => {
        state.topUp += amount;
        return { hash: '0xt', blockNumber: 3, success: true };
      },
      getPublishingConvictionAccountInfo: async () => ({
        owner: '0x' + '9'.repeat(40),
        committedTRAC: 100n,
        baseEpochAllowance: 1n,
        createdAtEpoch: 1,
        expiresAtEpoch: 9,
        createdAtTimestamp: 0,
        expiresAtTimestamp: 0,
        discountBps: 500,
        topUpBuffer: state.topUp,
        agentCount: state.agents.size,
        lastSettledWindow: 0,
        fullySwept: false,
      }),
    };
    const addr = '0x' + '3'.repeat(40);

    const reg = runCtx('POST', '/api/pca/1/agent', agent, { agent: addr });
    await reg.done;
    const fund = runCtx('POST', '/api/pca/1/funds', agent, { tokens: '5' });
    await fund.done;

    const get = runCtx('GET', '/api/pca/1', agent);
    await get.done;
    expect(get.res.statusCode).toBe(200);
    const body = JSON.parse(get.res.body);
    expect(body.agentCount).toBe(1);
    expect(body.topUpBuffer).toBe(ethers.parseEther('5').toString());
  });

  it('maps a NoChainAdapter noChain() throw to HTTP 503, not 500', async () => {
    const noChainErr = () => {
      throw new Error(
        'No blockchain configured. To use on-chain operations, provide chainConfig ' +
        '(rpcUrl, hubAddress, privateKey) when creating the agent, or set DKG_PRIVATE_KEY.',
      );
    };
    const create = runCtx('POST', '/api/pca', { createPublishingConvictionAccount: noChainErr }, { tokens: '1', primaryNode: '42' });
    await create.done;
    expect(create.res.statusCode).toBe(503);

    const info = runCtx('GET', '/api/pca/1', { getPublishingConvictionAccountInfo: noChainErr });
    await info.done;
    expect(info.res.statusCode).toBe(503);
  });

  it('maps a "NFT not deployed on this Hub" throw to HTTP 503 on write and GET, not 500/404', async () => {
    const undeployed = () => { throw new Error('DKGPublishingConvictionNFT not deployed on this Hub.'); };
    const create = runCtx('POST', '/api/pca', { createPublishingConvictionAccount: undeployed }, { tokens: '1', primaryNode: '42' });
    await create.done;
    expect(create.res.statusCode).toBe(503);

    const get = runCtx('GET', '/api/pca/1', { getPublishingConvictionAccountInfo: undeployed });
    await get.done;
    expect(get.res.statusCode).toBe(503);
  });

  it('maps a typed PcaUnavailableError (code PCA_UNAVAILABLE) to HTTP 503 on settle', async () => {
    const agent = {
      settlePublishingConvictionAccount: async () => {
        const e: any = new Error('boom'); e.code = 'PCA_UNAVAILABLE'; throw e;
      },
    };
    const { res, done } = runCtx('POST', '/api/pca/2/settle', agent);
    await done;
    expect(res.statusCode).toBe(503);
  });

  it('genuine account-missing (getInfo returns null on a deployed adapter) stays 404', async () => {
    // Adapter exposes the V10 surface → facade capability signal true,
    // so a null getInfo is a genuine missing account → 404.
    const agent = {
      supportsPublishingConvictionNft: true,
      getPublishingConvictionAccountInfo: async () => null,
    };
    const { res, done } = runCtx('GET', '/api/pca/9', agent);
    await done;
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/pca/:id against a NoChainAdapter-backed agent → 503 (feature-unavailable), not 404', async () => {
    // Real no-chain adapter: post-#519-fix it OMITS the PCA methods, so
    // the facade returns null AND its capability getter is false → 503.
    const chain = new NoChainAdapter();
    const agent = {
      supportsPublishingConvictionNft:
        typeof (chain as any).getPublishingConvictionAccountInfo === 'function',
      getPublishingConvictionAccountInfo: async () =>
        typeof (chain as any).getPublishingConvictionAccountInfo !== 'function'
          ? null
          : (chain as any).getPublishingConvictionAccountInfo(1n),
    };
    const { res, done } = runCtx('GET', '/api/pca/1', agent);
    await done;
    expect(res.statusCode).toBe(503);
  });

  it('maps known PCA contract reverts to 4xx (InvalidAmount 400, Already/NotRegistered 409, AccountExpired 409)', async () => {
    const addr = '0x' + '4'.repeat(40);
    const inv = runCtx('POST', '/api/pca', {
      createPublishingConvictionAccount: async () => { throw new Error('execution reverted: InvalidAmount()'); },
    }, { tokens: '1', primaryNode: '42' });
    await inv.done;
    expect(inv.res.statusCode).toBe(400);
    expect(JSON.parse(inv.res.body).error).toBe('InvalidAmount');

    const dup = runCtx('POST', '/api/pca/1/agent', {
      registerPublishingConvictionAgent: async () => { throw new Error('reverted: AgentAlreadyRegistered(1)'); },
    }, { agent: addr });
    await dup.done;
    expect(dup.res.statusCode).toBe(409);

    const missing = runCtx('DELETE', `/api/pca/1/agent/${addr}`, {
      deregisterPublishingConvictionAgent: async () => { throw new Error('reverted: AgentNotRegistered(1)'); },
    });
    await missing.done;
    expect(missing.res.statusCode).toBe(409);

    const expired = runCtx('POST', '/api/pca/1/funds', {
      topUpPublishingConvictionAccount: async () => { throw new Error('reverted: AccountExpired(1)'); },
    }, { tokens: '5' });
    await expired.done;
    expect(expired.res.statusCode).toBe(409);
  });

  it('owner revert still wins over generic revert classification (403, not 409)', async () => {
    const addr = '0x' + '5'.repeat(40);
    const { res, done } = runCtx('POST', '/api/pca/1/agent', {
      registerPublishingConvictionAgent: async () => { throw new Error('Mock: NotAccountOwner(1, 0xdead)'); },
    }, { agent: addr });
    await done;
    expect(res.statusCode).toBe(403);
  });

  it('POST /api/pca/:id/agent with the zero address → 400, facade not called', async () => {
    let called = false;
    const agent = {
      registerPublishingConvictionAgent: async () => { called = true; return { hash: '0x', blockNumber: 1, success: true }; },
    };
    const { res, done } = runCtx('POST', '/api/pca/1/agent', agent, { agent: ethers.ZeroAddress });
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('agent must not be the zero address');
    expect(called).toBe(false);
  });

  it('DELETE /api/pca/:id/agent/:address with the zero address → 400, facade not called', async () => {
    let called = false;
    const agent = {
      deregisterPublishingConvictionAgent: async () => { called = true; return { hash: '0x', blockNumber: 1, success: true }; },
    };
    const { res, done } = runCtx('DELETE', `/api/pca/1/agent/${ethers.ZeroAddress}`, agent);
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('agent must not be the zero address');
    expect(called).toBe(false);
  });

  it('maps a ZeroAgentAddress revert (defense-in-depth, guard bypassed) → 400', async () => {
    const addr = '0x' + '7'.repeat(40);
    const { res, done } = runCtx('POST', '/api/pca/1/agent', {
      registerPublishingConvictionAgent: async () => { throw new Error('execution reverted: ZeroAgentAddress()'); },
    }, { agent: addr });
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('ZeroAgentAddress');
  });

  it('maps an AgentCapReached revert on agent register → 409', async () => {
    const addr = '0x' + '8'.repeat(40);
    const { res, done } = runCtx('POST', '/api/pca/1/agent', {
      registerPublishingConvictionAgent: async () => { throw new Error('execution reverted: AgentCapReached(1, 100)'); },
    }, { agent: addr });
    await done;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('AgentCapReached');
  });

  it('maps a TokenTransferFailed revert on POST /api/pca → 400', async () => {
    const { res, done } = runCtx('POST', '/api/pca', {
      createPublishingConvictionAccount: async () => { throw new Error('execution reverted: TokenTransferFailed()'); },
    }, { tokens: '100', primaryNode: '42' });
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('TokenTransferFailed');
  });

  it('maps an OT-RFC-51 PrimaryNodeNotInShardingTable revert on POST /api/pca → 400, not 500', async () => {
    // A syntactically valid but nonexistent node id passes parsePrimaryNode but
    // reverts in createAccount — must be a caller-actionable 400, not a 500.
    const { res, done } = runCtx('POST', '/api/pca', {
      createPublishingConvictionAccount: async () => { throw new Error('execution reverted: PrimaryNodeNotInShardingTable(999999)'); },
    }, { tokens: '100', primaryNode: '999999' });
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('PrimaryNodeNotInShardingTable');
  });

  it('maps an AccountAlreadyFullySettled revert on POST /api/pca/:id/settle → 409', async () => {
    const { res, done } = runCtx('POST', '/api/pca/2/settle', {
      settlePublishingConvictionAccount: async () => { throw new Error('execution reverted: AccountAlreadyFullySettled(2)'); },
    });
    await done;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('AccountAlreadyFullySettled');
  });

  it('maps an ERC721NonexistentToken revert on POST /api/pca/:id/funds → 404 UnknownAccount', async () => {
    const { res, done } = runCtx('POST', '/api/pca/7/funds', {
      topUpPublishingConvictionAccount: async () => { throw new Error('execution reverted: ERC721NonexistentToken(7)'); },
    }, { tokens: '5' });
    await done;
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'UnknownAccount', accountId: '7' });
  });

  it('maps an ERC721NonexistentToken revert on POST /api/pca/:id/agent → 404 UnknownAccount', async () => {
    const addr = '0x' + '7'.repeat(40);
    const { res, done } = runCtx('POST', '/api/pca/9/agent', {
      registerPublishingConvictionAgent: async () => { throw new Error('execution reverted: ERC721NonexistentToken(9)'); },
    }, { agent: addr });
    await done;
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'UnknownAccount', accountId: '9' });
  });

  it('maps an ERC721NonexistentToken revert on POST /api/pca/:id/settle → 404 UnknownAccount', async () => {
    const { res, done } = runCtx('POST', '/api/pca/9/settle', {
      settlePublishingConvictionAccount: async () => { throw new Error('execution reverted: ERC721NonexistentToken(9)'); },
    });
    await done;
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'UnknownAccount', accountId: '9' });
  });

  it('GET ?key= probe exposes `registered` (not `authorized`)', async () => {
    const addr = '0x' + '6'.repeat(40);
    const agent = {
      getPublishingConvictionAccountInfo: async () => ({
        owner: '0x' + '9'.repeat(40),
        committedTRAC: 1n, baseEpochAllowance: 1n, createdAtEpoch: 1, expiresAtEpoch: 9,
        createdAtTimestamp: 0, expiresAtTimestamp: 0, discountBps: 0, topUpBuffer: 0n,
        agentCount: 1, lastSettledWindow: 0, fullySwept: false,
      }),
      isPublishingConvictionAgent: async () => true,
    };
    const { res, done } = runCtx('GET', `/api/pca/1?key=${addr}`, agent);
    await done;
    expect(res.statusCode).toBe(200);
    const probe = JSON.parse(res.body).probedKey;
    expect(probe.registered).toBe(true);
    expect(probe).not.toHaveProperty('authorized');
  });

  it('GET ?key= probe read failure stays 503/inconclusive, not registered:false', async () => {
    const addr = '0x' + '6'.repeat(40);
    const agent = {
      getPublishingConvictionAccountInfo: async () => ({
        owner: '0x' + '9'.repeat(40),
        committedTRAC: 1n, baseEpochAllowance: 1n, createdAtEpoch: 1, expiresAtEpoch: 9,
        createdAtTimestamp: 0, expiresAtTimestamp: 0, discountBps: 0, topUpBuffer: 0n,
        agentCount: 1, lastSettledWindow: 0, fullySwept: false,
      }),
      isPublishingConvictionAgent: async () => {
        const err: any = new Error('isAgent read failed');
        err.code = 'CALL_EXCEPTION';
        throw err;
      },
    };
    const { res, done } = runCtx('GET', `/api/pca/1?key=${addr}`, agent);
    await done;
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('PCA_LOOKUP_READ_FAILED');
  });

  // ----- B3: GET /api/pca/:id/agents (live approved publishing-wallet list) -----
  it('GET /api/pca/:id/agents → 200 with the checksummed agent list', async () => {
    const a1 = ethers.getAddress('0x' + 'ab'.repeat(20));
    const a2 = ethers.getAddress('0x' + 'cd'.repeat(20));
    let enumeratedId: bigint | null = null;
    const agent = {
      supportsPublishingConvictionNft: true,
      getPublishingConvictionAccountInfo: async () => ({ owner: '0x' + '9'.repeat(40) }),
      getPublishingConvictionAgents: async (id: bigint) => { enumeratedId = id; return [a1, a2]; },
    };
    const { res, done } = runCtx('GET', '/api/pca/5/agents', agent);
    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ accountId: '5', agents: [a1, a2] });
    expect(enumeratedId).toBe(5n);
  });

  it('GET /api/pca/:id/agents → 200 { agents: [] } for an existing account with no agents (NOT 404)', async () => {
    const agent = {
      supportsPublishingConvictionNft: true,
      getPublishingConvictionAccountInfo: async () => ({ owner: '0x' + '9'.repeat(40) }),
      getPublishingConvictionAgents: async () => [],
    };
    const { res, done } = runCtx('GET', '/api/pca/5/agents', agent);
    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).agents).toEqual([]);
  });

  it('GET /api/pca/:id/agents → 404 for an unknown account on a deployed adapter (existence-checked, never enumerates)', async () => {
    let enumerated = false;
    const agent = {
      supportsPublishingConvictionNft: true,
      getPublishingConvictionAccountInfo: async () => null,
      getPublishingConvictionAgents: async () => { enumerated = true; return []; },
    };
    const { res, done } = runCtx('GET', '/api/pca/9/agents', agent);
    await done;
    expect(res.statusCode).toBe(404);
    expect(enumerated).toBe(false);
  });

  it('GET /api/pca/:id/agents → 503 when the adapter lacks the PCA surface', async () => {
    const agent = {
      supportsPublishingConvictionNft: false,
      getPublishingConvictionAccountInfo: async () => null,
    };
    const { res, done } = runCtx('GET', '/api/pca/1/agents', agent);
    await done;
    expect(res.statusCode).toBe(503);
  });

  it('GET /api/pca/:id/agents → 503 when getInfo works but the enumerator is absent (facade null)', async () => {
    const agent = {
      supportsPublishingConvictionNft: true,
      getPublishingConvictionAccountInfo: async () => ({ owner: '0x' + '9'.repeat(40) }),
      getPublishingConvictionAgents: async () => null,
    };
    const { res, done } = runCtx('GET', '/api/pca/1/agents', agent);
    await done;
    expect(res.statusCode).toBe(503);
  });

  it('GET /api/pca/:id/agents → 503 on RPC transport exhaustion (sanitized body)', async () => {
    const agent = {
      supportsPublishingConvictionNft: true,
      getPublishingConvictionAccountInfo: async () => {
        const err: any = new Error(
          'getAccountInfo failed on all configured RPC endpoints (https://rpc.example/v2/SECRETKEY): boom',
        );
        err.code = 'RPC_ENDPOINTS_EXHAUSTED';
        err.rpcUrls = ['https://rpc.example/v2/SECRETKEY'];
        throw err;
      },
    };
    const { res, done } = runCtx('GET', '/api/pca/1/agents', agent);
    await done;
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('RPC_ENDPOINTS_EXHAUSTED');
    expect(res.body).not.toContain('SECRETKEY');
  });

  it('GET /api/pca/:id/agents → 503 PCA_LOOKUP_READ_FAILED on an enumerator CALL_EXCEPTION (NOT 200 [])', async () => {
    const agent = {
      supportsPublishingConvictionNft: true,
      getPublishingConvictionAccountInfo: async () => ({ owner: '0x' + '9'.repeat(40) }),
      getPublishingConvictionAgents: async () => {
        // getRegisteredAgents is a plain getter that returns [] for an unknown
        // account, so a CALL_EXCEPTION is a real read failure — the route must
        // NOT collapse it to a confirmed 200 [] ("no approved wallets").
        const err: any = new Error('missing revert data (execution reverted)');
        err.code = 'CALL_EXCEPTION';
        throw err;
      },
    };
    const { res, done } = runCtx('GET', '/api/pca/5/agents', agent);
    await done;
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('PCA_LOOKUP_READ_FAILED');
    expect(body.agents).toBeUndefined();
  });

  it('GET /api/pca/:id/agents → 400 for a non-numeric id', async () => {
    const { res, done } = runCtx('GET', '/api/pca/not-an-id/agents', {});
    await done;
    expect(res.statusCode).toBe(400);
  });

  // ----- GAP-3: GET /api/pca/agent/:address (which PCA funds a wallet) -----
  it('GET /api/pca/agent/:address → 200 { agent, accountId } for a registered wallet (strict discovery read)', async () => {
    const addr = ethers.getAddress('0x' + 'ab'.repeat(20));
    let queried: { a: string; strict: boolean | undefined } | null = null;
    const agent = {
      supportsPublishingConvictionNft: true,
      getConvictionAgentAccountId: async (a: string, opts?: { strict?: boolean }) => {
        queried = { a, strict: opts?.strict };
        return 7n;
      },
    };
    const { res, done } = runCtx('GET', `/api/pca/agent/${addr}`, agent);
    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ agent: addr, accountId: '7' });
    // Discovery route MUST opt into strict so a read failure can't masquerade as "unregistered".
    expect(queried).toEqual({ a: addr, strict: true });
  });

  it('GET /api/pca/agent/:address → 200 { accountId: null } for a genuinely unregistered wallet (0n on a healthy read)', async () => {
    const addr = ethers.getAddress('0x' + 'cd'.repeat(20));
    const agent = { supportsPublishingConvictionNft: true, getConvictionAgentAccountId: async () => 0n };
    const { res, done } = runCtx('GET', `/api/pca/agent/${addr}`, agent);
    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ agent: addr, accountId: null });
  });

  it('GET /api/pca/agent/:address → 400 for a malformed address', async () => {
    const { res, done } = runCtx('GET', '/api/pca/agent/not-an-address', {});
    await done;
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/pca/agent/:address → 503 (capability gate) when the adapter lacks the PCA surface; lookup not called', async () => {
    let called = false;
    const addr = ethers.getAddress('0x' + 'ab'.repeat(20));
    const agent = {
      supportsPublishingConvictionNft: false,
      getConvictionAgentAccountId: async () => { called = true; return 0n; },
    };
    const { res, done } = runCtx('GET', `/api/pca/agent/${addr}`, agent);
    await done;
    expect(res.statusCode).toBe(503);
    expect(called).toBe(false);
  });

  it('GET /api/pca/agent/:address → 503 when the facade returns null despite capability', async () => {
    const addr = ethers.getAddress('0x' + 'ab'.repeat(20));
    const agent = { supportsPublishingConvictionNft: true, getConvictionAgentAccountId: async () => null };
    const { res, done } = runCtx('GET', `/api/pca/agent/${addr}`, agent);
    await done;
    expect(res.statusCode).toBe(503);
  });

  it('GET /api/pca/agent/:address → 503 PCA_LOOKUP_READ_FAILED on a CALL_EXCEPTION read failure (NOT 200 null)', async () => {
    const addr = ethers.getAddress('0x' + 'ab'.repeat(20));
    const agent = {
      supportsPublishingConvictionNft: true,
      getConvictionAgentAccountId: async () => {
        // The strict path rethrows a CALL_EXCEPTION (a real read failure on the
        // mapping getter) — the route must NOT collapse it to accountId:null.
        const err: any = new Error('missing revert data (execution reverted)');
        err.code = 'CALL_EXCEPTION';
        throw err;
      },
    };
    const { res, done } = runCtx('GET', `/api/pca/agent/${addr}`, agent);
    await done;
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('PCA_LOOKUP_READ_FAILED');
    expect(body.accountId).toBeUndefined();
  });

  it('GET /api/pca/agent/:address → 503 when strict surfaces NFT-undeployed (PcaUnavailableError)', async () => {
    const addr = ethers.getAddress('0x' + 'ab'.repeat(20));
    const agent = {
      supportsPublishingConvictionNft: true,
      getConvictionAgentAccountId: async () => {
        const err: any = new Error('DKGPublishingConvictionNFT not deployed on this Hub.');
        err.code = 'PCA_UNAVAILABLE';
        throw err;
      },
    };
    const { res, done } = runCtx('GET', `/api/pca/agent/${addr}`, agent);
    await done;
    expect(res.statusCode).toBe(503);
  });

  it('GET /api/pca/agent/:address → 503 on RPC transport exhaustion (sanitized)', async () => {
    const addr = ethers.getAddress('0x' + 'ab'.repeat(20));
    const agent = {
      supportsPublishingConvictionNft: true,
      getConvictionAgentAccountId: async () => {
        const err: any = new Error(
          'agentToAccountId failed on all configured RPC endpoints (https://rpc.example/v2/SECRETKEY): boom',
        );
        err.code = 'RPC_ENDPOINTS_EXHAUSTED';
        err.rpcUrls = ['https://rpc.example/v2/SECRETKEY'];
        throw err;
      },
    };
    const { res, done } = runCtx('GET', `/api/pca/agent/${addr}`, agent);
    await done;
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('RPC_ENDPOINTS_EXHAUSTED');
    expect(res.body).not.toContain('SECRETKEY');
  });

  // ----- B10: register 409 carries existingAccountId (cross-PCA conflict) -----
  it('register AgentAlreadyRegistered → 409 with existingAccountId from the decoded revert arg', async () => {
    const addr = '0x' + '1'.repeat(40);
    const agent = {
      registerPublishingConvictionAgent: async () => {
        const err: any = new Error(`execution reverted: AgentAlreadyRegistered(${addr}, 5)`);
        // enrichEvmError shape: ethers.Result exposes named + positional access.
        err.revert = {
          name: 'AgentAlreadyRegistered',
          args: Object.assign([addr, 5n], { agent: addr, existingAccountId: 5n }),
        };
        throw err;
      },
      // Must NOT be consulted when the revert arg is present.
      getConvictionAgentAccountId: async () => { throw new Error('should not be called'); },
    };
    const { res, done } = runCtx('POST', '/api/pca/1/agent', agent, { agent: addr });
    await done;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'AgentAlreadyRegistered', accountId: '1', existingAccountId: '5' });
  });

  it('register AgentAlreadyRegistered with no revert arg → 409 with existingAccountId via reverse-map fallback', async () => {
    const addr = '0x' + '1'.repeat(40);
    const agent = {
      registerPublishingConvictionAgent: async () => {
        // RPC stripped the revert data — no err.revert, message-only.
        throw new Error('execution reverted: AgentAlreadyRegistered');
      },
      getConvictionAgentAccountId: async (a: string) => { expect(a).toBe(addr); return 7n; },
    };
    const { res, done } = runCtx('POST', '/api/pca/1/agent', agent, { agent: addr });
    await done;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'AgentAlreadyRegistered', accountId: '1', existingAccountId: '7' });
  });

  it('register AgentAlreadyRegistered with neither arg nor resolvable map → 409 WITHOUT existingAccountId', async () => {
    const addr = '0x' + '1'.repeat(40);
    const agent = {
      registerPublishingConvictionAgent: async () => { throw new Error('execution reverted: AgentAlreadyRegistered'); },
      getConvictionAgentAccountId: async () => 0n,
    };
    const { res, done } = runCtx('POST', '/api/pca/1/agent', agent, { agent: addr });
    await done;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'AgentAlreadyRegistered', accountId: '1' });
  });

  it('register AgentAlreadyRegistered fallback throwing must NOT mask the 409', async () => {
    const addr = '0x' + '1'.repeat(40);
    const agent = {
      registerPublishingConvictionAgent: async () => { throw new Error('execution reverted: AgentAlreadyRegistered'); },
      getConvictionAgentAccountId: async () => { throw new Error('reverse-map RPC blip'); },
    };
    const { res, done } = runCtx('POST', '/api/pca/1/agent', agent, { agent: addr });
    await done;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'AgentAlreadyRegistered', accountId: '1' });
  });

  // ----- GAP-4/5: GET /api/pca/:id?extended=1 (budget widget fields) -----
  it('GET /api/pca/:id?extended=1 includes the GAP-4/5 fields; default GET :id omits them', async () => {
    const baseInfo = {
      owner: '0x' + '9'.repeat(40), committedTRAC: 100n, baseEpochAllowance: 1n,
      createdAtEpoch: 1, expiresAtEpoch: 9, createdAtTimestamp: 0, expiresAtTimestamp: 0,
      discountBps: 500, topUpBuffer: 0n, agentCount: 0, lastSettledWindow: 0, fullySwept: false,
    };
    const agent = {
      supportsPublishingConvictionNft: true,
      getPublishingConvictionAccountInfo: async (_id: bigint, opts?: { extended?: boolean }) =>
        opts?.extended
          ? { ...baseInfo, primaryNode: 42n, lastPrimaryNodeChangeEpoch: 3, remainingAllowance: 8333n, currentEpoch: 7 }
          : baseInfo,
    };

    // Default: extended fields omitted (hot-poll path stays lean).
    const def = runCtx('GET', '/api/pca/1', agent);
    await def.done;
    expect(def.res.statusCode).toBe(200);
    const defBody = JSON.parse(def.res.body);
    expect(defBody).not.toHaveProperty('primaryNode');
    expect(defBody).not.toHaveProperty('remainingAllowance');
    expect(defBody).not.toHaveProperty('currentEpoch');

    // ?extended=1: fields present + typed (primaryNode/allowance strings, epochs numbers).
    const ext = runCtx('GET', '/api/pca/1?extended=1', agent);
    await ext.done;
    expect(ext.res.statusCode).toBe(200);
    const extBody = JSON.parse(ext.res.body);
    expect(extBody.primaryNode).toBe('42');
    expect(extBody.lastPrimaryNodeChangeEpoch).toBe(3);
    expect(extBody.remainingAllowance).toBe('8333');
    expect(extBody.remainingAllowanceTrac).toBe(ethers.formatEther(8333n));
    expect(extBody.currentEpoch).toBe(7);
  });
});

describe('PCA write routes — node-admin caller gating', () => {
  const ADMIN_TOKEN = 'node-admin-token';
  const AGENT_TOKEN = 'dkg_at_agent';

  // Resolves AGENT_TOKEN to an agent address, ADMIN_TOKEN (and anything else) to undefined.
  const gateAgent = (extra: Record<string, any> = {}) => ({
    resolveAgentByToken: (tok: string) => (tok === AGENT_TOKEN ? '0x' + 'a'.repeat(40) : undefined),
    createPublishingConvictionAccount: async () => ({ accountId: 1n, hash: '0x', blockNumber: 1, success: true }),
    setPublishingConvictionPrimaryNode: async () => ({ hash: '0x', blockNumber: 1, success: true }),
    ...extra,
  });

  it('rejects an agent-scoped token with 403 (create)', async () => {
    const { res, done } = runCtx('POST', '/api/pca', gateAgent(), { tokens: '100', primaryNode: '42' }, {
      authEnabled: true,
      requestToken: AGENT_TOKEN,
      validTokens: new Set([AGENT_TOKEN]),
    });
    await done;
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/admin token/i);
  });

  it('rejects an agent-scoped token with 403 (set primary-node)', async () => {
    const { res, done } = runCtx('POST', '/api/pca/7/primary-node', gateAgent(), { node: '42' }, {
      authEnabled: true,
      requestToken: AGENT_TOKEN,
      validTokens: new Set([AGENT_TOKEN]),
    });
    await done;
    expect(res.statusCode).toBe(403);
  });

  it('allows a node-admin token (create)', async () => {
    const { res, done } = runCtx('POST', '/api/pca', gateAgent(), { tokens: '100', primaryNode: '42' }, {
      authEnabled: true,
      requestToken: ADMIN_TOKEN,
      validTokens: new Set([ADMIN_TOKEN]),
    });
    await done;
    expect(res.statusCode).toBe(200);
  });

  it('does NOT gate the permissionless settle route', async () => {
    const agent = gateAgent({ settlePublishingConvictionAccount: async () => ({ hash: '0x', blockNumber: 1, success: true }) });
    const { res, done } = runCtx('POST', '/api/pca/7/settle', agent, undefined, {
      authEnabled: true,
      requestToken: AGENT_TOKEN,
      validTokens: new Set([AGENT_TOKEN]),
    });
    await done;
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /api/pca/contracts — wallet-connect address context', () => {
  it('returns chainId + nft/token/hub + publishingConviction addresses', async () => {
    const agent = {
      getPcaContractContext: async () => ({
        chainId: 31337,
        hubAddress: '0x' + '1'.repeat(40),
        nftAddress: '0x' + '2'.repeat(40),
        tokenAddress: '0x' + '3'.repeat(40),
        publishingConvictionAddress: '0x' + '4'.repeat(40),
        clearAgentsSupported: true,
      }),
    };
    const { res, done } = runCtx('GET', '/api/pca/contracts', agent);
    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      chainId: 31337,
      hubAddress: '0x' + '1'.repeat(40),
      nftAddress: '0x' + '2'.repeat(40),
      tokenAddress: '0x' + '3'.repeat(40),
      publishingConvictionAddress: '0x' + '4'.repeat(40),
      clearAgentsSupported: true,
    });
  });

  it('503 when the chain adapter has no surface', async () => {
    const { res, done } = runCtx('GET', '/api/pca/contracts', { getPcaContractContext: async () => null });
    await done;
    expect(res.statusCode).toBe(503);
  });

  it('is NOT parsed as an accountId by the :id GET (ordering guard)', async () => {
    // If the /:id GET matched first, "contracts" → parseAccountId → 400.
    const agent = { getPcaContractContext: async () => ({ chainId: 1, hubAddress: '0x', nftAddress: '0x', tokenAddress: '0x' }) };
    const { res, done } = runCtx('GET', '/api/pca/contracts', agent);
    await done;
    expect(res.statusCode).not.toBe(400);
  });
});

// #1370 HIGH: `owned` on the lookup-by-id GET means SERVER-MANAGEABLE, i.e. the
// PCA's ERC-721 owner is the daemon's PRIMARY operational wallet — the single
// signer every server-side PCA write is signed with. Admin keys and secondary
// operational wallets are local to the node but cannot drive those writes, so a
// PCA they own must report owned:false (else the UI lights up owner-gated actions
// whose writes revert on-chain instead of returning a clean 403/disabled state).
describe('daemon /api/pca/:id — owned flag is primary-signer-scoped (#1370 HIGH)', () => {
  const PRIMARY = ethers.getAddress('0x' + '1'.repeat(40));
  const SECONDARY = ethers.getAddress('0x' + '2'.repeat(40));
  const ADMIN = ethers.getAddress('0x' + '3'.repeat(40));
  const opWallets = {
    wallets: [{ address: PRIMARY }, { address: SECONDARY }],
    adminWallet: { address: ADMIN },
  };
  const agentFor = (owner: string) => ({
    supportsPublishingConvictionNft: true,
    getPublishingConvictionAccountInfo: async () => ({
      owner,
      committedTRAC: 0n,
      baseEpochAllowance: 0n,
      topUpBuffer: 0n,
      createdAtEpoch: 0,
      expiresAtEpoch: 0,
      createdAtTimestamp: 0,
      expiresAtTimestamp: 0,
      discountBps: 0,
      agentCount: 0,
      lastSettledWindow: 0,
      fullySwept: false,
    }),
    getConvictionPrimaryNode: async () => null,
    getNodeIdentityId: async () => 0n,
  });
  const ownedFor = async (owner: string) => {
    const { res, done } = runCtx('GET', '/api/pca/7', agentFor(owner), undefined, undefined, opWallets);
    await done;
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).owned;
  };

  it('owned:true when the PCA owner is the PRIMARY operational wallet (server can sign)', async () => {
    expect(await ownedFor(PRIMARY)).toBe(true);
  });

  it('owned:false when owned by a SECONDARY operational wallet (not the server signer)', async () => {
    expect(await ownedFor(SECONDARY)).toBe(false);
  });

  it('owned:false when owned by the ADMIN wallet (admin key never server-signs PCA writes)', async () => {
    expect(await ownedFor(ADMIN)).toBe(false);
  });

  // ----- B-staked-nodes (Stage-5): GET /api/pca/designatable-nodes -----
  const NODE_FIXTURE = [
    { nodeId: '0xaa', identityId: 42n, ask: 1n, stake: 250n },
    { nodeId: '0xbb', identityId: 57n, ask: 2n, stake: 180n },
    { nodeId: '0xcc', identityId: 61n, ask: 3n, stake: 500n },
  ];

  it('GET /api/pca/designatable-nodes → 200 {nodes,total} — the WHOLE table in one response (R4, no pagination)', async () => {
    const agent = { supportsPublishingConvictionNft: true, listDesignatableNodes: async () => NODE_FIXTURE };
    const { res, done } = runCtx('GET', '/api/pca/designatable-nodes', agent);
    await done;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(3);
    expect(body).not.toHaveProperty('nextStart'); // pagination dropped (R4)
    expect(body.nodes).toEqual([
      { nodeId: '0xaa', identityId: '42', ask: '1', stake: '250' },
      { nodeId: '0xbb', identityId: '57', ask: '2', stake: '180' },
      { nodeId: '0xcc', identityId: '61', ask: '3', stake: '500' },
    ]);
  });

  it('GET /api/pca/designatable-nodes ignores legacy ?start/?limit (no pagination, no 400)', async () => {
    const agent = { supportsPublishingConvictionNft: true, listDesignatableNodes: async () => NODE_FIXTURE };
    const { res, done } = runCtx('GET', '/api/pca/designatable-nodes?start=2&limit=1', agent);
    await done;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.nodes).toHaveLength(3); // full table regardless of legacy params
    expect(body).not.toHaveProperty('nextStart');
  });

  it('GET /api/pca/designatable-nodes → empty table {nodes:[],total:0}', async () => {
    const agent = { supportsPublishingConvictionNft: true, listDesignatableNodes: async () => [] };
    const { res, done } = runCtx('GET', '/api/pca/designatable-nodes', agent);
    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ nodes: [], total: 0 });
  });

  it('GET /api/pca/designatable-nodes → 503 when the adapter lacks the PCA surface (lookup not called)', async () => {
    let called = false;
    const agent = { supportsPublishingConvictionNft: false, listDesignatableNodes: async () => { called = true; return []; } };
    const { res, done } = runCtx('GET', '/api/pca/designatable-nodes', agent);
    await done;
    expect(res.statusCode).toBe(503);
    expect(called).toBe(false);
  });

  it('GET /api/pca/designatable-nodes → 503 SHARDING_TABLE_READ_FAILED on a CALL_EXCEPTION (dedicated code)', async () => {
    const agent = {
      supportsPublishingConvictionNft: true,
      listDesignatableNodes: async () => { const e: any = new Error('sharding read failed'); e.code = 'CALL_EXCEPTION'; throw e; },
    };
    const { res, done } = runCtx('GET', '/api/pca/designatable-nodes', agent);
    await done;
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('SHARDING_TABLE_READ_FAILED');
  });

  it('GET /api/pca/designatable-nodes → 503 FEATURE_UNAVAILABLE when the facade returns null (no code)', async () => {
    const agent = { supportsPublishingConvictionNft: true, listDesignatableNodes: async () => null };
    const { res, done } = runCtx('GET', '/api/pca/designatable-nodes', agent);
    await done;
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBeUndefined();
  });

  it('route ordering: /api/pca/designatable-nodes is matched BEFORE the generic GET :id (not 400 as an id)', async () => {
    // If the generic :id matcher ran first, "designatable-nodes" would parse as
    // an accountId and 400 ("Invalid accountId"). A clean 200 proves the
    // specific route is registered ahead of it.
    const agent = { supportsPublishingConvictionNft: true, listDesignatableNodes: async () => [] };
    const { res, done } = runCtx('GET', '/api/pca/designatable-nodes', agent);
    await done;
    expect(res.statusCode).toBe(200);
  });

  it('GET /api/pca/designatable-nodes threads ?fresh=1 to the facade (M4 cache-bust)', async () => {
    const seen: Array<{ fresh?: boolean } | undefined> = [];
    const agent = {
      supportsPublishingConvictionNft: true,
      listDesignatableNodes: async (opts?: { fresh?: boolean }) => { seen.push(opts); return NODE_FIXTURE; },
    };
    const a = runCtx('GET', '/api/pca/designatable-nodes?fresh=1', agent); await a.done;
    const b = runCtx('GET', '/api/pca/designatable-nodes', agent); await b.done;
    expect(a.res.statusCode).toBe(200);
    expect(seen[0]).toEqual({ fresh: true });  // ?fresh=1 → bypass the adapter cache
    expect(seen[1]).toEqual({ fresh: false }); // default → use the cache
  });

  it('GET /api/pca/designatable-nodes → 503 SHARDING_TABLE_READ_FAILED on a BAD_DATA decode failure (L10)', async () => {
    const agent = {
      supportsPublishingConvictionNft: true,
      listDesignatableNodes: async () => { const e: any = new Error('could not decode result data'); e.code = 'BAD_DATA'; throw e; },
    };
    const { res, done } = runCtx('GET', '/api/pca/designatable-nodes', agent);
    await done;
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('SHARDING_TABLE_READ_FAILED');
  });

  it('GET /api/pca/designatable-nodes → 503 on an RPC transport exhaustion (L12)', async () => {
    const agent = {
      supportsPublishingConvictionNft: true,
      listDesignatableNodes: async () => { throw Object.assign(new Error('all endpoints failed'), { code: 'RPC_ENDPOINTS_EXHAUSTED' }); },
    };
    const { res, done } = runCtx('GET', '/api/pca/designatable-nodes', agent);
    await done;
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('RPC_ENDPOINTS_EXHAUSTED');
  });

  it('GET /api/pca/designatable-nodes → 503 on no-chain and on PCA-unavailable (L12)', async () => {
    const noChain = { supportsPublishingConvictionNft: true, listDesignatableNodes: async () => { throw new Error('No blockchain configured'); } };
    const r1 = runCtx('GET', '/api/pca/designatable-nodes', noChain); await r1.done;
    expect(r1.res.statusCode).toBe(503);

    const unavail = { supportsPublishingConvictionNft: true, listDesignatableNodes: async () => { throw new Error('DKGPublishingConvictionNFT is not deployed on this Hub'); } };
    const r2 = runCtx('GET', '/api/pca/designatable-nodes', unavail); await r2.done;
    expect(r2.res.statusCode).toBe(503);
  });

  it('GET /api/pca/designatable-nodes → 500 on a generic (non-classified) error (L12)', async () => {
    const agent = { supportsPublishingConvictionNft: true, listDesignatableNodes: async () => { throw new Error('boom'); } };
    const { res, done } = runCtx('GET', '/api/pca/designatable-nodes', agent);
    await done;
    expect(res.statusCode).toBe(500);
  });

  // ----- sub-PR #2: GET /api/pca/contracts (browser bootstrap) -----
  const CONTRACTS_FIXTURE = {
    nft: ethers.getAddress('0x' + 'ab'.repeat(20)),
    token: ethers.getAddress('0x' + 'cd'.repeat(20)),
    chainId: 'base:84532',
    rpcUrls: ['https://rpc.example/v2/SECRETKEY', 'https://rpc.example/2'],
    walletRpcUrls: ['https://wallet-rpc.example/base-sepolia', '/api/pca/rpc', 'ws://wallet-rpc.example'],
  };
  const contractsAgent = (overrides: Record<string, unknown>) => ({
    supportsPublishingConvictionNft: true,
    supportsPublishingConvictionRpc: true,
    ...overrides,
  });

  it('GET /api/pca/contracts returns no wallet RPCs when the adapter omits them', async () => {
    const agent = contractsAgent({
      getPublishingConvictionContracts: async () => {
        const { walletRpcUrls: _walletRpcUrls, ...contracts } = CONTRACTS_FIXTURE;
        return contracts;
      },
    });
    const { res, done } = runCtx('GET', '/api/pca/contracts', agent);
    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).walletRpcUrls).toEqual([]);
  });

  it('GET /api/pca/contracts returns a same-origin RPC proxy and never leaks adapter URLs', async () => {
    const agent = contractsAgent({ getPublishingConvictionContracts: async () => CONTRACTS_FIXTURE });
    const { res, done } = runCtx('GET', '/api/pca/contracts', agent);
    await done;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      ...CONTRACTS_FIXTURE,
      rpcUrls: ['/api/pca/rpc'],
      walletRpcUrls: ['https://wallet-rpc.example/base-sepolia'],
    });
    expect(body.chainId).toBe('base:84532'); // compound, NOT pre-stripped
    expect(res.body).not.toContain('SECRETKEY');
    expect(res.body).not.toContain('https://rpc.example');
    expect(res.body).not.toContain('ws://wallet-rpc.example');
  });

  it('GET /api/pca/contracts → 503 when the adapter lacks the PCA surface (lookup not called)', async () => {
    let called = false;
    const agent = { supportsPublishingConvictionNft: false, getPublishingConvictionContracts: async () => { called = true; return CONTRACTS_FIXTURE; } };
    const { res, done } = runCtx('GET', '/api/pca/contracts', agent);
    await done;
    expect(res.statusCode).toBe(503);
    expect(called).toBe(false);
  });

  it('GET /api/pca/contracts returns 503 when the daemon RPC bridge is unavailable', async () => {
    let called = false;
    const agent = {
      supportsPublishingConvictionNft: true,
      supportsPublishingConvictionRpc: false,
      getPublishingConvictionContracts: async () => { called = true; return CONTRACTS_FIXTURE; },
    };
    const { res, done } = runCtx('GET', '/api/pca/contracts', agent);
    await done;
    expect(res.statusCode).toBe(503);
    expect(called).toBe(false);
  });

  it('GET /api/pca/contracts → 503 FEATURE_UNAVAILABLE when the facade returns null (no code)', async () => {
    const agent = contractsAgent({ getPublishingConvictionContracts: async () => null });
    const { res, done } = runCtx('GET', '/api/pca/contracts', agent);
    await done;
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBeUndefined();
  });

  it('GET /api/pca/contracts → 503 CONTRACTS_READ_FAILED on a CALL_EXCEPTION/BAD_DATA (dedicated code)', async () => {
    for (const code of ['CALL_EXCEPTION', 'BAD_DATA']) {
      const agent = {
        supportsPublishingConvictionNft: true,
        supportsPublishingConvictionRpc: true,
        getPublishingConvictionContracts: async () => { const e: any = new Error('addr read failed'); e.code = code; throw e; },
      };
      const { res, done } = runCtx('GET', '/api/pca/contracts', agent);
      await done;
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).code).toBe('CONTRACTS_READ_FAILED');
    }
  });

  it('GET /api/pca/contracts → 503 transport / 503 noChain+unavailable / 500 generic', async () => {
    const transport = contractsAgent({ getPublishingConvictionContracts: async () => { throw Object.assign(new Error('exhausted'), { code: 'RPC_ENDPOINTS_EXHAUSTED' }); } });
    const t = runCtx('GET', '/api/pca/contracts', transport); await t.done;
    expect(t.res.statusCode).toBe(503);
    expect(JSON.parse(t.res.body).code).toBe('RPC_ENDPOINTS_EXHAUSTED');

    const noChain = contractsAgent({ getPublishingConvictionContracts: async () => { throw new Error('No blockchain configured'); } });
    const n = runCtx('GET', '/api/pca/contracts', noChain); await n.done;
    expect(n.res.statusCode).toBe(503);

    const unavail = contractsAgent({ getPublishingConvictionContracts: async () => { throw new Error('DKGPublishingConvictionNFT is not deployed on this Hub'); } });
    const u = runCtx('GET', '/api/pca/contracts', unavail); await u.done;
    expect(u.res.statusCode).toBe(503);

    const generic = contractsAgent({
      getPublishingConvictionContracts: async () => { throw new Error('boom https://rpc.example/v2/SECRETKEY'); },
    });
    const g = runCtx('GET', '/api/pca/contracts', generic); await g.done;
    expect(g.res.statusCode).toBe(500);
    expect(g.res.body).toContain('getPublishingConvictionContracts failed');
    expect(g.res.body).not.toContain('SECRETKEY');
    expect(g.res.body).not.toContain('https://rpc.example');
  });

  it('POST /api/pca/rpc forwards allowed read JSON-RPC without leaking upstream URLs', async () => {
    const payload = { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] };
    const rpcMock = vi.fn(async (method: string, params: unknown[]) => {
      expect(method).toBe('eth_chainId');
      expect(params).toEqual([]);
      return '0x14a34';
    });
    const agent = { supportsPublishingConvictionNft: true, requestPublishingConvictionRpc: rpcMock };

    const { res, done } = runCtx('POST', '/api/pca/rpc', agent, payload);
    await done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ jsonrpc: '2.0', id: 1, result: '0x14a34' });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(res.body).not.toContain('SECRETKEY');
    expect(res.body).not.toContain('https://rpc.example');
  });

  it('POST /api/pca/rpc returns 503 when the daemon RPC bridge is unavailable', async () => {
    const rpcMock = vi.fn();
    const agent = {
      supportsPublishingConvictionNft: true,
      supportsPublishingConvictionRpc: false,
      requestPublishingConvictionRpc: rpcMock,
    };

    const { res, done } = runCtx('POST', '/api/pca/rpc', agent, {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_chainId',
      params: [],
    });
    await done;

    expect(res.statusCode).toBe(503);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('POST /api/pca/rpc allows PCA-scoped eth_call and rejects unrelated eth_call before delegation', async () => {
    const allowedCall = {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: CONTRACTS_FIXTURE.nft, data: '0x70a08231' }, 'latest'],
    };
    const rejectedCall = {
      jsonrpc: '2.0',
      id: 2,
      method: 'eth_call',
      params: [{ to: '0x' + '33'.repeat(20), data: '0x70a08231' }, 'latest'],
    };
    const rpcMock = vi.fn(async () => '0x' + '0'.repeat(63) + '1');
    const agent = {
      supportsPublishingConvictionNft: true,
      getPublishingConvictionContracts: async () => CONTRACTS_FIXTURE,
      requestPublishingConvictionRpc: rpcMock,
    };

    const ok = runCtx('POST', '/api/pca/rpc', agent, allowedCall);
    await ok.done;
    expect(ok.res.statusCode).toBe(200);
    expect(JSON.parse(ok.res.body)).toEqual({ jsonrpc: '2.0', id: 1, result: '0x' + '0'.repeat(63) + '1' });
    expect(rpcMock).toHaveBeenCalledWith('eth_call', allowedCall.params);

    rpcMock.mockClear();
    const bad = runCtx('POST', '/api/pca/rpc', agent, rejectedCall);
    await bad.done;
    expect(bad.res.statusCode).toBe(200);
    const body = JSON.parse(bad.res.body);
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain('target or selector is not allowed');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('POST /api/pca/rpc allows the browser PCA eth_call selectors with ABI-encoded calldata', async () => {
    const nft = new ethers.Interface([
      'function balanceOf(address owner) view returns (uint256)',
      'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
      'function ownerOf(uint256 tokenId) view returns (address)',
      'function getDiscountBps(uint96 accountId) view returns (uint16)',
    ]);
    const token = new ethers.Interface([
      'function balanceOf(address owner) view returns (uint256)',
      'function allowance(address owner, address spender) view returns (uint256)',
    ]);
    const owner = ethers.getAddress('0x' + '44'.repeat(20));
    const spender = ethers.getAddress('0x' + '55'.repeat(20));
    const cases = [
      { to: CONTRACTS_FIXTURE.nft, data: nft.encodeFunctionData('balanceOf', [owner]) },
      { to: CONTRACTS_FIXTURE.nft, data: nft.encodeFunctionData('tokenOfOwnerByIndex', [owner, 0n]) },
      { to: CONTRACTS_FIXTURE.nft, data: nft.encodeFunctionData('ownerOf', [1n]) },
      { to: CONTRACTS_FIXTURE.nft, data: nft.encodeFunctionData('getDiscountBps', [1n]) },
      { to: CONTRACTS_FIXTURE.token, data: token.encodeFunctionData('balanceOf', [owner]) },
      { to: CONTRACTS_FIXTURE.token, data: token.encodeFunctionData('allowance', [owner, spender]) },
    ];
    const rpcMock = vi.fn(async () => '0x');
    const agent = {
      supportsPublishingConvictionNft: true,
      getPublishingConvictionContracts: async () => CONTRACTS_FIXTURE,
      requestPublishingConvictionRpc: rpcMock,
    };

    for (const [index, call] of cases.entries()) {
      const params = [{ to: call.to, data: call.data }, 'latest'];
      const { res, done } = runCtx('POST', '/api/pca/rpc', agent, {
        jsonrpc: '2.0',
        id: index + 1,
        method: 'eth_call',
        params,
      });
      await done;
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ jsonrpc: '2.0', id: index + 1, result: '0x' });
      expect(rpcMock).toHaveBeenLastCalledWith('eth_call', params);
    }
    expect(rpcMock).toHaveBeenCalledTimes(cases.length);
  });

  it('POST /api/pca/rpc rejects over-broad eth_call params before adapter delegation', async () => {
    const call = { to: CONTRACTS_FIXTURE.nft, data: '0x70a08231' };
    const cases = [
      { id: 1, method: 'eth_call', params: [call, 'pending'] },
      { id: 2, method: 'eth_call', params: [call, { blockNumber: '0x1' }] },
      { id: 3, method: 'eth_call', params: [call, 'latest', { [CONTRACTS_FIXTURE.nft]: { balance: '0x0' } }] },
      { id: 4, method: 'eth_call', params: [call, 'safe', {}, {}] },
    ];
    const getContractsMock = vi.fn(async () => CONTRACTS_FIXTURE);
    const rpcMock = vi.fn();
    const agent = {
      supportsPublishingConvictionNft: true,
      getPublishingConvictionContracts: getContractsMock,
      requestPublishingConvictionRpc: rpcMock,
    };

    const { res, done } = runCtx('POST', '/api/pca/rpc', agent, cases);
    await done;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(cases.length);
    for (const response of body) {
      expect(response.error.code).toBe(-32602);
    }
    expect(getContractsMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('POST /api/pca/rpc supports viem-style JSON-RPC batches', async () => {
    const payload = [
      { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
      { jsonrpc: '2.0', id: 2, method: 'eth_getBlockByNumber', params: ['latest', false] },
    ];
    const expected = [
      { jsonrpc: '2.0', id: 1, result: '0x10' },
      { jsonrpc: '2.0', id: 2, result: { number: '0x10' } },
    ];
    const rpcMock = vi.fn(async (method: string) => {
      if (method === 'eth_blockNumber') return '0x10';
      return { number: '0x10' };
    });
    const agent = { supportsPublishingConvictionNft: true, requestPublishingConvictionRpc: rpcMock };

    const { res, done } = runCtx('POST', '/api/pca/rpc', agent, payload);
    await done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(expected);
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it('POST /api/pca/rpc rejects empty JSON-RPC batches before adapter delegation', async () => {
    const rpcMock = vi.fn();
    const agent = { supportsPublishingConvictionNft: true, requestPublishingConvictionRpc: rpcMock };

    const { res, done } = runCtx('POST', '/api/pca/rpc', agent, []);
    await done;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'JSON-RPC batch must contain at least one request' });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('POST /api/pca/rpc rejects oversized JSON-RPC batches before adapter delegation', async () => {
    const rpcMock = vi.fn();
    const agent = { supportsPublishingConvictionNft: true, requestPublishingConvictionRpc: rpcMock };
    const payload = Array.from({ length: 21 }, (_, i) => ({
      jsonrpc: '2.0',
      id: i + 1,
      method: 'eth_blockNumber',
      params: [],
    }));

    const { res, done } = runCtx('POST', '/api/pca/rpc', agent, payload);
    await done;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'JSON-RPC batch must contain at most 20 requests' });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('POST /api/pca/rpc preserves null JSON-RPC results for pending transaction reads', async () => {
    const rpcMock = vi.fn(async () => null);
    const agent = { supportsPublishingConvictionNft: true, requestPublishingConvictionRpc: rpcMock };
    const { res, done } = runCtx('POST', '/api/pca/rpc', agent, {
      jsonrpc: '2.0',
      id: 7,
      method: 'eth_getTransactionReceipt',
      params: ['0x' + '11'.repeat(32)],
    });
    await done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ jsonrpc: '2.0', id: 7, result: null });
    expect(rpcMock).toHaveBeenCalledWith('eth_getTransactionReceipt', ['0x' + '11'.repeat(32)]);
  });

  it('POST /api/pca/rpc preserves null JSON-RPC results for missing block reads', async () => {
    const rpcMock = vi.fn(async () => null);
    const agent = { supportsPublishingConvictionNft: true, requestPublishingConvictionRpc: rpcMock };
    const { res, done } = runCtx('POST', '/api/pca/rpc', agent, {
      jsonrpc: '2.0',
      id: 9,
      method: 'eth_getBlockByNumber',
      params: ['0xffffffffffff', false],
    });
    await done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ jsonrpc: '2.0', id: 9, result: null });
    expect(rpcMock).toHaveBeenCalledWith('eth_getBlockByNumber', ['0xffffffffffff', false]);
  });

  it('POST /api/pca/rpc allows viem receipt reconciliation full-block reads for exact block ids', async () => {
    const block = { number: '0x2cc9b11', transactions: [{ hash: '0x' + '22'.repeat(32) }] };
    const rpcMock = vi.fn(async () => block);
    const agent = { supportsPublishingConvictionNft: true, requestPublishingConvictionRpc: rpcMock };
    const { res, done } = runCtx('POST', '/api/pca/rpc', agent, {
      jsonrpc: '2.0',
      id: 10,
      method: 'eth_getBlockByNumber',
      params: ['0x2cc9b11', true],
    });
    await done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ jsonrpc: '2.0', id: 10, result: block });
    expect(rpcMock).toHaveBeenCalledWith('eth_getBlockByNumber', ['0x2cc9b11', true]);
  });

  it('POST /api/pca/rpc rejects over-broad non-PCA read params before adapter delegation', async () => {
    const rpcMock = vi.fn();
    const agent = { supportsPublishingConvictionNft: true, requestPublishingConvictionRpc: rpcMock };
    const cases = [
      { id: 1, method: 'eth_chainId', params: ['latest'] },
      { id: 2, method: 'eth_blockNumber', params: [false] },
      { id: 3, method: 'eth_getTransactionReceipt', params: ['0x1234'] },
      { id: 4, method: 'eth_getTransactionByHash', params: ['0x' + '11'.repeat(31)] },
      { id: 5, method: 'eth_getBlockByNumber', params: ['latest', true] },
      { id: 6, method: 'eth_getBlockByNumber', params: ['pending', false] },
      { id: 7, method: 'eth_getBlockByNumber', params: ['0x2cc9b11', 'true'] },
    ];

    const { res, done } = runCtx('POST', '/api/pca/rpc', agent, cases);
    await done;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(cases.length);
    for (const response of body) {
      expect(response.error.code).toBe(-32602);
    }
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('POST /api/pca/rpc maps unsupported facade nulls to feature-unavailable errors', async () => {
    const rpcMock = vi.fn(async () => null);
    const agent = { supportsPublishingConvictionNft: true, requestPublishingConvictionRpc: rpcMock };
    const { res, done } = runCtx('POST', '/api/pca/rpc', agent, {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_chainId',
      params: [],
    });
    await done;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32004);
    expect(body.error.message).toContain('Chain adapter does not expose V10 Publishing Conviction NFT methods');
    expect(rpcMock).toHaveBeenCalledWith('eth_chainId', []);
  });

  it('POST /api/pca/rpc rejects write/admin JSON-RPC methods before adapter delegation', async () => {
    const rpcMock = vi.fn();
    const agent = { supportsPublishingConvictionNft: true, requestPublishingConvictionRpc: rpcMock };
    const { res, done } = runCtx('POST', '/api/pca/rpc', agent, {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_sendRawTransaction',
      params: ['0xdead'],
    });
    await done;

    expect(res.statusCode).toBe(200);
    expect(rpcMock).not.toHaveBeenCalled();
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toContain('eth_sendRawTransaction');
    expect(res.body).not.toContain('SECRETKEY');
  });

  it('POST /api/pca/rpc maps transport failures to sanitized JSON-RPC errors', async () => {
    const payload = { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] };
    const err = new ChainRpcTransportError(
      'RPC_ENDPOINTS_EXHAUSTED',
      'all RPC endpoints failed (https://rpc.example/v2/SECRETKEY)',
      { rpcUrls: ['https://rpc.example/v2/SECRETKEY'] },
    );
    const agent = { supportsPublishingConvictionNft: true, requestPublishingConvictionRpc: async () => { throw err; } };

    const { res, done } = runCtx('POST', '/api/pca/rpc', agent, payload);
    await done;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32002);
    expect(body.error.data.code).toBe('RPC_ENDPOINTS_EXHAUSTED');
    expect(res.body).not.toContain('SECRETKEY');
    expect(res.body).not.toContain('https://rpc.example');
  });

  it('POST /api/pca/rpc sanitizes generic adapter errors', async () => {
    const agent = {
      supportsPublishingConvictionNft: true,
      requestPublishingConvictionRpc: async () => {
        throw new Error('boom https://rpc.example/v2/SECRETKEY');
      },
    };
    const { res, done } = runCtx('POST', '/api/pca/rpc', agent, {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_blockNumber',
      params: [],
    });
    await done;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain('PCA RPC read failed');
    expect(res.body).not.toContain('SECRETKEY');
    expect(res.body).not.toContain('https://rpc.example');
  });

  it('route ordering: /api/pca/contracts is matched BEFORE the generic GET :id (not 400 as an id)', async () => {
    const agent = contractsAgent({ getPublishingConvictionContracts: async () => CONTRACTS_FIXTURE });
    const { res, done } = runCtx('GET', '/api/pca/contracts', agent);
    await done;
    expect(res.statusCode).toBe(200); // a generic :id match would 400 "Invalid accountId"
  });
});
