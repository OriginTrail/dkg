// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  createCliEvmProviders,
  isCliRetryableRpcError,
  isCliKnownTransactionError,
  sendCliRawTransactionWithFailover,
} from '../src/cli-rpc.js';
import { isRetryableRpcError, isKnownTransactionError, isChainRpcTransportError } from '@origintrail-official/dkg-chain';

function writeContext(
  providers: any[],
  receiptTimeoutMs = 600_000,
) {
  return {
    endpoints: providers.map((provider, index) => ({
      provider,
      rpcUrl: `https://rpc-${index + 1}.example`,
    })),
    receiptTimeoutMs,
  };
}

describe('cli-rpc classifier consolidation (W4)', () => {
  // Each case is a fresh object so the in-place enrichEvmError mutation that
  // the chain classifier performs can't bleed between the two calls compared.
  const retryableCases = (): unknown[] => [
    { code: 'RPC_ENDPOINTS_EXHAUSTED' },
    { message: 'provider failed: no runners?!' },
    { code: 'UNPREDICTABLE_GAS_LIMIT' },
    { code: 'TRANSACTION_REPLACED' },
    { code: 'CALL_EXCEPTION', message: 'execution reverted' },
    { code: 'INSUFFICIENT_FUNDS' },
    { status: 429 },
    { code: 'TIMEOUT' },
    { code: 'RPC_TIMEOUT' }, // the chain-namespaced timeout must also be retryable (fail over)
    { code: 'BAD_DATA' },
    { message: 'intrinsic gas too low' },
    { message: 'exceeds block gas limit' },
    { info: { error: { code: 429 } } }, // nested status, depth-walked by the chain classifier
  ];

  it('delegates byte-for-byte to the chain isRetryableRpcError (no divergence)', () => {
    for (const c of retryableCases()) {
      const expected = isRetryableRpcError(JSON.parse(JSON.stringify(c)) ?? c);
      expect(isCliRetryableRpcError(c)).toBe(expected);
    }
  });

  it('now classifies the previously-divergent cases like the daemon', () => {
    expect(isCliRetryableRpcError({ code: 'RPC_ENDPOINTS_EXHAUSTED' })).toBe(true);
    expect(isCliRetryableRpcError({ message: 'no runners?!' })).toBe(true);
    expect(isCliRetryableRpcError({ code: 'UNPREDICTABLE_GAS_LIMIT' })).toBe(false);
    expect(isCliRetryableRpcError({ code: 'TRANSACTION_REPLACED' })).toBe(false);
  });

  it('known-transaction classifier delegates to the chain superset', () => {
    expect(isCliKnownTransactionError({ message: 'already known' }))
      .toBe(isKnownTransactionError({ message: 'already known' }));
    // chain superset gained "already have transaction" over the old CLI copy.
    expect(isCliKnownTransactionError({ message: 'already have transaction' })).toBe(true);
  });

  it('stamps RPC_ENDPOINTS_EXHAUSTED when every endpoint fails over (idempotency-safe)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = {
      broadcastTransaction: async () => {
        const e: any = new Error('connect ECONNREFUSED');
        e.code = 'ECONNREFUSED';
        throw e;
      },
    } as any;
    await expect(
      sendCliRawTransactionWithFailover(
        writeContext([failing, failing]),
        '0xsigned',
        '0xhash',
      ),
    ).rejects.toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });
  });

  it('does NOT fail over (throws immediately) on a deterministic application error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const reverting = {
      broadcastTransaction: async () => {
        calls += 1;
        const e: any = new Error('execution reverted');
        e.code = 'CALL_EXCEPTION';
        throw e;
      },
    } as any;
    await expect(
      sendCliRawTransactionWithFailover(
        writeContext([reverting, reverting]),
        '0xsigned',
        '0xhash',
      ),
    ).rejects.toMatchObject({ code: 'CALL_EXCEPTION' });
    // Only the first provider was tried — a revert is not retried on the backup.
    expect(calls).toBe(1);
  });

  it('rejects an invalid receipt deadline before broadcasting', async () => {
    const broadcastTransaction = vi.fn(async () => ({ hash: '0xside-effect' }));
    const provider = {
      broadcastTransaction,
      getTransactionReceipt: async () => null,
    } as any;

    await expect(sendCliRawTransactionWithFailover(
      writeContext([provider], 999),
      '0xsigned',
      '0xhash',
    )).rejects.toThrow(/receiptTimeoutMs must be a finite number >= 1000/);

    expect(broadcastTransaction).not.toHaveBeenCalled();
  });

  it('emits a structured RPC_RECEIPT_LOOKUP_FAILED (with the original txHash) when receipt lookup fails on every provider after a successful broadcast', async () => {
    // #1332 review: drives the REAL CLI receipt emitter end-to-end (broadcast OK,
    // then retryable receipt failures on all providers) so a regression that drops
    // txHash or changes the emitted shape fails loudly, not just the synthetic
    // classifier inputs.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = () => ({
      broadcastTransaction: async () => ({ hash: '0xignored' }),
      getTransactionReceipt: async () => {
        const e: any = new Error('receipt RPC down');
        e.code = 'SERVER_ERROR';
        throw e;
      },
    }) as any;
    const err = await sendCliRawTransactionWithFailover(
      writeContext([provider(), provider()]),
      '0xsigned',
      '0xdeadbeef',
    ).catch((e) => e);
    expect(err.code).toBe('RPC_RECEIPT_LOOKUP_FAILED');
    expect(err.txHash).toBe('0xdeadbeef');
    expect(isChainRpcTransportError(err)).toBe(true);
  });

  it('enforces one configured deadline across every receipt endpoint and polling', async () => {
    vi.useFakeTimers();
    try {
      let firstCalls = 0;
      let secondCalls = 0;
      const first = {
        broadcastTransaction: async () => ({ hash: '0xdeadline' }),
        getTransactionReceipt: async () => {
          firstCalls += 1;
          return new Promise<never>(() => {});
        },
      } as any;
      const second = {
        broadcastTransaction: async () => ({ hash: '0xdeadline' }),
        getTransactionReceipt: async () => {
          secondCalls += 1;
          return new Promise<never>(() => {});
        },
      } as any;
      const result = sendCliRawTransactionWithFailover(
        writeContext(
          [first, second],
          1_000,
        ),
        '0xsigned',
        '0xdeadline',
      ).catch((err) => err);

      await vi.advanceTimersByTimeAsync(1_001);
      await expect(result).resolves.toMatchObject({ code: 'RPC_TIMEOUT', txHash: '0xdeadline' });
      expect(firstCalls).toBe(1);
      expect(secondCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the factory-resolved default overall receipt deadline', async () => {
    vi.useFakeTimers();
    try {
      expect(createCliEvmProviders('https://rpc.example').receiptTimeoutMs).toBe(600_000);
      const provider = {
        broadcastTransaction: async () => ({ hash: '0xdefault-deadline' }),
        getTransactionReceipt: async () => null,
      } as any;
      const result = sendCliRawTransactionWithFailover(
        writeContext([provider]),
        '0xsigned',
        '0xdefault-deadline',
      ).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason) => ({ status: 'rejected' as const, reason }),
      );
      let settled = false;
      void result.finally(() => { settled = true; });

      // Pin the observable boundary independently of every production constant.
      // Checking only after ten minutes would miss an early regression: a
      // three-minute timeout is also settled by then.
      await vi.advanceTimersByTimeAsync(180_001);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(419_998);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);

      const outcome = await result;
      expect(outcome).toMatchObject({
        status: 'rejected',
        reason: {
          code: 'RPC_TIMEOUT',
          txHash: '0xdefault-deadline',
        },
      });
      expect(outcome.status === 'rejected' ? outcome.reason.message : '')
        .toContain('within 600000ms');
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a deterministic reverted receipt that arrives at the deadline', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const provider = {
        broadcastTransaction: async () => ({ hash: '0xreverted' }),
        getTransactionReceipt: async () => {
          vi.setSystemTime(1_001);
          return { status: 0 };
        },
      } as any;

      const outcome = sendCliRawTransactionWithFailover(
        writeContext([provider], 1_000),
        '0xsigned',
        '0xreverted',
      ).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason) => ({ status: 'rejected' as const, reason }),
      );

      await expect(outcome).resolves.toMatchObject({
        status: 'rejected',
        reason: { code: 'CALL_EXCEPTION' },
      });
      const result = await outcome;
      expect(result.status === 'rejected' ? result.reason.code : '')
        .not.toBe('RPC_TIMEOUT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('constructs one provider/url endpoint list at the factory boundary', () => {
    const context = createCliEvmProviders(
      'https://primary.example',
      ['https://backup.example'],
      725_000,
    );

    expect(context.endpoints.map(endpoint => endpoint.rpcUrl)).toEqual([
      'https://primary.example',
      'https://backup.example',
    ]);
    expect(context.endpoints.every(endpoint => endpoint.provider instanceof ethers.JsonRpcProvider))
      .toBe(true);
    expect(context).not.toHaveProperty('providers');
    expect(context).not.toHaveProperty('urls');
    expect(context.receiptTimeoutMs).toBe(725_000);
  });
});
