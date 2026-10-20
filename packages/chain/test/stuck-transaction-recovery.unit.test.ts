// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  MAX_STUCK_TRANSACTION_DEADLINE_RENEWALS,
  STUCK_TRANSACTION_CHECK_INTERVAL_MS,
  StuckTransactionRecovery,
  decideStuckTransaction,
  stuckTransactionCheckIntervalMs,
  type StuckTransactionPort,
} from '../src/stuck-transaction-recovery.js';
import { chainFeeFloor, priceEip1559Fees } from '../src/evm-fee-policy.js';
import { waitForReceiptWithDeadline } from '../src/receipt-wait.js';
import type { ReplacementBroadcastSignal } from '../src/chain-adapter.js';

const GWEI = 1_000_000_000n;
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const KA_LIFECYCLE = '0x38b54901f0ade112fd9002024dbdd0db3d7321b5';
const PUBLISH_CALLDATA = '0x2f9bbcec0000000000000000000000000000000000000000000000000000000000000020';

const wallet = new ethers.Wallet(PRIVATE_KEY);

/** 0xb10fd00a… of 2026-10-20: nonce 6722, maxFee 614 wei, tip 100 wei, gas 966,191. */
async function strandedPublish() {
  const signedTx = await wallet.signTransaction({
    type: 2,
    chainId: 100n,
    nonce: 6722,
    gasLimit: 966_191n,
    to: KA_LIFECYCLE,
    value: 0n,
    data: PUBLISH_CALLDATA,
    maxFeePerGas: 614n,
    maxPriorityFeePerGas: 100n,
  });
  return {
    txHash: ethers.Transaction.from(signedTx).hash!,
    signedTx,
    fees: { maxFeePerGas: 614n, maxPriorityFeePerGas: 100n },
  };
}

interface FakeChain {
  latestNonce: number;
  baseFeePerGas: bigint | null;
}

function fakePort(chain: FakeChain, overrides: Partial<StuckTransactionPort> = {}) {
  const events: string[] = [];
  const signedRequests: ethers.TransactionRequest[] = [];
  const signedTxs: string[] = [];
  const checkpoints: ReplacementBroadcastSignal[] = [];
  const broadcasts: string[] = [];
  const port: StuckTransactionPort = {
    readChainHead: async () => {
      events.push('read');
      return { latestNonce: chain.latestNonce, baseFeePerGas: chain.baseFeePerGas };
    },
    priceFees: async (baseFeePerGas) =>
      priceEip1559Fees({ baseFeePerGas, suggestedPriorityFeePerGas: 100n, floor: chainFeeFloor(100n) }),
    sign: async (request) => {
      signedRequests.push(request);
      const signedTx = await wallet.signTransaction(request);
      signedTxs.push(signedTx);
      events.push('sign');
      return { signedTx, txHash: ethers.Transaction.from(signedTx).hash! };
    },
    beforeBroadcast: async (signal) => {
      checkpoints.push(signal);
      events.push(`checkpoint:${signal.txHash}`);
    },
    broadcast: async (_signedTx, txHash) => {
      broadcasts.push(txHash);
      events.push(`broadcast:${txHash}`);
    },
    ...overrides,
  };
  return { port, events, signedRequests, signedTxs, checkpoints, broadcasts };
}

function recoveryFor(
  original: Awaited<ReturnType<typeof strandedPublish>>,
  port: StuckTransactionPort,
  clock: { now: number },
  extra: Partial<ConstructorParameters<typeof StuckTransactionRecovery>[0]> = {},
) {
  const logs: string[] = [];
  const recovery = new StuckTransactionRecovery({
    original,
    nonce: 6722,
    label: 'V10 publish',
    receiptTimeoutMs: 600_000,
    checkIntervalMs: 30_000,
    port,
    now: () => clock.now,
    log: (message) => logs.push(message),
    ...extra,
  });
  return { recovery, logs };
}

