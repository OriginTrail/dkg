import { describe, expect, it } from 'vitest';
import { walletCoverage, walletCoverageRow, summarizeCoverage } from '../src/ui/pca/walletCoverage.js';
import { makePcaSnapshot } from '../src/ui/mocks/pca.js';

const W0 = '0x9A3f000000000000000000000000000000000E41D';
const W1 = '0xB7c2000000000000000000000000000000000A12';
const NOW = 2_000_000_000;
const account = (id: string, probes: Array<[string, boolean | null]>, snap: Record<string, unknown> = {}) => ({
  accountId: id,
  snapshot: makePcaSnapshot({ accountId: id, expiresAtTimestamp: NOW + 86400 * 90, ...snap }),
  walletProbes: probes.map(([wallet, registered]) => ({ wallet, registered })),
}) as never;
const ctx = { walletsInconclusive: false, lookupError: false, accountCount: 1, bestCoveringDiscountBps: 3000 };

describe('walletCoverage', () => {
  it('orders covered before inactive before unknown', () => {
    const live = account('7', [[W0, true], [W1, null]]);
    const dead = account('9', [[W1, true]], { expiresAtTimestamp: NOW - 10 });
    expect(walletCoverage([W0, W1], [live, dead], false, NOW)).toEqual([
      { kind: 'covered', wallet: W0, accountId: '7' },
      { kind: 'inactive', wallet: W1, accountId: '9', expired: true },
    ]);
  });

  it('counts covered wallets from the state, not from a row tone', () => {
    const c = walletCoverage([W0, W1], [account('7', [[W0, true], [W1, false]])], false, NOW);
    expect(summarizeCoverage(c, ctx)).toMatchObject({ coveredCount: 1, value: '30%', sub: '1 of 2 publishing wallets covered', showWalletRows: true });
    expect(walletCoverageRow(c[1]!)).toEqual({ status: 'Not covered: pays the full fee', tone: 'neutral' });
  });

  it('says Unknown, never None, while the wallets can’t be read', () => {
    const c = walletCoverage([W0], [account('7', [[W0, false]])], true, NOW);
    expect(c[0]!.kind).toBe('unknown');
    expect(summarizeCoverage(c, { ...ctx, walletsInconclusive: true })).toMatchObject({ value: 'Unknown', anyUnknown: true });
  });

  it('names the inactive PCA and why, and offers no discount', () => {
    const c = walletCoverage([W0], [account('9', [[W0, true]], { expiresAtTimestamp: NOW - 10 })], false, NOW);
    expect(summarizeCoverage(c, ctx)).toMatchObject({
      hasCoveredWallet: false,
      value: 'None',
      sub: 'Your wallets are on PCA #9, which has expired. They pay the full fee.',
    });
  });
});
