// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
import {
  isCliRetryableRpcError,
  isCliKnownTransactionError,
  sendCliRawTransactionWithFailover,
} from '../src/cli-rpc.js';
import { isRetryableRpcError, isKnownTransactionError, isChainRpcTransportError } from '@origintrail-official/dkg-chain';

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
      sendCliRawTransactionWithFailover([failing, failing], '0xsigned', '0xhash', ['https://a.example', 'https://b.example']),
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
      sendCliRawTransactionWithFailover([reverting, reverting], '0xsigned', '0xhash', ['https://a.example', 'https://b.example']),
    ).rejects.toMatchObject({ code: 'CALL_EXCEPTION' });
    // Only the first provider was tried — a revert is not retried on the backup.
    expect(calls).toBe(1);
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
      [provider(), provider()],
      '0xsigned',
      '0xdeadbeef',
      ['https://a.example', 'https://b.example'],
    ).catch((e) => e);
    expect(err.code).toBe('RPC_RECEIPT_LOOKUP_FAILED');
    expect(err.txHash).toBe('0xdeadbeef');
    expect(isChainRpcTransportError(err)).toBe(true);
  });
});