describe('stuck-transaction decision', () => {
  const base = {
    nonce: 6722,
    baseFeePerGas: 4_900_000n,
    maxFeePerGas: 614n,
    replacementsLeft: 5,
    renewalsLeft: 2,
  };

  it('replaces the next-to-mine transaction once the base fee has passed its cap', () => {
    expect(decideStuckTransaction({ ...base, latestNonce: 6722, deadlineReached: false }))
      .toEqual({ action: 'replace', reason: 'underpriced', renewDeadline: false });
    expect(decideStuckTransaction({ ...base, latestNonce: 6722, maxFeePerGas: 2n * GWEI, deadlineReached: false }))
      .toEqual({ action: 'wait' });
    expect(decideStuckTransaction({ ...base, latestNonce: 6722, baseFeePerGas: null, deadlineReached: false }))
      .toEqual({ action: 'wait' });
    expect(decideStuckTransaction({ ...base, latestNonce: 6722, replacementsLeft: 0, deadlineReached: false }))
      .toEqual({ action: 'wait' });
  });

  it('replaces instead of abandoning a transaction that still holds the next nonce at the deadline', () => {
    expect(decideStuckTransaction({ ...base, latestNonce: 6722, maxFeePerGas: 2n * GWEI, deadlineReached: true }))
      .toEqual({ action: 'replace', reason: 'unmined', renewDeadline: true });
    expect(decideStuckTransaction({ ...base, latestNonce: 6722, renewalsLeft: 0, deadlineReached: true }))
      .toEqual({ action: 'give-up' });
    expect(decideStuckTransaction({ ...base, latestNonce: 6722, replacementsLeft: 0, deadlineReached: true }))
      .toEqual({ action: 'give-up' });
  });

  it('waits behind an earlier nonce, renewing the deadline a bounded number of times', () => {
    expect(decideStuckTransaction({ ...base, latestNonce: 6721, deadlineReached: false })).toEqual({ action: 'wait' });
    expect(decideStuckTransaction({ ...base, latestNonce: 6721, deadlineReached: true })).toEqual({ action: 'renew-deadline' });
    expect(decideStuckTransaction({ ...base, latestNonce: 6721, renewalsLeft: 0, deadlineReached: true }))
      .toEqual({ action: 'give-up' });
  });

  it('never replaces once the nonce is consumed, and lets the timeout surface at the deadline', () => {
    expect(decideStuckTransaction({ ...base, latestNonce: 6723, deadlineReached: false })).toEqual({ action: 'wait' });
    expect(decideStuckTransaction({ ...base, latestNonce: 6723, deadlineReached: true })).toEqual({ action: 'give-up' });
  });

  it('checks every 30 s, or four times per receipt timeout when that is shorter', () => {
    expect(stuckTransactionCheckIntervalMs(600_000)).toBe(STUCK_TRANSACTION_CHECK_INTERVAL_MS);
    expect(stuckTransactionCheckIntervalMs(1_000)).toBe(250);
    expect(stuckTransactionCheckIntervalMs(1)).toBe(1);
  });
});

