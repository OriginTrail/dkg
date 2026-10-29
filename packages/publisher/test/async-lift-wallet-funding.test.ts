/**
 * #3591 — the funding gate a wallet passes before it claims. Driven directly with a fake clock and a
 * scripted balance reader; the publisher-level rows live in `async-lift-funding-claims-3591.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AsyncLiftWalletFunding,
  WALLET_FUNDING_COOLDOWN_BASE_MS as BASE,
  WALLET_FUNDING_COOLDOWN_MAX_MS as MAX,
  WALLET_FUNDING_EVIDENCE_TTL_MS as EVIDENCE_TTL,
  WALLET_FUNDING_READING_TTL_MS as READING_TTL,
  WALLET_FUNDING_READ_TIMEOUT_MS as READ_TIMEOUT,
  refusedTransactionCostWei,
  type AsyncLiftWalletBalanceReader,
  type AsyncLiftWalletBalances,
} from '../src/async-lift-wallet-funding.js';

afterEach(() => vi.useRealTimers());

/** go-ethereum's text for a transaction it turns away: it states the cost. */
const STATED = new Error('insufficient funds for gas * price + value: address 0x00000000000000000000000000000000000000a1 have 1907 want 2047');
/** A refusal that states no cost (the adapter's own no-funded-wallet selection, for one). */
const UNSTATED = new Error('insufficient funds for gas * price + value');

