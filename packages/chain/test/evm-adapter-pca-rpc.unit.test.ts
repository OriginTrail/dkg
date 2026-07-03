import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { isChainRpcTransportError } from '../src/chain-rpc-transport-error.js';
import { _resetRpcFailoverStatsForTest } from '../src/rpc-failover-log.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const HUB = '0x0000000000000000000000000000000000000001';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'https://primary.example',
    privateKey: PK,
    hubAddress: HUB,
    chainId: 'evm:31337',
    allowNoAdminSigner: true,
    ...overrides,
  };
}

function retryable429(): Error {
  const err = new Error('429 too many requests');
  (err as { status?: number }).status = 429;
  return err;
}

type SendProvider = {
  send: (method: string, params: unknown[]) => Promise<unknown>;
};

function pcaRpcAdapter(providers: SendProvider[], rpcUrls: string[]): EVMChainAdapter {
  const adapter = new EVMChainAdapter(minimalConfig({ rpcUrl: rpcUrls[0], rpcUrls: rpcUrls.slice(1) }));
  (adapter as unknown as { init: () => Promise<void> }).init = async () => undefined;
  (adapter as unknown as { providers: SendProvider[] }).providers = providers;
  (adapter as unknown as { rpcUrls: string[] }).rpcUrls = rpcUrls;
  return adapter;
}

describe('EVMChainAdapter PCA RPC bridge', () => {
  beforeEach(() => { _resetRpcFailoverStatsForTest(); });
  afterEach(() => { _resetRpcFailoverStatsForTest(); });

  it('requestPublishingConvictionRpc reads through the provider failover loop', async () => {
    const primary = {
      send: recorder(async () => { throw retryable429(); }),
    };
    const backup = {
      send: recorder(async (method: string, params: unknown[]) => ({ method, params, endpoint: 'backup' })),
    };
    const adapter = pcaRpcAdapter(
      [primary, backup],
      ['https://primary.example/v2/SECRETKEY', 'https://backup.example'],
    );

    await expect(adapter.requestPublishingConvictionRpc('eth_chainId', []))
      .resolves.toEqual({ method: 'eth_chainId', params: [], endpoint: 'backup' });

    expect(primary.send.calls).toEqual([['eth_chainId', []]]);
    expect(backup.send.calls).toEqual([['eth_chainId', []]]);
  });

  it('requestPublishingConvictionRpc surfaces typed host-only exhaustion when all endpoints fail', async () => {
    const primary = {
      send: recorder(async () => { throw retryable429(); }),
    };
    const backup = {
      send: recorder(async () => { throw retryable429(); }),
    };
    const adapter = pcaRpcAdapter(
      [primary, backup],
      ['https://primary.example/v2/SECRETKEY', 'https://backup.example'],
    );

    let thrown: unknown;
    try {
      await adapter.requestPublishingConvictionRpc('eth_chainId', []);
    } catch (err) {
      thrown = err;
    }

    expect(isChainRpcTransportError(thrown)).toBe(true);
    expect(thrown).toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });
    expect(String((thrown as Error).message)).toContain('primary.example');
    expect(String((thrown as Error).message)).not.toContain('SECRETKEY');
    expect(String((thrown as Error).message)).not.toContain('https://');
    expect(primary.send.calls).toEqual([['eth_chainId', []]]);
    expect(backup.send.calls).toEqual([['eth_chainId', []]]);
  });

  it('getPublishingConvictionContracts returns configured wallet-public RPCs without private adapter RPCs', async () => {
    const adapter = new EVMChainAdapter(minimalConfig({
      rpcUrl: 'https://private-rpc.example/v2/SECRETKEY',
      walletRpcUrls: [' https://wallet-rpc.example/base-sepolia ', 'https://wallet-rpc.example/base-sepolia'],
    }));
    (adapter as unknown as { init: () => Promise<void> }).init = async () => undefined;
    (adapter as unknown as {
      contracts: {
        dkgPublishingConvictionNFT: { getAddress: () => Promise<string> };
        token: { getAddress: () => Promise<string> };
      };
    }).contracts = {
      dkgPublishingConvictionNFT: { getAddress: async () => '0x' + '11'.repeat(20) },
      token: { getAddress: async () => '0x' + '22'.repeat(20) },
    };

    const contracts = await adapter.getPublishingConvictionContracts();

    expect(contracts.rpcUrls).toEqual(['https://wallet-rpc.example/base-sepolia']);
    expect(contracts.walletRpcUrls).toEqual(['https://wallet-rpc.example/base-sepolia']);
    expect(JSON.stringify(contracts)).not.toContain('SECRETKEY');
    expect(JSON.stringify(contracts)).not.toContain('private-rpc.example');
  });
});
