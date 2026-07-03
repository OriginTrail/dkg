import { useEffect, useMemo, useReducer } from 'react';
import {
  fetchPca,
  fetchWalletsBalances,
  HttpError,
  type PcaSnapshot,
} from '../api.js';
import { usePcaStore } from '../stores/pca.js';
import { healthForSnapshot, type PcaHealthState } from '../pca/health.js';
import { classifyCoverage, isPcaSpendable } from '../pca/coverage.js';

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
   * PRIMARY operational wallet (`wallets[0]`).
   */
  ownerIsPrimaryWallet: boolean;
  health: PcaHealthState | null;
  /** One probe per node operational wallet. */
  walletProbes: PcaWalletProbe[];
  /** How many of the node's wallets are approved publishing wallets here. */
  approvedCount: number;
  /** Total node operational wallets probed. */
  walletCount: number;
  /**
   * H2: at least one wallet probe returned `null` (the probe threw / couldn't be
   * read). When true, `approvedCount` is a LOWER BOUND — callers must NOT assert
   * "0 approved / discounts nothing yet" off it; they caveat ("couldn't verify").
   */
  probesInconclusive: boolean;
}

export interface PcaOverview {
  accounts: ResolvedPcaAccount[];
  wallets: string[];
  walletsError: boolean;
  /**
   * T2/#9 — the wallets balances read FAILED and returned no wallets, so owned/
   * approved/covered are computed from an empty set and can't be trusted. Distinct
   * from a genuine 0-wallet node (walletsError false). Consumers show "couldn't
   * verify — retry" instead of a definitive empty/none/not-covered state.
   */
  walletsInconclusive: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /**
   * Best discount (bps) among accounts that currently COVER this node (≥1 node
   * wallet approved AND the account is spendable — not expired/swept). null when
   * nothing covers the node. A PREDICTION (no B8 confirmation).
   */
  bestCoveringDiscountBps: number | null;
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
    probesInconclusive: false,
  };
  let snapshot: PcaSnapshot;
  try {
    snapshot = await fetchPca(accountId, undefined, { extended: true });
  } catch (err) {
    return { ...blank, error: err, notFound: err instanceof HttpError && err.status === 404 };
  }

  const walletProbes: PcaWalletProbe[] = await Promise.all(
    wallets.map((wallet) =>
      fetchPca(accountId, wallet, { extended: true })
        // S2/#9 (via shared classifyCoverage, #1344 — reads s.probedKey) —
        // adapterSupported===false (the adapter couldn't answer) → registered null
        // (couldn't determine), NOT not-registered → probesInconclusive (H2 path),
        // excluded from approvedCount (which counts registered === true, not 'covers').
        .then((s): PcaWalletProbe => ({ wallet, registered: classifyCoverage(s).registered }))
        .catch((): PcaWalletProbe => ({ wallet, registered: null })),
    ),
  );
  const approvedCount = walletProbes.filter((p) => p.registered === true).length;
  const probesInconclusive = walletProbes.some((p) => p.registered === null);
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
    probesInconclusive,
  };
}

// ── M2: one shared poller per tracked-id set ─────────────────────────────────
// The bell (usePcaAlerts) is always mounted in the Shell, so without sharing it
// would run the N×(1+W) probe loop on its own AND a visible page would run a
// SECOND identical loop. All consumers subscribe to ONE entry keyed by the
// tracked-id set; the loop runs once, pauses while the tab is hidden, and stops
// (cache cleared) when the last subscriber unmounts.
interface OverviewData {
  wallets: string[];
  walletsError: boolean;
  accounts: ResolvedPcaAccount[];
}
interface OverviewEntry {
  ids: string[];
  data: OverviewData | null;
  loading: boolean;
  error: string | null;
  subs: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  intervalMs: number;
  onVisibility: (() => void) | null;
  seq: number;
}
const ENTRIES = new Map<string, OverviewEntry>();

function notify(entry: OverviewEntry) {
  for (const cb of entry.subs) cb();
}

async function loadEntry(entry: OverviewEntry) {
  const seq = ++entry.seq;
  if (entry.ids.length === 0) {
    if (seq !== entry.seq) return;
    entry.data = { wallets: [], walletsError: false, accounts: [] };
    entry.error = null;
    entry.loading = false;
    notify(entry);
    return;
  }
  try {
    const wb = await fetchWalletsBalances().catch(() => null);
    const wallets = wb?.wallets ?? [];
    const walletsError = !wb || !!wb.error;
    const accounts = await Promise.all(entry.ids.map((id) => resolveAccount(id, wallets)));
    if (seq !== entry.seq) return; // a newer load superseded this one
    entry.data = { wallets, walletsError, accounts };
    entry.error = null;
  } catch (err) {
    if (seq !== entry.seq) return;
    entry.error = (err as Error)?.message ?? 'Failed to resolve PCAs.';
  } finally {
    if (seq === entry.seq) {
      entry.loading = false;
      notify(entry);
    }
  }
}

