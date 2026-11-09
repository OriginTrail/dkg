/**
 * The Overview's "Your publishing discount": which of this node's publishing wallets a
 * PCA covers, and the one summary derived from that. Pure (no React), so the precedence
 * is stated once and tested directly; presentation (text, tone) maps from the state.
 */
import type { ResolvedPcaAccount } from '../hooks/usePcaOverview.js';
import { isPcaSpendable } from './coverage.js';
import { isPcaExpired } from './pca-primitives.js';
import { eqAddress } from '../web3/address.js';
import { formatBps } from '../lib/format.js';

type CoverageAccount = Pick<ResolvedPcaAccount, 'accountId' | 'snapshot' | 'walletProbes'>;

/** One publishing wallet, in precedence order: covered, then inactive, then unknown. */
export type WalletCoverage =
  | { kind: 'covered'; wallet: string; accountId: string }
  /** Approved on a PCA that can't pay right now (expired, or no TRAC left this epoch). */
  | { kind: 'inactive'; wallet: string; accountId: string; expired: boolean }
  /** A probe couldn't be read, so coverage can't be stated either way (#9). */
  | { kind: 'unknown'; wallet: string }
  | { kind: 'uncovered'; wallet: string };

export function walletCoverage(
  wallets: readonly string[],
  accounts: readonly CoverageAccount[],
  walletsInconclusive: boolean,
  nowSec?: number,
): WalletCoverage[] {
  return wallets.map((wallet) => {
    const approvedOn = (spendable: boolean) => accounts.find((account) =>
      account.snapshot
      && isPcaSpendable(account.snapshot, nowSec) === spendable
      && account.walletProbes.some((probe) => eqAddress(probe.wallet, wallet) && probe.registered === true),
    );
    const covering = approvedOn(true);
    if (covering) return { kind: 'covered', wallet, accountId: covering.accountId };
    const inactive = approvedOn(false);
    if (inactive) {
      return { kind: 'inactive', wallet, accountId: inactive.accountId, expired: !!inactive.snapshot && isPcaExpired(inactive.snapshot, nowSec) };
    }
    const unknown = walletsInconclusive || accounts.some((account) =>
      account.walletProbes.some((probe) => eqAddress(probe.wallet, wallet) && probe.registered == null),
    );
    return unknown ? { kind: 'unknown', wallet } : { kind: 'uncovered', wallet };
  });
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
  coverage: readonly WalletCoverage[],
  ctx: {
    walletsInconclusive: boolean;
    lookupError: boolean;
    accountCount: number;
    bestCoveringDiscountBps: number | null;
  },
): CoverageSummary {
  const walletTotal = coverage.length;
  const coveredCount = coverage.filter((c) => c.kind === 'covered').length;
  const hasCoveredWallet = coveredCount > 0;
  const anyUnknown = coverage.some((c) => c.kind === 'unknown');
  const inactive = coverage.find((c): c is Extract<WalletCoverage, { kind: 'inactive' }> => c.kind === 'inactive');
  const inactiveLabel = inactive
    ? `PCA #${inactive.accountId}, ${inactive.expired ? 'which has expired' : 'which has no TRAC left this epoch'}`
    : null;
  // #9 - never say "None" while the wallets or the PCA lookup can't be read.
  const unconfirmed = !hasCoveredWallet && (ctx.walletsInconclusive || ctx.lookupError);

  const value = hasCoveredWallet
    ? ctx.bestCoveringDiscountBps != null ? formatBps(ctx.bestCoveringDiscountBps) : '—'
    : unconfirmed ? 'Unknown' : inactive ? 'None' : 'None yet';
  const sub = hasCoveredWallet
    ? coveredCount === walletTotal
      ? `All ${walletTotal} publishing wallets covered`
      : `${coveredCount} of ${walletTotal} publishing wallets covered`
    : ctx.walletsInconclusive
      ? "Couldn't read this node's wallets, so we can't confirm your discount."
      : ctx.lookupError
        ? "Couldn't check this node's PCAs. You may still have a discount."
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
