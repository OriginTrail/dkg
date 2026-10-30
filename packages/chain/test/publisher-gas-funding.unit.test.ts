import { describe, expect, it, vi } from 'vitest';
import type { ethers } from 'ethers';
import { PublisherGasFunding, PublisherGasFundingError } from '../src/publisher-gas-funding.js';
import { isPublisherNativeGasFailure } from '../src/publisher-funding-error.js';
import { InsufficientPublisherFundsError } from '../src/evm-adapter-errors.js';
import { chainFeeFloor } from '../src/evm-fee-policy.js';
import type { PreparedTransaction } from '../src/rpc-failover-client.js';

function fixture() {
  let balance = 10n ** 18n;
  let baseFee = 100n;
  const getBalance = vi.fn(async () => balance);
  const provider = {
    getBlock: vi.fn(async () => ({ baseFeePerGas: baseFee })),
    send: vi.fn(async () => '0x1'),
    getBalance,
    getFeeData: vi.fn(async () => ({ gasPrice: 9n })),
  } as unknown as ethers.Provider;
  const funding = new PublisherGasFunding();
  const prepared = (gasLimit = 100_000n, fee = 10n): PreparedTransaction => ({
    signer: { address: '0x1111111111111111111111111111111111111111', provider },
    transaction: { gasLimit, maxFeePerGas: fee, value: 7n },
  } as PreparedTransaction);
  return { funding, provider, getBalance, prepared,
    balance: (value: bigint) => { balance = value; }, baseFee: (value: bigint) => { baseFee = value; } };
}

describe('publisher gas funding observations', () => {
  it('uses the actual fee floor and cap, and reads pending balance without a balance cache', async () => {
    const f = fixture();
    const first = await f.funding.read(f.provider, 'wallet', chainFeeFloor(100n), 1_500_000_000n);
    expect(first.feePerGasWei).toBe(1_500_000_000n);
    expect(first.requiredWei).toBe(1_500_000_000_000_000n);
    f.balance(1n);
    expect((await f.funding.read(f.provider, 'wallet')).balanceWei).toBe(1n);
    expect(f.getBalance.mock.calls).toEqual([['wallet', 'pending'], ['wallet', 'pending']]);
  });

  it('starts block, priority-fee and pending-balance reads independently before any completes', async () => {
    const f = fixture();
    let releaseFee!: () => void, releaseBalance!: () => void, releaseTip!: () => void;
    const fee = new Promise<void>(resolve => { releaseFee = resolve; });
    const balance = new Promise<void>(resolve => { releaseBalance = resolve; });
    const tip = new Promise<void>(resolve => { releaseTip = resolve; });
    vi.mocked(f.provider.getBlock).mockImplementationOnce(async () => { await fee; return { baseFeePerGas: 100n } as ethers.Block; });
    f.getBalance.mockImplementationOnce(async () => { await balance; return 10n ** 18n; });
    vi.mocked(f.provider as ethers.JsonRpcProvider).send.mockImplementationOnce(async () => { await tip; return '0x1'; });
    const start = Date.now();
    const reading = f.funding.read(f.provider, 'wallet');
    try {
      expect(f.provider.getBlock).toHaveBeenCalledOnce();
      expect(f.getBalance).toHaveBeenCalledWith('wallet', 'pending');
      expect((f.provider as ethers.JsonRpcProvider).send).toHaveBeenCalledWith('eth_maxPriorityFeePerGas', []);
      releaseFee(); releaseBalance(); releaseTip();
      const observation = await reading;
      expect(observation.observedAt).toBeGreaterThanOrEqual(start);
      expect(observation.observedAt).toBeLessThanOrEqual(Date.now());
    } finally { releaseFee(); releaseBalance(); releaseTip(); await reading; }
  });

  it('checks exact prepared maximum cost including value before the caller can sign', async () => {
    const f = fixture();
    const prepared = f.prepared();
    f.balance(1_000_006n);
    const sign = vi.fn();
    await expect(f.funding.assertPrepared(prepared).then(sign)).rejects.toBeInstanceOf(PublisherGasFundingError);
    expect(sign).not.toHaveBeenCalled();
    f.balance(1_000_007n);
    expect(await f.funding.assertPrepared(prepared)).toBe(prepared);
    const learned = await f.funding.read(f.provider, 'wallet');
    expect(learned.gasLimit).toBe(100_000n);
  });

  it('retains legacy gas-price fallback and its configured cap without a base fee', async () => {
    const f = fixture(); f.baseFee(0n);
    expect((await f.funding.read(f.provider, 'wallet')).feePerGasWei).toBe(9n);
    expect((await f.funding.read(f.provider, 'wallet', undefined, 8n)).feePerGasWei).toBe(8n);
  });

  it('does not treat an earlier eligibility estimate as funding proof at signing', async () => {
    const f = fixture();
    const before = await f.funding.read(f.provider, 'wallet');
    expect(before.balanceWei).toBeGreaterThan(before.requiredWei);
    f.balance(0n); f.baseFee(50_000n);
    await expect(f.funding.assertPrepared(f.prepared(2_000_000n, 150_001n)))
      .rejects.toMatchObject({ code: 'PUBLISHER_GAS_FUNDING_UNAVAILABLE' });
  });

  it('refuses unavailable fee/balance observations and a cap below the current base fee', async () => {
    const f = fixture();
    await expect(f.funding.read(f.provider, 'wallet', undefined, 50n))
      .rejects.toMatchObject({ code: 'FEE_CAP_BELOW_BASE_FEE' });
    f.getBalance.mockRejectedValueOnce(new Error('RPC unavailable'));
    await expect(f.funding.read(f.provider, 'wallet')).rejects.toThrow('RPC unavailable');
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
