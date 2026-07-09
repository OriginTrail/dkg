import React from 'react';
import { WalletRow } from './WalletRow.js';
import { CopyButton, useCopy } from './CopyButton.js';

/**
 * The asymmetric copy/paste packet between an edge node and a PCA owner (UX
 * §5.4 step 6 / §5.6 step 3): the edge SHARES its operational wallets; the core
 * RETURNS the created account id. Two labelled halves — deliberately NOT a
 * forced-symmetric reuse. `role` only changes which half is emphasized.
 */
export function SponsorshipHandshake({
  wallets = [],
  accountId,
  role = 'edge',
  className = '',
}: {
  wallets?: string[];
  accountId?: string;
  role?: 'edge' | 'core';
  className?: string;
}) {
  const { copied, copy } = useCopy();
  const allWallets = wallets.join('\n');

  return (
    <div className={['v10-pca-handshake', className].filter(Boolean).join(' ')}>
      <section
        className="v10-pca-handshake-half"
        data-emphasis={role === 'edge' ? 'true' : 'false'}
      >
        <header className="v10-pca-handshake-head">
          <span className="v10-pca-handshake-title">Operational wallets</span>
          <span className="v10-pca-handshake-sub">
            The edge node shares these; the PCA owner approves them.
          </span>
        </header>
        {wallets.length === 0 ? (
          <p className="v10-pca-handshake-empty">No operational wallets detected on this node.</p>
        ) : (
          <>
            <div className="v10-pca-handshake-wallets">
              {wallets.map((w) => (
                <WalletRow key={w} address={w} />
              ))}
            </div>
            <button
              type="button"
              className="v10-pca-handshake-copyall"
              onClick={() => copy(allWallets)}
              aria-label={copied ? 'Copied all wallets' : 'Copy all wallet addresses'}
            >
              {copied ? 'Copied' : 'Copy all'}
            </button>
          </>
        )}
      </section>

      <section
        className="v10-pca-handshake-half"
        data-emphasis={role === 'core' ? 'true' : 'false'}
      >
        <header className="v10-pca-handshake-head">
          <span className="v10-pca-handshake-title">PCA ID from owner</span>
          <span className="v10-pca-handshake-sub">
            The PCA owner sends this back after approving the wallets.
          </span>
        </header>
        {accountId ? (
          <div className="v10-pca-handshake-account">
            <span className="v10-pca-handshake-account-id">PCA #{accountId}</span>
            <CopyButton value={accountId} label={`Copy account id ${accountId}`} />
          </div>
        ) : (
          <p className="v10-pca-handshake-empty">
            Pending - enter it once the PCA owner confirms the approval.
          </p>
        )}
      </section>
    </div>
  );
}
