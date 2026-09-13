import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { createAllowedHttpAuthentication } from '../src/auth.js';
import { handleRequest, type HandleRequestInput } from '../src/daemon/handle-request.js';
import { handleIdentityWalletRoutes } from '../src/daemon/routes/identity-wallets.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

function fakeRes() {
  const res: any = { statusCode: 0, body: '', writableEnded: false, headersSent: false };
  res.writeHead = (status: number) => { res.statusCode = status; };
  res.end = (body: string) => { res.body = body; res.writableEnded = true; };
  return res;
}

function runCtx(method: string, path: string, agent: any, body?: unknown) {
  const res = fakeRes();
  const req: any = { method, url: path };
  if (body !== undefined) req.__dkgPrebufferedBody = Buffer.from(JSON.stringify(body));
  const ctx = {
    req,
    res,
    agent,
    path,
    url: new URL(`http://127.0.0.1${path}`),
  } as unknown as RequestContext;
  return { res, done: handleIdentityWalletRoutes(ctx) };
}

function runRawCtx(method: string, path: string, agent: any, body: string) {
  const res = fakeRes();
  const req: any = {
    method,
    url: path,
    __dkgPrebufferedBody: Buffer.from(body),
  };
  const ctx = {
    req,
    res,
    agent,
    path,
    url: new URL(`http://127.0.0.1${path}`),
  } as unknown as RequestContext;
  return { res, done: handleIdentityWalletRoutes(ctx) };
}

const CONTRACTS = {
  profile: ethers.getAddress(`0x${'11'.repeat(20)}`),
  identity: ethers.getAddress(`0x${'22'.repeat(20)}`),
  storage: ethers.getAddress(`0x${'33'.repeat(20)}`),
  chainId: 'base:84532',
  rpcUrls: ['https://private.example/v2/SECRETKEY'],
  walletRpcUrls: ['https://wallet.example/base', '/api/private', 'ws://wallet.example'],
};

