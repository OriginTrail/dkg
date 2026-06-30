import React from 'react';
import {
  HealthChip,
  WalletRow,
  formatPcaTrac,
  formatWeiToTrac,
  formatRelativeExpiry,
} from '../../components/Pca/index.js';
import { StatStrip } from '../../components/ContextGraphPrimitives.js';
import type { ResolvedPcaAccount } from '../../hooks/usePcaOverview.js';

export type PcaAccountOwnerMode = 'daemon' | 'wallet' | 'external' | 'unknown';

export type PcaAccountCardAccount = ResolvedPcaAccount & {
  ownerMode?: PcaAccountOwnerMode;
  primaryWallet?: string;
  connectedWallet?: string | null;
  walletWrongNetwork?: boolean;
};

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
 * Owner≠coverage (#11) and the three-key owner rule are enforced here: a fresh
 * owned PCA with 0 approved wallets says it discounts nothing yet, and owner-write
 * actions are enabled only for daemon-owned or connected-wallet-owned PCAs.
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
  onSwitchNetwork,
  view,
}: {
  account: PcaAccountCardAccount;
  blockExplorerUrl?: string | null;
  nowSec?: number;
  onManage?: (id: string) => void;
  onApproveWallets?: (id: string) => void;
  onUseForPublishing?: (id: string) => void;
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
  onSwitchNetwork?: () => void;
  view?: 'owner' | 'coverage';
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
  const ownerMode: PcaAccountOwnerMode = account.ownerMode ?? (ownerIsPrimaryWallet ? 'daemon' : 'external');
  const walletWrongNetwork = ownerMode === 'wallet' && !!account.walletWrongNetwork;
  const ownerWritesEnabled = ownerMode === 'daemon' || (ownerMode === 'wallet' && !walletWrongNetwork);
  const connectedAs = account.connectedWallet;
  const ownerActionTitle =
    ownerMode === 'daemon'
      ? undefined
      : ownerMode === 'wallet'
        ? walletWrongNetwork
          ? "Wrong network - switch the connected wallet to this node's PCA network."
          : 'Connected wallet will sign this owner action.'
        : connectedAs
          ? `Connected as ${connectedAs}; switch to ${snapshot.owner} to manage PCA #${accountId}.`
          : `Connect owner wallet ${snapshot.owner} to manage PCA #${accountId}.`;

  const titleBand = (
    <div className="v10-pca-card-title">
      <span className="v10-pca-card-id">PCA #{accountId}</span>
      <span className="badge badge-info v10-pca-card-discount">◉ {pct(snapshot.discountBps)} discount</span>
      {ownerMode === 'wallet' && <span className="badge badge-info">✎ wallet-managed</span>}
      {ownerMode === 'external' && <span className="badge badge-warn">tracked external</span>}
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

  const ownerNote =
    ownerMode === 'daemon'
      ? 'Daemon-managed: owner actions use this node’s primary operational wallet.'
      : ownerMode === 'wallet'
        ? 'Wallet-managed: owner actions are signed by the connected wallet.'
        : connectedAs
          ? `Read-only here: connected as ${connectedAs}; switch to the owner wallet to manage.`
          : 'Read-only here: connect the owner wallet to manage this PCA.';
  const showOwnerCard =
    view === 'coverage'
      ? false
      : view === 'owner'
        ? true
        : classification === 'owned' ||
          ownerMode === 'wallet' ||
          (ownerMode === 'external' && account.approvedCount === 0);

  // --- Owned / wallet-managed / tracked-external owner card ---
  if (showOwnerCard) {
    const selfCovers = account.approvedCount > 0;
    const inconclusive = account.probesInconclusive;
    return (
      <div
        className="card v10-pca-card"
        data-state="owned"
        data-owner-mode={ownerMode}
        data-account={accountId}
        data-testid="pca-account-card"
      >
        <div className="card-body">
          {titleBand}
          <StatStrip
            items={[
              { id: 'committed', label: 'Committed', value: `${formatPcaTrac(snapshot.committedTRACTrac)} TRAC` },
              { id: 'buffer', label: 'Top-up buffer', value: `${formatPcaTrac(snapshot.topUpBufferTrac)} TRAC` },
              { id: 'per-epoch', label: 'Per-epoch allowance', value: `${formatWeiToTrac(snapshot.baseEpochAllowance)} TRAC` },
              { id: 'wallets', label: 'Publishing wallets', value: `${snapshot.agentCount} / 100` },
            ]}
          />
          {ownerLine}
          {ownerMode === 'daemon' ? (
          <p className="v10-pca-card-owner-note">
            This is the node’s operational wallet — who <strong>signs</strong>, not who’s covered.
          </p>
          ) : (
            <p className="v10-pca-card-owner-note">{ownerNote}</p>
          )}
          {/* #11 — owner ≠ coverage. H2: never assert "0 approved" when the
              per-wallet probes couldn't be read — caveat instead of a false
              "discounts nothing yet". */}
          {walletWrongNetwork && (
            <p className="v10-pca-card-warn" role="alert">
              Wrong network. Reads still work, but wallet-owner writes are disabled until the wallet is
              switched.{' '}
              {onSwitchNetwork && (
                <button type="button" className="v10-pca-inline-btn" onClick={onSwitchNetwork}>
                  Switch network
                </button>
              )}
            </p>
          )}
          {ownerMode === 'external' && (
            <p className="v10-pca-card-warn">
              {connectedAs
                ? `Connected as ${connectedAs} - switch to ${snapshot.owner} to manage PCA #${accountId}.`
                : `Connect ${snapshot.owner} to manage PCA #${accountId}.`}
            </p>
          )}
          {inconclusive ? (
            <p className="v10-pca-card-warn">
              ⚠ Couldn’t verify which of this node’s wallets are approved — retry. Until then, whether
              this account discounts your publishes is unconfirmed.
            </p>
          ) : !selfCovers ? (
            <p className="v10-pca-card-warn">
              ⚠ 0 of this node’s wallets are approved here — it discounts nothing yet. Approve this
              node’s operational wallets to start saving.
            </p>
          ) : null}
          <p className="v10-pca-card-meta">
            {expiry}
            <span className="v10-pca-card-meta-sep"> · </span>
            <span title={`Expiry epoch ${snapshot.expiresAtEpoch}`}>epoch {snapshot.expiresAtEpoch} ⓘ</span>
          </p>
          <div className="v10-pca-card-actions">
            {onManage && (
              <button
                type="button"
                className="v10-pca-card-btn primary"
                onClick={() => onManage(accountId)}
              >
                {ownerMode === 'external' ? 'View details' : 'Manage'}
              </button>
            )}
            {ownerMode === 'external' ? (
              onRemove && (
                <button
                  type="button"
                  className="v10-pca-card-btn"
                  onClick={() => onRemove(accountId)}
                >
                  Stop tracking
                </button>
              )
            ) : (
              <button
                type="button"
                className="v10-pca-card-btn"
                onClick={() => onApproveWallets?.(accountId)}
                disabled={!ownerWritesEnabled || !onApproveWallets}
                title={ownerActionTitle}
              >
                Approve wallets
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // --- Approved-for-this-node compact account summary ---
  const allApproved = account.walletCount > 0 && account.approvedCount === account.walletCount;
  const inconclusive = account.probesInconclusive;
  return (
    <div className="card v10-pca-card" data-state="approved" data-account={accountId} data-testid="pca-account-card">
      <div className="card-body">
        <div className="v10-pca-card-title">
          <span className="v10-pca-card-id">PCA #{accountId}</span>
          <span className="v10-pca-card-sponsor">(approved for this node)</span>
          <span className="badge badge-info v10-pca-card-discount">◉ {pct(snapshot.discountBps)}</span>
          <span className="v10-pca-card-spacer" />
          {inconclusive ? (
            <span className="badge badge-warn">⚠ couldn’t verify approvals</span>
          ) : !allApproved && account.walletCount > 0 ? (
            <span className="badge badge-warn">
              ⚠ {account.approvedCount} of {account.walletCount} wallets approved
            </span>
          ) : null}
        </div>
        {ownerLine}
        <p className="v10-pca-card-meta">
          {expiry}
          <span className="v10-pca-card-meta-sep"> · </span>
          <span title={`Expiry epoch ${snapshot.expiresAtEpoch}`}>epoch {snapshot.expiresAtEpoch} ⓘ</span>
        </p>
        <p className="v10-pca-card-summary">
          {inconclusive
            ? 'Approval coverage could not be fully verified.'
            : `${account.approvedCount} of ${account.walletCount} node publishing wallet${account.walletCount === 1 ? '' : 's'} approved.`}
        </p>
        {inconclusive ? (
          <p className="v10-pca-card-warn">Couldn’t verify which wallets are approved — retry.</p>
        ) : !allApproved && account.walletCount > 0 ? (
          <p className="v10-pca-card-warn">
            Publishes from the un-approved wallet(s) will quietly pay the direct cost.
          </p>
        ) : null}
        <div className="v10-pca-card-actions">
          {onManage && (
            <button type="button" className="v10-pca-card-btn primary" onClick={() => onManage(accountId)}>
              View details
            </button>
          )}
          {/* L9: no global "publish" target — the discount auto-applies at the
              per-CG publish CTA. Guidance hint, not an inert disabled button.
              (If a caller ever wires onUseForPublishing, render the action.) */}
          {onUseForPublishing && (
            <button type="button" className="v10-pca-card-btn primary" onClick={() => onUseForPublishing(accountId)}>
              Use for publishing
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