describe('StuckTransactionRecovery', () => {
  it('re-signs the 2026-10-20 publish at nonce 6722 above the spiked base fee, checkpointing before it broadcasts', async () => {
    const original = await strandedPublish();
    const chain = { latestNonce: 6722, baseFeePerGas: 4_900_000n };
    const { port, events, signedTxs, checkpoints, broadcasts } = fakePort(chain);
    const clock = { now: 0 };
    const { recovery, logs } = recoveryFor(original, port, clock);

    // Nothing is read before the first check interval.
    clock.now = 29_999;
    await expect(recovery.onPending({ deadlineMs: 600_000, deadlineReached: false })).resolves.toBeUndefined();
    expect(events).toEqual([]);

    clock.now = 30_000;
    await expect(recovery.onPending({ deadlineMs: 600_000, deadlineReached: false })).resolves.toBeUndefined();
    expect(signedTxs).toHaveLength(1);
    const replacementHash = broadcasts[0];
    expect(events).toEqual(['read', 'sign', `checkpoint:${replacementHash}`, `broadcast:${replacementHash}`]);
    expect(checkpoints).toEqual([{ txHash: replacementHash, nonce: 6722, replacesTxHashes: [original.txHash] }]);
    expect(recovery.txHashes()).toEqual([original.txHash, replacementHash]);
    expect(recovery.latestTxHash()).toBe(replacementHash);

    const before = ethers.Transaction.from(original.signedTx);
    const replaced = ethers.Transaction.from(signedTxs[0]);
    for (const field of ['chainId', 'nonce', 'gasLimit', 'to', 'value', 'data'] as const) {
      expect(replaced[field]).toEqual(before[field]);
    }
    expect(replaced.maxFeePerGas).toBe(2n * GWEI);
    expect(replaced.maxPriorityFeePerGas).toBe(GWEI);
    expect(replaced.maxFeePerGas!).toBeGreaterThan(36_000_000n);
    expect(logs.join('\n')).toContain('is below the base fee 4900000');

    // The replacement is priced right: the next check finds nothing to do.
    clock.now = 60_000;
    await recovery.onPending({ deadlineMs: 600_000, deadlineReached: false });
    expect(broadcasts).toHaveLength(1);
  });

  it('replaces and renews the deadline when a correctly priced transaction is still unmined at it', async () => {
    const original = await strandedPublish();
    const chain = { latestNonce: 6722, baseFeePerGas: 23n };
    const { port, broadcasts } = fakePort(chain);
    const clock = { now: 600_000 };
    const { recovery } = recoveryFor(original, port, clock);

    await expect(recovery.onPending({ deadlineMs: 600_000, deadlineReached: true })).resolves.toBe(1_200_000);
    expect(broadcasts).toHaveLength(1);
    expect(recovery.describeTimeout()).toBe(` (nonce 6722; it replaced ${original.txHash}; deadline renewed 1x)`);
  });

  it('keeps waiting behind an earlier nonce without replacing, at most the bounded number of times', async () => {
    const original = await strandedPublish();
    const chain = { latestNonce: 6721, baseFeePerGas: 4_900_000n };
    const { port, broadcasts } = fakePort(chain);
    const clock = { now: 600_000 };
    const { recovery } = recoveryFor(original, port, clock);

    for (let renewal = 1; renewal <= MAX_STUCK_TRANSACTION_DEADLINE_RENEWALS; renewal += 1) {
      await expect(recovery.onPending({ deadlineMs: clock.now, deadlineReached: true }))
        .resolves.toBe(clock.now + 600_000);
      clock.now += 600_000;
    }
    await expect(recovery.onPending({ deadlineMs: clock.now, deadlineReached: true })).resolves.toBeUndefined();
    expect(broadcasts).toEqual([]);
  });

  it('never replaces a nonce something else consumed (an operator replacement, say)', async () => {
    const original = await strandedPublish();
    const chain = { latestNonce: 6723, baseFeePerGas: 4_900_000n };
    const { port, events } = fakePort(chain);
    const clock = { now: 0 };
    const { recovery } = recoveryFor(original, port, clock);

    clock.now = 30_000;
    await recovery.onPending({ deadlineMs: 600_000, deadlineReached: false });
    clock.now = 600_000;
    await expect(recovery.onPending({ deadlineMs: 600_000, deadlineReached: true })).resolves.toBeUndefined();
    expect(events).toEqual(['read', 'read']);
    expect(recovery.txHashes()).toEqual([original.txHash]);
  });

  it('does not broadcast a replacement its checkpoint refused, and gives up at the deadline', async () => {
    const original = await strandedPublish();
    const chain = { latestNonce: 6722, baseFeePerGas: 4_900_000n };
    const { port, broadcasts } = fakePort(chain, {
      beforeBroadcast: async () => { throw new Error('write-ahead store unavailable'); },
    });
    const clock = { now: 600_000 };
    const { recovery, logs } = recoveryFor(original, port, clock);

    await expect(recovery.onPending({ deadlineMs: 600_000, deadlineReached: true })).resolves.toBeUndefined();
    expect(broadcasts).toEqual([]);
    expect(recovery.txHashes()).toEqual([original.txHash]);
    expect(logs.join('\n')).toContain('replacement failed: write-ahead store unavailable');
  });

  it('keeps a replacement the RPC rejected out of the outcome and out of the polled hashes', async () => {
    const original = await strandedPublish();
    const chain = { latestNonce: 6722, baseFeePerGas: 4_900_000n };
    const { port } = fakePort(chain, {
      broadcast: async () => {
        throw Object.assign(new Error('insufficient funds for gas * price + value'), { code: 'INSUFFICIENT_FUNDS' });
      },
    });
    const clock = { now: 600_000 };
    const { recovery, logs } = recoveryFor(original, port, clock);

    await expect(recovery.onPending({ deadlineMs: 600_000, deadlineReached: true })).resolves.toBeUndefined();
    expect(recovery.txHashes()).toEqual([original.txHash]);
    expect(logs.join('\n')).toContain('was not accepted: insufficient funds');
  });

  it('polls a replacement whose broadcast failed in transport, since an endpoint may have taken it', async () => {
    const original = await strandedPublish();
    const chain = { latestNonce: 6722, baseFeePerGas: 4_900_000n };
    const { port } = fakePort(chain, {
      broadcast: async () => {
        throw Object.assign(new Error('V10 publish broadcast failed on all configured RPC endpoints'), {
          code: 'RPC_ENDPOINTS_EXHAUSTED',
        });
      },
    });
    const clock = { now: 600_000 };
    const { recovery } = recoveryFor(original, port, clock);

    await expect(recovery.onPending({ deadlineMs: 600_000, deadlineReached: true })).resolves.toBeUndefined();
    expect(recovery.txHashes()).toHaveLength(2);
  });

  it('does not replace when the operator fee cap leaves no room for a bump', async () => {
    const original = await strandedPublish();
    const chain = { latestNonce: 6722, baseFeePerGas: 4_900_000n };
    const { port, signedRequests } = fakePort(chain);
    const clock = { now: 0 };
    const { recovery, logs } = recoveryFor(original, port, clock, { maxFeePerGasCap: 650n });

    clock.now = 30_000;
    await recovery.onPending({ deadlineMs: 600_000, deadlineReached: false });
    expect(signedRequests).toEqual([]);
    expect(logs.join('\n')).toContain('chain.maxFeePerGasWei 650 leaves no room');
  });

  it('caps a replacement at the operator fee cap', async () => {
    const original = await strandedPublish();
    const chain = { latestNonce: 6722, baseFeePerGas: 4_900_000n };
    const { port, signedRequests } = fakePort(chain);
    const clock = { now: 0 };
    const { recovery } = recoveryFor(original, port, clock, { maxFeePerGasCap: 100_000_000n });

    clock.now = 30_000;
    await recovery.onPending({ deadlineMs: 600_000, deadlineReached: false });
    expect(signedRequests[0]).toMatchObject({ maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 100_000_000n });
  });

  it('treats a failed chain read as nothing to do', async () => {
    const original = await strandedPublish();
    const { port, events } = fakePort({ latestNonce: 6722, baseFeePerGas: 4_900_000n }, {
      readChainHead: async () => { throw new Error('RPC_ENDPOINTS_EXHAUSTED'); },
    });
    const clock = { now: 600_000 };
    const { recovery } = recoveryFor(original, port, clock);

    await expect(recovery.onPending({ deadlineMs: 600_000, deadlineReached: true })).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });

  it('stops replacing after the bounded number of replacements', async () => {
    const original = await strandedPublish();
    const chain = { latestNonce: 6722, baseFeePerGas: 0n };
    const { port, broadcasts } = fakePort(chain);
    const clock = { now: 0 };
    const { recovery } = recoveryFor(original, port, clock, { maxReplacements: 2 });

    for (let check = 1; check <= 4; check += 1) {
      // A base fee that keeps outrunning every replacement.
      chain.baseFeePerGas = 10n ** BigInt(9 + check) * 10n;
      clock.now = check * 30_000;
      await recovery.onPending({ deadlineMs: 600_000, deadlineReached: false });
    }
    expect(broadcasts).toHaveLength(2);
  });
});

