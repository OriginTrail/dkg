import React, { useEffect, useRef, useState } from 'react';
import { useFetch } from '../../hooks.js';
import { fetchWalletsBalances, fetchPca, pcaAgentAccount, describePcaError } from '../../api.js';
import { formatEth, formatEthTooltip } from '../../lib/formatEth.js';
import { usePcaStore } from '../../stores/pca.js';
import { classifyCoverage, type PcaCoverageResult } from '../../pca/coverage.js';
import { PcaModalShell } from './PcaModalShell.js';
import {
  WalletRow,
  RetryButton,
  useCopy,
  nativeGasSymbol,
  isTestnetChain,
} from '../../components/Pca/index.js';
import { Check } from 'lucide-react';
import { Badge, StatusGlyph } from '../../components/ds/Badge.js';
import { Loading } from '../../components/ds/Loading.js';
import { ExternalMark } from '../../components/ds/ExternalMark.js';

// Testnet faucets for the native gas token (testnet-only CTA — §6.2). Only
// chains we have a known faucet for render a button; others show the copy alone.
const FAUCETS: Record<string, string> = {
  '84532': 'https://www.alchemy.com/faucets/base-sepolia',
  '11155111': 'https://www.alchemy.com/faucets/ethereum-sepolia',
  '10200': 'https://faucet.chiadochain.net/',
};
function faucetUrl(chainId: string | null | undefined): string | undefined {
  if (chainId == null) return undefined;
  const k = String(chainId);
  const numeric = k.includes(':') ? k.split(':').pop()! : k;
  return FAUCETS[numeric];
}

/** A failed approval check: what to say, and whether Retry can help (not for a capability gap). */
interface ProbeError {
  message: string;
  retry: boolean;
  /** The PCA itself was read (only its approval check is unsupported), so it can still be added. */
  trackableId?: string;
}

/**
 * Put a PCA that was read but covers nothing here (or can't be checked) in the list,
 * read-only, so its funding, expiry and owner stay reachable. It claims no coverage.
 */
function AddToListAction({ accountId, trackedNote }: { accountId: string; trackedNote: string }) {
  const trackAccount = usePcaStore((s) => s.trackAccount);
  const tracked = usePcaStore((s) => s.trackedIds.includes(accountId));
  if (tracked) return <p className="v10-pca-detail-hint" data-testid="pca-sponsor-tracked">{trackedNote}</p>;
  return (
    <div className="v10-pca-overview-cta-group">
      <button type="button" className="v10-pca-card-btn ds-btn ds-sm" data-testid="pca-sponsor-track" onClick={() => trackAccount(accountId)}>
        Add PCA #{accountId} to your list
      </button>
    </div>
  );
}

interface ProbeRow {
  wallet: string;
  /**
   * The CANONICAL coverage result for this wallet on the probed account — carried as the
   * discriminated union (#1344), NOT flattened into parallel `registered`/`covers`/
   * `adapterUnsupported` flags that could express impossible states. Every derived signal
   * (approved count, N1 coverage, S6 "Ready", the #1356 capability-gap split) reads the
   * single `.outcome` discriminant. A transport failure maps to the `inconclusive`
   * variant with `adapterUnsupported:false` (couldn't read ≠ capability gap).
   */
  coverage: PcaCoverageResult;
}

/** The S6 approval-row status derived from the single coverage discriminant. */
function sponsorRowStatus(c: PcaCoverageResult): { text: string; tone: 'success' | 'warn' | 'danger' | 'neutral' } {
  switch (c.outcome) {
    case 'covers':
      return { text: 'Approved', tone: 'success' };
    case 'uncovered':
      return { text: 'Approved, no discount', tone: 'warn' };
    case 'unregistered':
      return { text: 'Not approved: ask the PCA owner to approve it', tone: 'danger' };
    case 'inconclusive':
      return { text: 'Couldn’t check', tone: 'warn' };
  }
}

/** Why approved wallets get no discount, said once above the rows. */
function inactiveReason(accountId: string, rows: ProbeRow[]): string | null {
  const uncovered = rows.map((r) => r.coverage).filter((c) => c.outcome === 'uncovered');
  if (uncovered.length === 0) return null;
  return uncovered.some((c) => c.dead)
    ? `PCA #${accountId} has expired, so publishes pay the full fee.`
    : `PCA #${accountId} has no TRAC left this epoch, so publishes pay the full fee until the next epoch.`;
}

