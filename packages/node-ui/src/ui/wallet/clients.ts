import {
  createPublicClient,
  createWalletClient,
  custom,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem';
import type { Eip1193Provider } from './eip6963.js';

/**
 * Both clients ride the user's OWN wallet provider (EIP-1193) — reads,
 * receipt-waits, AND signing. This is deliberate: the node's RPC URL is never
 * shipped to the browser (it can carry a tenant secret), and the connected
 * wallet is already on the right chain. Caller passes the current provider from
 * the wallet store (it can change on wallet swap), so these are not memoised.
 */
export function publicClientFromProvider(chain: Chain, provider: Eip1193Provider): PublicClient {
  return createPublicClient({ chain, transport: custom(provider) });
}

export function walletClientFromProvider(chain: Chain, provider: Eip1193Provider): WalletClient {
  return createWalletClient({ chain, transport: custom(provider) });
}