describe('daemon identity-wallet browser capability', () => {
  it('is reachable through the top-level daemon request dispatcher', async () => {
    const res = fakeRes();
    const req = {
      method: 'GET',
      url: '/api/identity-wallets/contracts',
      headers: { host: '127.0.0.1' },
    };
    const agent = {
      resolveAgentAddress: () => ethers.ZeroAddress,
      supportsIdentityWalletManagement: true,
      getIdentityWalletContracts: vi.fn(async () => CONTRACTS),
      requestBrowserWalletRpc: vi.fn(),
    };

    await handleRequest({
      req,
      res,
      agent,
      // The dispatcher reaches the status routes, which read the live config
      // snapshot before matching a path.
      configStore: { current: {} },
      authentication: createAllowedHttpAuthentication({ mode: 'disabled' }),
    } as unknown as HandleRequestInput);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).storage).toBe(CONTRACTS.storage);
    expect(JSON.parse(res.body).error).not.toBe('Not found');
  });

  it('bootstraps independently of PCA support and never exposes private RPC URLs', async () => {
    const agent = {
      supportsPublishingConvictionNft: false,
      supportsIdentityWalletManagement: true,
      getIdentityWalletContracts: vi.fn(async () => CONTRACTS),
      requestBrowserWalletRpc: vi.fn(),
    };
    const request = runCtx('GET', '/api/identity-wallets/contracts', agent);
    await request.done;
    expect(request.res.statusCode).toBe(200);
    expect(JSON.parse(request.res.body)).toEqual({
      ...CONTRACTS,
      rpcUrls: ['/api/identity-wallets/rpc'],
      walletRpcUrls: ['https://wallet.example/base'],
    });
    expect(request.res.body).not.toContain('SECRETKEY');
    expect(request.res.body).not.toContain('private.example');
  });

  it('returns a controlled unavailable response for a missing identity contract set', async () => {
    const agent = {
      supportsIdentityWalletManagement: true,
      getIdentityWalletContracts: vi.fn(async () => null),
      requestBrowserWalletRpc: vi.fn(),
    };
    const request = runCtx('GET', '/api/identity-wallets/contracts', agent);
    await request.done;
    expect(request.res.statusCode).toBe(503);
    expect(JSON.parse(request.res.body).error).toMatch(/not available/);
    expect(JSON.parse(request.res.body).code).toBe('IDENTITY_WALLET_MANAGEMENT_UNAVAILABLE');
  });

  it('allows only the two IdentityStorage reads and delegates through the identity bridge', async () => {
    const identityStorage = new ethers.Interface([
      'function keyHasPurpose(uint72 identityId, bytes32 key, uint256 purpose) view returns (bool)',
      'function getKeysByPurpose(uint72 identityId, uint256 purpose) view returns (bytes32[])',
      'function getIdentityId(address operational) view returns (uint72)',
    ]);
    const key = ethers.keccak256(ethers.solidityPacked([
      'address',
    ], [ethers.getAddress(`0x${'45'.repeat(20)}`)]));
    const allowed = [
      identityStorage.encodeFunctionData('keyHasPurpose', [61n, key, 1n]),
      identityStorage.encodeFunctionData('getKeysByPurpose', [61n, 2n]),
    ];
    const rpc = vi.fn(async () => '0x');
    const agent = {
      supportsIdentityWalletManagement: true,
      getIdentityWalletContracts: vi.fn(async () => CONTRACTS),
      requestBrowserWalletRpc: rpc,
    };

    for (const [index, data] of allowed.entries()) {
      const params = [{ to: CONTRACTS.storage, data }, 'latest'];
      const request = runCtx('POST', '/api/identity-wallets/rpc', agent, {
        jsonrpc: '2.0', id: index + 1, method: 'eth_call', params,
      });
      await request.done;
      expect(JSON.parse(request.res.body)).toEqual({
        jsonrpc: '2.0', id: index + 1, result: '0x',
      });
      expect(rpc).toHaveBeenLastCalledWith('eth_call', params);
    }

    rpc.mockClear();
    const rejected = runCtx('POST', '/api/identity-wallets/rpc', agent, {
      jsonrpc: '2.0',
      id: 3,
      method: 'eth_call',
      params: [{
        to: CONTRACTS.storage,
        data: identityStorage.encodeFunctionData('getIdentityId', [
          ethers.getAddress(`0x${'45'.repeat(20)}`),
        ]),
      }, 'latest'],
    });
    await rejected.done;
    expect(JSON.parse(rejected.res.body).error.code).toBe(-32602);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['Profile target', CONTRACTS.profile, {}],
    ['Identity target', CONTRACTS.identity, {}],
    ['unrelated target', ethers.getAddress(`0x${'44'.repeat(20)}`), {}],
    ['from transaction field', CONTRACTS.storage, { from: ethers.getAddress(`0x${'55'.repeat(20)}`) }],
    ['value transaction field', CONTRACTS.storage, { value: '0x0' }],
    ['gas transaction field', CONTRACTS.storage, { gas: '0x5208' }],
  ])('rejects the unsafe eth_call case: %s, before adapter delegation', async (
    _label,
    to,
    extraFields,
  ) => {
    const rpc = vi.fn(async () => '0x');
    const agent = {
      supportsIdentityWalletManagement: true,
      getIdentityWalletContracts: vi.fn(async () => CONTRACTS),
      requestBrowserWalletRpc: rpc,
    };
    const data = new ethers.Interface([
      'function keyHasPurpose(uint72 identityId, bytes32 key, uint256 purpose) view returns (bool)',
    ]).encodeFunctionData('keyHasPurpose', [61n, `0x${'ab'.repeat(32)}`, 1n]);
    const request = runCtx('POST', '/api/identity-wallets/rpc', agent, {
      jsonrpc: '2.0',
      id: 9,
      method: 'eth_call',
      params: [{ to, data, ...extraFields }, 'latest'],
    });
    await request.done;
    expect(JSON.parse(request.res.body).error.code).toBe(-32602);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects unsafe JSON-RPC methods before adapter delegation', async () => {
    const rpc = vi.fn(async () => '0x');
    const agent = {
      supportsIdentityWalletManagement: true,
      getIdentityWalletContracts: vi.fn(async () => CONTRACTS),
      requestBrowserWalletRpc: rpc,
    };
    const request = runCtx('POST', '/api/identity-wallets/rpc', agent, {
      jsonrpc: '2.0', id: 10, method: 'eth_sendRawTransaction', params: ['0xdeadbeef'],
    });
    await request.done;
    expect(JSON.parse(request.res.body).error).toMatchObject({
      code: -32601,
      message: expect.stringContaining('eth_sendRawTransaction'),
    });
    expect(agent.getIdentityWalletContracts).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON and malformed eth_call envelopes in the shared executor', async () => {
    const rpc = vi.fn(async () => '0x');
    const agent = {
      supportsIdentityWalletManagement: true,
      getIdentityWalletContracts: vi.fn(async () => CONTRACTS),
      requestBrowserWalletRpc: rpc,
    };

    const malformedJson = runRawCtx('POST', '/api/identity-wallets/rpc', agent, '{');
    await malformedJson.done;
    expect(malformedJson.res.statusCode).toBe(400);
    expect(JSON.parse(malformedJson.res.body).error).toMatch(/^Invalid JSON:/);

    const malformedCall = runCtx('POST', '/api/identity-wallets/rpc', agent, {
      jsonrpc: '2.0', id: 11, method: 'eth_call', params: [{ to: CONTRACTS.storage }],
    });
    await malformedCall.done;
    expect(JSON.parse(malformedCall.res.body).error).toMatchObject({
      code: -32602,
      message: expect.stringContaining('target address and function selector'),
    });
    expect(agent.getIdentityWalletContracts).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', []],
    ['oversized', Array.from({ length: 21 }, (_, index) => ({
      jsonrpc: '2.0', id: index + 1, method: 'eth_chainId', params: [],
    }))],
  ])('rejects an %s JSON-RPC batch before adapter delegation', async (_label, body) => {
    const rpc = vi.fn(async () => '0x14a34');
    const agent = {
      supportsIdentityWalletManagement: true,
      getIdentityWalletContracts: vi.fn(async () => CONTRACTS),
      requestBrowserWalletRpc: rpc,
    };

    const request = runCtx('POST', '/api/identity-wallets/rpc', agent, body);
    await request.done;

    expect(request.res.statusCode).toBe(400);
    expect(JSON.parse(request.res.body)).toEqual({
      error: 'JSON-RPC batch must contain between 1 and 20 requests',
    });
    expect(agent.getIdentityWalletContracts).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('accepts and delegates the maximum 20-request JSON-RPC batch', async () => {
    const rpc = vi.fn(async () => '0x14a34');
    const agent = {
      supportsIdentityWalletManagement: true,
      getIdentityWalletContracts: vi.fn(async () => CONTRACTS),
      requestBrowserWalletRpc: rpc,
    };
    const body = Array.from({ length: 20 }, (_, index) => ({
      jsonrpc: '2.0', id: index + 1, method: 'eth_chainId', params: [],
    }));

    const request = runCtx('POST', '/api/identity-wallets/rpc', agent, body);
    await request.done;

    expect(request.res.statusCode).toBe(200);
    expect(JSON.parse(request.res.body)).toEqual(body.map(({ id }) => ({
      jsonrpc: '2.0', id, result: '0x14a34',
    })));
    expect(rpc).toHaveBeenCalledTimes(20);
    expect(rpc).toHaveBeenCalledWith('eth_chainId', []);
  });

  it('rejects expanded block batches while preserving bounded receipt polling', async () => {
    const rpc = vi.fn(async (method: string) => method === 'eth_getTransactionReceipt' ? null : {});
    const agent = {
      supportsIdentityWalletManagement: true,
      getIdentityWalletContracts: vi.fn(async () => CONTRACTS),
      requestBrowserWalletRpc: rpc,
    };
    const expandedBlocks = Array.from({ length: 20 }, (_, index) => ({
      jsonrpc: '2.0', id: index, method: 'eth_getBlockByNumber', params: ['latest', true],
    }));
    const rejected = runCtx('POST', '/api/identity-wallets/rpc', agent, expandedBlocks);
    await rejected.done;
    expect(JSON.parse(rejected.res.body)).toHaveLength(20);
    expect(JSON.parse(rejected.res.body).every(
      (item: { error?: { code?: number } }) => item.error?.code === -32602,
    )).toBe(true);
    expect(rpc).not.toHaveBeenCalled();

    const hash = `0x${'ab'.repeat(32)}`;
    const receipt = runCtx('POST', '/api/identity-wallets/rpc', agent, {
      jsonrpc: '2.0', id: 21, method: 'eth_getTransactionReceipt', params: [hash],
    });
    await receipt.done;
    expect(JSON.parse(receipt.res.body)).toEqual({ jsonrpc: '2.0', id: 21, result: null });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('eth_getTransactionReceipt', [hash]);
  });

  it('returns per-request errors for hostile block tags without rejecting mixed batches', async () => {
    const rpc = vi.fn(async () => '0x14a34');
    const agent = {
      supportsIdentityWalletManagement: true,
      getIdentityWalletContracts: vi.fn(async () => CONTRACTS),
      requestBrowserWalletRpc: rpc,
    };
    const hostileTag = { toString: null };
    const request = runCtx('POST', '/api/identity-wallets/rpc', agent, [
      {
        jsonrpc: '2.0',
        id: 30,
        method: 'eth_getBlockByNumber',
        params: [hostileTag, false],
      },
      {
        jsonrpc: '2.0',
        id: 31,
        method: 'eth_call',
        params: [{ to: CONTRACTS.storage, data: `0x${'ab'.repeat(32)}` }, hostileTag],
      },
      { jsonrpc: '2.0', id: 32, method: 'eth_chainId', params: [] },
    ]);

    await expect(request.done).resolves.toBeUndefined();
    expect(JSON.parse(request.res.body)).toEqual([
      expect.objectContaining({ id: 30, error: expect.objectContaining({ code: -32602 }) }),
      expect.objectContaining({ id: 31, error: expect.objectContaining({ code: -32602 }) }),
      { jsonrpc: '2.0', id: 32, result: '0x14a34' },
    ]);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('eth_chainId', []);
  });
});
