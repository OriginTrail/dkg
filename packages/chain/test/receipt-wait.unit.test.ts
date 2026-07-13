// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcFailoverClient } from '../src/rpc-failover-client.js';
import {
  waitForReceiptWithDeadline,
  waitForTransactionReceiptWithFailover,
} from '../src/receipt-wait.js';

describe('receipt deadline orchestration', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not mask a reverted receipt that arrives after the deadline as RPC_TIMEOUT', async () => {
    vi.useFakeTimers({ now: 0 });
    const revertedReceipt = { status: 0 };

    const outcome = waitForReceiptWithDeadline({
      txHash: '0xreverted',
      receiptTimeoutMs: 1_000,
      pollIntervalMs: 100,
      getReceipt: async () => {
        vi.setSystemTime(1_001);
        return revertedReceipt;
      },
      assertSuccessfulReceipt: (receipt) => {
        if (receipt.status !== 0) return;
        const err = new Error('mined transaction reverted');
        (err as any).code = 'CALL_EXCEPTION';
        throw err;
      },
      formatTimeoutMessage: () => 'must not be used',
    }).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason) => ({ status: 'rejected' as const, reason }),
    );

    await expect(outcome).resolves.toMatchObject({
      status: 'rejected',
      reason: { code: 'CALL_EXCEPTION', message: 'mined transaction reverted' },
    });
  });

  it('caps endpoint validation with the same operation deadline before receipt lookup', async () => {
    vi.useFakeTimers({ now: 0 });
    const getTransactionReceipt = vi.fn(async () => null);
    const validateEndpoint = vi.fn(async () => new Promise<void>(() => {}));
    const client = new RpcFailoverClient(
      () => [{
        provider: { getTransactionReceipt } as any,
        rpcUrl: 'https://rpc.example',
      }],
      async () => { throw new Error('signing must not be reached'); },
      () => 'evm:31337',
      { validateEndpoint },
    );

    const outcome = waitForReceiptWithDeadline({
      txHash: '0xvalidation-timeout',
      receiptTimeoutMs: 1_000,
      pollIntervalMs: 100,
      getReceipt: (hash, options) => client.getReceipt(hash, options),
      assertSuccessfulReceipt: () => {},
      formatTimeoutMessage: () => 'validation exhausted the receipt deadline',
    }).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason) => ({ status: 'rejected' as const, reason }),
    );

    await vi.advanceTimersByTimeAsync(1_001);
    await expect(outcome).resolves.toMatchObject({
      status: 'rejected',
      reason: { code: 'RPC_TIMEOUT', txHash: '0xvalidation-timeout' },
    });
    expect(validateEndpoint).toHaveBeenCalledTimes(1);
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('treats omitted endpoint URLs as telemetry-only metadata', async () => {
    const receipt = { status: 1, hash: '0xfound' } as any;
    const firstLookup = vi.fn(async () => null);
    const secondLookup = vi.fn(async () => receipt);

    await expect(waitForTransactionReceiptWithFailover(
      [
        {
          provider: { getTransactionReceipt: firstLookup } as any,
          rpcUrl: 'https://first.example',
        },
        { provider: { getTransactionReceipt: secondLookup } as any },
      ],
      '0xfound',
      { receiptTimeoutMs: 1_000 },
    )).resolves.toBe(receipt);

    expect(firstLookup).toHaveBeenCalledWith('0xfound');
    expect(secondLookup).toHaveBeenCalledWith('0xfound');
  });
});
