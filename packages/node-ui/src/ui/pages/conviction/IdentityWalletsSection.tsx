import React from 'react';
import { WalletConnectControl, WalletPill } from '../../components/Pca/index.js';
import { IdentityWalletKnownList } from './IdentityWalletKnownList.js';
import { IdentityWalletRoleEditor } from './IdentityWalletRoleEditor.js';
import {
  IDENTITY_WALLET_ACTION_META,
  useIdentityWalletManagement,
} from './useIdentityWalletManagement.js';

/**
 * Hardware-wallet identity key management, colocated with the PCA publishing-wallet view.
 * Contract writes never pass through the daemon: the connected, already-authorized admin
 * wallet signs Profile/Identity calls directly.
 */
export function IdentityWalletsSection({ blockExplorerUrl }: { blockExplorerUrl: string | null }) {
  const management = useIdentityWalletManagement();
  const {
    data,
    loading,
    loadError,
    refresh,
    bootstrap,
    connected,
    wrongNetwork,
    summary,
    summaryError,
    summaryLoading,
    reloadSummary,
    connectedIsAdmin,
    identityContractsReady,
    writesEnabled,
    inputs,
    setInput,
    removal,
    requestRemoval,
    cancelRemoval,
    confirmRemoval,
    submit,
    transaction,
    transactionPending,
  } = management;

  const completed = transaction.status === 'succeeded'
    ? transaction.completed
    : transaction.status === 'failed'
      ? transaction.completed
      : undefined;
  const actionErrorMessage = transaction.status === 'failed' ? transaction.message : null;
  const resultUrl = completed && blockExplorerUrl
    ? `${blockExplorerUrl.replace(/\/$/, '')}/tx/${completed.txHash}`
    : null;

  return (
    <section className="v10-pca-section v10-identity-wallets" data-testid="identity-wallets-section">
      <div className="v10-pca-section-head">
        <div>
          <h3 className="v10-pca-section-title">Node identity wallets</h3>
          <p className="v10-pca-overview-caveat">
            Register and rotate operational or admin keys for node identity{' '}
            {data?.hasProfile ? data.identityId : '—'}.
            Every change is signed by the connected admin wallet; its private key never enters the node.
          </p>
        </div>
        <div className="v10-identity-wallet-counts" aria-label="Identity wallet counts">
          <span className="badge badge-info">{summary?.operationalCount ?? '—'} operational</span>
          <span className="badge badge-info">{summary?.adminCount ?? '—'} admin</span>
        </div>
      </div>

      <div className="v10-identity-wallet-signer">
        {connected ? <WalletPill /> : <WalletConnectControl className="compact" />}
        {connected && !summaryLoading && !summaryError && (
          <span className={`badge ${connectedIsAdmin ? 'badge-success' : 'badge-warn'}`}>
            {connectedIsAdmin ? 'authorized admin signer' : 'not an admin for this identity'}
          </span>
        )}
      </div>

      {loading && !data && <p className="v10-pca-inline-status" role="status">Loading node identity wallets…</p>}
      {loadError && !data && (
        <p className="v10-modal-warning" role="alert">
          Couldn&apos;t load this node&apos;s wallet list.{' '}
          <button type="button" className="v10-pca-card-btn compact" onClick={() => refresh()}>Retry</button>
        </p>
      )}
      {data && !data.hasProfile && (
        <p className="v10-modal-warning" role="status">This node does not have an on-chain identity profile yet.</p>
      )}
      {data?.hasProfile && bootstrap && !identityContractsReady && (
        <p className="v10-modal-warning" role="status">
          Identity wallet management requires a node version that exposes the Profile, Identity, and IdentityStorage addresses.
        </p>
      )}
      {wrongNetwork && (
        <p className="v10-modal-warning" role="status">Switch the connected wallet to this node&apos;s network to manage identity keys.</p>
      )}
      {summaryError && (
        <p className="v10-modal-warning" role="alert">
          Couldn&apos;t verify identity keys: {summaryError}{' '}
          <button type="button" className="v10-pca-card-btn compact" onClick={reloadSummary}>Retry</button>
        </p>
      )}

      <IdentityWalletKnownList
        wallets={data?.wallets ?? []}
        summary={summary}
        writesEnabled={writesEnabled}
        onRemove={requestRemoval}
      />

      <div className="v10-identity-wallet-grid">
        <IdentityWalletRoleEditor
          role="operational"
          value={inputs.operational}
          writesEnabled={writesEnabled}
          onChange={(value) => setInput('operational', value)}
          onSubmit={(action, address) => void submit(action, address)}
          onRemove={requestRemoval}
        />
        <IdentityWalletRoleEditor
          role="admin"
          value={inputs.admin}
          writesEnabled={writesEnabled}
          finalAdmin={(summary?.adminCount ?? 0) <= 1}
          onChange={(value) => setInput('admin', value)}
          onSubmit={(action, address) => void submit(action, address)}
          onRemove={requestRemoval}
        />
      </div>

      {removal && (
        <div className="v10-modal-warning v10-identity-wallet-confirm" role="alertdialog" aria-label="Confirm key removal">
          <span>
            Remove {removal.address} as an {removal.role} key from identity {data?.identityId}?
            This takes effect on-chain immediately.
          </span>
          <button type="button" className="v10-pca-card-btn" onClick={confirmRemoval} disabled={transactionPending}>
            Yes, remove
          </button>
          <button type="button" className="v10-pca-card-btn" onClick={cancelRemoval} disabled={transactionPending}>
            Cancel
          </button>
        </div>
      )}

      {transactionPending && (
        <p className="v10-pca-inline-status" role="status">
          {transaction.status === 'submitted'
            ? 'Transaction submitted — waiting for on-chain confirmation…'
            : 'Confirm the identity-key transaction on your wallet device…'}
        </p>
      )}
      {actionErrorMessage && <p className="v10-modal-error" role="alert">{actionErrorMessage}</p>}
      {completed && (
        <div className="v10-pca-inline-status" role="status" data-testid="identity-wallet-result">
          {completed.confirmed
            ? `✓ ${IDENTITY_WALLET_ACTION_META[completed.action].label}: ${completed.address}. `
            : `Transaction broadcast for ${completed.address}, but confirmation is unknown. Check it before retrying. `}
          {resultUrl && <a href={resultUrl} target="_blank" rel="noreferrer">View transaction ↗</a>}
          {completed.confirmed && IDENTITY_WALLET_ACTION_META[completed.action].role === 'operational' && (
            <span> Restart the node before relying on the updated operational signer rotation.</span>
          )}
        </div>
      )}
    </section>
  );
}
