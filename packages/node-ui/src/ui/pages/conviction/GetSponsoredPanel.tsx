import React, { useState } from 'react';
import { useFetch } from '../../hooks.js';
import { fetchWalletsBalances, fetchPca, describePcaError } from '../../api.js';
import { formatEth, formatEthTooltip } from '../../lib/formatEth.js';
import { usePcaStore } from '../../stores/pca.js';
import { PcaModalShell } from './PcaModalShell.js';
import {
  WalletRow,
  SponsorshipHandshake,
  useCopy,
  nativeGasSymbol,
  isTestnetChain,
  healthForSnapshot,
} from '../../components/Pca/index.js';

// mirror usePublishEligibility cover predicate — shared extraction tracked in #1344
function bigGt0(wei: string | undefined): boolean {
  if (!wei) return false;
  try {
    return BigInt(wei) > 0n;
  } catch {
    return false;
  }
}

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

interface ProbeRow {
  wallet: string;
  registered: boolean | null;
  /**
   * N1 — registered AND the sponsor PCA is spendable (not expired/swept, has
   * budget): only then does an approved wallet actually COVER the publish. A
   * registered wallet on a dead PCA must not render "Ready" (#9 false coverage).
   */
  covers: boolean;
}

/**
 * S6 — Edge "Get sponsored" panel. Share operational wallets with a sponsoring
 * core node, fund their native gas (the PCA covers TRAC, never gas — faucet CTA
 * testnet-only), and track approval against the sponsor's account id. Ready =
 * ≥1 wallet approved AND gas-funded → publish.
 */
