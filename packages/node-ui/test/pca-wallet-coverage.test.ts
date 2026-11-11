import { describe, expect, it } from 'vitest';
import { walletCoverageRow, nodeCoverage, summarizeCoverage, type CoverageAccount } from '../src/ui/pca/walletCoverage.js';
import { classifyCoverage } from '../src/ui/pca/coverage.js';
import { makePcaSnapshot } from '../src/ui/mocks/pca.js';
import type { PcaSnapshot } from '../src/ui/api.js';

const W0 = '0x9A3f000000000000000000000000000000000E41D';
const W1 = '0xB7c2000000000000000000000000000000000A12';
const NOW = 2_000_000_000;
/**
 * A PCA with one probe per wallet, each classified by the real `classifyCoverage`
 * (as usePcaOverview does): `true`/`false` is the probe's registration, `null` a probe
 * that failed to read.
 */
const account = (id: string, probes: Array<[string, boolean | null]>, snap: Partial<PcaSnapshot> = {}): CoverageAccount => {
  const snapshot = makePcaSnapshot({ accountId: id, discountBps: 3000, expiresAtTimestamp: NOW + 86400 * 90, ...snap });
  return {
    accountId: id,
    snapshot,
    walletProbes: probes.map(([wallet, registered]) => ({
      wallet,
      coverage: registered === null
        ? { outcome: 'inconclusive', registered: null, adapterUnsupported: false }
        : classifyCoverage({ ...snapshot, probedKey: { key: wallet, registered, adapterSupported: true } }, NOW),
    })),
  };
};
const ctx = { walletsInconclusive: false, lookupError: false, accountCount: 1 };
/** An extended read whose budget fields came back: topUp empty, this billing period's allowance as given. */
const budget = (remainingAllowance: string | undefined): Partial<PcaSnapshot> =>
  ({ extendedRequested: true, topUpBuffer: '0', remainingAllowance });

describe('nodeCoverage', () => {
  it('derives each wallet and the best discount from the same classified probes', () => {
    const node = nodeCoverage([W0, W1], [
      account('7', [[W0, true]], { discountBps: 3000 }),
      account('8', [[W1, true]], { discountBps: 5000 }),
      account('9', [[W1, true]], { discountBps: 7500, expiresAtTimestamp: NOW - 10 }), // uncovered: expired
    ], false);
    expect(node.covered).toBe(true);
    expect(node.bestCoveringDiscountBps).toBe(5000);
    expect(node.wallets).toEqual([
      { kind: 'covered', wallet: W0, accountId: '7' },
      { kind: 'covered', wallet: W1, accountId: '8' },
    ]);
  });

  it('an unreadable probe outranks an inactive approval, because it might still cover (#9)', () => {
    const live = account('7', [[W1, null]]);
    const dead = account('9', [[W1, true]], { expiresAtTimestamp: NOW - 10 });
    expect(nodeCoverage([W1], [live, dead], false).wallets).toEqual([{ kind: 'unknown', wallet: W1 }]);
  });

  it('has no discount when nothing covers this node', () => {
    expect(nodeCoverage([W0], [account('7', [[W0, false]])], false)).toMatchObject({ covered: false, bestCoveringDiscountBps: null });
  });
});

describe('summarizeCoverage', () => {
  it('counts covered wallets from the state, not from a row tone', () => {
    const node = nodeCoverage([W0, W1], [account('7', [[W0, true], [W1, false]])], false);
    expect(summarizeCoverage(node, ctx)).toMatchObject({ coveredCount: 1, value: '30%', sub: '1 of 2 publishing wallets covered', showWalletRows: true });
    expect(walletCoverageRow(node.wallets[1]!)).toEqual({ status: 'Not covered: pays the full fee', tone: 'neutral' });
  });

  it('says Unknown, never None, while the wallets can’t be read', () => {
    const node = nodeCoverage([W0], [account('7', [[W0, false]])], true);
    expect(node.wallets[0]!.kind).toBe('unknown');
    expect(summarizeCoverage(node, { ...ctx, walletsInconclusive: true })).toMatchObject({ value: 'Unknown', anyUnknown: true });
  });

  it('says Unknown when one wallet’s approval check fails, with the wallet list and lookup fine', () => {
    const node = nodeCoverage([W0], [account('7', [[W0, null]])], false);
    expect(summarizeCoverage(node, ctx)).toMatchObject({
      anyUnknown: true,
      value: 'Unknown',
      sub: "Couldn't check whether a PCA covers this node's wallets. You may still have a discount.",
    });
  });

  it('says Unknown, not "no TRAC left", when an approving PCA’s budget couldn’t be read', () => {
    // The extended read omitted remainingAllowance: classifyCoverage calls a registered wallet inconclusive.
    const node = nodeCoverage([W0], [account('7', [[W0, true]], budget(undefined))], false);
    expect(node.wallets[0]!.kind).toBe('unknown');
    const s = summarizeCoverage(node, ctx);
    expect(s).toMatchObject({ value: 'Unknown', anyUnknown: true }); // anyUnknown shows Retry on the Overview
    expect(s.sub).not.toContain('no TRAC left');
  });

  it('says "no TRAC left in this billing period" only when a live PCA’s budget is confirmed empty', () => {
    const node = nodeCoverage([W0], [account('7', [[W0, true]], budget('0'))], false);
    expect(node.wallets[0]).toEqual({ kind: 'inactive', wallet: W0, accountId: '7', expired: false });
    expect(summarizeCoverage(node, ctx)).toMatchObject({
      value: 'None',
      sub: 'Your wallets are on PCA #7, which has no TRAC left in this billing period. They pay the full fee.',
    });
  });

  it('a swept PCA reads as expired, even with a future expiry time', () => {
    const node = nodeCoverage([W0], [account('7', [[W0, true]], { fullySwept: true })], false);
    expect(node.wallets[0]).toEqual({ kind: 'inactive', wallet: W0, accountId: '7', expired: true });
    expect(summarizeCoverage(node, ctx).sub).toBe('Your wallets are on PCA #7, which has expired. They pay the full fee.');
  });

  it('still says None yet when every wallet is confirmed not covered', () => {
    const node = nodeCoverage([W0], [account('7', [[W0, false]])], false);
    expect(summarizeCoverage(node, ctx)).toMatchObject({ value: 'None yet', sub: "This node's publishing wallets pay the full TRAC fee." });
  });

  it('names the inactive PCA and why, and offers no discount', () => {
    const node = nodeCoverage([W0], [account('9', [[W0, true]], { expiresAtTimestamp: NOW - 10 })], false);
    expect(summarizeCoverage(node, ctx)).toMatchObject({
      hasCoveredWallet: false,
      value: 'None',
      sub: 'Your wallets are on PCA #9, which has expired. They pay the full fee.',
    });
  });
});
