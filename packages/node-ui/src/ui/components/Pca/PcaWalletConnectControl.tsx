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
          We recommend a hardware wallet. If you use one, check the amount and contract on its screen
          before you confirm. Publishing wallets sign automatically, without asking you. Each epoch,
          they can spend up to that epoch’s allowance, plus any top-up balance.
        </>
      )}
    />
  );
}
