/**
 * The Overview's "Your publishing discount": which of this node's publishing wallets a
 * PCA covers, and the one summary derived from that. Pure (no React), so the precedence
 * is stated once and tested directly; presentation (text, tone) maps from the state.
 */
import type { PcaSnapshot } from '../api.js';
import type { PcaCoverageResult } from './coverage.js';
import { eqAddress } from '../web3/address.js';
import { formatBps } from '../lib/format.js';

/** One wallet probed on one PCA, keeping the canonical `classifyCoverage` result. */
export interface CoverageProbe {
  wallet: string;
  coverage: PcaCoverageResult;
}

/** What the coverage model needs from a PCA. The overview hook's resolved account extends it. */
export interface CoverageAccount {
  accountId: string;
  snapshot: PcaSnapshot | null;
  /** One probe per node publishing wallet. */
  walletProbes: CoverageProbe[];
}

/**
 * One publishing wallet, aggregated from its probes' canonical outcomes across PCAs.
 * Precedence: `covers` anywhere → covered; else any `inconclusive` (a probe or a budget
 * couldn't be read) → unknown, because it might still cover (#9); else `uncovered` →
 * inactive; else uncovered.
 */
export type WalletCoverage =
  | { kind: 'covered'; wallet: string; accountId: string }
  /** Approved on a PCA that definitely can't pay: expired or swept, or this billing period's budget is confirmed empty. */
  | { kind: 'inactive'; wallet: string; accountId: string; expired: boolean }
  /** Coverage can't be stated either way (#9): a probe or a budget couldn't be read. */
  | { kind: 'unknown'; wallet: string }
  | { kind: 'uncovered'; wallet: string };

/** This node's coverage: one state per publishing wallet, plus the best discount among the
 *  PCAs that cover it, both from the same classified probes. The single aggregate the
 *  Overview, Dashboard and Settings all read. */
export interface NodeCoverage {
  wallets: WalletCoverage[];
  /** Best discount among PCAs whose probe `covers` at least one of this node's wallets. */
  bestCoveringDiscountBps: number | null;
  /** At least one publishing wallet is covered right now. */
  covered: boolean;
}

export function nodeCoverage(
  wallets: readonly string[],
  accounts: readonly CoverageAccount[],
  walletsInconclusive: boolean,
): NodeCoverage {
  let best: number | null = null;
  const states = wallets.map((wallet): WalletCoverage => {
    const results = accounts.flatMap((account) => account.walletProbes
      .filter((probe) => eqAddress(probe.wallet, wallet))
      .map((probe) => ({ account, coverage: probe.coverage })));
    for (const { account, coverage } of results) {
      const bps = account.snapshot?.discountBps;
      if (coverage.outcome === 'covers' && typeof bps === 'number' && (best == null || bps > best)) best = bps;
    }
    const covering = results.find((r) => r.coverage.outcome === 'covers');
    if (covering) return { kind: 'covered', wallet, accountId: covering.account.accountId };
    if (walletsInconclusive || results.some((r) => r.coverage.outcome === 'inconclusive')) return { kind: 'unknown', wallet };
    const inactive = results.find((r) => r.coverage.outcome === 'uncovered');
    if (inactive && inactive.coverage.outcome === 'uncovered') {
      return { kind: 'inactive', wallet, accountId: inactive.account.accountId, expired: inactive.coverage.dead };
    }
    return { kind: 'uncovered', wallet };
  });
  return { wallets: states, bestCoveringDiscountBps: best, covered: states.some((c) => c.kind === 'covered') };
}

export type WalletCoverageTone = 'success' | 'warn' | 'neutral';

/** The wallet row's status text and tone. */
export function walletCoverageRow(c: WalletCoverage): { status: string; tone: WalletCoverageTone } {
  switch (c.kind) {
    case 'covered': return { status: `Covered by PCA #${c.accountId}`, tone: 'success' };
    case 'inactive': return { status: `Approved on PCA #${c.accountId}, which isn't active: pays the full fee`, tone: 'warn' };
    case 'unknown': return { status: "Couldn't check", tone: 'warn' };
    case 'uncovered': return { status: 'Not covered: pays the full fee', tone: 'neutral' };
  }
}

export interface CoverageSummary {
  coveredCount: number;
  hasCoveredWallet: boolean;
  anyUnknown: boolean;
  /** The headline: the best covering discount, Unknown, None or None yet. */
  value: string;
  /** The line under it. */
  sub: string;
  /** Show the per-wallet rows: only when at least one wallet is more than "not covered". */
  showWalletRows: boolean;
}

export function summarizeCoverage(
  node: NodeCoverage,
  ctx: {
    walletsInconclusive: boolean;
    lookupError: boolean;
    accountCount: number;
  },
): CoverageSummary {
  const coverage = node.wallets;
  const walletTotal = coverage.length;
  const coveredCount = coverage.filter((c) => c.kind === 'covered').length;
  const hasCoveredWallet = coveredCount > 0;
  const anyUnknown = coverage.some((c) => c.kind === 'unknown');
  const inactive = coverage.find((c): c is Extract<WalletCoverage, { kind: 'inactive' }> => c.kind === 'inactive');
  const inactiveLabel = inactive
    ? `PCA #${inactive.accountId}, ${inactive.expired ? 'which has expired' : 'which has no TRAC left in this billing period'}`
    : null;
  // #9 - never say "None" while the wallets, the PCA lookup or any wallet's approval can't be read.
  const unconfirmed = !hasCoveredWallet && (ctx.walletsInconclusive || ctx.lookupError || anyUnknown);

  const value = hasCoveredWallet
    ? node.bestCoveringDiscountBps != null ? formatBps(node.bestCoveringDiscountBps) : '—'
    : unconfirmed ? 'Unknown' : inactive ? 'None' : 'None yet';
  const sub = hasCoveredWallet
    ? coveredCount === walletTotal
      ? `All ${walletTotal} publishing wallets covered`
      : `${coveredCount} of ${walletTotal} publishing wallets covered`
    : ctx.walletsInconclusive
      ? "Couldn't read this node's wallets, so we can't confirm your discount."
      : ctx.lookupError
        ? "Couldn't check this node's PCAs. You may still have a discount."
        : anyUnknown
          ? "Couldn't check whether a PCA covers this node's wallets. You may still have a discount."
          : inactiveLabel
            ? `Your wallets are on ${inactiveLabel}. They pay the full fee.`
            : walletTotal === 0 && ctx.accountCount > 0
              ? "This node didn't report any publishing wallets."
              : "This node's publishing wallets pay the full TRAC fee.";

  return {
    coveredCount,
    hasCoveredWallet,
    anyUnknown,
    value,
    sub,
    showWalletRows: coverage.some((c) => c.kind !== 'uncovered'),
  };
}
