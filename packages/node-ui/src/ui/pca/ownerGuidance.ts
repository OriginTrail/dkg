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
  const probeNote = ' You can still check whether a wallet is approved.';
  const switchLine = `Your connected wallet isn’t the PCA owner wallet. To top up, approve wallets or renew this PCA, switch to ${short}.`;
  const connectAnyLine = 'To manage a PCA that a wallet owns, connect that wallet.';

  // Writes on (ownerModeWritesEnabled: this node owns it, or the owner wallet is
  // connected on the right network): only the wallet line, nothing to explain.
  if (access.writesEnabled) {
    const walletLine = !connected
      ? connectAnyLine
      : access.mode === 'daemon'
        ? 'This node owns this PCA and signs changes itself. You don’t need to connect a wallet.'
        : 'Your connected wallet is the PCA owner wallet. It signs top-ups, wallet approvals, removals and renewals.';
    return { walletLine, notice: null, disabledReason: undefined };
  }

  // Writes off from here: the reason is also the tooltip on the disabled owner actions.
  const disabled = (walletLine: string, reason: string, notice: OwnerNotice | null): OwnerGuidance =>
    ({ walletLine, notice, disabledReason: reason });

  // Ownership can't be confirmed yet: the node's wallet list is loading (a neutral tip)
  // or couldn't be read ("can't confirm" with Retry, never a false non-owner).
  if (access.ownerUnknownCause === 'wallets-loading') {
    const reason = `Confirming ownership of PCA #${accountId}…`;
    return disabled(connected ? switchLine : connectAnyLine, reason, { kind: 'loading', text: reason });
  }
  if (access.ownerUnknownCause === 'wallets-unreadable') {
    const reason = `Couldn’t load this node’s wallets, so we can’t confirm who owns PCA #${accountId}.`;
    return disabled(connected ? switchLine : connectAnyLine, reason, { kind: 'warning', text: reason, retry: true });
  }

  // The owner wallet is connected, but on another network.
  if (access.mode === 'wallet') {
    const reason = `The PCA owner wallet is on another network. Switch it to this node’s network to change PCA #${accountId}.`;
    const line = connected
      ? 'Your connected wallet is the PCA owner wallet, but it’s on another network. Switch networks to top up, approve wallets or renew this PCA.'
      : connectAnyLine;
    return disabled(line, reason, { kind: 'warning', text: reason + probeNote, retry: false });
  }

  // Someone other than this node and the connected wallet owns it.
  const reason = ownerInPool
    ? `Only the PCA owner wallet (${short}) can change PCA #${accountId}. It’s one of this node’s operational wallets, but the node signs PCA changes only with its primary operational wallet.`
    : connected
      ? `You’re connected with a different wallet. Only the PCA owner wallet (${short}) can change PCA #${accountId}.`
      : `Only the PCA owner wallet (${short}) can change PCA #${accountId}.`;
  const warning: OwnerNotice = { kind: 'warning', text: reason + probeNote, retry: false };
  if (access.mode === 'external' && !connected) {
    // The line already says to connect the owner wallet, so only the node-wallet case adds a notice.
    return disabled('To top up, approve wallets or renew this PCA, connect the PCA owner wallet.', reason, ownerInPool ? warning : null);
  }
  return disabled(connected ? switchLine : connectAnyLine, reason, warning);
}