function gate(options: { reader?: AsyncLiftWalletBalanceReader | null } = {}) {
  let now = 1_000_000;
  const balances = new Map<string, AsyncLiftWalletBalances>();
  const reads: string[] = [];
  const pokes: string[] = [];
  const reader: AsyncLiftWalletBalanceReader = async (walletId) => {
    reads.push(walletId);
    return balances.get(walletId) ?? { native: null, trac: null };
  };
  const funding = new AsyncLiftWalletFunding({
    now: () => now,
    ...(options.reader === null ? {} : { readBalances: options.reader ?? reader }),
    onReading: (walletId) => { pokes.push(walletId); },
  });
  return {
    funding,
    reads,
    pokes,
    advance: (ms: number) => { now += ms; },
    fund: (walletId: string, native: bigint | null, trac: bigint | null = null, pca?: bigint | null) => {
      balances.set(walletId, { native, trac, ...(pca !== undefined ? { pca } : {}) });
    },
    /** Let a pending reading land. */
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

describe('AsyncLiftWalletFunding (#3591)', () => {
  it('lets every wallet claim and reads nothing until the chain refuses one', () => {
    const { funding, reads } = gate();
    expect(funding.mayClaim('w1')).toBe(true);
    expect(funding.mayClaim('w2')).toBe(true);
    funding.recordSpend('w1');
    expect(funding.mayClaim('w1')).toBe(true);
    expect(reads).toEqual([]);
  });

  it('keeps a refused wallet out, rereads it after each cooldown and lets it back once it covers the stated cost', async () => {
    const g = gate();
    g.fund('w1', 1907n);
    g.funding.recordRefusal('w1', STATED);
    await g.settle();
    expect(g.reads).toEqual(['w1']);
    g.advance(BASE - 1);
    expect(g.funding.mayClaim('w1')).toBe(false);
    expect(g.reads).toEqual(['w1']);

    // Cooldown over: a fresh reading decides, and the claim waits for it.
    g.advance(1);
    expect(g.funding.mayClaim('w1')).toBe(false);
    await g.settle();
    expect(g.reads).toEqual(['w1', 'w1']);
    expect(g.pokes).toEqual(['w1', 'w1']);
    // Still short: the next cooldown is twice as long.
    expect(g.funding.mayClaim('w1')).toBe(false);
    g.advance(2 * BASE - 1);
    expect(g.funding.mayClaim('w1')).toBe(false);
    expect(g.reads).toHaveLength(2);

    g.fund('w1', 2047n);
    g.advance(1);
    expect(g.funding.mayClaim('w1')).toBe(false);
    await g.settle();
    expect(g.funding.mayClaim('w1')).toBe(true);
    expect(g.funding.mayClaim('w2')).toBe(false);
  });

  it('caps the cooldown at ten minutes', async () => {
    const g = gate();
    g.fund('w1', 1n);
    g.funding.recordRefusal('w1', STATED);
    await g.settle();
    let cooldown = BASE;
    for (let round = 0; round < 8; round += 1) {
      g.advance(cooldown);
      g.funding.mayClaim('w1');
      await g.settle();
      expect(g.funding.mayClaim('w1')).toBe(false);
      cooldown = Math.min(MAX, cooldown * 2);
    }
    g.advance(MAX - 1);
    expect(g.funding.mayClaim('w1')).toBe(false);
    const reads = g.reads.length;
    g.advance(1);
    g.funding.mayClaim('w1');
    await g.settle();
    expect(g.reads).toHaveLength(reads + 1);
  });

  it('lets a wallet refused with no stated cost back once its native or TRAC balance grew', async () => {
    const g = gate();
    g.fund('w1', 100n, 5n);
    g.funding.recordRefusal('w1', UNSTATED);
    await g.settle();
    g.advance(BASE);
    g.funding.mayClaim('w1');
    await g.settle();
    expect(g.funding.mayClaim('w1')).toBe(false);

    g.fund('w1', 100n, 6n);
    g.advance(2 * BASE);
    g.funding.mayClaim('w1');
    await g.settle();
    expect(g.funding.mayClaim('w1')).toBe(true);
    // No stated cost: other wallets are not read.
    expect(g.funding.mayClaim('w2')).toBe(true);
    expect(g.reads.filter((walletId) => walletId === 'w2')).toEqual([]);
  });

  it('lets a wallet refused with no stated cost back once its Publishing Conviction coverage grew', async () => {
    const g = gate();
    // Gas-funded, no TRAC, no account: the adapter found it unfundable before signing.
    g.fund('w1', 100n, 0n, 0n);
    g.funding.recordRefusal('w1', UNSTATED);
    await g.settle();
    g.advance(BASE);
    g.funding.mayClaim('w1');
    await g.settle();
    expect(g.funding.mayClaim('w1')).toBe(false);

    // Registered for a funded account: neither balance changed.
    g.fund('w1', 100n, 0n, 500n);
    g.advance(2 * BASE);
    g.funding.mayClaim('w1');
    await g.settle();
    expect(g.funding.mayClaim('w1')).toBe(true);
  });

  it('lets a wallet refused with no stated cost back when a balance read at the refusal is unreadable now', async () => {
    const g = gate();
    g.fund('w1', 100n, 0n);
    g.funding.recordRefusal('w1', UNSTATED);
    await g.settle();
    g.advance(BASE);
    g.funding.mayClaim('w1');
    await g.settle();
    expect(g.funding.mayClaim('w1')).toBe(false);

    // The gas read now fails: the top-up cannot be ruled out, so the cooldown-paced attempt goes ahead.
    g.fund('w1', null, 0n);
    g.advance(2 * BASE);
    g.funding.mayClaim('w1');
    await g.settle();
    expect(g.funding.mayClaim('w1')).toBe(true);
  });

  it('holds every wallet to a stated cost for an hour, from a reading taken since its last job', async () => {
    const g = gate();
    g.fund('w1', 1907n);
    g.fund('w2', 5_000n);
    g.fund('w3', 100n);
    g.funding.recordRefusal('w1', STATED);
    await g.settle();

    expect(g.funding.mayClaim('w2')).toBe(false);
    await g.settle();
    expect(g.funding.mayClaim('w2')).toBe(true);
    expect(g.funding.mayClaim('w2')).toBe(true);
    expect(g.reads.filter((walletId) => walletId === 'w2')).toHaveLength(1);
    // Its job spent funds: the reading before it no longer counts.
    g.advance(1);
    g.funding.recordSpend('w2');
    g.advance(1);
    expect(g.funding.mayClaim('w2')).toBe(false);
    await g.settle();
    expect(g.funding.mayClaim('w2')).toBe(true);
    // An old reading does not count either.
    g.advance(READING_TTL + 1);
    expect(g.funding.mayClaim('w2')).toBe(false);
    await g.settle();
    expect(g.funding.mayClaim('w2')).toBe(true);

    // A wallet below the cost is kept out like a refused one, until it covers it.
    expect(g.funding.mayClaim('w3')).toBe(false);
    await g.settle();
    expect(g.funding.mayClaim('w3')).toBe(false);
    g.fund('w3', 2_047n);
    g.advance(BASE);
    expect(g.funding.mayClaim('w3')).toBe(false);
    await g.settle();
    expect(g.funding.mayClaim('w3')).toBe(true);

    // After the hour the cost is no longer applied.
    g.advance(EVIDENCE_TTL);
    const reads = g.reads.length;
    expect(g.funding.mayClaim('w4')).toBe(true);
    expect(g.reads).toHaveLength(reads);
  });

  it('gives a refused wallet that was never topped up one more attempt after an hour', async () => {
    const g = gate();
    g.fund('w1', 1n);
    g.funding.recordRefusal('w1', STATED);
    await g.settle();
    g.advance(EVIDENCE_TTL - 1);
    g.funding.mayClaim('w1');
    await g.settle();
    expect(g.funding.mayClaim('w1')).toBe(false);
    g.advance(MAX);
    expect(g.funding.mayClaim('w1')).toBe(true);
    // A second refusal starts over at the first cooldown step.
    g.funding.recordRefusal('w1', STATED);
    g.advance(BASE);
    g.funding.mayClaim('w1');
    await g.settle();
    expect(g.funding.mayClaim('w1')).toBe(false);
  });

  it('never keeps a wallet out on an unreadable balance alone', async () => {
    const g = gate();
    g.funding.recordRefusal('w1', STATED);
    await g.settle();
    g.advance(BASE);
    expect(g.funding.mayClaim('w1')).toBe(false);
    await g.settle();
    expect(g.funding.mayClaim('w1')).toBe(true);
    expect(g.funding.mayClaim('w2')).toBe(false);
    await g.settle();
    expect(g.funding.mayClaim('w2')).toBe(true);
  });

  it('counts a reader that throws or does not answer as unreadable, and reads once at a time', async () => {
    vi.useFakeTimers();
    let hang = true;
    const reads: string[] = [];
    const g = gate({
      reader: async (walletId) => {
        reads.push(walletId);
        if (hang) return await new Promise<never>(() => {});
        throw new Error('rpc down');
      },
    });
    g.funding.recordRefusal('w1', STATED);
    expect(g.funding.mayClaim('w2')).toBe(false);
    expect(g.funding.mayClaim('w2')).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toEqual(['w1', 'w2']);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT);
    expect(g.pokes.sort()).toEqual(['w1', 'w2']);
    expect(g.funding.mayClaim('w2')).toBe(true);

    hang = false;
    g.advance(BASE);
    expect(g.funding.mayClaim('w1')).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(g.funding.mayClaim('w1')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts a malformed reading as unreadable instead of throwing in the claim', async () => {
    const g = gate({ reader: async () => ({ native: '5000', trac: -1n }) as unknown as AsyncLiftWalletBalances });
    g.funding.recordRefusal('w1', STATED);
    expect(g.funding.mayClaim('w2')).toBe(false);
    await g.settle();
    expect(g.funding.mayClaim('w2')).toBe(true);
    const undefinedReading = gate({ reader: async () => undefined as unknown as AsyncLiftWalletBalances });
    undefinedReading.funding.recordRefusal('w1', STATED);
    expect(undefinedReading.funding.mayClaim('w2')).toBe(false);
    await undefinedReading.settle();
    expect(undefinedReading.funding.mayClaim('w2')).toBe(true);
  });

  it('without a reader, keeps a refused wallet out for its cooldown only', () => {
    const g = gate({ reader: null });
    g.funding.recordRefusal('w1', STATED);
    expect(g.funding.mayClaim('w1')).toBe(false);
    expect(g.funding.mayClaim('w2')).toBe(true);
    g.advance(BASE);
    expect(g.funding.mayClaim('w1')).toBe(true);
    expect(g.pokes).toEqual([]);
  });

  it('isolates a throwing poke from the reading', async () => {
    const funding = new AsyncLiftWalletFunding({
      now: () => 0,
      readBalances: async () => ({ native: 1n, trac: null }),
      onReading: () => { throw new Error('scheduler gone'); },
    });
    funding.recordRefusal('w1', STATED);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(funding.mayClaim('w1')).toBe(false);
  });
});

describe('refusedTransactionCostWei', () => {
  it('reads the cost a node states for a refused transaction', () => {
    expect(refusedTransactionCostWei(STATED)).toBe(2047n);
    expect(refusedTransactionCostWei(new Error(
      'insufficient funds for intrinsic transaction cost (info={ "error": { "message": "insufficient funds for gas * price + value: balance 0, tx cost 21000000000000, overshot 21000000000000" } }, code=INSUFFICIENT_FUNDS)',
    ))).toBe(21_000_000_000_000n);
    expect(refusedTransactionCostWei('insufficient funds: have 1 want 2')).toBe(2n);
  });

  it('follows the cause chain of a wrapped error', () => {
    expect(refusedTransactionCostWei(new Error('No funded publisher wallet', { cause: STATED }))).toBe(2047n);
  });

  it('answers undefined when no cost is stated, the cost is zero or the error cannot be read', () => {
    expect(refusedTransactionCostWei(UNSTATED)).toBeUndefined();
    expect(refusedTransactionCostWei(new Error('have 1 want 0'))).toBeUndefined();
    expect(refusedTransactionCostWei(undefined)).toBeUndefined();
    const hostile = {} as { message: string; cause: unknown };
    Object.defineProperty(hostile, 'message', { get: () => { throw new Error('no'); } });
    Object.defineProperty(hostile, 'cause', { get: () => { throw new Error('no'); } });
    expect(refusedTransactionCostWei(hostile)).toBeUndefined();
  });
});
