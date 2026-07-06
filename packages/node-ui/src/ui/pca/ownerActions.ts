import {
  createPca,
  fetchPca,
  fetchWalletsBalances,
  pcaAddAgent,
  pcaRemoveAgent,
  pcaTopUp,
  pcaSettle,
} from '../api.js';
import { isWrongNetwork, useWalletStore } from '../stores/wallet.js';
import {
  walletOwnerActionSubmitter,
  type WalletOwnerActionSubmitterDeps,
} from '../web3/walletOwnerActionSubmitter.js';
import { resolvePcaOwnerAccess, type PcaOwnerAccess, type PcaOwnerMode } from './ownerAccess.js';

/**
 * OWNER-ACTION SEAM.
 *
 * Every PCA owner write - create / approve (registerAgent) / deregister /
 * top-up / settle - routes through this indirection. H-B adds the browser
 * wallet branch while preserving the daemon API result shapes consumed by the
 * existing call sites.
 */
export interface OwnerActionSubmitter {
  create: typeof createPca;
  registerAgent: typeof pcaAddAgent;
  deregisterAgent: typeof pcaRemoveAgent;
  topUp: typeof pcaTopUp;
  settle: typeof pcaSettle;
}

/**
 * The daemon submitter: the daemon EOA signs owner writes when the PCA is owned
 * by this node's primary operational wallet (`wallets[0]`).
 */
export const daemonOwnerActionSubmitter: OwnerActionSubmitter = {
  create: createPca,
  registerAgent: pcaAddAgent,
  deregisterAgent: pcaRemoveAgent,
  topUp: pcaTopUp,
  settle: pcaSettle,
};

export class ReadOnlyOwnerActionError extends Error {
  constructor(message = 'Connect the PCA owner wallet to manage this account.') {
    super(message);
    this.name = 'ReadOnlyOwnerActionError';
  }
}

export class OwnerActionUnavailableError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message);
    this.name = 'OwnerActionUnavailableError';
    this.cause = opts?.cause;
  }
}

async function readOnlyWrite(): Promise<never> {
  throw new ReadOnlyOwnerActionError();
}

function unavailableSubmitter(message: string, cause?: unknown): OwnerActionSubmitter {
  async function fail(): Promise<never> {
    throw new OwnerActionUnavailableError(message, { cause });
  }
  return {
    create: fail,
    registerAgent: fail,
    deregisterAgent: fail,
    topUp: fail,
    settle: daemonOwnerActionSubmitter.settle,
  };
}

/**
 * Read-only submitter for externally owned PCAs where neither the daemon's
 * primary wallet nor the connected wallet is the owner. Settlement stays
 * daemon-routed because it is permissionless.
 */
export const readOnlyOwnerActionSubmitter: OwnerActionSubmitter = {
  create: readOnlyWrite,
  registerAgent: readOnlyWrite,
  deregisterAgent: readOnlyWrite,
  topUp: readOnlyWrite,
  settle: daemonOwnerActionSubmitter.settle,
};

export type OwnerKey = 'hot' | 'hardware';

/** Args for `useOwnerActionSubmitterForAccount` — the per-call RESOLVING submitter (cross-account
 *  deregister, create). */
export interface OwnerActionSubmitterForAccountArgs {
  /** ADVISORY only — documents the bound account at the call site; routing resolves per the
   *  accountId PASSED to each method, not this field. */
  accountId?: string;
  /** Create-time selector: 'hardware' → browser wallet, else daemon. */
  ownerKey?: OwnerKey;
  /** Optional UI progress hook for browser-wallet approve/action prompts. */
  onWalletProgress?: WalletOwnerActionSubmitterDeps['onProgress'];
}

/** Args for `useOwnerActionSubmitter` — the same-account ACCESS-PINNED submitter (resolve-once from
 *  the display access). */
