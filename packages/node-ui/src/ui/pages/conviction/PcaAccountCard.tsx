import React from 'react';
import { formatTrac } from '../../lib/formatTrac.js';
import {
  HealthChip,
  WalletRow,
  CopyButton,
  formatWeiToTrac,
  formatRelativeExpiry,
} from '../../components/Pca/index.js';
import { StatStrip } from '../../components/ContextGraphPrimitives.js';
import type { ResolvedPcaAccount } from '../../hooks/usePcaOverview.js';

function pct(bps: number | undefined): string {
  if (typeof bps !== 'number' || !Number.isFinite(bps)) return '—';
  const p = bps / 100;
  return `${p % 1 === 0 ? p.toFixed(0) : p.toFixed(1)}%`;
}

/**
 * S1 account summary card (UX Part II §1/§2). Renders three shapes: the owned
 * card (StatStrip + Manage/Approve), the approved/"sponsor" card (per-wallet
 * probe list + Use-for-publishing), and the per-card error states (404 →
 * Remove-from-tracked; transient → Retry). One failing card never blanks the
 * grid — that's the parent's job, this just renders its own state.
 *
 * Owner≠coverage (#11) and the §8A owner-wallet rule are enforced here: a fresh
 * owned PCA with 0 approved wallets says it discounts nothing yet, and
 * owner-write actions are disabled unless the owner is the node's primary wallet.
 */
