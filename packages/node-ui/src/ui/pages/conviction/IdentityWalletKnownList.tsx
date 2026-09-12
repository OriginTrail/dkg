import React from 'react';
import type { OperationalWalletSnapshot } from '../../api.js';
import { WalletRow } from '../../components/Pca/index.js';
import { eqAddress } from '../../pca/address.js';
import type { IdentityWalletSummary } from '../../web3/identityWalletActions.js';
import type { IdentityWalletRole } from './useIdentityWalletManagement.js';

export function IdentityWalletKnownList({
  wallets,
  summary,
  writesEnabled,
  onRemove,
}: {
  wallets: OperationalWalletSnapshot['wallets'];
  summary: IdentityWalletSummary | null;
  writesEnabled: boolean;
  onRemove: (role: IdentityWalletRole, address: string) => void;
}) {
  if (wallets.length === 0) return null;
  return (
    <div className="v10-identity-wallet-known">
      <p className="v10-identity-wallet-subtitle">Wallets known to this node</p>
      <div className="v10-pca-wallet-list">
        {wallets.map((wallet) => {
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
                      data-testid={`remove-operational-${wallet.address}`}
                      onClick={() => onRemove('operational', wallet.address)}
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
                      data-testid={`remove-admin-${wallet.address}`}
                      onClick={() => onRemove('admin', wallet.address)}
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
  );
}