export function GetSponsoredPanel({ onClose }: { onClose: () => void }) {
  const { data: wb, loading: walletsLoading, error: walletsError, refresh: refreshWallets } = useFetch(fetchWalletsBalances, [], 0);
  const wallets = wb?.wallets ?? [];
  const balances = wb?.balances ?? [];
  const chainId = wb?.chainId ?? null;
  const gasSymbol = nativeGasSymbol(chainId);
  const faucet = isTestnetChain(chainId) ? faucetUrl(chainId) : undefined;

  const trackAccount = usePcaStore((s) => s.trackAccount);
  const { copied, copy } = useCopy();
  const [sponsorId, setSponsorId] = useState('');
  const [checking, setChecking] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probed, setProbed] = useState<{ accountId: string; rows: ProbeRow[] } | null>(null);

  const ethFor = (w: string) => balances.find((b) => b.address?.toLowerCase() === w.toLowerCase())?.eth;
  const isFunded = (w: string) => {
    const e = ethFor(w);
    return e != null && Number(e) > 0;
  };

  const check = async () => {
    const id = sponsorId.trim();
    if (!/^\d+$/.test(id)) { setProbeError('Enter the numeric account id your sponsor gave you.'); return; }
    setChecking(true);
    setProbeError(null);
    try {
      const rows = await Promise.all(
        wallets.map((w) =>
          fetchPca(id, w)
            .then((snap): ProbeRow => {
              const registered = snap.probedKey?.registered ?? null;
              // N1: mirror S5's cover predicate so S6 "Ready" == S5 GREEN — a
              // registered wallet only covers when the PCA is spendable.
              const h = healthForSnapshot(snap);
              const covers =
                registered === true &&
                h !== 'expired' &&
                h !== 'swept' &&
                (bigGt0(snap.topUpBuffer) || bigGt0(snap.baseEpochAllowance));
              return { wallet: w, registered, covers };
            })
            .catch((): ProbeRow => ({ wallet: w, registered: null, covers: false })),
        ),
      );
      // L4: the per-wallet .catch swallows failures, so every-row-null means the
      // lookup failed wholesale (vs genuine 0-approved, which is registered:false).
      // Surface that as an error — don't render a false "0 of N approved".
      if (rows.length > 0 && rows.every((r) => r.registered === null)) {
        setProbeError(`Couldn’t check approval on PCA #${id} right now — the chain lookup failed. Retry.`);
        setProbed(null);
        return;
      }
      // N2: persist the sponsor id once ≥1 wallet is approved so the overview/chip
      // pick it up (NOT on the wholesale-failure path). Downstream re-probes the
      // chain independently, so nothing trusts this S6 result — safe vs #9.
      if (rows.some((r) => r.registered === true)) trackAccount(id);
      setProbed({ accountId: id, rows });
    } catch (err) {
      setProbeError(describePcaError(err, { accountId: id })?.message ?? 'Couldn’t check approval.');
    } finally {
      setChecking(false);
    }
  };

  const approvedCount = probed?.rows.filter((r) => r.registered === true).length ?? 0;
  // N1: Ready requires actual COVERAGE (spendable PCA), not bare registration.
  const ready = !!probed && probed.rows.some((r) => r.covers && isFunded(r.wallet));

  return (
    <PcaModalShell
      onClose={onClose}
      testId="pca-get-sponsored"
      title="Get sponsored"
      subtitle="Share your operational wallets with a core node — they approve them; you keep paying your own gas."
    >
      <div className="v10-modal-body">
        {/* Wallets to share */}
        <section className="v10-pca-detail-section">
          <h3 className="v10-pca-detail-section-title">Your operational wallets (signers / msg.sender)</h3>
          <div className="v10-pca-detail-agentlist">
            {/* Gate the empty state on load/error — a false "No operational
                wallets" while the fetch is in flight (or on a transient error)
                reads, on the edge's ONLY path to a discount, as "I can't get
                sponsored". Empty copy shows ONLY when loaded AND truly zero. */}
            {walletsLoading && !wb ? (
              <p className="v10-pca-handshake-empty" role="status">Loading your wallets…</p>
            ) : walletsError && wallets.length === 0 ? (
              <p className="v10-modal-error" role="alert">
                Couldn’t load your wallets.{' '}
                <button type="button" className="v10-pca-card-btn" onClick={() => refreshWallets()}>Retry</button>
              </p>
            ) : wallets.length === 0 ? (
              <p className="v10-pca-handshake-empty">No operational wallets detected on this node.</p>
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
                          gas {formatEth(eth)} {gasSymbol} {funded ? '✓' : '⚠ fund to publish'}
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
          <p className="v10-pca-detail-hint">
            Share <strong>all</strong> your wallets (the node rotates its signer per publish) or pin to
            one. Share the exact address — a typo gets “approved” on the sponsor’s side but never
            matches your real signer.
          </p>
        </section>

        {/* Gas nudge */}
        <div className="v10-modal-warning">
          ⚠ Gas is always on you. The PCA covers the TRAC publishing fee — never your gas. Fund each
          wallet with native {gasSymbol}.
          {faucet ? (
            <>{' '}<a href={faucet} target="_blank" rel="noreferrer">Open faucet ↗</a> (testnet only)</>
          ) : (
            <>{' '}Fund with native {gasSymbol} from your wallet.</>
          )}
        </div>

        {/* Handshake packet — only once wallets have loaded, so its own
            wallets-empty half can't become a false-empty during the fetch. */}
        {wb && <SponsorshipHandshake wallets={wallets} accountId={probed?.accountId} role="edge" />}

        {/* Approval tracker */}
        <section className="v10-pca-detail-section">
          <h3 className="v10-pca-detail-section-title">Track your approval</h3>
          <div className="v10-pca-detail-form">
            <input
              className="v10-form-input"
              type="text"
              value={sponsorId}
              onChange={(e) => setSponsorId(e.target.value)}
              placeholder="Sponsor's account id (e.g. 7)"
              aria-label="Sponsor account id"
            />
            <button type="button" className="v10-pca-card-btn primary" onClick={check} disabled={checking}>
              {checking ? 'Checking…' : 'Check approval'}
            </button>
          </div>
          {probeError && <p className="v10-modal-error" role="alert">{probeError}</p>}
          {probed && (
            <div className="v10-pca-approve-results" role="status" aria-live="polite">
              <p className="v10-pca-approve-summary">
                Approved on PCA #{probed.accountId}: {approvedCount} of {probed.rows.length} wallets ✓
              </p>
              {probed.rows.map((r) => (
                <WalletRow
                  key={r.wallet}
                  address={r.wallet}
                  status={
                    r.registered === true
                      ? r.covers
                        ? 'approved'
                        : 'approved, but the sponsor’s PCA is expired/swept/out of budget — publishes won’t get the discount'
                      : r.registered === false
                        ? 'not approved — ask the sponsor to approve it'
                        : 'unknown'
                  }
                  statusTone={
                    r.registered === true
                      ? r.covers
                        ? 'success'
                        : 'warn'
                      : r.registered === false
                        ? 'danger'
                        : 'neutral'
                  }
                />
              ))}
            </div>
          )}
        </section>

        {ready && (
          <div className="v10-pca-create-success" role="status">
            ● Ready: ≥1 wallet is approved and gas-funded — this node can publish under PCA #{probed!.accountId}.{' '}
            {/* L9: no global publish target — the discount applies at any per-CG
                publish. Guidance hint, not an inert "Go to publish →" button. */}
            Publish from any context graph — the discount applies automatically to your approved wallets.
          </div>
        )}
      </div>

      <div className="v10-modal-footer">
        <button type="button" className="v10-modal-btn" onClick={onClose}>Close</button>
      </div>
    </PcaModalShell>
  );
}