export function PcaAccountCard({
  account,
  blockExplorerUrl,
  nowSec,
  onManage,
  onApproveWallets,
  onUseForPublishing,
  onRemove,
  onRetry,
}: {
  account: ResolvedPcaAccount;
  blockExplorerUrl?: string | null;
  nowSec?: number;
  onManage?: (id: string) => void;
  onApproveWallets?: (id: string) => void;
  onUseForPublishing?: (id: string) => void;
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
}) {
  const { accountId, snapshot, notFound, classification, ownerIsPrimaryWallet } = account;

  // --- Per-card error states ---
  if (notFound) {
    return (
      <div className="card v10-pca-card" data-state="not-found" data-account={accountId} data-testid="pca-account-card">
        <div className="card-body v10-pca-card-error">
          <p>PCA #{accountId} no longer exists on-chain.</p>
          {onRemove && (
            <button type="button" className="v10-pca-card-btn" onClick={() => onRemove(accountId)}>
              Remove from tracked
            </button>
          )}
        </div>
      </div>
    );
  }
  if (!snapshot) {
    return (
      <div className="card v10-pca-card" data-state="error" data-account={accountId} data-testid="pca-account-card">
        <div className="card-body v10-pca-card-error">
          <p>Couldn’t load PCA #{accountId}.</p>
          {onRetry && (
            <button type="button" className="v10-pca-card-btn" onClick={() => onRetry(accountId)}>
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  const expiry = formatRelativeExpiry(snapshot.expiresAtTimestamp, nowSec);
  const ownerExplorer =
    blockExplorerUrl ? `${blockExplorerUrl}/address/${snapshot.owner}` : undefined;

  const titleBand = (
    <div className="v10-pca-card-title">
      <span className="v10-pca-card-id">PCA #{accountId}</span>
      <span className="badge badge-info v10-pca-card-discount">◉ {pct(snapshot.discountBps)} discount</span>
      <span className="v10-pca-card-spacer" />
      {account.health && <HealthChip state={account.health} />}
    </div>
  );

  const ownerLine = (
    <div className="v10-pca-card-owner">
      <span className="v10-pca-card-owner-lbl">Owner</span>
      <WalletRow
        address={snapshot.owner}
        trailing={
          ownerExplorer ? (
            <a
              className="v10-pca-card-explorer"
              href={ownerExplorer}
              target="_blank"
              rel="noreferrer"
              aria-label={`View owner ${snapshot.owner} on the block explorer`}
            >
              ↗
            </a>
          ) : undefined
        }
      />
    </div>
  );

  // --- Owned card ---
  if (classification === 'owned') {
    const selfCovers = account.approvedCount > 0;
    return (
      <div className="card v10-pca-card" data-state="owned" data-account={accountId} data-testid="pca-account-card">
        <div className="card-body">
          {titleBand}
          <StatStrip
            items={[
              { id: 'committed', label: 'Committed', value: `${formatTrac(snapshot.committedTRACTrac)} TRAC` },
              { id: 'buffer', label: 'Top-up buffer', value: `${formatTrac(snapshot.topUpBufferTrac)} TRAC` },
              { id: 'per-epoch', label: 'Per-epoch allowance', value: `${formatWeiToTrac(snapshot.baseEpochAllowance)} TRAC` },
              { id: 'wallets', label: 'Publishing wallets', value: `${snapshot.agentCount} / 100` },
            ]}
          />
          {ownerLine}
          <p className="v10-pca-card-owner-note">
            This is the node’s operational wallet — who <strong>signs</strong>, not who’s covered.
          </p>
          {/* #11 — owner ≠ coverage. */}
          {!selfCovers && (
            <p className="v10-pca-card-warn">
              ⚠ 0 of this node’s wallets are approved here — it discounts nothing yet. Approve this
              node’s operational wallets to start saving.
            </p>
          )}
          <p className="v10-pca-card-meta">
            {expiry}
            <span className="v10-pca-card-meta-sep"> · </span>
            <span title={`Expiry epoch ${snapshot.expiresAtEpoch}`}>epoch {snapshot.expiresAtEpoch} ⓘ</span>
          </p>
          <div className="v10-pca-card-actions">
            <button
              type="button"
              className="v10-pca-card-btn primary"
              onClick={() => onManage?.(accountId)}
            >
              Manage
            </button>
            <button
              type="button"
              className="v10-pca-card-btn"
              onClick={() => onApproveWallets?.(accountId)}
              disabled={!ownerIsPrimaryWallet || !onApproveWallets}
              title={
                ownerIsPrimaryWallet
                  ? undefined
                  : `Owner-only — PCA #${accountId} isn’t owned by this node’s primary operational wallet.`
              }
            >
              Approve wallets
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- Approved / "sponsor" card (also the read-only "tracked, not approved" case) ---
  const allApproved = account.walletCount > 0 && account.approvedCount === account.walletCount;
  const firstUnapproved = account.walletProbes.find((p) => p.registered !== true)?.wallet;
  return (
    <div className="card v10-pca-card" data-state="approved" data-account={accountId} data-testid="pca-account-card">
      <div className="card-body">
        <div className="v10-pca-card-title">
          <span className="v10-pca-card-id">PCA #{accountId}</span>
          <span className="v10-pca-card-sponsor">(sponsor)</span>
          <span className="badge badge-info v10-pca-card-discount">◉ {pct(snapshot.discountBps)}</span>
          <span className="v10-pca-card-spacer" />
          {!allApproved && account.walletCount > 0 && (
            <span className="badge badge-warn">
              ⚠ {account.approvedCount} of {account.walletCount} wallets approved
            </span>
          )}
        </div>
        {ownerLine}
        <p className="v10-pca-card-meta">
          {expiry}
          <span className="v10-pca-card-meta-sep"> · </span>
          <span title={`Expiry epoch ${snapshot.expiresAtEpoch}`}>epoch {snapshot.expiresAtEpoch} ⓘ</span>
        </p>
        <div className="v10-pca-card-wallets">
          {account.walletProbes.map((p) => (
            <WalletRow
              key={p.wallet}
              address={p.wallet}
              status={p.registered === true ? 'approved' : p.registered === false ? 'not approved' : 'unknown'}
              statusTone={p.registered === true ? 'success' : p.registered === false ? 'danger' : 'neutral'}
            />
          ))}
        </div>
        {!allApproved && account.walletCount > 0 && (
          <p className="v10-pca-card-warn">
            Publishes from the un-approved wallet(s) will quietly pay the direct cost.
          </p>
        )}
        <div className="v10-pca-card-actions">
          <button
            type="button"
            className="v10-pca-card-btn primary"
            onClick={() => onUseForPublishing?.(accountId)}
            disabled={!onUseForPublishing}
          >
            Use for publishing
          </button>
          {firstUnapproved && (
            <CopyButton value={firstUnapproved} label={`Copy unapproved wallet ${firstUnapproved}`} />
          )}
        </div>
      </div>
    </div>
  );
}
