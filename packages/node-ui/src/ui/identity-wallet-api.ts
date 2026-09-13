// Node identity-wallet management — daemon read/bootstrap API.
//
// Kept outside the general api.ts barrel so this security-sensitive feature has
// one discoverable wire boundary. api.ts re-exports the module for compatibility.
import { get, HttpError } from './http.js';

const IDENTITY_WALLET_UNAVAILABLE_CODE = 'IDENTITY_WALLET_MANAGEMENT_UNAVAILABLE';
const OPERATIONAL_WALLET_UNAVAILABLE_CODE = 'OPERATIONAL_WALLET_MANAGEMENT_UNAVAILABLE';

export class IdentityWalletApiDecodeError extends Error {
  readonly code = 'IDENTITY_WALLET_API_DECODE_ERROR';
  readonly endpoint: string;

  constructor(endpoint: string, detail: string) {
    super(`${detail} from ${endpoint}`);
    this.name = 'IdentityWalletApiDecodeError';
    this.endpoint = endpoint;
    Object.setPrototypeOf(this, IdentityWalletApiDecodeError.prototype);
  }
}

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
  const endpoint = '/api/operational-wallets';
  try {
    const value = await get<unknown>(endpoint);
    if (!isOperationalWalletSnapshot(value)) {
      throw new IdentityWalletApiDecodeError(endpoint, 'Invalid operational-wallet snapshot');
    }
    return { available: true, snapshot: value };
  } catch (error) {
    if (
      error instanceof HttpError
      && error.status === 503
      && (error.body as { code?: unknown } | undefined)?.code === OPERATIONAL_WALLET_UNAVAILABLE_CODE
    ) return { available: false };
    throw error;
  }
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
  const endpoint = '/api/identity-wallets/contracts';
  try {
    const value = await get<unknown>(endpoint);
    if (!isIdentityWalletContracts(value)) {
      throw new IdentityWalletApiDecodeError(endpoint, 'Invalid identity-wallet contracts response');
    }
    return value;
  } catch (error) {
    if (
      error instanceof HttpError
      && error.status === 503
      && (error.body as { code?: unknown } | undefined)?.code === IDENTITY_WALLET_UNAVAILABLE_CODE
    ) return null;
    throw error;
  }
};
