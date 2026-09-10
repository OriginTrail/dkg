import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getAddress, type Address, type Hex } from 'viem';
import { fetchOperationalWallets } from '../../api.js';
import { WalletConnectControl, WalletPill, WalletRow } from '../../components/Pca/index.js';
import { useFetch } from '../../hooks.js';
import { eqAddress } from '../../pca/address.js';
import { useWalletStore, isWrongNetwork } from '../../stores/wallet.js';
import { publicClientFor } from '../../web3/clients.js';
import {
  IdentityWalletActionError,
  identityWalletActionSubmitter,
  readIdentityWalletSummary,
  type IdentityWalletAction,
  type IdentityWalletSummary,
} from '../../web3/identityWalletActions.js';
import { describeWalletTxError, WalletReceiptWaitError, WalletTxStepError } from '../../web3/walletTxError.js';

type KeyRole = 'operational' | 'admin';

interface PendingRemoval {
  role: KeyRole;
  address: Address;
}

interface CompletedAction {
  action: IdentityWalletAction;
  address: Address;
  txHash: Hex;
  confirmed: boolean;
}

function parseAddress(value: string, label: string): Address {
  try {
    return getAddress(value.trim()) as Address;
  } catch {
    throw new IdentityWalletActionError(`${label} must be a valid EVM address.`);
  }
}

function actionLabel(action: IdentityWalletAction): string {
  switch (action) {
    case 'add-operational': return 'Operational wallet registered';
    case 'remove-operational': return 'Operational wallet removed';
    case 'add-admin': return 'Admin wallet registered';
    case 'remove-admin': return 'Admin wallet removed';
  }
}

function actionError(err: unknown): string {
  if (err instanceof IdentityWalletActionError) return err.message;
  const info = describeWalletTxError(err, 'action');
  if (info.kind === 'rejected') return 'You rejected the transaction. No identity key was changed.';
  return info.message;
}

/**
 * Hardware-wallet identity key management, colocated with the PCA publishing-wallet view.
 * Contract writes never pass through the daemon: the connected, already-authorized admin
 * wallet signs Profile/Identity calls directly.
 */
