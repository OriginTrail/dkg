import React, { useState } from 'react';
import { Power, RefreshCw } from 'lucide-react';
import { useWalletStore, isWrongNetwork } from '../../stores/wallet.js';
import { truncateAddress } from './format.js';

function providerLabel(name?: string | null): string {
  const trimmed = name?.trim();
  return trimmed || 'browser wallet';
}

/**
 * Persistent connected-wallet chip for the PCA tab. Provider metadata is
 * display-only; the chain guard is the actionable state.
 */
export function WalletPill({ className = '' }: { className?: string }) {
  const address = useWalletStore((s) => s.address);
  const providerInfo = useWalletStore((s) => s.providerInfo);
  const chainId = useWalletStore((s) => s.chainId);
  const expectedChainId = useWalletStore((s) => s.expectedChainId);
  const wrongNetwork = useWalletStore((s) => isWrongNetwork(s));
  const disconnect = useWalletStore((s) => s.disconnect);
  const switchToExpectedChain = useWalletStore((s) => s.switchToExpectedChain);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!address) return null;

  const onSwitch = async () => {
    setSwitching(true);
    setError(null);
    try {
      await switchToExpectedChain();
    } catch (err) {
      setError((err as Error)?.message ?? 'Could not switch wallet network.');
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className={['v10-pca-wallet-pill-wrap', className].filter(Boolean).join(' ')}>
      <div className="v10-pca-wallet-pill" data-state={wrongNetwork ? 'wrong-network' : 'connected'}>
        <span className="v10-pca-wallet-pill-main" title={address}>
          {truncateAddress(address)}
        </span>
        <span className="v10-pca-wallet-pill-provider">
          via {providerLabel(providerInfo?.name)}
        </span>
        {wrongNetwork ? (
          <span className="badge badge-warn v10-pca-wallet-pill-network" role="alert">
            wrong network
          </span>
        ) : (
          <span className="badge badge-success">connected</span>
        )}
        <button
          type="button"
          className="v10-pca-wallet-pill-btn"
          onClick={disconnect}
          title="Disconnect this wallet before switching to another wallet"
        >
          <Power size={13} aria-hidden="true" />
          <span>Disconnect</span>
        </button>
      </div>
      {wrongNetwork && (
        <div className="v10-pca-wallet-pill-sub">
          <span>
            Connected chain {chainId ?? '-'}; node expects {expectedChainId ?? '-'}.
          </span>
          <button
            type="button"
            className="v10-pca-wallet-pill-link"
            onClick={onSwitch}
            disabled={switching}
          >
            <RefreshCw size={12} aria-hidden="true" />
            <span>{switching ? 'Switching...' : 'Switch'}</span>
          </button>
        </div>
      )}
      {error && (
        <p className="v10-pca-wallet-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
