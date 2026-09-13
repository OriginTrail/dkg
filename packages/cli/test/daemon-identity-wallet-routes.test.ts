import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { handleIdentityWalletRoutes } from '../src/daemon/routes/identity-wallets.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

function fakeRes() {
  const res: any = { statusCode: 0, body: '' };
  res.writeHead = (status: number) => { res.statusCode = status; };
  res.end = (body: string) => { res.body = body; };
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

const CONTRACTS = {
  profile: ethers.getAddress(`0x${'11'.repeat(20)}`),
  identity: ethers.getAddress(`0x${'22'.repeat(20)}`),
  storage: ethers.getAddress(`0x${'33'.repeat(20)}`),
  chainId: 'base:84532',
  rpcUrls: ['https://private.example/v2/SECRETKEY'],
  walletRpcUrls: ['https://wallet.example/base', '/api/private', 'ws://wallet.example'],
};

describe('daemon identity-wallet browser capability', () => {
  it('bootstraps independently of PCA support and never exposes private RPC URLs', async () => {
    const agent = {
      supportsPublishingConvictionNft: false,
      supportsIdentityWalletManagement: true,
      getIdentityWalletContracts: vi.fn(async () => CONTRACTS),
      requestIdentityWalletRpc: vi.fn(),
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
      requestIdentityWalletRpc: vi.fn(),
    };
    const request = runCtx('GET', '/api/identity-wallets/contracts', agent);
    await request.done;
    expect(request.res.statusCode).toBe(503);
    expect(JSON.parse(request.res.body).error).toMatch(/not available/);
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
      requestIdentityWalletRpc: rpc,
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
});