export interface OwnerActionSubmitterArgs {
  /** The display-resolved owner access for THIS account. */
  access: PcaOwnerAccess;
  /** Optional UI progress hook for browser-wallet approve/action prompts. */
  onWalletProgress?: WalletOwnerActionSubmitterDeps['onProgress'];
}

export type OwnerActionSubmitterKind = 'daemon' | 'wallet' | 'read-only';

function walletUnavailableReason(): string | null {
  const walletState = useWalletStore.getState();
  if (!walletState.provider || !walletState.address) {
    return 'Connect the PCA owner wallet before signing.';
  }
  if (!walletState.bootstrap || walletState.expectedChainId == null) {
    return 'PCA contract addresses are not bootstrapped yet.';
  }
  if (walletState.chainId !== walletState.expectedChainId) {
    return "Switch the connected wallet to this node's PCA network.";
  }
  return null;
}

/**
 * Derive the owner-action submitter KIND from the pure owner mode (T2 / #1468). The model owns
 * only the owner STATE; the submitter vocabulary is derived here at the ownerActions boundary.
 * inv-17 precedence already lives in `mode` (daemon-first + redundant guard); this is the
 * address-only mode→kind projection: daemon→'daemon', wallet→'wallet', external/unknown→
 * 'read-only' (the network gate is applied separately, never by reclassifying a wallet).
 */
export function submitterKindForOwnerMode(mode: PcaOwnerMode): OwnerActionSubmitterKind {
  return mode === 'daemon' ? 'daemon' : mode === 'wallet' ? 'wallet' : 'read-only';
}

/**
 * inv-17 owner-kind classification for the async manage path — the pure model mode projected to a
 * submitter kind via `submitterKindForOwnerMode`.
 */
export function resolveOwnerActionSubmitterKind({
  owner,
  primaryWallet,
  connectedWallet,
}: {
  owner: string;
  primaryWallet?: string | null;
  connectedWallet?: string | null;
}): OwnerActionSubmitterKind {
  return submitterKindForOwnerMode(resolvePcaOwnerAccess({ owner, primaryWallet, connectedWallet }).mode);
}

/**
 * The signer KIND for a (possibly different) account's OWNER — `'daemon' | 'wallet' | undefined`.
 * The approve batch calls this to count device prompts for a CROSS-account deregister (renew's
 * old `deregisterFrom`). It re-fetches that account's owner and reduces via the owner-access model,
 * so the classification math lives in the owner-access layer, not the component (folds the former
 * inline `ApproveWalletsModal.signerKindForAccount`, #1470 item).
 *
 * `primaryWallet` (this node's `wallets[0]`, the daemon signer) is passed BY THE CALLER from its
 * already-loaded wallet list — deliberately NOT re-fetched here. The old inline predicate keyed the
 * daemon branch on the modal's cached `ownerWallet` and the wallet branch on `connectedWallet` only
 * (no wallet-LIST dependency at all), so its only async was `fetchPca(deregisterFrom)`, correlated
 * with the execution path. An internal `fetchWalletsBalances()` would add an UNCORRELATED failure
 * that maps to `undefined` and can disarm the R4 wallet-signing lock (deviceTotal 0 / no
 * `walletBatchSigning`) while the resolving deregister submitter independently re-fetches, succeeds,
 * and opens a browser prompt with the lock off — the exact contract #1468/R4 protects. Keeping the
 * fetch out preserves the old correlation.
 *
 * `undefined` for a missing id, a read failure, or an owner this node can't sign for
 * (external / wrong-network) — byte-identical to the old inline predicate (the `signerKindRef`
 * oracle pins it): `daemon` when the owner is this node's primary wallet; `wallet` only when the
 * connected wallet owns it ON THE RIGHT NETWORK (`writesEnabled`). inv-16: this only PLANS the
 * device count — the actual deregister still re-resolves + re-verifies ownership per prompt.
 */
