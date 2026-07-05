import { describeWalletTxError } from '../web3/walletTxError.js';
import type { WalletTxFlow } from './useWalletTxProgress.js';

/** The two device-signed owner actions in the PCA detail view. */
export type DetailDeviceAction = 'topup' | 'remove';

/**
 * Device-confirm flow for the detail-view owner actions. Top-up is the
 * allowance-then-action flow (approve -> action -> confirm); remove is a
 * single-signature flow (action -> confirm, no approve step). The shared
 * `Approve exact TRAC allowance` / `Confirm on-chain receipt` labels come from
 * `useWalletTxProgress` defaults.
 */
export function detailDeviceFlow(action: DetailDeviceAction): WalletTxFlow {
  return action === 'topup'
    ? { requiresApproval: true, actionLabel: 'Sign top-up' }
    : { requiresApproval: false, actionLabel: 'Sign remove wallet' };
}

/** Action-step failure copy; a rejected remove gets a "no wallet was removed" message. */
export function describeDetailWalletError(err: unknown, action: DetailDeviceAction): string {
  const info = describeWalletTxError(err, 'action');
  if (action === 'remove' && info.kind === 'rejected') {
    return 'You rejected the remove-wallet transaction. No wallet was removed.';
  }
  return info.message;
}