function startTimer(entry: OverviewEntry) {
  if (entry.timer || entry.intervalMs <= 0) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  entry.timer = setInterval(() => loadEntry(entry), entry.intervalMs);
}
function stopTimer(entry: OverviewEntry) {
  if (entry.timer) {
    clearInterval(entry.timer);
    entry.timer = null;
  }
}

function subscribeOverview(key: string, ids: string[], intervalMs: number, cb: () => void): () => void {
  let entry = ENTRIES.get(key);
  const isNew = !entry;
  if (!entry) {
    entry = { ids, data: null, loading: true, error: null, subs: new Set(), timer: null, intervalMs, onVisibility: null, seq: 0 };
    ENTRIES.set(key, entry);
  }
  // Register the subscriber BEFORE the first load so a synchronously-completing
  // load (the empty tracked-ids fast path) doesn't notify into an empty set and
  // leave this consumer stuck on the initial loading state.
  entry.subs.add(cb);
  if (isNew) {
    const e = entry;
    const onVisibility = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden) stopTimer(e);
      else { loadEntry(e); startTimer(e); }
    };
    entry.onVisibility = onVisibility;
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    loadEntry(entry);
    startTimer(entry);
  } else if (intervalMs < entry.intervalMs) {
    // Honor the tightest cadence any consumer asked for.
    entry.intervalMs = intervalMs;
    stopTimer(entry);
    startTimer(entry);
  }
  return () => {
    const e = ENTRIES.get(key);
    if (!e) return;
    e.subs.delete(cb);
    if (e.subs.size === 0) {
      stopTimer(e);
      if (e.onVisibility && typeof document !== 'undefined') document.removeEventListener('visibilitychange', e.onVisibility);
      ENTRIES.delete(key);
    }
  };
}

const EMPTY_ACCOUNTS: ResolvedPcaAccount[] = [];

/**
 * The S1 overview resolution engine + the single source of truth for the
 * Dashboard row / Settings card / bell. Backed by ONE shared poller per
 * tracked-id set (M2) so the always-mounted bell + a visible page don't double
 * the probe load. Skips all work when nothing is tracked.
 */
export function usePcaOverview(intervalMs = 30_000, extraIds: string[] = []): PcaOverview {
  const trackedIds = usePcaStore((s) => s.trackedIds);
  const extraIdsKey = extraIds.join(',');
  const ids = useMemo(
    () => [...trackedIds, ...extraIds.filter((id) => !trackedIds.includes(id))],
    // trackedIds / extraIds are represented by stable string keys for the poller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trackedIds.join(','), extraIdsKey],
  );
  const idsKey = ids.join(',');
  const [, force] = useReducer((c: number) => c + 1, 0);

  useEffect(
    () => subscribeOverview(idsKey, ids, intervalMs, force),
    // ids is derived from idsKey; intervalMs rarely changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idsKey, intervalMs],
  );

  const entry = ENTRIES.get(idsKey);
  const accounts = entry?.data?.accounts ?? EMPTY_ACCOUNTS;
  const loading = entry ? entry.loading : true;
  const error = entry?.error ?? null;

  const { bestCoveringDiscountBps, covered } = useMemo(() => {
    let best: number | null = null;
    for (const a of accounts) {
      if (!a.snapshot || a.approvedCount <= 0) continue;
      // U2 (via shared isPcaSpendable, #1344) — exclude expired/swept + zero-budget so
      // the dashboard/settings don't advertise a discount S5 treats as not-covering.
      if (!isPcaSpendable(a.snapshot)) continue;
      const bps = a.snapshot.discountBps;
      if (typeof bps === 'number' && (best == null || bps > best)) best = bps;
    }
    return { bestCoveringDiscountBps: best, covered: best != null };
  }, [accounts]);

  const wallets = entry?.data?.wallets ?? [];
  const walletsError = entry?.data?.walletsError ?? false;
  return {
    accounts,
    wallets,
    walletsError,
    // T2 — unreadable wallets (error + empty) vs a genuine 0-wallet node (no error).
    walletsInconclusive: walletsError && wallets.length === 0,
    loading,
    error,
    refresh: () => {
      const e = ENTRIES.get(idsKey);
      if (e) loadEntry(e);
    },
    bestCoveringDiscountBps,
    covered,
  };
}
