import type { DeviceConfirmStep } from '../components/Pca/index.js';
import { describeWalletTxError } from '../web3/walletTxError.js';

/** The two device-signed owner actions in the PCA detail view. */
export type DetailDeviceAction = 'topup' | 'remove';

/**
 * Seed template for the detail-view device-confirm progress. Top-up is the
 * allowance-then-action 3-step flow; remove is a single-signature 2-step flow
 * (no approve step).
 */
export function initialDetailDeviceSteps(action: DetailDeviceAction): DeviceConfirmStep[] {
  return action === 'topup'
    ? [
        { id: 'approve', label: 'Approve exact TRAC allowance', state: 'pending' },
        { id: 'action', label: 'Sign top-up', state: 'pending' },
        { id: 'confirm', label: 'Confirm on-chain receipt', state: 'pending' },
      ]
    : [
        { id: 'action', label: 'Sign remove wallet', state: 'pending' },
        { id: 'confirm', label: 'Confirm on-chain receipt', state: 'pending' },
      ];
}

/** Action-step failure copy; a rejected remove gets a "no wallet was removed" message. */
export function describeDetailWalletError(err: unknown, action: DetailDeviceAction): string {
  const info = describeWalletTxError(err, 'action');
  if (action === 'remove' && info.kind === 'rejected') {
    return 'You rejected the remove-wallet transaction. No wallet was removed.';
  }
  return info.message;
}