export async function resolveSignerKindForAccount(
  accountId?: string,
  primaryWallet?: string | null,
): Promise<'daemon' | 'wallet' | undefined> {
  if (!accountId) return undefined;
  const snapshot = await fetchPca(accountId).catch(() => null);
  if (!snapshot?.owner) return undefined;
  const walletState = useWalletStore.getState();
  const access = resolvePcaOwnerAccess({
    owner: snapshot.owner,
    primaryWallet,
    connectedWallet: walletState.address,
    walletWrongNetwork: isWrongNetwork(walletState),
  });
  const kind = submitterKindForOwnerMode(access.mode);
  if (kind === 'daemon') return 'daemon';
  // The wrong-network gate lives in `writesEnabled` (mode stays 'wallet'): a wrong-network wallet
  // owner is NOT counted as a device prompt, matching the old `!walletWrongNetwork` conjunct.
  if (kind === 'wallet' && access.writesEnabled) return 'wallet';
  return undefined;
}

/**
 * Map a resolved owner-action kind to its submitter. Pure selection — NO fetch and NO
 * `walletUnavailableReason` here: usability is enforced up-front by the display `writesEnabled`
 * gate and, per prompt, by the wallet submitter's own loadContext / assertStillConnected /
 * allowance liveness guards. `settle` stays daemon inside each returned submitter.
 */
export function ownerActionSubmitterForKind(
  kind: OwnerActionSubmitterKind,
  walletDeps: WalletOwnerActionSubmitterDeps = {},
): OwnerActionSubmitter {
  if (kind === 'daemon') return daemonOwnerActionSubmitter;
  if (kind === 'read-only') return readOnlyOwnerActionSubmitter;
  return walletOwnerActionSubmitter(walletDeps);
}

export async function resolveOwnerActionSubmitterForAccount(
  accountId: string,
  walletDeps: WalletOwnerActionSubmitterDeps = {},
): Promise<OwnerActionSubmitter> {
  let snapshot;
  try {
    snapshot = await fetchPca(accountId);
  } catch (cause) {
    return unavailableSubmitter('Could not verify the PCA owner before signing.', cause);
  }

  let wallets: string[];
  try {
    wallets = (await fetchWalletsBalances()).wallets ?? [];
  } catch (cause) {
    return unavailableSubmitter("Could not verify this node's primary wallet before signing.", cause);
  }

  const connectedWallet = useWalletStore.getState().address;
  const kind = resolveOwnerActionSubmitterKind({
    owner: snapshot.owner,
    primaryWallet: wallets[0] ?? null,
    connectedWallet,
  });

  // This async face has no display gate in front of it (e.g. renew's cross-account
  // deregisterFrom), so it KEEPS the pre-flight walletUnavailableReason for the wallet
  // branch — unchanged from before. The submitter's per-prompt liveness guards still run.
  if (kind === 'wallet') {
    const reason = walletUnavailableReason();
    if (reason) return unavailableSubmitter(reason);
  }
  return ownerActionSubmitterForKind(kind, walletDeps);
}

/**
 * Create-time submitter selection (no accountId/owner yet): `ownerKey: 'hardware'` signs with
 * the browser wallet (pre-flight walletUnavailableReason), anything else uses the daemon. Shared
 * by both the resolving and the access-path submitters — create never depends on `access`.
 */
function resolvingCreate(args: OwnerActionSubmitterForAccountArgs): OwnerActionSubmitter['create'] {
  return async (createArgs) => {
    if (args.ownerKey !== 'hardware') return daemonOwnerActionSubmitter.create(createArgs);
    const reason = walletUnavailableReason();
    if (reason) throw new OwnerActionUnavailableError(reason);
    return walletOwnerActionSubmitter({ onProgress: args.onWalletProgress }).create(createArgs);
  };
}