/** Summary icon: all covered is a success, none approved an error, the rest need a look. */
function summaryTone(rows: ProbeRow[]): 'success' | 'warning' | 'danger' {
  if (rows.every((r) => r.coverage.outcome === 'covers')) return 'success';
  if (rows.every((r) => r.coverage.outcome === 'unregistered')) return 'danger';
  return 'warning';
}

/**
 * S6 — Edge "get added to a PCA" panel. Share operational wallets with a PCA
 * owner, fund their native gas (the PCA covers TRAC, never gas — faucet CTA
 * testnet-only), and track approval against the owner-provided PCA id. Ready =
 * ≥1 wallet approved AND gas-funded → publish.
 */
export function GetSponsoredPanel({
  onClose,
  initialAccountId,
}: {
  onClose: () => void;
  /** A PCA ID entered on the Overview: pre-filled and checked once the wallets load. */
  initialAccountId?: string;
}) {
  const { data: wb, loading: walletsLoading, error: walletsError, refresh: refreshWallets } = useFetch(fetchWalletsBalances, [], 0);
  const wallets = wb?.wallets ?? [];
  const balances = wb?.balances ?? [];
  const walletsBodyError = typeof wb?.error === 'string' && wb.error.length > 0 ? wb.error : null;
  const walletsReadError = walletsError || walletsBodyError;
  const chainId = wb?.chainId ?? null;
  const gasSymbol = nativeGasSymbol(chainId);
  const faucet = isTestnetChain(chainId) ? faucetUrl(chainId) : undefined;

  const trackAccount = usePcaStore((s) => s.trackAccount);
  const { copied, copy } = useCopy();

  // GAP-3 discovery (#1344) — surface which PCA(s) already sponsor this node's wallets
  // (chain truth, untracked by definition — that's the point of the edge panel). PURE
  // discovery: it never auto-tracks (guardrail b) and never asserts coverage — it just
  // pre-fills the manual "Check approval" so the edge doesn't need the core to hand over
  // the id. A wallet is approved on at most one account; distinct non-null ids are shown.
  const walletsKey = wallets.join(',');
  const { data: discovered } = useFetch(
    async () => {
      const ws = wb?.wallets ?? [];
      if (ws.length === 0) return [] as string[];
      const ids = await Promise.all(
        ws.map((w) => pcaAgentAccount(w).then((r) => r.accountId).catch(() => null)),
      );
      return Array.from(new Set(ids.filter((id): id is string => id != null)));
    },
    [walletsKey],
    0,
  );

  const [sponsorId, setSponsorId] = useState(initialAccountId ?? '');
  const [checking, setChecking] = useState(false);
  // One error model: the message and whether Retry can help are set and cleared together.
  const [probeError, setProbeError] = useState<ProbeError | null>(null);
  const [probed, setProbed] = useState<{ accountId: string; rows: ProbeRow[] } | null>(null);

  const ethFor = (w: string) => balances.find((b) => b.address?.toLowerCase() === w.toLowerCase())?.eth;
  const isFunded = (w: string) => {
    const e = ethFor(w);
    return e != null && Number(e) > 0;
  };

  const check = async (idToCheck?: string) => {
    const id = (idToCheck ?? sponsorId).trim();
    if (!/^\d+$/.test(id)) { setProbeError({ message: 'Enter the PCA ID as a number.', retry: false }); return; }
    setChecking(true);
    setProbeError(null);
    try {
      const rows = await Promise.all(
        wallets.map((w) =>
          fetchPca(id, w, { extended: true })
            // #1344 — single canonical classifier (reads snap.probedKey); the row keeps the
            // whole discriminated result. S2 adapterSupported===false → inconclusive
            // (neutral "unknown" row, not a false not-approved; all-unsupported → wholesale
            // "not supported"); N1 coverage / S6 "Ready" == outcome 'covers'.
            .then((snap): ProbeRow => ({ wallet: w, coverage: classifyCoverage(snap) }))
            // A transport failure couldn't determine coverage → inconclusive, NOT a
            // capability gap (retry may resolve it).
            .catch((): ProbeRow => ({ wallet: w, coverage: { outcome: 'inconclusive', registered: null, adapterUnsupported: false } })),
        ),
      );
      // L4: the per-wallet .catch swallows failures, so every-row-null means the
      // lookup failed wholesale (vs genuine 0-approved, which is registered:false).
      // Surface that as an error — don't render a false "0 of N approved".
      if (rows.length > 0 && rows.every((r) => r.coverage.outcome === 'inconclusive')) {
        // #1356 — split the CAPABILITY GAP (the chain adapter can't answer PCA
        // queries here — retrying is futile) from a transient RPC failure (retry).
        // Only claim "not supported" when EVERY inconclusive probe is an adapter gap.
        const allAdapterGap = rows.every((r) => r.coverage.outcome === 'inconclusive' && r.coverage.adapterUnsupported);
        setProbeError({
          message: allAdapterGap
            ? 'This node can’t check PCA approval, so we can’t confirm which wallets are covered. You can still publish. To check approval, update the node or ask the PCA owner.'
            : `Couldn’t check PCA #${id} right now.`,
          retry: !allAdapterGap,
          // A capability gap still read the PCA itself; a transient failure proves nothing.
          ...(allAdapterGap ? { trackableId: id } : {}),
        });
        setProbed(null);
        return;
      }
      // N2: persist the sponsor id once ≥1 wallet is approved so the overview/chip
      // pick it up (NOT on the wholesale-failure path). Downstream re-probes the
      // chain independently, so nothing trusts this S6 result — safe vs #9.
      if (rows.some((r) => r.coverage.registered === true)) trackAccount(id);
      setProbed({ accountId: id, rows });
    } catch (err) {
      setProbeError({ message: describePcaError(err, { accountId: id })?.message ?? 'Couldn’t check approval.', retry: false });
    } finally {
      setChecking(false);
    }
  };

  // An ID entered on the Overview is checked as soon as this node's wallets are known.
  const autoChecked = useRef(false);
  useEffect(() => {
    if (!initialAccountId || autoChecked.current || walletsLoading || wallets.length === 0) return;
    autoChecked.current = true;
    void check(initialAccountId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAccountId, walletsLoading, walletsKey]);
  // Bring that first result into view: it sits below the wallets to share.
  const resultsRef = useRef<HTMLDivElement>(null);
  const scrolledToResult = useRef(false);
  useEffect(() => {
    if (!autoChecked.current || scrolledToResult.current || (!probed && !probeError)) return;
    scrolledToResult.current = true;
    resultsRef.current?.scrollIntoView?.({ block: 'start' });
  }, [probed, probeError]);

  const approvedCount = probed?.rows.filter((r) => r.coverage.registered === true).length ?? 0;
  // N1: Ready requires actual COVERAGE (spendable PCA), not bare registration.
  const ready = !!probed && probed.rows.some((r) => r.coverage.outcome === 'covers' && isFunded(r.wallet));

  return (
    <PcaModalShell
      onClose={onClose}
      testId="pca-get-sponsored"
      title="Get added to a PCA"
      subtitle="Share this node's publishing wallets with the PCA owner, who approves them. You still pay gas."
    >
      <div className="v10-modal-body v10-pca-get-added-body">
        {/* Wallets to share */}
        <section className="v10-pca-detail-section">
          <h3 className="v10-pca-detail-section-title">This node's publishing wallets</h3>
          <div className="v10-pca-detail-agentlist">
            {/* Gate the empty state on load/error — a false "No operational
                wallets" while the fetch is in flight (or on a transient error)
                reads, on the edge's ONLY path to a discount, as "I can't get
                sponsored". Empty copy shows ONLY when loaded AND truly zero. */}
            {walletsLoading && !wb ? (
              <Loading label="Loading your wallets…" />
            ) : walletsReadError && wallets.length === 0 ? (
              <div className="v10-pca-retry-block">
                <p className="v10-modal-error ds-card-nested" role="alert">Couldn’t load your wallets.</p>
                <RetryButton onClick={() => refreshWallets()} />
              </div>
            ) : wallets.length === 0 ? (
              <p className="v10-pca-handshake-empty">This node didn't report any publishing wallets.</p>
            ) : (
              wallets.map((w) => {
                const eth = ethFor(w);
                const funded = isFunded(w);
                return (
                  <WalletRow
                    key={w}
                    address={w}
                    gas={
                      eth != null ? (
                        <span title={formatEthTooltip(eth)}>
                          gas {formatEth(eth)} {gasSymbol} {funded ? <Check size={12} /> : <><StatusGlyph tone="warning" /> fund to publish</>}
                        </span>
                      ) : undefined
                    }
                  />
                );
              })
            )}
          </div>
          {wallets.length > 0 && (
            <button
              type="button"
              className="v10-pca-handshake-copyall"
              onClick={() => copy(wallets.join('\n'))}
              aria-label={copied ? 'Copied all wallets' : 'Copy all wallet addresses'}
            >
              {copied ? 'Copied' : `Copy all ${wallets.length}`}
            </button>
          )}
          {wallets.length > 0 && (
            <p className="v10-pca-detail-hint">
              Share <strong>all</strong> of them, because the node can sign with a different wallet each time, or pin publishing to one.
              Copy the exact addresses: a wrong address can still be approved, but it gives no discount.
            </p>
          )}
        </section>

        {/* Gas nudge */}
        <div className="v10-modal-warning ds-card-nested">
          <StatusGlyph tone="warning" /> You pay gas. The PCA only covers the TRAC fee, so each publishing wallet needs {gasSymbol}.
          {faucet ? (
            <>{' '}Get test {gasSymbol}: <a className="v10-pca-text-link" href={faucet} target="_blank" rel="noreferrer">Open faucet <ExternalMark /></a></>
          ) : wallets.length > 0 ? (
            <>{' '}Transfer {gasSymbol} to the addresses above.</>
          ) : null}
        </div>

        {/* Approval tracker */}
        <section className="v10-pca-detail-section">
          <h3 className="v10-pca-detail-section-title">Have a PCA ID?</h3>
          {/* GAP-3 discovery — surface any sponsoring PCA we found on-chain; pre-fill the
              check (the user confirms; nothing is auto-tracked). */}
          <p className="v10-pca-detail-hint">
            If the PCA owner gave you a PCA ID, enter it to see which of this node&apos;s wallets are covered.
          </p>
          {discovered && discovered.length > 0 && (
            <div className="v10-pca-discovered-check" role="status" data-testid="pca-sponsor-discovered">
              <StatusGlyph tone="success" /> At least one of your wallets is already approved on {discovered.map((id) => `PCA #${id}`).join(', ')}.{' '}
              <button type="button" className="v10-pca-card-btn compact ds-btn ds-sm" onClick={() => setSponsorId(discovered[0])}>
                Check PCA #{discovered[0]}
              </button>
            </div>
          )}
          <div className="v10-pca-detail-form">
            <input
              className="v10-form-input ds-input"
              type="text"
              value={sponsorId}
              onChange={(e) => setSponsorId(e.target.value)}
              placeholder="PCA ID from owner (e.g. 7)"
              aria-label="PCA ID from owner"
            />
            <button type="button" className="v10-pca-card-btn primary ds-btn ds-primary" onClick={() => void check()} disabled={checking}>
              {checking ? 'Checking…' : 'Check approval'}
            </button>
          </div>
          <div ref={resultsRef} aria-hidden="true" />
          {probeError && (
            <div className="v10-pca-retry-block">
              <p className="v10-modal-error ds-card-nested" role="alert">{probeError.message}</p>
              {probeError.retry && <RetryButton onClick={() => void check()} />}
              {probeError.trackableId && (
                <AddToListAction
                  accountId={probeError.trackableId}
                  trackedNote={`PCA #${probeError.trackableId} is in your list. This node can’t check whether it covers your wallets.`}
                />
              )}
            </div>
          )}
          {probed && (
            <div className="v10-pca-approve-results" role="status" aria-live="polite">
              <p className="v10-pca-approve-summary">
                <Badge tone={summaryTone(probed.rows)}>Approved on PCA #{probed.accountId}: {approvedCount} of {probed.rows.length} wallets</Badge>
              </p>
              {inactiveReason(probed.accountId, probed.rows) && (
                <p className="v10-modal-warning ds-card-nested">{inactiveReason(probed.accountId, probed.rows)}</p>
              )}
              {probed.rows.map((r) => {
                const s = sponsorRowStatus(r.coverage);
                return <WalletRow key={r.wallet} address={r.wallet} status={s.text} statusTone={s.tone} />;
              })}
              {/* The PCA exists but approves none of these wallets yet: it can still go in the
                  list, read-only, to view its funding, expiry and owner. It covers nothing. */}
              {approvedCount === 0 && (
                <AddToListAction
                  accountId={probed.accountId}
                  trackedNote={`PCA #${probed.accountId} is in your list. It gives no discount until the owner approves these wallets.`}
                />
              )}
            </div>
          )}
        </section>

        {ready && (
          <div className="v10-pca-create-success" role="status">
            Ready. At least 1 wallet is approved and has gas, so this node can publish with PCA #{probed!.accountId}.{' '}
            {/* L9: no global publish target — the discount applies at any per-CG
                publish. Guidance hint, not an inert "Go to publish →" button. */}
            Publish from any Context Graph. The discount applies automatically to approved wallets.
          </div>
        )}
      </div>

      <div className="v10-modal-footer">
        <button type="button" className="v10-modal-btn ds-btn" onClick={onClose}>Close</button>
      </div>
    </PcaModalShell>
  );
}
