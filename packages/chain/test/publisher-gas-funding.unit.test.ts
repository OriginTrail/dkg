import { describe, expect, it, vi } from 'vitest';
import type { ethers } from 'ethers';
import { PublisherGasFunding, PublisherGasFundingError } from '../src/publisher-gas-funding.js';
import { isPublisherNativeGasFailure } from '../src/publisher-funding-error.js';
import { InsufficientPublisherFundsError } from '../src/evm-adapter-errors.js';
import type { PreparedTransaction } from '../src/rpc-failover-client.js';

describe('actual prepared execution-gas funding', () => {
  function fixture() {
    let balance = 10n ** 18n;
    const getBalance = vi.fn(async () => balance);
    const provider = { getBalance } as unknown as ethers.Provider;
    const prepared = (gasLimit = 100_000n, fee = 10n): PreparedTransaction => ({
      signer: { address: '0x1111111111111111111111111111111111111111', provider },
      transaction: { gasLimit, maxFeePerGas: fee, value: 7n },
    } as PreparedTransaction);
    return { funding: new PublisherGasFunding(), prepared, getBalance, balance: (n: bigint) => { balance = n; } };
  }

  it('rejects one wei below the prepared maximum cost and permits the exact boundary before signing', async () => {
    const f = fixture(), prepared = f.prepared(), sign = vi.fn();
    f.balance(1_000_006n);
    await expect(f.funding.assertPrepared(prepared).then(sign)).rejects.toBeInstanceOf(PublisherGasFundingError);
    expect(sign).not.toHaveBeenCalled();
    f.balance(1_000_007n); expect(await f.funding.assertPrepared(prepared)).toBe(prepared);
    expect(f.getBalance.mock.calls).toEqual([[prepared.signer.address, 'pending'], [prepared.signer.address, 'pending']]);
  });

  it('permits a small job below the former one-million-gas budget, independent of the previous job', async () => {
    const f = fixture();
    // At 2 gwei, old startup screening demanded0.002 native. This job needs0.0015 + value.
    f.balance(1_800_000_000_000_000n);
    const small = f.prepared(750_000n, 2_000_000_000n);
    expect(await f.funding.assertPrepared(small)).toBe(small);
    await expect(f.funding.assertPrepared(f.prepared(2_000_000n, 2_000_000_000n)))
      .rejects.toBeInstanceOf(PublisherGasFundingError);
    expect(await f.funding.assertPrepared(small)).toBe(small);
  });

  it('uses prepared legacy gasPrice and fresh pending balances without changing fee parameters', async () => {
    const f = fixture(), prepared = f.prepared();
    const legacy = { ...prepared, transaction: { gasLimit: 10n, gasPrice: 20n, value: 3n } };
    f.balance(203n); expect(await f.funding.assertPrepared(legacy)).toBe(legacy);
    f.balance(202n); await expect(f.funding.assertPrepared(legacy)).rejects.toBeInstanceOf(PublisherGasFundingError);
  });

  it('does not turn an unavailable balance read or incomplete preparation into a funding diagnosis', async () => {
    const f = fixture(), error = new Error('RPC unavailable');
    f.getBalance.mockRejectedValueOnce(error);
    await expect(f.funding.assertPrepared(f.prepared())).rejects.toBe(error);
    await expect(f.funding.assertPrepared({ ...f.prepared(), transaction: {} }))
      .rejects.toThrow('gas cost unavailable');
  });
});

describe('native funding error normalization', () => {
  const native = Object.assign(new Error('insufficient funds for gas * price + value'), { code: 'INSUFFICIENT_FUNDS' });
  it.each([
    [native, true],
    [new PublisherGasFundingError({ observedAt: 0, balanceWei: 0n, requiredWei: 1n, gasLimit: 1n, feePerGasWei: 1n }), true],
    [new InsufficientPublisherFundsError('unfunded', [], { nativeGasShortfall: true }), true],
    [new InsufficientPublisherFundsError('unfunded', [], { cause: native }), true],
    [new InsufficientPublisherFundsError('unfunded', [], { cause: Object.assign(new Error('ERC20InsufficientBalance'), { code: 'CALL_EXCEPTION' }) }), false],
    [new Error('arbitrary wrapper', { cause: native }), false],
    [new InsufficientPublisherFundsError('outer', [], { cause: new InsufficientPublisherFundsError('inner', [], { cause: native }) }), false],
    [new Error('execution reverted: insufficient funds for gas'), false],
  ])('classifies only direct or known immediate native evidence: %s', (error, expected) => {
    expect(isPublisherNativeGasFailure(error)).toBe(expected);
  });
  it('fails closed on throwing inspection', () => {
    const error = Object.defineProperty({}, 'code', { get() { throw new Error('unsafe accessor'); } });
    expect(isPublisherNativeGasFailure(error)).toBe(false);
  });
});
