// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RpcFailoverClient,
  waitForTransactionReceiptWithFailover,
} from '../src/rpc-failover-client.js';
import { waitForReceiptWithDeadline } from '../src/receipt-wait.js';

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

  it('owns the combined validation/lookup attempt budget in RpcFailoverClient', async () => {
    vi.useFakeTimers({ now: 0 });
    const lookup = vi.fn(async () => null);
    const validate = vi.fn(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 1_100));
    });
    const client = new RpcFailoverClient(
      () => [{
        provider: { getTransactionReceipt: lookup } as any,
        rpcUrl: 'https://rpc.example',
      }],
      async () => { throw new Error('signing must not be reached'); },
      () => 'evm:31337',
      { validateEndpoint: validate },
    );

    const outcome = client.getReceipt('0xshared-budget', {
      deadlineMs: 1_000,
      logLabel: 'shared budget test',
    }).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason) => ({ status: 'rejected' as const, reason }),
    );

    await vi.advanceTimersByTimeAsync(1_001);
    await expect(outcome).resolves.toMatchObject({
      status: 'rejected',
      reason: { code: 'RPC_RECEIPT_LOOKUP_FAILED', txHash: '0xshared-budget' },
    });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();

    // The timed-out validation can settle later, but lookup is a separate stage
    // in the canonical provider pass and therefore cannot resume in the background.
    await vi.advanceTimersByTimeAsync(200);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('does not continue into receipt lookup when validation resolves after the deadline', async () => {
    vi.useFakeTimers({ now: 0 });
    const getTransactionReceipt = vi.fn(async () => null);
    const validateEndpoint = vi.fn(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 1_100));
    });
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

    // The uncancelled validation promise itself may still resolve, but the
    // lookup callback must already have terminated at its own deadline cap.
    await vi.advanceTimersByTimeAsync(200);
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('uses the canonical reverted-receipt error for direct transaction waits', async () => {
    const receipt = { status: 0, hash: '0xreverted' } as any;
    const endpoint = {
      provider: { getTransactionReceipt: vi.fn(async () => receipt) } as any,
      rpcUrl: 'https://rpc.example',
    };

    await expect(waitForTransactionReceiptWithFailover(
      [endpoint],
      receipt.hash,
      { receiptTimeoutMs: 1_000, logLabel: 'direct test' },
    )).rejects.toMatchObject({
      code: 'CALL_EXCEPTION',
      receipt,
      message: 'direct test tx 0xreverted was mined but reverted (status=0)',
    });
  });

  it('runs direct transaction waits through the canonical retryable provider pass', async () => {
    const receipt = { status: 1, hash: '0xfailover-found' } as any;
    const primaryLookup = vi.fn(async () => {
      const error = new Error('primary receipt transport unavailable') as Error & { code: string };
      error.code = 'SERVER_ERROR';
      throw error;
    });
    const backupLookup = vi.fn(async () => receipt);

    await expect(waitForTransactionReceiptWithFailover(
      [
        {
          provider: { getTransactionReceipt: primaryLookup } as any,
          rpcUrl: 'https://primary.example',
        },
        {
          provider: { getTransactionReceipt: backupLookup } as any,
          rpcUrl: 'https://backup.example',
        },
      ],
      receipt.hash,
      { receiptTimeoutMs: 1_000, logLabel: 'direct failover test' },
    )).resolves.toBe(receipt);

    expect(primaryLookup).toHaveBeenCalledWith(receipt.hash);
    expect(backupLookup).toHaveBeenCalledWith(receipt.hash);
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
