// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createCliEvmProviders: vi.fn(),
  loadConfig: vi.fn(),
  loadNetworkConfig: vi.fn(),
  loadOpWallets: vi.fn(),
  resolveReadyChainConfig: vi.fn(),
  sendCliRawTransactionWithFailover: vi.fn(),
}));

vi.mock('../src/cli-rpc.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/cli-rpc.js')>();
  return {
    ...actual,
    createCliEvmProviders: mocks.createCliEvmProviders,
    sendCliRawTransactionWithFailover: mocks.sendCliRawTransactionWithFailover,
  };
});

vi.mock('../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
    loadNetworkConfig: mocks.loadNetworkConfig,
    resolveReadyChainConfig: mocks.resolveReadyChainConfig,
  };
});

vi.mock('@origintrail-official/dkg-agent', async importOriginal => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-agent')>();
  return {
    ...actual,
    loadOpWallets: mocks.loadOpWallets,
  };
});

vi.mock('ethers', async importOriginal => {
  const actual = await importOriginal<typeof import('ethers')>();

  class FakeWallet {
    readonly address = '0x1000000000000000000000000000000000000001';

    async populateTransaction(populated: unknown): Promise<unknown> {
      return populated;
    }

    async signTransaction(): Promise<string> {
      return '0xsigned';
    }
  }

  class FakeContract {
    readonly updateAsk = {
      populateTransaction: async () => ({
        to: '0x4000000000000000000000000000000000000004',
        data: '0x1234',
      }),
    };

    async getContractAddress(name: string): Promise<string> {
      if (name === 'IdentityStorage') return '0x2000000000000000000000000000000000000002';
      if (name === 'ProfileStorage') return '0x3000000000000000000000000000000000000003';
      if (name === 'Profile') return '0x4000000000000000000000000000000000000004';
      throw new Error(`Unexpected Hub lookup: ${name}`);
    }

    async getIdentityId(): Promise<bigint> {
      return 7n;
    }

    async getAsk(): Promise<bigint> {
      return 1n;
    }
  }

  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      Contract: FakeContract,
      Wallet: FakeWallet,
      Transaction: { from: () => ({ hash: '0xhash' }) },
    },
  };
});

const { Command } = await import('commander');
const { registerNodeOpsCommands } = await import('../src/commands/node-ops.js');

describe('node-ops set-ask receipt deadline wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockResolvedValue({ networkConfig: 'testnet' });
    mocks.loadNetworkConfig.mockResolvedValue({});
    mocks.loadOpWallets.mockResolvedValue({
      adminWallet: undefined,
      wallets: [{ privateKey: `0x${'11'.repeat(32)}` }],
    });
    mocks.resolveReadyChainConfig.mockReturnValue({
      rpcUrl: 'https://rpc.example',
      hubAddress: '0x5000000000000000000000000000000000000005',
      receiptTimeoutMs: 725_000,
    });
    mocks.createCliEvmProviders.mockReturnValue({
      endpoints: [{
        rpcUrl: 'https://rpc.example',
        provider: { id: 'write-provider' },
      }],
      readProvider: { id: 'read-provider' },
      receiptTimeoutMs: 725_000,
    });
    mocks.sendCliRawTransactionWithFailover.mockResolvedValue({ blockNumber: 42 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes the resolved timeout from the set-ask command to the canonical sender', async () => {
    const program = new Command();
    program.exitOverride();
    registerNodeOpsCommands(program);

    await program.parseAsync(['set-ask', '2'], { from: 'user' });

    expect(mocks.sendCliRawTransactionWithFailover).toHaveBeenCalledTimes(1);
    expect(mocks.createCliEvmProviders).toHaveBeenCalledWith(
      'https://rpc.example',
      undefined,
      725_000,
    );
    expect(mocks.sendCliRawTransactionWithFailover).toHaveBeenCalledWith(
      {
        endpoints: [{
          rpcUrl: 'https://rpc.example',
          provider: { id: 'write-provider' },
        }],
        readProvider: { id: 'read-provider' },
        receiptTimeoutMs: 725_000,
      },
      '0xsigned',
      '0xhash',
    );
  });
});
