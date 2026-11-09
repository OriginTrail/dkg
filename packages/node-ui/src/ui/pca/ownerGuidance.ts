/**
 * What the PCA page tells you about who can change this PCA, derived once from the
 * owner-access model: the line above the wallet control, the optional notice under it,
 * and the reason shown on disabled owner actions. Pure, so the three always agree and
 * there's no separate rule for when one message repeats another.
 */
import type { PcaOwnerAccess } from './ownerAccess.js';
import { truncateAddress } from '../components/Pca/format.js';

export interface OwnerGuidanceInput {
  accountId: string;
  /** The PCA owner's full address. */
  owner: string;
  access: Pick<PcaOwnerAccess, 'mode' | 'wrongNetwork' | 'writesEnabled' | 'ownerUnknownCause'>;
  /** A browser wallet is connected. */
  connected: boolean;
  /** The owner is one of this node's operational wallets (but not the one it signs with). */
  ownerInPool: boolean;
}

export type OwnerNotice =
  /** The node's wallets are still loading: a neutral tip, no Retry. */
  | { kind: 'loading'; text: string }
  /** Writes are off for a reason worth a warning; `retry` when the wallets couldn't be read. */
  | { kind: 'warning'; text: string; retry: boolean };

export interface OwnerGuidance {
  walletLine: string;
  notice: OwnerNotice | null;
  /** Tooltip on disabled owner actions; undefined when writes are on. */
  disabledReason: string | undefined;
}

export function ownerGuidance({ accountId, owner, access, connected, ownerInPool }: OwnerGuidanceInput): OwnerGuidance {
  const short = truncateAddress(owner);
  const loading = access.ownerUnknownCause === 'wallets-loading';
  const unreadable = access.ownerUnknownCause === 'wallets-unreadable';
  const isWallet = access.mode === 'wallet';

  const reason = loading
    ? `Confirming ownership of PCA #${accountId}…`
    : unreadable
    ? `Couldn’t load this node’s wallets, so we can’t confirm who owns PCA #${accountId}.`
    : isWallet && access.wrongNetwork
    ? `The PCA owner wallet is on another network. Switch it to this node’s network to change PCA #${accountId}.`
    : isWallet
    ? `Your connected wallet is the PCA owner wallet, so you can change PCA #${accountId}.`
    : ownerInPool
    ? `Only the PCA owner wallet (${short}) can change PCA #${accountId}. It’s one of this node’s operational wallets, but the node signs PCA changes only with its primary operational wallet.`
    : connected
    ? `You’re connected with a different wallet. Only the PCA owner wallet (${short}) can change PCA #${accountId}.`
    : `Only the PCA owner wallet (${short}) can change PCA #${accountId}.`;

  const walletLine = connected
    ? isWallet
      ? access.wrongNetwork
        ? 'Your connected wallet is the PCA owner wallet, but it’s on another network. Switch networks to top up, approve wallets or renew this PCA.'
        : 'Your connected wallet is the PCA owner wallet. It signs top-ups, wallet approvals, removals and renewals.'
      : access.mode === 'daemon'
        ? 'This node owns this PCA and signs changes itself. You don’t need to connect a wallet.'
        : `Your connected wallet isn’t the PCA owner wallet. To top up, approve wallets or renew this PCA, switch to ${short}.`
    : access.mode === 'external'
      ? 'To top up, approve wallets or renew this PCA, connect the PCA owner wallet.'
      : 'To manage a PCA that a wallet owns, connect that wallet.';

  let notice: OwnerNotice | null = null;
  if (!access.writesEnabled) {
    if (loading) notice = { kind: 'loading', text: reason };
    // Someone else's PCA with no wallet connected: the wallet line already says to connect the owner wallet.
    else if (!(access.mode === 'external' && !connected && !ownerInPool)) {
      notice = { kind: 'warning', text: unreadable ? reason : `${reason} You can still check whether a wallet is approved.`, retry: unreadable };
    }
  }

  return { walletLine, notice, disabledReason: access.writesEnabled ? undefined : reason };
}
