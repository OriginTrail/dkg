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

/** Address-only owner classification. `unknown` is the display carve-out for the two
 *  "can't classify" causes below; it is NOT part of inv-17 precedence. */
export type PcaOwnerMode = 'daemon' | 'wallet' | 'external' | 'unknown';

/**
 * Why the owner couldn't be classified. Kept distinct because the consumers word them
 * differently: `no-snapshot` = the PCA snapshot (owner) isn't loaded (ConvictionOverview's
 * `!owner`); `wallets-unreadable` = the node's own wallet list failed to read, so ownership
 * can't be confirmed; `wallets-loading` = the node's wallet list is still loading (the load
 * window), split out of `wallets-unreadable` so a daemon PCA shows loading (not read-only)
 * while the balances fetch is in flight.
 */
export type PcaOwnerUnknownCause = 'no-snapshot' | 'wallets-unreadable' | 'wallets-loading';

export interface PcaOwnerAccessInput {
  /** The on-chain PCA owner. Absent/empty ⇒ `unknown` (`no-snapshot`). */
  owner?: string | null;
  /** This node's primary operational wallet (`wallets[0]`) — the daemon signer. */
  primaryWallet?: string | null;
  /** The currently connected browser wallet, or null. */
  connectedWallet?: string | null;
  /** The connected wallet is on a chain other than the node's PCA network (raw fact). */
  walletWrongNetwork?: boolean;
  /**
   * The load state of this node's wallet list (`wallets[0]` = the daemon signer). `'loading'`
   * ⇒ `unknown` (`wallets-loading`); `'unreadable'` ⇒ `unknown` (`wallets-unreadable`); `'ready'`
   * (the default when omitted) ⇒ classify the owner normally. Split out of the former
   * `walletsUnknown` boolean so a daemon PCA shows loading (not read-only) during the fetch.
   */
  primaryWalletState?: 'loading' | 'unreadable' | 'ready';
}

/**
 * The pure owner STATE (T2 / #1468). Deliberately minimal — the submitter KIND is derived at the
 * ownerActions boundary (`submitterKindForOwnerMode`) and the signer candidates at the walletBinding
 * boundary (`signableOwnersFor`), so this model carries no owner-action vocabulary.
 */
export interface PcaOwnerAccess {
  /** Address-only classification (network never folded in). */
  mode: PcaOwnerMode;
  /** Raw connected-wallet wrong-network fact (independent of `mode`). Consumers that show a
   *  wallet-scoped warning gate it themselves with `mode === 'wallet' && wrongNetwork`. */
  wrongNetwork: boolean;
  /** Owner writes are enabled: daemon always; wallet only on the right network. */
  writesEnabled: boolean;
  /** Present only when `mode === 'unknown'`; names which read is missing. */
  ownerUnknownCause?: PcaOwnerUnknownCause;
  /**
   * The target-write signing plan: could an owner write open a browser-wallet signature? True
   * when the owner is a loaded wallet on the right network, OR — during a load window (`mode`
   * still `unknown`) — a wallet is connected and the owner is either not-yet-known (#1469) or
   * equals the connected wallet (subsumes R4). Safe-direction over-arm; the resolving submitter
   * refuses read-only / daemon-confirms once the re-fetched owner is known. See
   * `computeMayPromptWallet`.
   */
  mayPromptWallet: boolean;
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
 * The target-write signing plan — could an owner write open a browser-wallet signature? The
 * single source `ApproveWalletsModal.targetWalletManaged` reads.
 *  - Clause 1: a loaded wallet-owned PCA on the right network (`mode === 'wallet' && writesEnabled`).
 *  - Clause 2: a load window (`mode === 'unknown'` — loading / unreadable / no-snapshot) with a
 *    connected wallet, when the owner is not-yet-known (`!owner` ⇒ closes #1469) or equals the
 *    connected wallet (subsumes the R4 fix).
 * Safe-direction over-arm: NOT gated on wrong-network (render→click network flips are re-checked
 * call-time by the wallet submitter, inv-16), and the resolving submitter refuses read-only /
 * daemon-confirms instantly once the re-fetched owner turns out not to be the connected wallet.
 */
function computeMayPromptWallet(
  mode: PcaOwnerMode,
  owner: string | null | undefined,
  connectedWallet: string | null | undefined,
  writesEnabled: boolean,
): boolean {
  if (mode === 'wallet' && writesEnabled) return true;
  if (mode === 'unknown') return !!connectedWallet && (!owner || eqAddress(owner, connectedWallet));
  return false;
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
    primaryWalletState = 'ready',
  } = input;

  // Unknown carve-outs (OUTSIDE inv-17 precedence), causes kept distinct. The wallet-list load
  // state is checked FIRST to mirror the detail view, which gates on "couldn't read / still
  // reading this node's wallets" before it ever classifies the owner. `'loading'` is split from
  // `'unreadable'` so a daemon PCA shows loading (not read-only) while the balances fetch runs.
  if (primaryWalletState === 'loading') {
    return {
      mode: 'unknown',
      wrongNetwork: walletWrongNetwork,
      writesEnabled: false,
      ownerUnknownCause: 'wallets-loading',
      mayPromptWallet: computeMayPromptWallet('unknown', owner, connectedWallet, false),
    };
  }
  if (primaryWalletState === 'unreadable') {
    return {
      mode: 'unknown',
      wrongNetwork: walletWrongNetwork,
      writesEnabled: false,
      ownerUnknownCause: 'wallets-unreadable',
      mayPromptWallet: computeMayPromptWallet('unknown', owner, connectedWallet, false),
    };
  }
  if (!owner) {
    return {
      mode: 'unknown',
      wrongNetwork: walletWrongNetwork,
      writesEnabled: false,
      ownerUnknownCause: 'no-snapshot',
      mayPromptWallet: computeMayPromptWallet('unknown', owner, connectedWallet, false),
    };
  }

  // inv-17 precedence — byte-for-byte from detailOwnerMode / the async classifier
  // (`if (eq(owner, primaryWallet)) 'daemon'; if (connectedWallet && eq(owner, connectedWallet) &&
  // !eq(owner, primaryWallet)) 'wallet'; else 'external'`). Daemon-first + the redundant guard.
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
  const mayPromptWallet = computeMayPromptWallet(mode, owner, connectedWallet, writesEnabled);

  return { mode, wrongNetwork, writesEnabled, mayPromptWallet };
}

// The sync display hook `usePcaOwnerAccess` lives in `./usePcaOwnerAccess.ts` so THIS module
// stays PURE (no React / wallet-store import) — the pure classifier is what the parity tests
// and the async owner-action seam depend on.
