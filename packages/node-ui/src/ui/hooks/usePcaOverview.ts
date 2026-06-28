import { useMemo } from 'react';
import { useFetch } from '../hooks.js';
import {
  fetchPca,
  fetchWalletsBalances,
  HttpError,
  type PcaSnapshot,
} from '../api.js';
import { usePcaStore } from '../stores/pca.js';
import { healthForSnapshot, type PcaHealthState } from '../components/Pca/HealthChip.js';

/** Per-(node wallet) registration probe against one account. `null` = couldn't determine. */
export interface PcaWalletProbe {
  wallet: string;
  registered: boolean | null;
}

export type PcaClassification = 'owned' | 'approved' | 'unknown';

export interface ResolvedPcaAccount {
  accountId: string;
  snapshot: PcaSnapshot | null;
  error: unknown;
  /** The daemon returned 404 — the tracked id no longer exists (offer Remove). */
  notFound: boolean;
  /** Owned (node owns the NFT) vs approved (a node wallet is registered) vs unknown. */
  classification: PcaClassification;
  /**
   * §8A: owner-gated actions are only enabled when the owner is the node's
   * PRIMARY operational wallet (`wallets[0]`) — the only key the daemon signs
   * owner writes with. False on a pool-/external-owned PCA (still renders;
   * actions explain why they're disabled).
   */
  ownerIsPrimaryWallet: boolean;
  health: PcaHealthState | null;
  /** One probe per node operational wallet. */
  walletProbes: PcaWalletProbe[];
  /** How many of the node's wallets are approved publishing wallets here. */
  approvedCount: number;
  /** Total node operational wallets probed. */
  walletCount: number;
}

export interface PcaOverview {
  accounts: ResolvedPcaAccount[];
  wallets: string[];
  walletsError: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /**
   * Best discount (bps) among accounts that currently COVER this node — i.e. at
   * least one node wallet is approved (owner≠coverage, #11) AND the account is
   * spendable (not expired/swept). null when nothing covers the node. This is a
   * PREDICTION (no B8 confirmation), so callers label it "pending confirmation".
   */
  bestCoveringDiscountBps: number | null;
  /** Whether any tracked account currently covers this node's publishes. */
  covered: boolean;
}

const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

async function resolveAccount(accountId: string, wallets: string[]): Promise<ResolvedPcaAccount> {
  const blank: ResolvedPcaAccount = {
    accountId,
    snapshot: null,
    error: null,
    notFound: false,
    classification: 'unknown',
    ownerIsPrimaryWallet: false,
    health: null,
    walletProbes: [],
    approvedCount: 0,
    walletCount: wallets.length,
  };
  let snapshot: PcaSnapshot;
  try {
    snapshot = await fetchPca(accountId);
  } catch (err) {
    return {
      ...blank,
      error: err,
      notFound: err instanceof HttpError && err.status === 404,
    };
  }

  // Probe each node wallet for registration on this account (the round-robin
  // footgun made visible). A failed probe → null (don't claim "not approved").
  const walletProbes: PcaWalletProbe[] = await Promise.all(
    wallets.map((wallet) =>
      fetchPca(accountId, wallet)
        .then((s): PcaWalletProbe => ({ wallet, registered: s.probedKey?.registered ?? null }))
        .catch((): PcaWalletProbe => ({ wallet, registered: null })),
    ),
  );
  const approvedCount = walletProbes.filter((p) => p.registered === true).length;
  const owned = wallets.some((w) => eq(w, snapshot.owner));
  const classification: PcaClassification = owned
    ? 'owned'
    : approvedCount > 0
      ? 'approved'
      : 'unknown';

  return {
    accountId,
    snapshot,
    error: null,
    notFound: false,
    classification,
    ownerIsPrimaryWallet: eq(wallets[0], snapshot.owner),
    health: healthForSnapshot(snapshot),
    walletProbes,
    approvedCount,
    walletCount: wallets.length,
  };
}

/**
 * The S1 overview resolution engine — the single source of truth for the
 * Conviction tab AND the Dashboard "Publishing discount" row / Settings card
 * (so the derived discount can't drift across surfaces). Resolves the locally
 * tracked id set: snapshot + per-wallet registration probes + owned/approved
 * classification + health + a node-level coverage summary. Wallets and accounts
 * are fetched together so the cards never flash an "unknown" classification
 * while wallets are still loading.
 */
export function usePcaOverview(intervalMs = 30_000): PcaOverview {
  const trackedIds = usePcaStore((s) => s.trackedIds);
  const idsKey = trackedIds.join(',');

  const { data, loading, error, refresh } = useFetch(
    async () => {
      // Nothing tracked → nothing to resolve. Skip the wallets fetch entirely so
      // the always-mounted Dashboard row / Settings card cost nothing on a fresh
      // node (and don't duplicate the Dashboard's own wallet poll).
      if (trackedIds.length === 0) return { wallets: [], walletsError: false, accounts: [] };
      const wb = await fetchWalletsBalances().catch(() => null);
      const wallets = wb?.wallets ?? [];
      const walletsError = !wb || !!wb.error;
      const settled = await Promise.all(trackedIds.map((id) => resolveAccount(id, wallets)));
      return { wallets, walletsError, accounts: settled };
    },
    [idsKey],
    intervalMs,
  );

  const accounts = useMemo(() => data?.accounts ?? [], [data]);
  const { bestCoveringDiscountBps, covered } = useMemo(() => {
    let best: number | null = null;
    for (const a of accounts) {
      if (!a.snapshot || a.approvedCount <= 0) continue;
      if (a.health === 'expired' || a.health === 'swept') continue;
      const bps = a.snapshot.discountBps;
      if (typeof bps === 'number' && (best == null || bps > best)) best = bps;
    }
    return { bestCoveringDiscountBps: best, covered: best != null };
  }, [accounts]);

  return {
    accounts,
    wallets: data?.wallets ?? [],
    walletsError: data?.walletsError ?? false,
    loading,
    error,
    refresh,
    bestCoveringDiscountBps,
    covered,
  };
}
