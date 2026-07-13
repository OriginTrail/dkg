// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForReceiptWithDeadline } from '../src/receipt-wait.js';

describe('waitForReceiptWithDeadline error priority', () => {
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
});
