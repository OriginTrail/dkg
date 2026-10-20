// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  MAX_STUCK_TRANSACTION_DEADLINE_RENEWALS,
  STUCK_TRANSACTION_CHECK_INTERVAL_MS,
  STUCK_TRANSACTION_READ_BUDGET_MS,
  StuckTransactionRecovery,
  decideStuckTransaction,
  stuckTransactionCheckIntervalMs,
  stuckTransactionRecoveryFor,
  type StuckTransactionChain,
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
    finalLookupLeft: true,
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

  it('never replaces once the nonce is consumed; at the deadline it looks every hash up once more, then gives up', () => {
    expect(decideStuckTransaction({ ...base, latestNonce: 6723, deadlineReached: false })).toEqual({ action: 'wait' });
    expect(decideStuckTransaction({ ...base, latestNonce: 6723, deadlineReached: true }))
      .toEqual({ action: 'final-lookup' });
    expect(decideStuckTransaction({ ...base, latestNonce: 6723, deadlineReached: true, finalLookupLeft: false }))
      .toEqual({ action: 'give-up' });
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
    expect(recovery.latestTxHash()).toBe(broadcasts[0]);
    expect(recovery.describeTimeout()).toBe(` (nonce 6722; also sent as ${original.txHash}; deadline renewed 1x)`);
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
    // One more look at every hash: the transaction that consumed the slot may be ours.
    await expect(recovery.onPending({ deadlineMs: 600_000, deadlineReached: true })).resolves.toBe(630_000);
    clock.now = 630_000;
    await expect(recovery.onPending({ deadlineMs: 630_000, deadlineReached: true })).resolves.toBeUndefined();
    expect(events).toEqual(['read', 'read', 'read']);
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

  // otReviewAgent on #3393: a failover broadcast can be accepted by one endpoint whose answer is
  // lost, then rejected by the next (nonce too low once it has mined, or insufficient funds), so
  // a broadcast error never proves the replacement reached no mempool.
  for (const [name, failure] of [
    ['an endpoint rejected', Object.assign(new Error('nonce too low'), { code: 'NONCE_EXPIRED' })],
    ['an endpoint refused for funds', Object.assign(new Error('insufficient funds for gas * price + value'), { code: 'INSUFFICIENT_FUNDS' })],
    ['broadcast failed in transport', Object.assign(new Error('broadcast failed on all configured RPC endpoints'), { code: 'RPC_ENDPOINTS_EXHAUSTED' })],
  ] as const) {
    it(`keeps polling a replacement ${name}, and waits for it past the deadline`, async () => {
      const original = await strandedPublish();
      const chain = { latestNonce: 6722, baseFeePerGas: 4_900_000n };
      const { port, broadcasts } = fakePort(chain, {
        broadcast: async (_signedTx, txHash) => {
          broadcasts.push(txHash);
          throw failure;
        },
      });
      const clock = { now: 600_000 };
      const { recovery, logs } = recoveryFor(original, port, clock);

      await expect(recovery.onPending({ deadlineMs: 600_000, deadlineReached: true })).resolves.toBe(1_200_000);
      expect(recovery.txHashes()).toEqual([original.txHash, broadcasts[0]]);
      // The timeout still names the transaction an endpoint is known to hold.
      expect(recovery.latestTxHash()).toBe(original.txHash);
      expect(logs.join('\n')).toContain('may not have been accepted, still polling it');
    });
  }

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

  type FakeReceipt = { hash: string; status: number; blockHash?: string };

  async function waitWithRecovery(params: {
    minedHash: (hashes: readonly string[]) => string | undefined;
    baseFeePerGas?: bigint;
    /** The chain the recovery reads; a test may advance its nonce as a transaction mines. */
    chain?: FakeChain;
    receiptTimeoutMs?: number;
    checkIntervalMs?: number;
    pollIntervalMs?: number;
    broadcast?: StuckTransactionPort['broadcast'];
    receiptFor?: (hash: string, hashes: readonly string[]) => FakeReceipt | null;
    isReceiptEligible?: (receipt: FakeReceipt) => Promise<boolean>;
  }) {
    vi.useFakeTimers({ now: 0 });
    const original = await strandedPublish();
    const chain = params.chain ?? { latestNonce: 6722, baseFeePerGas: params.baseFeePerGas ?? 4_900_000n };
    const receiptTimeoutMs = params.receiptTimeoutMs ?? 600_000;
    const { port, broadcasts } = fakePort(chain, params.broadcast ? { broadcast: params.broadcast } : {});
    const recovery = new StuckTransactionRecovery({
      original,
      nonce: 6722,
      label: 'V10 publish',
      receiptTimeoutMs,
      checkIntervalMs: params.checkIntervalMs ?? 30_000,
      port,
      log: () => {},
    });
    const lookups: string[] = [];
    const outcome = waitForReceiptWithDeadline<FakeReceipt>({
      txHash: original.txHash,
      txHashes: () => recovery.txHashes(),
      timeoutTxHash: () => recovery.latestTxHash(),
      receiptTimeoutMs,
      pollIntervalMs: params.pollIntervalMs ?? 2_000,
      getReceipt: async (hash) => {
        lookups.push(hash);
        if (params.receiptFor) return params.receiptFor(hash, recovery.txHashes());
        return params.minedHash(recovery.txHashes()) === hash ? { hash, status: 1 } : null;
      },
      ...(params.isReceiptEligible ? { isReceiptEligible: params.isReceiptEligible } : {}),
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

  // otReviewAgent on #3393: one endpoint mines the replacement but loses its answer, and the next
  // reports nonce too low. The broadcast fails, yet the operation succeeded.
  it('resolves with a replacement an endpoint mined though the broadcast reported nonce too low', async () => {
    let replacementHash: string | undefined;
    const { outcome } = await waitWithRecovery({
      minedHash: () => replacementHash,
      broadcast: async (_signedTx, txHash) => {
        replacementHash = txHash;
        throw Object.assign(new Error('nonce too low'), { code: 'NONCE_EXPIRED' });
      },
    });
    await vi.advanceTimersByTimeAsync(40_000);
    await expect(outcome).resolves.toMatchObject({ status: 'fulfilled', receipt: { hash: replacementHash } });
  });

  it('gives a replacement sent with an uncertain outcome at the deadline its own receipt window', async () => {
    let replacementHash: string | undefined;
    const { outcome } = await waitWithRecovery({
      // Correctly priced, so nothing happens before the deadline.
      baseFeePerGas: 23n,
      minedHash: () => replacementHash,
      broadcast: async (_signedTx, txHash) => {
        replacementHash = txHash;
        throw Object.assign(new Error('broadcast timed out'), { code: 'RPC_ENDPOINTS_EXHAUSTED' });
      },
    });
    await vi.advanceTimersByTimeAsync(600_000 + 10_000);
    await expect(outcome).resolves.toMatchObject({ status: 'fulfilled', receipt: { hash: replacementHash } });
  });

  it('does not let an ineligible original receipt hide the replacement receipt', async () => {
    const ORPHANED = `0x${'0a'.repeat(32)}`;
    const CANONICAL = `0x${'0b'.repeat(32)}`;
    const { outcome, broadcasts } = await waitWithRecovery({
      minedHash: () => undefined,
      // After the reorg one endpoint still serves the original's receipt from an orphaned block,
      // while the replacement sits in the canonical chain.
      receiptFor: (hash, hashes) => {
        if (hashes.length < 2) return null;
        if (hash === hashes[0]) return { hash, status: 1, blockHash: ORPHANED };
        return hash === hashes[1] ? { hash, status: 1, blockHash: CANONICAL } : null;
      },
      isReceiptEligible: async (receipt) => receipt.blockHash === CANONICAL,
    });
    await vi.advanceTimersByTimeAsync(40_000);
    await expect(outcome).resolves.toMatchObject({
      status: 'fulfilled',
      receipt: { hash: broadcasts[0], blockHash: CANONICAL },
    });
  });

  // otReviewAgent on #3393: an underpriced replacement started before the deadline whose
  // broadcast returns after it, mined by then. The deadline check alone would see the consumed
  // nonce and give up without ever looking up the new hash.
  it('looks up a replacement whose broadcast finishes after the deadline before giving up', async () => {
    const chain = { latestNonce: 6722, baseFeePerGas: 4_900_000n };
    let minedReplacement: string | undefined;
    const { outcome, lookups } = await waitWithRecovery({
      chain,
      receiptTimeoutMs: 1_000,
      checkIntervalMs: 250,
      pollIntervalMs: 100,
      minedHash: () => minedReplacement,
      broadcast: async (_signedTx, txHash) => {
        // Starts at the first check (~300 ms) and returns at ~1,150 ms, mined by then.
        await new Promise((resolve) => setTimeout(resolve, 850));
        chain.latestNonce = 6723;
        minedReplacement = txHash;
      },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(outcome).resolves.toMatchObject({ status: 'fulfilled', receipt: { hash: minedReplacement } });
    expect(lookups).toContain(minedReplacement);
  });

  // otReviewAgent on #3393, with the production 2 s poll: the sleep after a late broadcast can
  // use up its whole extension, and the slot is then seen consumed by that very replacement.
  it('looks a late replacement up when the poll sleep used up its extension (4 s timeout, 2 s poll)', async () => {
    const chain = { latestNonce: 6722, baseFeePerGas: 4_900_000n };
    let minedReplacement: string | undefined;
    const { outcome, lookups } = await waitWithRecovery({
      chain,
      receiptTimeoutMs: 4_000,
      checkIntervalMs: stuckTransactionCheckIntervalMs(4_000),
      pollIntervalMs: 2_000,
      minedHash: () => minedReplacement,
      broadcast: async (_signedTx, txHash) => {
        // Starts at the 2 s check and returns at 4.5 s, mined by then.
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        chain.latestNonce = 6723;
        minedReplacement = txHash;
      },
    });
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(outcome).resolves.toMatchObject({ status: 'fulfilled', receipt: { hash: minedReplacement } });
    expect(lookups).toContain(minedReplacement);
  });
});

describe('recovery read budgets', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // otReviewAgent on #3393: a single-RPC node's reads have no attempt cap, and the receipt wait
  // awaits its checks, so each recovery read carries its own absolute deadline.
  it('gives the chain-head and fee-pricing reads an absolute deadline', async () => {
    vi.useFakeTimers({ now: 0 });
    const original = await strandedPublish();
    const deadlines: Array<[string, number]> = [];
    const chain: StuckTransactionChain = {
      receiptTimeoutMs: 600_000,
      feeFloor: chainFeeFloor(100n),
      readHead: async (label, _read, deadlineMs) => {
        deadlines.push([label, deadlineMs]);
        return { latestNonce: 6722, baseFeePerGas: 4_900_000n } as never;
      },
      read: async (label, _read, deadlineMs) => {
        deadlines.push([label, deadlineMs]);
        return { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI } as never;
      },
      broadcast: async () => {},
    };
    const recovery = stuckTransactionRecoveryFor({
      signer: wallet,
      signedTx: original.signedTx,
      txHash: original.txHash,
      nonce: 6722,
      label: 'V10 publish',
    }, chain)!;

    vi.setSystemTime(30_000);
    await recovery.onPending({ deadlineMs: 600_000, deadlineReached: false });
    expect(deadlines).toEqual([
      ['stuck transaction check', 30_000 + STUCK_TRANSACTION_READ_BUDGET_MS],
      ['replacement fee pricing', 30_000 + STUCK_TRANSACTION_READ_BUDGET_MS],
    ]);
  });

  it('lets the receipt timeout surface when the chain-head read stalls until its budget', async () => {
    vi.useFakeTimers({ now: 0 });
    const original = await strandedPublish();
    // A read that only ends when its deadline aborts it, as the RPC client does.
    const stalled = <T>(_label: string, _read: unknown, deadlineMs: number) =>
      new Promise<T>((_resolve, reject) => {
        setTimeout(() => reject(new Error('stuck transaction check timed out')), deadlineMs - Date.now());
      });
    const recovery = stuckTransactionRecoveryFor({
      signer: wallet,
      signedTx: original.signedTx,
      txHash: original.txHash,
      nonce: 6722,
      label: 'V10 publish',
    }, {
      receiptTimeoutMs: 1_000,
      readHead: stalled,
      read: stalled,
      broadcast: async () => {},
    })!;
    const outcome = waitForReceiptWithDeadline({
      txHash: original.txHash,
      txHashes: () => recovery.txHashes(),
      receiptTimeoutMs: 1_000,
      pollIntervalMs: 100,
      getReceipt: async () => null,
      assertSuccessfulReceipt: () => {},
      onPending: (context) => recovery.onPending(context),
      formatTimeoutMessage: ({ txHash }) => `tx ${txHash} timed out`,
    }).then(() => 'resolved', (err: { code?: string }) => err.code);
    await vi.advanceTimersByTimeAsync(1_000 + 2 * STUCK_TRANSACTION_READ_BUDGET_MS);
    await expect(outcome).resolves.toBe('RPC_TIMEOUT');
  });
});
