import React, { useId, useState } from 'react';
import { HealthChip, RetryButton, formatPcaTrac, truncateAddress } from '../../components/Pca/index.js';
import type { ResolvedPcaAccount } from '../../hooks/usePcaOverview.js';
import type { DiscoveredPca } from '../../hooks/useDiscoveredPcas.js';
import { ownerModeWritesEnabled, type PcaOwnerMode } from '../../pca/ownerAccess.js';
import { Badge } from '../../components/ds/Badge.js';
import { formatBps } from '../../lib/format.js';

export type PcaListAccount = ResolvedPcaAccount & {
  ownerMode: PcaOwnerMode;
  walletWrongNetwork: boolean;
};

const DAY = 86400;

function pct(bps: number | undefined): string {
  return typeof bps === 'number' && Number.isFinite(bps) ? formatBps(bps) : '—';
}

function days(n: number): string {
  return `${n} day${n === 1 ? '' : 's'}`;
}

function expiryText(expiresAt: number | undefined, nowSec: number): string {
  if (!expiresAt || expiresAt <= 0) return '—';
  const left = Math.round(Math.abs(expiresAt - nowSec) / DAY);
  if (expiresAt > nowSec) return `In ${days(left)}`;
  return left === 0 ? 'Expired today' : `Expired ${days(left)} ago`;
}

function ownerText(account: PcaListAccount, walletsInconclusive: boolean): string {
  if (walletsInconclusive) return 'Couldn’t check';
  if (account.ownerMode === 'daemon') return 'This node';
  if (account.ownerMode === 'wallet') return 'Your wallet';
  return account.approvedCount > 0 ? 'Someone else' : 'Someone else, read-only';
}

function walletsCell(account: PcaListAccount, walletsInconclusive: boolean): { text: string; warn: boolean } {
  if (walletsInconclusive) return { text: 'Couldn’t check', warn: false };
  // H2 - a failed probe makes approvedCount a lower bound, so never state it as fact.
  if (account.probesInconclusive) return { text: 'Couldn’t check all', warn: true };
  const { approvedCount, walletCount, ownerMode } = account;
  if (approvedCount === 0) {
    return ownerMode === 'external' ? { text: 'None of yours', warn: false } : { text: 'None approved', warn: true };
  }
  if (ownerMode === 'external' && approvedCount < walletCount) {
    return { text: `${approvedCount} of ${walletCount} approved`, warn: true };
  }
  return { text: `${approvedCount} approved`, warn: false };
}

function Warn({ on, children }: { on: boolean; children: React.ReactNode }) {
  return on ? <Badge tone="warning" size="sm">{children}</Badge> : <>{children}</>;
}

function AccountRow({
  account,
  nowSec,
  walletsInconclusive,
  onManage,
  onApproveWallets,
  onRemove,
  onRetry,
}: {
  account: PcaListAccount;
  nowSec: number;
  walletsInconclusive: boolean;
  onManage: (id: string) => void;
  onApproveWallets: (id: string) => void;
  onRemove: (id: string) => void;
  onRetry: () => void;
}) {
  const { accountId, snapshot, notFound, ownerMode, walletWrongNetwork } = account;
  const id = <strong>#{accountId}</strong>;

  if (notFound || !snapshot) {
    return (
      <tr data-testid="pca-account-row" data-account={accountId} data-state={notFound ? 'not-found' : 'error'}>
        <td>{id}</td>
        <td className="ds-num">—</td>
        <td>—</td>
        <td className="ds-num">—</td>
        <td>
          <Warn on>{notFound ? `PCA #${accountId} can’t be found on-chain.` : `Couldn’t load PCA #${accountId}`}</Warn>
        </td>
        <td>—</td>
        <td className="ds-num">
          {notFound ? (
            <button type="button" className="v10-pca-card-btn ds-btn ds-sm" onClick={() => onRemove(accountId)}>Remove from list</button>
          ) : (
            <RetryButton onClick={onRetry} />
          )}
        </td>
      </tr>
    );
  }

  const wallets = walletsCell(account, walletsInconclusive);
  const expiringSoon = account.health === 'expiring' || account.health === 'expired';
  const needsApproval = ownerMode !== 'external' && !walletsInconclusive && !account.probesInconclusive
    && account.approvedCount === 0 && account.health !== 'expired';
  const writesEnabled = ownerModeWritesEnabled(ownerMode, walletWrongNetwork);
  const showChip = account.health === 'insolvent' || account.health === 'cap-near';

  return (
    <tr data-testid="pca-account-row" data-account={accountId} data-state="loaded" data-owner-mode={ownerMode}>
      <td>
        <button type="button" className="v10-pca-inline-btn" aria-label={`Open PCA #${accountId}`} onClick={() => onManage(accountId)}>
          #{accountId}
        </button>
        {showChip && account.health && <> <HealthChip state={account.health} /></>}
      </td>
      <td className="ds-num">{pct(snapshot.discountBps)}</td>
      <td>{ownerText(account, walletsInconclusive)}</td>
      <td className="ds-num">{formatPcaTrac(snapshot.committedTRACTrac)} TRAC</td>
      <td><Warn on={wallets.warn}>{wallets.text}</Warn></td>
      <td><Warn on={expiringSoon}>{expiryText(snapshot.expiresAtTimestamp, nowSec)}</Warn></td>
      <td className="ds-num">
        <span className="v10-pca-row-actions">
          {needsApproval ? (
            <button
              type="button"
              className="v10-pca-card-btn ds-btn ds-sm"
              disabled={!writesEnabled}
              title={walletWrongNetwork ? 'Wrong network. Switch your wallet to this node’s network.' : undefined}
              onClick={() => onApproveWallets(accountId)}
            >
              Approve wallets
            </button>
          ) : (
            <button type="button" className="v10-pca-card-btn ds-btn ds-sm" onClick={() => onManage(accountId)}>
              {ownerMode === 'external' ? 'View' : 'Manage'}
            </button>
          )}
          {ownerMode === 'external' && account.approvedCount === 0 && !walletsInconclusive && (
            <button type="button" className="v10-pca-card-btn ds-btn ds-sm" onClick={() => onRemove(accountId)}>Remove from list</button>
          )}
        </span>
      </td>
    </tr>
  );
}

