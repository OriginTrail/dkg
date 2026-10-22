// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RpcFailoverClient,
} from '../src/rpc-failover-client.js';
import { waitForTransactionReceiptWithFailover } from '../src/transaction-receipt-failover.js';
import { ChainRpcTransportError } from '../src/chain-rpc-transport-error.js';
import { waitForReceiptWithDeadline } from '../src/receipt-wait.js';
import { EvmReceiptFinalityReader } from '../src/evm-adapter-receipt-finality.js';

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

  // otReviewAgent on #3393: a superseded original whose fallback endpoint stalls must not use up
  // the shared deadline before the already-mined replacement is looked up AND passes the
  // deadline-bound finality check every adapter wait runs.
  it('looks every hash up together, so a stalled lookup cannot starve a mined one or its finality check', async () => {
    vi.useFakeTimers({ now: 0 });
    const CANONICAL = `0x${'cb'.repeat(32)}`;
    // The adapter's real finality gate, over an endpoint that refuses a read once its deadline has
    // passed, as RpcFailoverClient does.
    const finality = new EvmReceiptFinalityReader(1, async (_label, read, opts) => {
      if (opts?.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
        throw Object.assign(new Error('receipt finality read past its deadline'), { code: 'RPC_TIMEOUT' });
      }
      return read({
        getBlock: async (blockNumber: number) => ({ number: blockNumber, hash: CANONICAL }),
        getBlockNumber: async () => 100,
      } as never);
    });
    const outcome = waitForReceiptWithDeadline({
      txHash: '0xoriginal',
      txHashes: () => ['0xoriginal', '0xreplacement'],
      receiptTimeoutMs: 1_000,
      pollIntervalMs: 100,
      getReceipt: (hash, { deadlineMs }) => {
        // Like RpcFailoverClient: no endpoint attempt once the deadline has passed.
        if (Date.now() >= deadlineMs) return Promise.resolve(null);
        if (hash === '0xreplacement') {
          return Promise.resolve({ hash, status: 1, blockNumber: 100, blockHash: CANONICAL });
        }
        return new Promise((resolve) => setTimeout(() => resolve(null), deadlineMs - Date.now()));
      },
      isReceiptEligible: async (receipt, { deadlineMs }) =>
        (await finality.read(receipt, { deadlineMs })) !== null,
      assertSuccessfulReceipt: () => {},
      formatTimeoutMessage: () => 'timed out',
    }).then(
      (receipt) => ({ status: 'fulfilled' as const, receipt }),
      (reason) => ({ status: 'rejected' as const, reason }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toMatchObject({ status: 'fulfilled', receipt: { hash: '0xreplacement' } });
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

  it('keeps polling through a mid-deadline transport failure and returns the later receipt', async () => {
    // GH: a transport-class failure inside a budgeted wait must consume budget, never the
    // publish. Today one exhausted endpoint pass (RPC_RECEIPT_LOOKUP_FAILED, classified
    // non-retryable) throws out of the wait with most of the 10-minute budget unspent, which
    // demotes a healthy post-write-ahead publish into the recovery lane.
    vi.useFakeTimers({ now: 0 });
    const receipt = { status: 1, hash: '0xrecovered-after-blip' } as any;
    const getReceipt = vi.fn<[], Promise<any>>()
      .mockImplementationOnce(async () => {
        throw new ChainRpcTransportError(
          'RPC_RECEIPT_LOOKUP_FAILED',
          'every configured endpoint failed this poll tick',
          { txHash: receipt.hash },
        );
      })
      .mockImplementation(async () => receipt);

    const outcome = waitForReceiptWithDeadline({
      txHash: receipt.hash,
      receiptTimeoutMs: 10_000,
      pollIntervalMs: 100,
      getReceipt: getReceipt as never,
      assertSuccessfulReceipt: () => {},
      formatTimeoutMessage: () => 'must not be used',
    }).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason) => ({ status: 'rejected' as const, reason }),
    );

    await vi.advanceTimersByTimeAsync(500);
    await expect(outcome).resolves.toEqual({ status: 'fulfilled', value: receipt });
    expect(getReceipt.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('still aborts the wait immediately on a non-transport lookup error', async () => {
    // The tolerance is scoped to the chain-namespaced transport codes: a deterministic
    // classification (here INVALID_ARGUMENT) must keep failing fast, not burn the budget
    // re-asking a question with a stable answer.
    vi.useFakeTimers({ now: 0 });
    const deterministic = new Error('malformed tx hash') as Error & { code: string };
    deterministic.code = 'INVALID_ARGUMENT';
    const getReceipt = vi.fn(async () => { throw deterministic; });

    const outcome = waitForReceiptWithDeadline({
      txHash: '0xdeterministic',
      receiptTimeoutMs: 10_000,
      pollIntervalMs: 100,
      getReceipt,
      assertSuccessfulReceipt: () => {},
      formatTimeoutMessage: () => 'must not be used',
    }).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason) => ({ status: 'rejected' as const, reason }),
    );

    await vi.advanceTimersByTimeAsync(0);
    await expect(outcome).resolves.toMatchObject({
      status: 'rejected',
      reason: { code: 'INVALID_ARGUMENT' },
    });
    expect(getReceipt).toHaveBeenCalledTimes(1);
  });

  it('maps sustained transport failure to the operation RPC_TIMEOUT after polling the whole budget', async () => {
    // Persistent exhaustion is still terminal — but at the OPERATION deadline, with the last
    // transport error as cause, after having actually retried across the budget rather than
    // dying on the first tick.
    vi.useFakeTimers({ now: 0 });
    const getReceipt = vi.fn(async () => {
      throw new ChainRpcTransportError(
        'RPC_RECEIPT_LOOKUP_FAILED',
        'endpoints failing all run long',
        { txHash: '0xnever-found' },
      );
    });

    const outcome = waitForReceiptWithDeadline({
      txHash: '0xnever-found',
      receiptTimeoutMs: 1_000,
      pollIntervalMs: 100,
      getReceipt,
      assertSuccessfulReceipt: () => {},
      formatTimeoutMessage: ({ lastError }) =>
        `budget exhausted (last: ${(lastError as Error | undefined)?.message ?? 'none'})`,
    }).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason) => ({ status: 'rejected' as const, reason }),
    );

    await vi.advanceTimersByTimeAsync(1_100);
    await expect(outcome).resolves.toMatchObject({
      status: 'rejected',
      reason: {
        code: 'RPC_TIMEOUT',
        message: 'budget exhausted (last: endpoints failing all run long)',
      },
    });
    expect(getReceipt.mock.calls.length).toBeGreaterThanOrEqual(5);
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
