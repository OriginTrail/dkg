/**
 * The centralized PCA owner-access model (#1375, item 2/3).
 *
 * Before this module the owner/signing classification lived in FOUR hand-copied
 * places — `detailOwnerMode`, `ownerActions.resolveOwnerActionSubmitterKind`,
 * `ConvictionOverview.ownerModeFor`, and `ApproveWalletsModal.signerKindForAccount`
 * — each pairing the same inv-17 precedence with a slightly different wrong-network
 * gate. `resolvePcaOwnerAccess` is the SINGLE pure classifier they all reduce to.
 *
 * Two hard invariants live here:
 *  - **inv-17 (owner precedence):** the daemon (primary-wallet) check comes FIRST, so the
 *    daemon wins even when the primary wallet is also the connected wallet; the redundant
 *    `&& !eqAddress(owner, primaryWallet)` guard stays on the wallet branch.
 *  - **address-only classification (the wrong-network fold hazard):** `mode` is derived from
 *    ADDRESSES ONLY — the network is never folded into it. Wrong-network gates *writes*
 *    separately via `writesEnabled`, exactly like the async submitter, whose
 *    `resolveOwnerActionSubmitterKind` is address-only and whose `walletUnavailableReason`
 *    applies the network gate afterwards. This lets every consumer keep its effective
 *    (classify + gate) behavior without any classifier double-gating or, worse, a consumer
 *    that drops its gate enabling a wallet sign on the wrong chain.
 *
 * This module owns the classification ONLY. It deliberately does NOT own the browser
 * wallet submitter's per-prompt liveness guards (inv-16) — those stay call-time in
 * `web3/walletOwnerActionSubmitter.ts`.
 */
import { eqAddress } from './address.js';
import { isWrongNetwork, useWalletStore } from '../stores/wallet.js';
import type { SignableOwner, SignableOwnerKind } from './walletBinding.js';
import type { OwnerActionSubmitterKind } from './ownerActions.js';

// Re-exported (type-only) so consumers can take the whole owner-access vocabulary from the
// model. The single definitions still live in walletBinding.ts / ownerActions.ts (shared,
// not duplicated); the model does not move their logic.
export type { SignableOwner, SignableOwnerKind, OwnerActionSubmitterKind };

/** Address-only owner classification. `unknown` is the display carve-out for the two
 *  "can't classify" causes below; it is NOT part of inv-17 precedence. */
export type PcaOwnerMode = 'daemon' | 'wallet' | 'external' | 'unknown';

/**
 * Why the owner couldn't be classified. Kept distinct because the consumers word them
 * differently: `no-snapshot` = the PCA snapshot (owner) isn't loaded (ConvictionOverview's
 * `!owner`); `wallets-unreadable` = the node's own wallet list failed to read, so ownership
 * can't be confirmed (ConvictionDetailView's `walletsUnknown`).
 */
export type PcaOwnerUnknownCause = 'no-snapshot' | 'wallets-unreadable';

export interface PcaOwnerAccessInput {
  /** The on-chain PCA owner. Absent/empty ⇒ `unknown` (`no-snapshot`). */
  owner?: string | null;
  /** This node's primary operational wallet (`wallets[0]`) — the daemon signer. */
  primaryWallet?: string | null;
  /** The currently connected browser wallet, or null. */
  connectedWallet?: string | null;
  /** The connected wallet is on a chain other than the node's PCA network (raw fact). */
  walletWrongNetwork?: boolean;
  /** This node's wallet list failed to read ⇒ `unknown` (`wallets-unreadable`). */
  walletsUnknown?: boolean;
}

export interface PcaOwnerAccess {
  /** Address-only classification (network never folded in). */
  mode: PcaOwnerMode;
  /** Raw connected-wallet wrong-network fact (independent of `mode`). Consumers that show a
   *  wallet-scoped warning gate it themselves with `mode === 'wallet' && wrongNetwork`. */
  wrongNetwork: boolean;
  /** Owner writes are enabled: daemon always; wallet only on the right network. */
  writesEnabled: boolean;
  /** Which submitter the async owner-action seam routes to. Address-only, matching
   *  `resolveOwnerActionSubmitterKind`: a wrong-network wallet is still `'wallet'` here
   *  (the network block is applied separately, not by reclassifying to read-only). */
  submitterKind: OwnerActionSubmitterKind;
  /** Present only when `mode === 'unknown'`; names which read is missing. */
  ownerUnknownCause?: PcaOwnerUnknownCause;
  /** The candidate owner signers in daemon→wallet order (both entries always present so
   *  addresses may be null; downstream normalizers drop the null-address entries). Matches
   *  ApproveWalletsModal's `signableOwners` exactly. */
  signableOwners: SignableOwner[];
}

