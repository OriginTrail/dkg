// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { sendNodeOpsRawTransactionWithFailover } from '../src/commands/node-ops-transaction.js';

describe('node-ops transaction receipt deadline wiring', () => {
  it('forwards the resolved chain receipt timeout to the transaction sender', async () => {
    const receipt = { blockNumber: 42 } as any;
    const send = vi.fn(async () => receipt);
    const providers = [] as any;
    const urls = ['https://rpc.example'];

    await expect(sendNodeOpsRawTransactionWithFailover(
      providers,
      '0xsigned',
      '0xhash',
      urls,
      { receiptTimeoutMs: 725_000 },
      send,
    )).resolves.toBe(receipt);

    expect(send).toHaveBeenCalledWith(
      providers,
      '0xsigned',
      '0xhash',
      urls,
      { receiptTimeoutMs: 725_000 },
    );
  });
});
