import React from 'react';
import {
  WalletConnectControl,
  type WalletConnectControlProps,
} from '../Wallet/WalletConnectControl.js';

/** PCA-owned wrapper for publishing and spend-specific wallet guidance. */
export function PcaWalletConnectControl(
  props: Omit<WalletConnectControlProps, 'description'>,
) {
  return (
    <WalletConnectControl
      {...props}
      description={(
        <>
          Hardware wallet recommended. If your provider uses a device, verify the amount and contract
          on the device. Hot publishing wallets can publish without prompts; their spend is bounded by
          the per-epoch allowance, not the committed TRAC.
        </>
      )}
    />
  );
}
