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
  /** Create-time selector. Manage-time routing fetches the PCA owner at call time. */
  ownerKey?: OwnerKey;
  /** Optional UI progress hook for browser-wallet approve/action prompts. */
  onWalletProgress?: WalletOwnerActionSubmitterDeps['onProgress'];
}

export type OwnerActionSubmitterKind = 'daemon' | 'wallet' | 'read-only';

function eq(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

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

export function resolveOwnerActionSubmitterKind({
  owner,
  primaryWallet,
  connectedWallet,
}: {
  owner: string;
  primaryWallet?: string | null;
  connectedWallet?: string | null;
}): OwnerActionSubmitterKind {
  if (eq(owner, primaryWallet)) return 'daemon';
  if (connectedWallet && eq(owner, connectedWallet) && !eq(owner, primaryWallet)) return 'wallet';
  return 'read-only';
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

  if (kind === 'daemon') return daemonOwnerActionSubmitter;
  if (kind === 'read-only') return readOnlyOwnerActionSubmitter;

  const reason = walletUnavailableReason();
  if (reason) return unavailableSubmitter(reason);
  return walletOwnerActionSubmitter(walletDeps);
}

function resolvingOwnerActionSubmitter(args: OwnerActionSubmitterArgs = {}): OwnerActionSubmitter {
  return {
    async create(createArgs) {
      if (args.ownerKey !== 'hardware') return daemonOwnerActionSubmitter.create(createArgs);
      const reason = walletUnavailableReason();
      if (reason) throw new OwnerActionUnavailableError(reason);
      return walletOwnerActionSubmitter({ onProgress: args.onWalletProgress }).create(createArgs);
    },
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
 */
export function useOwnerActionSubmitter(args: OwnerActionSubmitterArgs = {}): OwnerActionSubmitter {
  return resolvingOwnerActionSubmitter(args);
}
