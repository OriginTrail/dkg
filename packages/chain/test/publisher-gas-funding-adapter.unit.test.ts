import { describe, expect, it } from 'vitest';
import { JsonRpcProvider, type Contract } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import type { PreparedTransaction, ReadOpts } from '../src/rpc-failover-client.js';

class FundingAdapter extends EVMChainAdapter {
  balance = 10n ** 18n;
  reads = 0;
  private readonly testProvider = {
    getBlock: async () => ({ baseFeePerGas: 100n }),
    send: async () => '0x1',
    getBalance: async () => { this.reads += 1; return this.balance; },
  } as unknown as JsonRpcProvider;

  constructor(enabled: boolean) {
    super({ rpcUrl: 'http://127.0.0.1:1', privateKey: `0x${'11'.repeat(32)}`,
      chainId: 'evm:31337', hubAddress: '0x1111111111111111111111111111111111111111',
      allowNoAdminSigner: true, publisherFundingAwareClaims: enabled });
  }

  protected override readProvider<T>(
    _label: string, read: (provider: JsonRpcProvider) => Promise<T>, _opts?: ReadOpts,
  ): Promise<T> { return read(this.testProvider); }

  protected override async prepareAcrossProviders(): Promise<PreparedTransaction> {
    return { signer: this.signer, transaction: { gasLimit: 100_000n, gasPrice: 10n } };
  }

  prepare() {
    return this.prepareV10WithAllowanceRecovery(this.signer, {} as Contract, 'publish', {},
      '0x1111111111111111111111111111111111111111', 0n, 'unused');
  }
}

describe('native EVM async publisher funding composition', () => {
  it('exposes current fees/balance and checks exact prepared cost before returning to signing', async () => {
    const adapter = new FundingAdapter(true);
    try {
      expect((await adapter.getPublisherGasFunding()).requiredWei).toBe(301_000_000n);
      adapter.balance = 999_999n;
      await expect(adapter.prepare()).rejects.toMatchObject({ code: 'PUBLISHER_GAS_FUNDING_UNAVAILABLE' });
      adapter.balance = 1_000_000n;
      expect((await adapter.prepare()).transaction.gasLimit).toBe(100_000n);
      expect((await adapter.getPublisherGasFunding()).gasLimit).toBe(100_000n);
    } finally { adapter.destroy(); }
  });

  it('leaves non-async transaction preparation unchanged', async () => {
    const adapter = new FundingAdapter(false);
    try {
      adapter.balance = 0n;
      expect((await adapter.prepare()).transaction.gasLimit).toBe(100_000n);
      expect(adapter.reads).toBe(0);
    } finally { adapter.destroy(); }
  });
});