/**
 * The write gate as a pure function of the resolved owner mode + wrong-network. The single
 * source of the `writesEnabled` formula — `resolvePcaOwnerAccess` uses it, and display
 * consumers that already carry a pre-resolved mode (e.g. PcaAccountCard's
 * `ownerIsPrimaryWallet` fallback) read the gate here instead of re-deriving the boolean.
 */
export function ownerModeWritesEnabled(mode: PcaOwnerMode, wrongNetwork: boolean): boolean {
  return mode === 'daemon' || (mode === 'wallet' && !wrongNetwork);
}

/**
 * The one pure owner-access classifier. Sync, side-effect-free, and the single encoding of
 * inv-17 + the wrong-network gate. Both faces of the model (the sync display hook below and
 * the async re-fetching submitter resolver) reduce to this.
 */
export function resolvePcaOwnerAccess(input: PcaOwnerAccessInput): PcaOwnerAccess {
  const {
    owner,
    primaryWallet,
    connectedWallet,
    walletWrongNetwork = false,
    walletsUnknown = false,
  } = input;

  const signableOwners: SignableOwner[] = [
    { address: primaryWallet, kind: 'daemon' },
    { address: connectedWallet, kind: 'wallet' },
  ];

  // Unknown carve-outs (OUTSIDE inv-17 precedence), causes kept distinct. `walletsUnknown`
  // is checked FIRST to mirror the detail view, which gates on "couldn't read this node's
  // wallets" before it ever classifies the owner.
  if (walletsUnknown) {
    return {
      mode: 'unknown',
      wrongNetwork: walletWrongNetwork,
      writesEnabled: false,
      submitterKind: 'read-only',
      ownerUnknownCause: 'wallets-unreadable',
      signableOwners,
    };
  }
  if (!owner) {
    return {
      mode: 'unknown',
      wrongNetwork: walletWrongNetwork,
      writesEnabled: false,
      submitterKind: 'read-only',
      ownerUnknownCause: 'no-snapshot',
      signableOwners,
    };
  }

  // inv-17 precedence — byte-for-byte from ownerActions.resolveOwnerActionSubmitterKind
  // (`if (eq(owner, primaryWallet)) 'daemon'; if (connectedWallet && eq(owner,
  // connectedWallet) && !eq(owner, primaryWallet)) 'wallet'; else …`) and detailOwnerMode.
  let mode: PcaOwnerMode;
  if (eqAddress(owner, primaryWallet)) {
    mode = 'daemon';
  } else if (connectedWallet && eqAddress(owner, connectedWallet) && !eqAddress(owner, primaryWallet)) {
    mode = 'wallet';
  } else {
    mode = 'external';
  }

  const wrongNetwork = walletWrongNetwork;
  const writesEnabled = ownerModeWritesEnabled(mode, wrongNetwork);
  const submitterKind: OwnerActionSubmitterKind =
    mode === 'daemon' ? 'daemon' : mode === 'wallet' ? 'wallet' : 'read-only';

  return { mode, wrongNetwork, writesEnabled, submitterKind, signableOwners };
}

/**
 * Sync display face: reads the connected wallet + wrong-network from the wallet store and
 * runs the pure core against already-loaded owner/primaryWallet props. Use in render paths
 * (detail view, overview, cards). The async, deliberately re-fetching face stays in
 * `ownerActions.resolveOwnerActionSubmitterForAccount` — do not force it onto React state.
 */
export function usePcaOwnerAccess(input: {
  owner?: string | null;
  primaryWallet?: string | null;
  walletsUnknown?: boolean;
}): PcaOwnerAccess {
  const connectedWallet = useWalletStore((s) => s.address);
  const walletWrongNetwork = useWalletStore((s) => isWrongNetwork(s));
  return resolvePcaOwnerAccess({
    owner: input.owner,
    primaryWallet: input.primaryWallet,
    connectedWallet,
    walletWrongNetwork,
    walletsUnknown: input.walletsUnknown,
  });
}
