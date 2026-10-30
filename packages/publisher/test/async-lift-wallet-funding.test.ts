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

  it.each([
    ['TRAC', { trac: null, pca: 0n }, { trac: 500n, pca: 0n }],
    ['coverage', { trac: 0n, pca: null }, { trac: 0n, pca: 500n }],
  ] as const)('lets a wallet refused with no stated cost back when %s, unreadable at the refusal, reads now', async (_name, atRefusal, later) => {
    const g = gate();
    g.fund('w1', 100n, atRefusal.trac, atRefusal.pca);
    g.funding.recordRefusal('w1', UNSTATED);
    await g.settle();
    // Still unreadable and nothing else moved: it stays out.
    g.advance(BASE);
    g.funding.mayClaim('w1');
    await g.settle();
    expect(g.funding.mayClaim('w1')).toBe(false);

    // There is nothing to compare it with, and it may be the top-up: the cooldown-paced attempt goes ahead.
    g.fund('w1', 100n, later.trac, later.pca);
    g.advance(2 * BASE);
    g.funding.mayClaim('w1');
    await g.settle();
    expect(g.funding.mayClaim('w1')).toBe(true);
  });

  it('keeps only the refused wallet out: a stated cost never applies to another wallet', async () => {
    const g = gate();
    // An expensive publication is refused on w1, stating 2047.
    g.fund('w1', 1907n);
    g.funding.recordRefusal('w1', STATED);
    await g.settle();
    // w2 holds less than that cost, yet may pay for a cheaper job: it claims, and nothing reads it.
    g.fund('w2', 500n);
    expect(g.funding.mayClaim('w2')).toBe(true);
    expect(g.funding.mayClaim('w3')).toBe(true);
    await g.settle();
    expect(g.reads).toEqual(['w1']);
    expect(g.funding.mayClaim('w1')).toBe(false);
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
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toEqual(['w1']);
    // The refusal's reading is still pending when the cooldown ends: no second reading starts.
    g.advance(BASE);
    expect(g.funding.mayClaim('w1')).toBe(false);
    expect(g.funding.mayClaim('w1')).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toEqual(['w1']);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT);
    expect(g.pokes).toEqual(['w1']);

    hang = false;
    expect(g.funding.mayClaim('w1')).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toEqual(['w1', 'w1']);
    expect(g.pokes).toEqual(['w1', 'w1']);
    // A thrown read is unreadable, and an unreadable balance does not keep the wallet out.
    expect(g.funding.mayClaim('w1')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts a malformed reading as unreadable instead of throwing in the claim', async () => {
    for (const answer of [{ native: '5000', trac: -1n }, undefined]) {
      const g = gate({ reader: async () => answer as unknown as AsyncLiftWalletBalances });
      g.funding.recordRefusal('w1', STATED);
      await g.settle();
      g.advance(BASE);
      expect(g.funding.mayClaim('w1')).toBe(false);
      await g.settle();
      expect(g.funding.mayClaim('w1')).toBe(true);
    }
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
