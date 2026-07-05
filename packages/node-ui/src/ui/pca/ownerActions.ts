import {
  createPca,
  fetchPca,
  fetchWalletsBalances,
  pcaAddAgent,
  pcaRemoveAgent,
  pcaTopUp,
  pcaSettle,
} from '../api.js';
import { useWalletStore } from '../stores/wallet.js';
import {
  walletOwnerActionSubmitter,
  type WalletOwnerActionSubmitterDeps,
} from '../web3/walletOwnerActionSubmitter.js';
import { resolvePcaOwnerAccess, type PcaOwnerAccess } from './ownerAccess.js';

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

export interface OwnerActionSubmitterArgs {
  accountId?: string;
  /**
   * The display-resolved owner access for `accountId` (item 3 / #1375). When provided, the
   * submitter is selected ONCE up-front from `access.submitterKind` and the manage writes
   * submit directly — no per-write owner/wallet re-fetch. Omit it to keep the async
   * re-fetching path (create-time ownerKey, cross-account deregisterFrom).
   */
  access?: PcaOwnerAccess;
  /** Create-time selector. Manage-time routing fetches the PCA owner at call time. */
  ownerKey?: OwnerKey;
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
 * inv-17 owner-kind classification for the async manage path. Now a thin delegation to the
 * single model classifier — `resolvePcaOwnerAccess(...).submitterKind` (address-only; the
 * network gate is applied separately in the resolving path below). This is the last inv-17
 * copy, now living on the model.
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
  return resolvePcaOwnerAccess({ owner, primaryWallet, connectedWallet }).submitterKind;
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
function resolvingCreate(args: OwnerActionSubmitterArgs): OwnerActionSubmitter['create'] {
  return async (createArgs) => {
    if (args.ownerKey !== 'hardware') return daemonOwnerActionSubmitter.create(createArgs);
    const reason = walletUnavailableReason();
    if (reason) throw new OwnerActionUnavailableError(reason);
    return walletOwnerActionSubmitter({ onProgress: args.onWalletProgress }).create(createArgs);
  };
}

function resolvingOwnerActionSubmitter(args: OwnerActionSubmitterArgs = {}): OwnerActionSubmitter {
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

/**
 * Item 3 (#1375) — the resolve-signer-ONCE path. Selects the submitter up-front from the
 * display-resolved `access.submitterKind`, so registerAgent / deregisterAgent / topUp submit
 * DIRECTLY (no per-write owner/wallet re-fetch). The wallet submitter still runs its per-prompt
 * loadContext / assertStillConnected / allowance liveness guards on every write (inv-16 intact).
 * create stays on the ownerKey path; settle stays daemon.
 */
function accessOwnerActionSubmitter(access: PcaOwnerAccess, args: OwnerActionSubmitterArgs): OwnerActionSubmitter {
  const resolved = ownerActionSubmitterForKind(access.submitterKind, { onProgress: args.onWalletProgress });
  return {
    create: resolvingCreate(args),
    registerAgent: resolved.registerAgent,
    deregisterAgent: resolved.deregisterAgent,
    topUp: resolved.topUp,
    settle: daemonOwnerActionSubmitter.settle,
  };
}

/**
 * Resolve the owner-action submitter for PCA owner writes.
 *
 * Manage writes resolve at call time by fetching the PCA owner, then applying
 * inv-17:
 *  - owner == node primary wallet (`wallets[0]`) -> daemon, even if connected.
 *  - owner == connected wallet and != `wallets[0]` -> browser wallet submitter.
 *  - otherwise -> read-only/no-op owner writes.
 *
 * Create time has no accountId/owner yet, so `ownerKey: 'hardware' | 'hot'`
 * selects browser wallet vs daemon. Omitted ownerKey defaults to the existing
 * daemon create flow.
 *
 * When `access` is supplied (item 3 / #1375), the submitter is resolved ONCE from
 * `access.submitterKind` and the manage writes submit directly — no per-write re-fetch.
 * EXCEPT when `access.mode === 'unknown'` (the caller's PCA snapshot hasn't loaded, or a
 * just-created replacement PCA isn't chain-readable yet): fall back to the RESOLVING path so
 * a write re-fetches the owner and self-heals on retry. Pinning the access-path there would
 * stick submitterKind at 'read-only' and fail every click on a genuinely daemon-owned account.
 */
export function useOwnerActionSubmitter(args: OwnerActionSubmitterArgs = {}): OwnerActionSubmitter {
  if (args.access && args.access.mode !== 'unknown') return accessOwnerActionSubmitter(args.access, args);
  return resolvingOwnerActionSubmitter(args);
}