export function IdentityWalletsSection({ blockExplorerUrl }: { blockExplorerUrl: string | null }) {
  const { data, loading, error: loadError, refresh } = useFetch(fetchOperationalWallets, [], 0);
  const bootstrap = useWalletStore((s) => s.bootstrap);
  const connected = useWalletStore((s) => s.address);
  const wrongNetwork = useWalletStore((s) => isWrongNetwork(s));
  const [summary, setSummary] = useState<IdentityWalletSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [operationalAddress, setOperationalAddress] = useState('');
  const [adminAddress, setAdminAddress] = useState('');
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null);
  const [pendingAction, setPendingAction] = useState<IdentityWalletAction | null>(null);
  const [phase, setPhase] = useState<'idle' | 'signing' | 'submitted'>('idle');
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null);
  const [completed, setCompleted] = useState<CompletedAction | null>(null);

  const knownAddresses = useMemo(() => {
    const addresses = [...(data?.wallets.map((wallet) => wallet.address) ?? [])];
    if (connected) addresses.push(connected);
    return addresses;
  }, [connected, data]);
  const knownAddressesKey = knownAddresses.join('|').toLowerCase();

  const reloadSummary = useCallback(() => {
    setRefreshNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!data?.hasProfile || !bootstrap?.identityStorage) {
      setSummary(null);
      setSummaryError(null);
      setSummaryLoading(false);
      return;
    }
    setSummaryLoading(true);
    setSummaryError(null);
    const client = publicClientFor(bootstrap.chainId, bootstrap.rpcUrls);
    void readIdentityWalletSummary(bootstrap, client, data.identityId, knownAddresses)
      .then((next) => {
        if (!cancelled) setSummary(next);
      })
      .catch((err) => {
        if (!cancelled) {
          setSummary(null);
          setSummaryError((err as Error)?.message ?? 'Could not read identity keys from chain.');
        }
      })
      .finally(() => {
        if (!cancelled) setSummaryLoading(false);
      });
    return () => { cancelled = true; };
  }, [bootstrap, data?.hasProfile, data?.identityId, knownAddressesKey, refreshNonce]);

  const connectedRoles = summary?.addresses.find((item) => eqAddress(item.address, connected));
  const connectedIsAdmin = connectedRoles?.admin === true;
  const identityContractsReady = Boolean(bootstrap?.profile && bootstrap?.identity && bootstrap?.identityStorage);
  const writesEnabled = Boolean(
    data?.hasProfile &&
    identityContractsReady &&
    connected &&
    connectedIsAdmin &&
    !wrongNetwork &&
    !pendingAction,
  );
  const primaryAddress = data?.wallets.find((wallet) => wallet.isPrimary)?.address ?? null;

  const submit = async (action: IdentityWalletAction, addressValue: string) => {
    setActionErrorMessage(null);
    setCompleted(null);
    let address: Address;
    try {
      address = parseAddress(
        addressValue,
        action.includes('admin') ? 'Admin wallet' : 'Operational wallet',
      );
    } catch (err) {
      setActionErrorMessage(actionError(err));
      return;
    }
    if (!data?.hasProfile) {
      setActionErrorMessage('This node does not have an on-chain identity profile.');
      return;
    }
    setPendingAction(action);
    setPhase('signing');
    try {
      const submitter = identityWalletActionSubmitter({
        onProgress: (event) => {
          if (event.state === 'submitted') setPhase('submitted');
          else if (event.state === 'signing') setPhase('signing');
        },
      });
      const result = action === 'add-operational'
        ? await submitter.addOperational(data.identityId, address)
        : action === 'remove-operational'
          ? await submitter.removeOperational(data.identityId, address, primaryAddress)
          : action === 'add-admin'
            ? await submitter.addAdmin(data.identityId, address)
            : await submitter.removeAdmin(data.identityId, address);
      setCompleted({ action, address: result.address, txHash: result.txHash, confirmed: true });
      setPendingRemoval(null);
      if (action === 'add-operational') setOperationalAddress('');
      if (action === 'add-admin') setAdminAddress('');
      refresh();
      reloadSummary();
    } catch (err) {
      setActionErrorMessage(actionError(err));
      // A receipt wait failure carries a tx hash: keep it visible so the operator
      // can reconcile before retrying and accidentally issuing a duplicate rotation.
      const txHash = err instanceof WalletReceiptWaitError
        ? err.txHash
        : err instanceof WalletTxStepError && err.cause instanceof WalletReceiptWaitError
          ? err.cause.txHash
          : undefined;
      if (txHash) setCompleted({ action, address, txHash: txHash as Hex, confirmed: false });
    } finally {
      setPendingAction(null);
      setPhase('idle');
    }
  };

  const askRemove = (role: KeyRole, value: string) => {
    setActionErrorMessage(null);
    try {
      const address = parseAddress(value, role === 'admin' ? 'Admin wallet' : 'Operational wallet');
      if (role === 'operational' && primaryAddress && eqAddress(address, primaryAddress)) {
        throw new IdentityWalletActionError(
          'The primary operational wallet cannot be removed because it anchors this node\'s on-chain identity.',
        );
      }
      setPendingRemoval({ role, address });
    } catch (err) {
      setActionErrorMessage(actionError(err));
    }
  };

  const confirmRemoval = () => {
    if (!pendingRemoval) return;
    void submit(
      pendingRemoval.role === 'admin' ? 'remove-admin' : 'remove-operational',
      pendingRemoval.address,
    );
  };

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
      {summaryError && (
        <p className="v10-modal-warning" role="alert">
          Couldn&apos;t verify identity keys: {summaryError}{' '}
          <button type="button" className="v10-pca-card-btn compact" onClick={reloadSummary}>Retry</button>
        </p>
      )}

      {data?.wallets && data.wallets.length > 0 && (
        <div className="v10-identity-wallet-known">
          <p className="v10-identity-wallet-subtitle">Wallets known to this node</p>
          <div className="v10-pca-wallet-list">
            {data.wallets.map((wallet) => {
              const roles = summary?.addresses.find((item) => eqAddress(item.address, wallet.address));
              const status = [
                wallet.isPrimary ? 'primary' : null,
                roles?.operational === true || wallet.registered === true ? 'operational' : null,
                roles?.admin === true ? 'admin' : null,
                wallet.registered === null ? 'chain status unknown' : null,
              ].filter(Boolean).join(' · ') || 'not registered';
              return (
                <WalletRow
                  key={wallet.address}
                  address={wallet.address}
                  status={status}
                  statusTone={wallet.registered === null ? 'warn' : roles?.operational || roles?.admin ? 'success' : 'danger'}
                  trailing={
                    <span className="v10-identity-wallet-row-actions">
                      {(roles?.operational === true || wallet.registered === true) && (
                        <button
                          type="button"
                          className="v10-pca-card-btn compact"
                          onClick={() => askRemove('operational', wallet.address)}
                          disabled={!writesEnabled || wallet.isPrimary}
                          title={wallet.isPrimary ? 'The primary operational wallet cannot be removed.' : undefined}
                        >
                          Remove operational
                        </button>
                      )}
                      {roles?.admin === true && (
                        <button
                          type="button"
                          className="v10-pca-card-btn compact"
                          onClick={() => askRemove('admin', wallet.address)}
                          disabled={!writesEnabled || (summary?.adminCount ?? 0) <= 1}
                          title={(summary?.adminCount ?? 0) <= 1 ? 'Add a replacement admin before removing the final admin key.' : undefined}
                        >
                          Remove admin
                        </button>
                      )}
                    </span>
                  }
                />
              );
            })}
          </div>
        </div>
      )}

      <div className="v10-identity-wallet-grid">
        <div className="v10-identity-wallet-card">
          <h4>Operational keys</h4>
          <p>
            These wallets sign publishes. Registering an address does not copy its private key into this node;
            it must already be present in the node&apos;s operational wallet pool to participate in rotation.
          </p>
          <label htmlFor="identity-operational-address">Operational wallet address</label>
          <input
            id="identity-operational-address"
            className="v10-form-input mono"
            value={operationalAddress}
            onChange={(event) => setOperationalAddress(event.target.value)}
            placeholder="0x…"
            autoComplete="off"
            spellCheck={false}
          />
          <div className="v10-identity-wallet-actions">
            <button
              type="button"
              className="v10-pca-card-btn primary"
              onClick={() => void submit('add-operational', operationalAddress)}
              disabled={!writesEnabled || !operationalAddress.trim()}
            >
              Register operational
            </button>
            <button
              type="button"
              className="v10-pca-card-btn"
              onClick={() => askRemove('operational', operationalAddress)}
              disabled={!writesEnabled || !operationalAddress.trim()}
            >
              Remove operational
            </button>
          </div>
        </div>

        <div className="v10-identity-wallet-card">
          <h4>Admin keys</h4>
          <p>
            Admin addresses are stored on-chain as hashes, so they cannot be enumerated back into addresses.
            Enter the exact address when rotating an old key. The contract never allows the final admin key to be removed.
          </p>
          <label htmlFor="identity-admin-address">Admin wallet address</label>
          <input
            id="identity-admin-address"
            className="v10-form-input mono"
            value={adminAddress}
            onChange={(event) => setAdminAddress(event.target.value)}
            placeholder="0x…"
            autoComplete="off"
            spellCheck={false}
          />
          <div className="v10-identity-wallet-actions">
            <button
              type="button"
              className="v10-pca-card-btn primary"
              onClick={() => void submit('add-admin', adminAddress)}
              disabled={!writesEnabled || !adminAddress.trim()}
            >
              Register admin
            </button>
            <button
              type="button"
              className="v10-pca-card-btn"
              onClick={() => askRemove('admin', adminAddress)}
              disabled={!writesEnabled || !adminAddress.trim() || (summary?.adminCount ?? 0) <= 1}
            >
              Remove admin
            </button>
          </div>
        </div>
      </div>

      {pendingRemoval && (
        <div className="v10-modal-warning v10-identity-wallet-confirm" role="alertdialog" aria-label="Confirm key removal">
          <span>
            Remove {pendingRemoval.address} as an {pendingRemoval.role} key from identity {data?.identityId}?
            This takes effect on-chain immediately.
          </span>
          <button type="button" className="v10-pca-card-btn" onClick={confirmRemoval} disabled={pendingAction != null}>
            Yes, remove
          </button>
          <button type="button" className="v10-pca-card-btn" onClick={() => setPendingRemoval(null)} disabled={pendingAction != null}>
            Cancel
          </button>
        </div>
      )}

      {pendingAction && (
        <p className="v10-pca-inline-status" role="status">
          {phase === 'submitted' ? 'Transaction submitted — waiting for on-chain confirmation…' : 'Confirm the identity-key transaction on your wallet device…'}
        </p>
      )}
      {actionErrorMessage && <p className="v10-modal-error" role="alert">{actionErrorMessage}</p>}
      {completed && (
        <div className="v10-pca-inline-status" role="status" data-testid="identity-wallet-result">
          {completed.confirmed
            ? `✓ ${actionLabel(completed.action)}: ${completed.address}. `
            : `Transaction broadcast for ${completed.address}, but confirmation is unknown. Check it before retrying. `}
          {resultUrl && <a href={resultUrl} target="_blank" rel="noreferrer">View transaction ↗</a>}
          {completed.confirmed && completed.action.includes('operational') && (
            <span> Restart the node before relying on the updated operational signer rotation.</span>
          )}
        </div>
      )}
    </section>
  );
}
