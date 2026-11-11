import React, { useEffect, useRef, useState } from 'react';
import { useFetch } from '../../hooks.js';
import { fetchWalletsBalances, pcaAgentAccount, describePcaError, isPcaReadFailed } from '../../api.js';
import { formatEth, formatEthTooltip } from '../../lib/formatEth.js';
import { usePcaStore } from '../../stores/pca.js';
import type { PcaCoverageResult } from '../../pca/coverage.js';
import { readPcaAccount } from '../../pca/readAccount.js';
import type { CoverageProbe } from '../../pca/walletCoverage.js';
import { PcaModalShell } from './PcaModalShell.js';
import {
  WalletRow,
  useCopy,
  nativeGasSymbol,
  isTestnetChain,
} from '../../components/Pca/index.js';
import { RetryButton } from '../../components/ds/RetryButton.js';
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

/** The outcome of one check, set once when the check finishes. */
type CheckResult =
  /** The ID isn't a number, or the PCA itself couldn't be read: nothing to show or add. */
  | { kind: 'failed'; message: string; retry: boolean }
  /** The PCA was read, but approval couldn't be checked: no wallets, unreadable wallets, or no probe answered. */
  | { kind: 'unverifiable'; accountId: string; message: string; retry: boolean }
  /** Approval was checked wallet by wallet. */
  | { kind: 'checked'; accountId: string; rows: ProbeRow[] };

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

/**
 * One wallet's canonical coverage on the checked PCA (#1344). Every derived signal
 * (approved count, N1 coverage, S6 "Ready", the #1356 capability-gap split) reads the
 * single `.outcome` discriminant.
 */
