import React from 'react';
import type { ReactNode } from 'react';
import { CopyButton } from './CopyButton.js';
import { truncateAddress } from './format.js';

/** Textual status tone for the wallet's approval/funding state. */
export type WalletRowTone = 'success' | 'warn' | 'danger' | 'neutral';

/**
 * A centralised truncated-address row, reused everywhere a wallet appears
 * (S1/S3/S4/S5/S6). The FULL address and status live in the row's accessible
 * name (`aria-label`) so a screen reader never gets only the truncated form;
 * the status is rendered as TEXT (not glyph-only) for the same reason. The copy
 * control has a ≥24×24 hit area (see `CopyButton`).
 */
export function WalletRow({
  address,
  status,
  statusTone = 'neutral',
  gas,
  trailing,
  className = '',
}: {
  address: string;
  /** Textual status, e.g. "approved" / "not approved". */
  status?: ReactNode;
  statusTone?: WalletRowTone;
  /** Optional secondary line, e.g. native-gas balance. */
  gas?: ReactNode;
  /** Trailing controls, e.g. a Remove button. */
  trailing?: ReactNode;
  className?: string;
}) {
  // Build the accessible name from the FULL address + the textual status.
  const statusText = typeof status === 'string' ? status : undefined;
  const ariaLabel = statusText ? `${address}, ${statusText}` : address;

  return (
    <div
      className={['v10-pca-wallet-row', className].filter(Boolean).join(' ')}
      role="group"
      aria-label={ariaLabel}
    >
      <span className="v10-pca-wallet-addr" title={address}>
        {truncateAddress(address)}
      </span>
      <CopyButton value={address} label={`Copy address ${address}`} />
      {status != null && (
        <span
          className="v10-pca-wallet-status"
          data-tone={statusTone}
        >
          {status}
        </span>
      )}
      {gas != null && <span className="v10-pca-wallet-gas">{gas}</span>}
      {trailing != null && <span className="v10-pca-wallet-trailing">{trailing}</span>}
    </div>
  );
}
