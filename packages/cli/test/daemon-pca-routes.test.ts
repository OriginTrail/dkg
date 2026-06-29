import { describe, it, expect } from 'vitest';
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

function runCtx(method: string, rawPath: string, agent: any, body?: unknown) {
  const res = fakeRes();
  // Mirror handle-request.ts: route on url.pathname, query lives on url.
  const url = new URL(`http://127.0.0.1${rawPath}`);
  const ctx = {
    req: fakeReq(method, rawPath, body),
    res,
    agent,
    path: url.pathname,
    url,
  } as unknown as RequestContext;
  return { res, done: handlePcaRoutes(ctx) };
}

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

  it('GET /api/pca/:id/agents → 400 for a non-numeric id', async () => {
    const { res, done } = runCtx('GET', '/api/pca/not-an-id/agents', {});
    await done;
    expect(res.statusCode).toBe(400);
  });

  // ----- GAP-3: GET /api/pca/agent/:address (which PCA funds a wallet) -----
  it('GET /api/pca/agent/:address → 200 { agent, accountId } for a registered wallet', async () => {
    const addr = ethers.getAddress('0x' + 'ab'.repeat(20));
    let queried: string | null = null;
    const agent = {
      getConvictionAgentAccountId: async (a: string) => { queried = a; return 7n; },
    };
    const { res, done } = runCtx('GET', `/api/pca/agent/${addr}`, agent);
    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ agent: addr, accountId: '7' });
    expect(queried).toBe(addr);
  });

  it('GET /api/pca/agent/:address → 200 { accountId: null } for an unregistered wallet (0n)', async () => {
    const addr = ethers.getAddress('0x' + 'cd'.repeat(20));
    const agent = { getConvictionAgentAccountId: async () => 0n };
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

  it('GET /api/pca/agent/:address → 503 when the adapter lacks the surface (facade null)', async () => {
    const addr = ethers.getAddress('0x' + 'ab'.repeat(20));
    const agent = { getConvictionAgentAccountId: async () => null };
    const { res, done } = runCtx('GET', `/api/pca/agent/${addr}`, agent);
    await done;
    expect(res.statusCode).toBe(503);
  });

  it('GET /api/pca/agent/:address → 503 on RPC transport exhaustion (sanitized)', async () => {
    const addr = ethers.getAddress('0x' + 'ab'.repeat(20));
    const agent = {
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
});
