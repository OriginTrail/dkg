// Node identity-wallet management — daemon read/bootstrap API.
//
// Kept outside the general api.ts barrel so this security-sensitive feature has
// one discoverable wire boundary. api.ts re-exports the module for compatibility.
import { get, HttpError } from './http.js';

export interface OperationalWalletSnapshot {
  identityId: string;
  hasProfile: boolean;
  adminKeyConfigured: boolean;
  canManage: boolean;
  wallets: Array<{
    address: string;
    isAdmin: boolean;
    isPrimary: boolean;
    registered: boolean | null;
  }>;
}

export type OperationalWalletCapability =
  | { available: false }
  | { available: true; snapshot: OperationalWalletSnapshot };

function isOperationalWalletEntry(
  value: unknown,
): value is OperationalWalletSnapshot['wallets'][number] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<OperationalWalletSnapshot['wallets'][number]>;
  return typeof item.address === 'string'
    && typeof item.isAdmin === 'boolean'
    && typeof item.isPrimary === 'boolean'
    && (typeof item.registered === 'boolean' || item.registered === null);
}

function isOperationalWalletSnapshot(value: unknown): value is OperationalWalletSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<OperationalWalletSnapshot>;
  return typeof item.identityId === 'string'
    && typeof item.hasProfile === 'boolean'
    && typeof item.adminKeyConfigured === 'boolean'
    && typeof item.canManage === 'boolean'
    && Array.isArray(item.wallets)
    && item.wallets.every(isOperationalWalletEntry);
}

/** Local wallets annotated with their on-chain operational-key state. */
export const fetchOperationalWallets = async (): Promise<OperationalWalletCapability> => {
  const value = await get<unknown>('/api/operational-wallets');
  return isOperationalWalletSnapshot(value)
    ? { available: true, snapshot: value }
    : { available: false };
};

export interface IdentityWalletContracts {
  profile: string;
  identity: string;
  storage: string;
  chainId: string | number;
  rpcUrls: string[];
  walletRpcUrls?: string[];
}

function isIdentityWalletContracts(value: unknown): value is IdentityWalletContracts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<IdentityWalletContracts>;
  const chainIdIsUsable = (typeof item.chainId === 'number' && Number.isFinite(item.chainId))
    || (typeof item.chainId === 'string' && /(\d+)\s*$/.test(item.chainId));
  return typeof item.profile === 'string'
    && typeof item.identity === 'string'
    && typeof item.storage === 'string'
    && chainIdIsUsable
    && Array.isArray(item.rpcUrls)
    && item.rpcUrls.every((url) => typeof url === 'string')
    && (item.walletRpcUrls === undefined
      || (Array.isArray(item.walletRpcUrls)
        && item.walletRpcUrls.every((url) => typeof url === 'string')));
}

export const fetchIdentityWalletContracts = async (): Promise<IdentityWalletContracts | null> => {
  try {
    const value = await get<unknown>('/api/identity-wallets/contracts');
    return isIdentityWalletContracts(value) ? value : null;
  } catch (error) {
    // A capability 503 is stable deployment state; transport 503/504 responses
    // carry an RPC code and remain retryable errors for the query controller.
    if (
      error instanceof HttpError
      && error.status === 503
      && (error.body as { code?: unknown } | undefined)?.code === undefined
      && /identity wallet management is not available/i.test(error.message)
    ) return null;
    throw error;
  }
};