// Internal (NOT a hook) — the per-call resolving submitter. Exposed to components via
// `useOwnerActionSubmitterForAccount`, and reused by the pinned submitter's fallback branches.
function resolvingOwnerActionSubmitter(args: OwnerActionSubmitterForAccountArgs = {}): OwnerActionSubmitter {
  return {
    create: resolvingCreate(args),
    async registerAgent(accountId, address) {
      return (await resolveOwnerActionSubmitterForAccount(accountId, { onProgress: args.onWalletProgress })).registerAgent(accountId, address);
    },
    async deregisterAgent(accountId, address) {
      return (await resolveOwnerActionSubmitterForAccount(accountId, { onProgress: args.onWalletProgress })).deregisterAgent(accountId, address);
    },
    async topUp(accountId, tokens) {
      return (await resolveOwnerActionSubmitterForAccount(accountId, { onProgress: args.onWalletProgress })).topUp(accountId, tokens);
    },
    settle: daemonOwnerActionSubmitter.settle,
  };
}

// Internal (NOT a hook) — the same-account resolve-ONCE submitter, with the two safety fallbacks.
function pinnedOwnerActionSubmitter(
  access: PcaOwnerAccess,
  onWalletProgress?: WalletOwnerActionSubmitterDeps['onProgress'],
): OwnerActionSubmitter {
  // Route to the RESOLVING path (per-write re-fetch + re-classify) in two cases:
  //  - access.mode === 'unknown': the caller's snapshot hasn't loaded, or a just-created
  //    replacement PCA isn't chain-readable yet. Pinning would stick submitterKind at 'read-only'
  //    and fail every click on a genuinely owned account; resolving self-heals on retry.
  //  - submitterKind === 'wallet' (T1 / #1468, the SAFETY case): a browser-wallet write runs
  //    approveExactIfNeeded (grants TRAC) BEFORE the owner-gated call, so it must re-verify
  //    ownership at CALL time. A render-time-pinned wallet submitter could grant allowance and then
  //    revert NotAccountOwner on a stale owner/connected wallet; the resolving path re-fetches the
  //    owner (origin) and returns read-only FIRST when it no longer matches — no approve, no spend.
  if (access.mode === 'unknown' || submitterKindForOwnerMode(access.mode) === 'wallet') {
    return resolvingOwnerActionSubmitter({ onWalletProgress });
  }
  // daemon (server-side, no browser approve) + read-only (never writes) pin ONCE — the resolve-
  // once win. create stays on the ownerKey path; settle stays daemon.
  const resolved = ownerActionSubmitterForKind(submitterKindForOwnerMode(access.mode), { onProgress: onWalletProgress });
  return {
    create: resolvingCreate({ onWalletProgress }),
    registerAgent: resolved.registerAgent,
    deregisterAgent: resolved.deregisterAgent,
    topUp: resolved.topUp,
    settle: daemonOwnerActionSubmitter.settle,
  };
}

/**
 * `useOwnerActionSubmitterForAccount` — the per-call RESOLVING strategy (T3 / #1468): every manage
 * write re-fetches the PCA owner + re-classifies (via `resolveOwnerActionSubmitterForAccount`, keyed
 * on the accountId PASSED to the method). Use for CROSS-account writes — renew's / self-coverage's
 * deregister from a DIFFERENT account — and for create. The optional `accountId` arg is ADVISORY
 * (routing uses the call-time accountId). This is the security seam; it must NOT be pinned onto
 * React state.
 */
export function useOwnerActionSubmitterForAccount(args: OwnerActionSubmitterForAccountArgs = {}): OwnerActionSubmitter {
  return resolvingOwnerActionSubmitter(args);
}

/**
 * `useOwnerActionSubmitter` — the same-account ACCESS-PINNED strategy (T3 / #1468): resolves the
 * signer ONCE from the display `access` for writes on THAT account (the resolve-once win), with the
 * T1 wallet re-verify + the unknown-mode self-heal baked in (see `pinnedOwnerActionSubmitter`).
 * create/settle unchanged.
 */
export function useOwnerActionSubmitter(args: OwnerActionSubmitterArgs): OwnerActionSubmitter {
  return pinnedOwnerActionSubmitter(args.access, args.onWalletProgress);
}
