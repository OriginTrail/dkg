import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Loader2, Wallet } from 'lucide-react';
import { useWalletStore } from '../../stores/wallet.js';
import type { Eip6963ProviderDetail } from '../../web3/eip6963.js';
import { WalletPill } from './WalletPill.js';

function providerName(detail: Eip6963ProviderDetail): string {
  return detail.info.name?.trim() || detail.info.rdns || 'Browser wallet';
}

function providerKey(detail: Eip6963ProviderDetail): string {
  return detail.info.uuid || `${detail.info.rdns}:${detail.info.name}`;
}

/**
 * PCA-local wallet connect surface. It starts EIP-6963 discovery only while PCA
 * UI is mounted, keeps provider metadata display-only, and uses conditional
 * hardware copy per inv-14.
 */
export function WalletConnectControl({ className = '' }: { className?: string }) {
  const discovered = useWalletStore((s) => s.discovered);
  const unsupported = useWalletStore((s) => s.unsupported);
  const address = useWalletStore((s) => s.address);
  const initWallet = useWalletStore((s) => s.initWallet);
  const connect = useWalletStore((s) => s.connect);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    initWallet();
  }, [initWallet]);

  const unsupportedNames = useMemo(
    () => unsupported.map((d) => providerName(d)).join(', '),
    [unsupported],
  );

  if (address) {
    return (
      <div className={['v10-pca-wallet-connect', className].filter(Boolean).join(' ')}>
        <WalletPill />
        <p className="v10-pca-wallet-note">
          One active wallet in v1. Disconnect to switch accounts or providers.
        </p>
      </div>
    );
  }

  const connectDetail = async (detail: Eip6963ProviderDetail) => {
    const key = providerKey(detail);
    setBusyKey(key);
    setError(null);
    try {
      await connect(detail);
      setPickerOpen(false);
    } catch (err) {
      setError((err as Error)?.message ?? 'Wallet connection failed.');
    } finally {
      setBusyKey(null);
    }
  };

  const onMainClick = () => {
    if (discovered.length === 1) {
      void connectDetail(discovered[0]!);
      return;
    }
    setPickerOpen((open) => !open);
  };

  return (
    <div className={['v10-pca-wallet-connect', className].filter(Boolean).join(' ')}>
      <button
        type="button"
        className="v10-pca-wallet-connect-btn"
        data-testid="pca-wallet-connect"
        onClick={onMainClick}
        aria-expanded={pickerOpen}
      >
        {busyKey ? <Loader2 size={14} aria-hidden="true" /> : <Wallet size={14} aria-hidden="true" />}
        <span>{busyKey ? 'Connecting...' : 'Connect hardware wallet'}</span>
        {discovered.length !== 1 && <ChevronDown size={14} aria-hidden="true" />}
      </button>
      <p className="v10-pca-wallet-note">
        Hardware wallet recommended. If your provider uses a device, verify the amount and contract on
        the device. Hot publishing wallets can publish without prompts; their spend is bounded by the
        per-epoch allowance, not the committed TRAC.
      </p>
      <p className="v10-pca-wallet-note">
        Provider names are self-reported and display-only.
      </p>
      {pickerOpen && (
        <div className="v10-pca-wallet-picker" role="menu" aria-label="Wallet providers">
          {discovered.length > 0 ? (
            discovered.map((detail) => {
              const key = providerKey(detail);
              return (
                <button
                  key={key}
                  type="button"
                  className="v10-pca-wallet-provider"
                  role="menuitem"
                  onClick={() => void connectDetail(detail)}
                  disabled={busyKey != null}
                >
                  {detail.info.icon && (
                    <img src={detail.info.icon} alt="" aria-hidden="true" className="v10-pca-wallet-provider-icon" />
                  )}
                  <span>{providerName(detail)}</span>
                  {busyKey === key && <Loader2 size={13} aria-hidden="true" />}
                </button>
              );
            })
          ) : (
            <p className="v10-pca-wallet-picker-empty">
              No supported injected wallet detected. Use a browser wallet that can connect to your hardware wallet.
            </p>
          )}
        </div>
      )}
      {unsupportedNames && (
        <p className="v10-pca-wallet-note" role="status">
          Unsupported provider detected: {unsupportedNames}.
        </p>
      )}
      {error && (
        <p className="v10-pca-wallet-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