describe('receipt wait over a transaction and its replacements', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function waitWithRecovery(params: {
    minedHash: (hashes: readonly string[]) => string | undefined;
  }) {
    vi.useFakeTimers({ now: 0 });
    const original = await strandedPublish();
    const chain = { latestNonce: 6722, baseFeePerGas: 4_900_000n };
    const { port, broadcasts } = fakePort(chain);
    const recovery = new StuckTransactionRecovery({
      original,
      nonce: 6722,
      label: 'V10 publish',
      receiptTimeoutMs: 600_000,
      checkIntervalMs: 30_000,
      port,
      log: () => {},
    });
    const lookups: string[] = [];
    const outcome = waitForReceiptWithDeadline({
      txHash: original.txHash,
      txHashes: () => recovery.txHashes(),
      receiptTimeoutMs: 600_000,
      pollIntervalMs: 2_000,
      getReceipt: async (hash) => {
        lookups.push(hash);
        return params.minedHash(recovery.txHashes()) === hash ? { hash, status: 1 } : null;
      },
      assertSuccessfulReceipt: () => {},
      onPending: (context) => recovery.onPending(context),
      formatTimeoutMessage: ({ txHash }) => `tx ${txHash} timed out${recovery.describeTimeout()}`,
    }).then(
      (receipt) => ({ status: 'fulfilled' as const, receipt }),
      (reason) => ({ status: 'rejected' as const, reason }),
    );
    return { original, outcome, broadcasts, lookups };
  }

  it('resolves with the replacement when the replacement is mined', async () => {
    const { original, outcome, broadcasts, lookups } = await waitWithRecovery({
      minedHash: (hashes) => hashes[1],
    });
    await vi.advanceTimersByTimeAsync(40_000);
    await expect(outcome).resolves.toMatchObject({ status: 'fulfilled', receipt: { hash: broadcasts[0] } });
    expect(lookups).toContain(original.txHash);
  });

  it('resolves with the original when it is mined after all', async () => {
    const { original, outcome, broadcasts } = await waitWithRecovery({
      minedHash: (hashes) => (hashes.length > 1 ? hashes[0] : undefined),
    });
    await vi.advanceTimersByTimeAsync(40_000);
    await expect(outcome).resolves.toMatchObject({ status: 'fulfilled', receipt: { hash: original.txHash } });
    expect(broadcasts).toHaveLength(1);
  });

  it('times out naming the latest hash and every one it replaced', async () => {
    const { original, outcome, broadcasts } = await waitWithRecovery({ minedHash: () => undefined });
    await vi.advanceTimersByTimeAsync(3 * 600_000 + 10_000);
    const settled = await outcome;
    expect(settled.status).toBe('rejected');
    const reason = (settled as { reason: { code: string; txHash: string; message: string } }).reason;
    expect(reason.code).toBe('RPC_TIMEOUT');
    expect(reason.txHash).toBe(broadcasts[broadcasts.length - 1]);
    expect(reason.message).toContain(original.txHash);
  });
});