function FoundRow({ item, nowSec, onAdd }: { item: DiscoveredPca; nowSec: number; onAdd: (id: string) => void }) {
  const { accountId, basics, relation } = item;
  // #9 - only show a discount this node actually draws: on an owned-only PCA no wallet
  // is approved, so its tier isn't a discount this node gets.
  const draws = relation === 'agent' || relation === 'both';
  return (
    <tr data-testid="pca-discovered-row" data-account={accountId}>
      <td><strong>#{accountId}</strong></td>
      <td className="ds-num">{draws ? pct(basics?.discountBps) : '—'}</td>
      <td>{relation === 'agent' ? 'Someone else' : 'This node'}</td>
      <td className="ds-num">{basics?.committedTRACTrac != null ? `${formatPcaTrac(basics.committedTRACTrac)} TRAC` : '—'}</td>
      <td>Found on-chain</td>
      <td>{expiryText(basics?.expiresAtTimestamp, nowSec)}</td>
      <td className="ds-num">
        <button type="button" className="v10-pca-card-btn ds-btn ds-sm" data-testid="pca-discovered-track" onClick={() => onAdd(accountId)}>Add</button>
      </td>
    </tr>
  );
}

function AddById({ onAdd }: { onAdd: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();

  const submit = () => {
    const id = value.trim();
    if (!/^\d+$/.test(id)) {
      setError('Enter the PCA ID as a number.');
      return;
    }
    onAdd(id);
    setValue('');
    setError(null);
    setOpen(false);
  };

  return (
    <div className="v10-pca-add-by-id">
      {open ? (
        <div id={panelId} className="v10-pca-overview-cta-group">
          <input
            type="text"
            className="v10-form-input ds-input ds-sm"
            data-testid="pca-track-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="PCA ID (for example 7)"
            aria-label="PCA ID to add"
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
          <button type="button" className="v10-pca-card-btn primary ds-btn ds-primary ds-sm" data-testid="pca-track-submit" onClick={submit}>
            Add
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="v10-pca-card-btn ds-btn ds-sm"
          data-testid="pca-track-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(true)}
        >
          Add by ID
        </button>
      )}
      {error && <p className="v10-pca-crux-error" role="alert">{error}</p>}
    </div>
  );
}

/** One list for every PCA this node knows about, whoever owns it. */
export function PcaAccountList({
  accounts,
  found,
  loading,
  walletsInconclusive,
  onManage,
  onApproveWallets,
  onRemove,
  onRetry,
  onAddFound,
  onAddById,
  pendingId,
  readingWallet,
  nowSec = Math.floor(Date.now() / 1000),
}: {
  accounts: PcaListAccount[];
  found: DiscoveredPca[];
  loading: boolean;
  walletsInconclusive: boolean;
  onManage: (id: string) => void;
  onApproveWallets: (id: string) => void;
  onRemove: (id: string) => void;
  onRetry: () => void;
  onAddFound: (id: string) => void;
  onAddById: (id: string) => void;
  pendingId: string | null;
  /** The full address of the wallet being read; shown shortened, in full on hover. */
  readingWallet: string | null;
  nowSec?: number;
}) {
  const hasRows = accounts.length > 0 || found.length > 0;
  const partial = !walletsInconclusive && accounts.some(
    (a) => a.ownerMode === 'external' && a.approvedCount > 0 && a.approvedCount < a.walletCount && !a.probesInconclusive,
  );

  return (
    <section className="v10-pca-section" data-testid="pca-list">
      <div className="v10-pca-section-head">
        <h3 className="v10-pca-section-title">{hasRows || loading ? 'PCAs' : 'Already have a PCA?'}</h3>
        <AddById onAdd={onAddById} />
      </div>
      {pendingId && (
        <p className="v10-pca-track-status" role="status" data-testid="pca-track-status">
          Checking PCA #{pendingId}. It will appear here shortly.
        </p>
      )}
      {loading && !hasRows && <div className="card ds-card v10-pca-card v10-pca-card-skeleton" aria-hidden="true" />}
      {hasRows && (
        <div className="ds-table-scroll"><table className="data-table v10-pca-list">
            <thead>
              <tr>
                <th>PCA</th>
                <th className="ds-num">Discount</th>
                <th>Owner</th>
                <th className="ds-num">Committed</th>
                <th>Wallets</th>
                <th>Expires</th>
                <th className="ds-num"><span className="v10-sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <AccountRow
                  key={account.accountId}
                  account={account}
                  nowSec={nowSec}
                  walletsInconclusive={walletsInconclusive}
                  onManage={onManage}
                  onApproveWallets={onApproveWallets}
                  onRemove={onRemove}
                  onRetry={onRetry}
                />
              ))}
              {found.map((item) => (
                <FoundRow key={item.accountId} item={item} nowSec={nowSec} onAdd={onAddFound} />
              ))}
            </tbody>
          </table></div>
      )}
      {partial && <p className="v10-pca-overview-caveat">Wallets that aren’t approved pay the full fee, without any warning.</p>}
      {readingWallet && (
        <p className="v10-pca-overview-caveat" role="status">
          Reading PCAs owned by <span title={readingWallet}>{truncateAddress(readingWallet)}</span>…
        </p>
      )}
    </section>
  );
}
