import { describe, expect, it } from 'vitest';
import { walletCoverage, walletCoverageRow, nodeCoverage, summarizeCoverage } from '../src/ui/pca/walletCoverage.js';
import { makePcaSnapshot } from '../src/ui/mocks/pca.js';

const W0 = '0x9A3f000000000000000000000000000000000E41D';
const W1 = '0xB7c2000000000000000000000000000000000A12';
const NOW = 2_000_000_000;
const account = (id: string, probes: Array<[string, boolean | null]>, snap: Record<string, unknown> = {}) => ({
  accountId: id,
  snapshot: makePcaSnapshot({ accountId: id, discountBps: 3000, expiresAtTimestamp: NOW + 86400 * 90, ...snap }),
  walletProbes: probes.map(([wallet, registered]) => ({ wallet, registered })),
}) as never;
const ctx = { walletsInconclusive: false, lookupError: false, accountCount: 1 };

describe('walletCoverage', () => {
  it('orders covered before inactive before unknown', () => {
    const live = account('7', [[W0, true], [W1, null]]);
    const dead = account('9', [[W1, true]], { expiresAtTimestamp: NOW - 10 });
    expect(walletCoverage([W0, W1], [live, dead], false, NOW)).toEqual([
      { kind: 'covered', wallet: W0, accountId: '7' },
      { kind: 'inactive', wallet: W1, accountId: '9', expired: true },
    ]);
  });
});

describe('nodeCoverage', () => {
  it('derives coverage and the best discount from the same accounts', () => {
    const node = nodeCoverage([W0, W1], [
      account('7', [[W0, true]], { discountBps: 3000 }),
      account('8', [[W1, true]], { discountBps: 5000 }),
      account('9', [[W1, true]], { discountBps: 7500, expiresAtTimestamp: NOW - 10 }), // not spendable
    ], false, NOW);
    expect(node.covered).toBe(true);
    expect(node.bestCoveringDiscountBps).toBe(5000);
    expect(node.wallets.map((c) => c.kind)).toEqual(['covered', 'covered']);
  });

  it('has no discount when nothing covers this node', () => {
    const node = nodeCoverage([W0], [account('7', [[W0, false]])], false, NOW);
    expect(node).toMatchObject({ covered: false, bestCoveringDiscountBps: null });
  });
});

describe('summarizeCoverage', () => {
  it('counts covered wallets from the state, not from a row tone', () => {
    const node = nodeCoverage([W0, W1], [account('7', [[W0, true], [W1, false]])], false, NOW);
    expect(summarizeCoverage(node, ctx)).toMatchObject({ coveredCount: 1, value: '30%', sub: '1 of 2 publishing wallets covered', showWalletRows: true });
    expect(walletCoverageRow(node.wallets[1]!)).toEqual({ status: 'Not covered: pays the full fee', tone: 'neutral' });
  });

  it('says Unknown, never None, while the wallets can’t be read', () => {
    const node = nodeCoverage([W0], [account('7', [[W0, false]])], true, NOW);
    expect(node.wallets[0]!.kind).toBe('unknown');
    expect(summarizeCoverage(node, { ...ctx, walletsInconclusive: true })).toMatchObject({ value: 'Unknown', anyUnknown: true });
  });

  it('says Unknown when one wallet’s approval check fails, with the wallet list and lookup fine', () => {
    const node = nodeCoverage([W0], [account('7', [[W0, null]])], false, NOW);
    expect(summarizeCoverage(node, ctx)).toMatchObject({
      anyUnknown: true,
      value: 'Unknown',
      sub: "Couldn't check whether a PCA covers this node's wallets. You may still have a discount.",
    });
  });

  it('still says None yet when every wallet is confirmed not covered', () => {
    const node = nodeCoverage([W0], [account('7', [[W0, false]])], false, NOW);
    expect(summarizeCoverage(node, ctx)).toMatchObject({ value: 'None yet', sub: "This node's publishing wallets pay the full TRAC fee." });
  });

  it('names the inactive PCA and why, and offers no discount', () => {
    const node = nodeCoverage([W0], [account('9', [[W0, true]], { expiresAtTimestamp: NOW - 10 })], false, NOW);
    expect(summarizeCoverage(node, ctx)).toMatchObject({
      hasCoveredWallet: false,
      value: 'None',
      sub: 'Your wallets are on PCA #9, which has expired. They pay the full fee.',
    });
  });
});
