import { describe, expect, it } from 'vitest';
import { walletCoverageRow, nodeCoverage, summarizeCoverage, withLookupOutcome, type CoverageAccount } from '../src/ui/pca/walletCoverage.js';
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
const READ = { walletsUnreadable: false };
const UNREADABLE = { walletsUnreadable: true };
/** An extended read whose budget fields came back: topUp empty, this billing period's allowance as given. */
const budget = (remainingAllowance: string | undefined): Partial<PcaSnapshot> =>
  ({ extendedRequested: true, topUpBuffer: '0', remainingAllowance });

describe('nodeCoverage', () => {
  it('derives each wallet and the best discount from the same classified probes', () => {
    const node = nodeCoverage([W0, W1], [
      account('7', [[W0, true]], { discountBps: 3000 }),
      account('8', [[W1, true]], { discountBps: 5000 }),
      account('9', [[W1, true]], { discountBps: 7500, expiresAtTimestamp: NOW - 10 }), // uncovered: expired
    ], READ);
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
    expect(nodeCoverage([W1], [live, dead], READ).wallets).toEqual([{ kind: 'unknown', wallet: W1 }]);
  });

  it('has no discount when nothing covers this node', () => {
    expect(nodeCoverage([W0], [account('7', [[W0, false]])], READ)).toMatchObject({ covered: false, bestCoveringDiscountBps: null });
  });
});

describe('summarizeCoverage', () => {
  it('counts covered wallets from the state, not from a row tone', () => {
    const node = nodeCoverage([W0, W1], [account('7', [[W0, true], [W1, false]])], READ);
    expect(summarizeCoverage(node)).toMatchObject({ coveredCount: 1, value: '30%', sub: '1 of 2 publishing wallets covered', showWalletRows: true });
    expect(walletCoverageRow(node.wallets[1]!)).toEqual({ status: 'Not covered: pays the full fee', tone: 'neutral' });
  });

  it('says Unknown, never None, while the wallets can’t be read', () => {
    const node = nodeCoverage([W0], [account('7', [[W0, false]])], UNREADABLE);
    expect(node.wallets[0]!.kind).toBe('unknown');
    expect(summarizeCoverage(node)).toMatchObject({ value: 'Unknown', anyUnknown: true });
  });

  it('says Unknown when one wallet’s approval check fails, with the wallet list and lookup fine', () => {
    const node = nodeCoverage([W0], [account('7', [[W0, null]])], READ);
    expect(summarizeCoverage(node)).toMatchObject({
      anyUnknown: true,
      value: 'Unknown',
      sub: "Couldn't check whether a PCA covers this node's wallets. You may still have a discount.",
    });
  });

  it('says Unknown, not "no TRAC left", when an approving PCA’s budget couldn’t be read', () => {
    // The extended read omitted remainingAllowance: classifyCoverage calls a registered wallet inconclusive.
    const node = nodeCoverage([W0], [account('7', [[W0, true]], budget(undefined))], READ);
    expect(node.wallets[0]!.kind).toBe('unknown');
    const s = summarizeCoverage(node);
    expect(s).toMatchObject({ value: 'Unknown', anyUnknown: true }); // anyUnknown shows Retry on the Overview
    expect(s.sub).not.toContain('no TRAC left');
  });

  it('says "no TRAC left in this billing period" only when a live PCA’s budget is confirmed empty', () => {
    const node = nodeCoverage([W0], [account('7', [[W0, true]], budget('0'))], READ);
    expect(node.wallets[0]).toEqual({ kind: 'inactive', wallet: W0, accountId: '7', expired: false });
    expect(summarizeCoverage(node)).toMatchObject({
      value: 'None',
      sub: 'Your wallets are on PCA #7, which has no TRAC left in this billing period. They pay the full fee.',
    });
  });

  it('a swept PCA reads as expired, even with a future expiry time', () => {
    const node = nodeCoverage([W0], [account('7', [[W0, true]], { fullySwept: true })], READ);
    expect(node.wallets[0]).toEqual({ kind: 'inactive', wallet: W0, accountId: '7', expired: true });
    expect(summarizeCoverage(node).sub).toBe('Your wallets are on PCA #7, which has expired. They pay the full fee.');
  });

  it('still says None yet when every wallet is confirmed not covered', () => {
    const node = nodeCoverage([W0], [account('7', [[W0, false]])], READ);
    expect(summarizeCoverage(node)).toMatchObject({ value: 'None yet', sub: "This node's publishing wallets pay the full TRAC fee." });
  });

  it('names the inactive PCA and why, and offers no discount', () => {
    const node = nodeCoverage([W0], [account('9', [[W0, true]], { expiresAtTimestamp: NOW - 10 })], READ);
    expect(summarizeCoverage(node)).toMatchObject({
      hasCoveredWallet: false,
      value: 'None',
      sub: 'Your wallets are on PCA #9, which has expired. They pay the full fee.',
    });
  });
});

describe('NodeCoverage status and uncertainty', () => {
  it('tells unreadable wallets apart from a confirmed empty list', () => {
    const unreadable = nodeCoverage([], [], UNREADABLE);
    const empty = nodeCoverage([], [], READ);
    expect(unreadable).toMatchObject({ status: 'uncertain', uncertainty: 'wallets-unreadable', recovery: 'retry-read' });
    expect(empty).toMatchObject({ status: 'not-covered', uncertainty: null, recovery: null });
    expect(summarizeCoverage(unreadable)).toMatchObject({ value: 'Unknown', sub: "Couldn't read this node's wallets, so we can't confirm your discount." });
    expect(summarizeCoverage(empty)).toMatchObject({ value: 'None yet' });
  });

  it('names a confirmed empty wallet list when a PCA is tracked', () => {
    const node = nodeCoverage([], [account('7', [])], READ);
    expect(summarizeCoverage(node).sub).toBe("This node didn't report any publishing wallets.");
  });

  it('a failed PCA lookup is uncertain, and only the lookup’s own Retry is offered', () => {
    const node = withLookupOutcome(nodeCoverage([W0], [account('7', [[W0, null]])], READ), true);
    expect(node).toMatchObject({ status: 'uncertain', uncertainty: 'lookup-failed', recovery: 'retry-lookup' });
    expect(summarizeCoverage(node).sub).toBe("Couldn't check this node's PCAs. You may still have a discount.");
    // Unreadable wallets still come first when both fail.
    expect(withLookupOutcome(nodeCoverage([], [], UNREADABLE), true)).toMatchObject({ uncertainty: 'wallets-unreadable', recovery: 'retry-lookup' });
  });

  it('partial coverage stays covered, but an inconclusive probe still offers Retry', () => {
    const node = nodeCoverage([W0, W1], [account('7', [[W0, true], [W1, null]])], READ);
    expect(node).toMatchObject({ status: 'covered', covered: true, uncertainty: 'probe-inconclusive', recovery: 'retry-read' });
    expect(summarizeCoverage(node)).toMatchObject({ value: '30%', sub: '1 of 2 publishing wallets covered' });
  });

  it('an inconclusive probe with nothing covered is uncertain', () => {
    expect(nodeCoverage([W0], [account('7', [[W0, null]])], READ)).toMatchObject({ status: 'uncertain', uncertainty: 'probe-inconclusive' });
  });
});