type ProbeRow = CoverageProbe;

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
    : `PCA #${accountId} has no TRAC left in this billing period, so publishes pay the full fee until its next billing period starts.`;
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
  // The check that was asked for: the ID from the Overview to start with, then each Check
  // or Retry. A fresh object per submission, so the same ID can be checked again.
  const [submitted, setSubmitted] = useState<{ id: string } | null>(() => (initialAccountId ? { id: initialAccountId } : null));
  const initialSubmission = useRef(submitted);
  const submit = () => setSubmitted({ id: sponsorId });

  const ethFor = (w: string) => balances.find((b) => b.address?.toLowerCase() === w.toLowerCase())?.eth;
  const isFunded = (w: string) => {
    const e = ethFor(w);
    return e != null && Number(e) > 0;
  };

  /** Classify one check: read the PCA, then probe each wallet. Says nothing and tracks nothing itself. */
  const runCheck = async (rawId: string): Promise<CheckResult> => {
    const id = rawId.trim();
    if (!/^\d+$/.test(id)) return { kind: 'failed', message: 'Enter the PCA ID as a number.', retry: false };
    // The PCA itself is read first: nothing is offered for an ID that doesn't exist.
    const read = await readPcaAccount(id, wallets);
    if (!read.ok) {
      const temporary: CheckResult = { kind: 'failed', message: `Couldn’t check PCA #${id} right now.`, retry: true };
      // A 503 PCA_LOOKUP_READ_FAILED is a chain read that failed, not a network without
      // PCAs, so it's temporary (Retry) before any capability reading of the 503.
      if (isPcaReadFailed(read.error)) return temporary;
      // A known daemon error says what happened (a missing PCA among them); anything else is a transient read failure.
      const described = describePcaError(read.error, { accountId: id });
      return described
        ? { kind: 'failed', message: described.message, retry: described.code === 'ServerError' }
        : temporary;
    }
    // From here the PCA exists, so it can always be added read-only, whatever approval shows.
    // Approval needs only the wallet addresses: a balance-read error (gas unknown) still
    // probes every known wallet, and Ready stays off until gas is known.
    if (wallets.length === 0) {
      return {
        kind: 'unverifiable',
        accountId: id,
        // The wallet section above has its own Retry for an unreadable list.
        message: walletsReadError
          ? `PCA #${id} exists, but this node’s wallets couldn’t be read, so we can’t check its approval. Retry loading the wallets above.`
          : `PCA #${id} exists, but this node reported no publishing wallets to check.`,
        retry: false,
      };
    }
    const rows: ProbeRow[] = read.probes;
    // L4: every probe inconclusive means approval couldn't be checked at all, never a
    // false "0 of N approved". #1356: only a capability gap on every probe says "not
    // supported" (Retry won't help); anything else is transient (Retry).
    if (rows.every((r) => r.coverage.outcome === 'inconclusive')) {
      const allAdapterGap = rows.every((r) => r.coverage.outcome === 'inconclusive' && r.coverage.adapterUnsupported);
      return {
        kind: 'unverifiable',
        accountId: id,
        message: allAdapterGap
          ? 'This node can’t check PCA approval, so we can’t confirm which wallets are covered. You can still publish. To check approval, update the node or ask the PCA owner.'
          : `Couldn’t check approval on PCA #${id} right now.`,
        retry: !allAdapterGap,
      };
    }
    return { kind: 'checked', accountId: id, rows };
  };

  // A submitted check runs once this node's wallets are known, either way: runCheck reports
  // no or unreadable wallets itself. The result is scoped to its submission, so a new check
  // never shows the previous one's result while it runs. It runs again when the wallet
  // addresses or the wallet read's outcome change (a wallet Retry that recovers), with the
  // recovered wallets; useFetch drops a superseded run's result.
  const walletsSettled = !walletsLoading && (wb != null || walletsReadError != null);
  const { data: checkData, error: checkError, loading: checking } = useFetch(
    () => runCheck(submitted!.id),
    [submitted, walletsKey, walletsReadError],
    0,
    { enabled: submitted != null && walletsSettled, scope: submitted, retention: 'scope' },
  );
  const result: CheckResult | null = checkData
    ?? (checkError && submitted ? { kind: 'failed', message: `Couldn’t check PCA #${submitted.id.trim()} right now.`, retry: true } : null);

  // N2: once a wallet is approved, put the PCA in the list so the Overview and chip pick it
  // up. Downstream re-probes the chain independently, so nothing trusts this result (#9).
  useEffect(() => {
    if (result?.kind === 'checked' && result.rows.some((r) => r.coverage.registered === true)) trackAccount(result.accountId);
  }, [result, trackAccount]);

  // Bring the Overview ID's result into view: it sits below the wallets to share.
  const resultsRef = useRef<HTMLDivElement>(null);
  const scrolledToResult = useRef(false);
  useEffect(() => {
    if (scrolledToResult.current || !result || submitted == null || submitted !== initialSubmission.current) return;
    scrolledToResult.current = true;
    resultsRef.current?.scrollIntoView?.({ block: 'start' });
  }, [result, submitted]);

  const checked = result?.kind === 'checked' ? result : null;
  const approvedCount = checked?.rows.filter((r) => r.coverage.registered === true).length ?? 0;
  // N1: Ready requires actual COVERAGE (spendable PCA), not bare registration.
  const ready = !!checked && checked.rows.some((r) => r.coverage.outcome === 'covers' && isFunded(r.wallet));
  // A PCA that was read but covers nothing here, or couldn't be checked, can still go in the list.
  // "Needs approval" only when every wallet is confirmed unregistered; a wallet whose probe
  // failed might already be approved, so then coverage stays unknown.
  const allUnregistered = !!checked && checked.rows.every((r) => r.coverage.outcome === 'unregistered');
  const addable = result?.kind === 'unverifiable'
    ? { accountId: result.accountId, note: `PCA #${result.accountId} is in your list. This node can’t check whether it covers your wallets.` }
    : checked && approvedCount === 0
      ? {
        accountId: checked.accountId,
        note: allUnregistered
          ? `PCA #${checked.accountId} is in your list. It gives no discount until the owner approves these wallets.`
          : `PCA #${checked.accountId} is in your list. This node couldn’t check every wallet, so it may already cover some.`,
      }
      : null;

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
              <p className="v10-pca-handshake-empty" data-testid="pca-sponsor-no-wallets">This node didn't report any publishing wallets.</p>
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
            <button type="button" className="v10-pca-card-btn primary ds-btn ds-primary" onClick={submit} disabled={checking || walletsLoading}>
              {checking ? 'Checking…' : 'Check approval'}
            </button>
          </div>
          <div ref={resultsRef} aria-hidden="true" />
          {result && result.kind !== 'checked' && (
            <div className="v10-pca-retry-block">
              <p className="v10-modal-error ds-card-nested" role="alert">{result.message}</p>
              {result.retry && <RetryButton onClick={submit} />}
            </div>
          )}
          {checked && (
            <div className="v10-pca-approve-results" role="status" aria-live="polite">
              <p className="v10-pca-approve-summary">
                <Badge tone={summaryTone(checked.rows)}>Approved on PCA #{checked.accountId}: {approvedCount} of {checked.rows.length} wallets</Badge>
              </p>
              {inactiveReason(checked.accountId, checked.rows) && (
                <p className="v10-modal-warning ds-card-nested">{inactiveReason(checked.accountId, checked.rows)}</p>
              )}
              {checked.rows.map((r) => {
                const s = sponsorRowStatus(r.coverage);
                return <WalletRow key={r.wallet} address={r.wallet} status={s.text} statusTone={s.tone} />;
              })}
            </div>
          )}
          {/* Read-only: funding, expiry and owner stay reachable. It claims no coverage. */}
          {addable && <AddToListAction accountId={addable.accountId} trackedNote={addable.note} />}
        </section>

        {ready && (
          <div className="v10-pca-create-success" role="status">
            Ready. At least 1 wallet is approved and has gas, so this node can publish with PCA #{checked!.accountId}.{' '}
            {/* L9: no global publish target — the discount applies at any per-CG
                publish. Guidance hint, not an inert "Go to publish →" button. */}
            Publish from any context graph. The discount applies automatically to approved wallets.
          </div>
        )}
      </div>

      <div className="v10-modal-footer">
        <button type="button" className="v10-modal-btn ds-btn" onClick={onClose}>Close</button>
      </div>
    </PcaModalShell>
  );
}
