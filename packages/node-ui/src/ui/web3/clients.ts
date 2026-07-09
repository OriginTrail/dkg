// Adapted from OriginTrail/staking-ui-v10 (Apache-2.0, © OriginTrail).
//
// viem client factories for the in-browser PCA signing layer. Unlike staking-ui (which keys a
// static `chains` map by slug), node-UI is single-network-per-node and bootstraps the chain from
// the daemon `GET /api/pca/contracts` ({ chainId, rpcUrls }) — so we SYNTHESIZE the viem `Chain`
// here rather than import a pre-baked one. Reads go through `publicClientFor` (rpcUrls); writes go
// through `walletClientFromProvider` (the user's injected EIP-1193 provider).

import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  fallback,
  http,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { nativeGasSymbol } from '../lib/nativeGasSymbol.js';
import { authHeaders } from '../api.js';
import { numericChainId } from './chainId.js';
import type { Eip1193Provider } from './eip6963.js';

// Re-exported for back-compat with web3 callers that imported it from here.
export { numericChainId } from './chainId.js';

/**
 * Synthesize a viem `Chain` from the daemon bootstrap. `nativeCurrency.symbol` comes from the shared
 * `nativeGasSymbol` map (no daemon route exposes nativeCurrency); decimals are 18 on every supported
 * chain (ETH/xDAI/NEURO).
 */
export function synthesizeChain(chainId: string | number, rpcUrls: string[]): Chain {
  const id = numericChainId(chainId);
  const symbol = nativeGasSymbol(chainId);
  return defineChain({
    id,
    name: `chain-${id}`,
    nativeCurrency: { name: symbol, symbol, decimals: 18 },
    rpcUrls: { default: { http: rpcUrls } },
  });
}

const publicCache = new Map<string, PublicClient>();

function publicClientCacheKey(chainId: string | number, rpcUrls: string[]): string {
  return `${numericChainId(chainId)}:${rpcUrls.join('|')}`;
}

function isSameOriginRpcUrl(url: string): boolean {
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  if (typeof window === 'undefined' || !window.location?.origin) return false;
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

function rpcFetchOptions(url: string): RequestInit | undefined {
  if (!isSameOriginRpcUrl(url)) return undefined;
  const headers = authHeaders();
  return Object.keys(headers).length ? { headers } : undefined;
}

/**
 * A read client for the bootstrap chain (cached per chain id + RPC URL set). Transport tuning ported from
 * staking-ui: capped batching (public RPCs throttle/blackhole uncapped batches), an explicit
 * per-attempt timeout, and a per-endpoint retry budget SCALED TO THE POOL — a multi-RPC chain
 * gets retryCount:0 (resilience IS the next endpoint) while a single-endpoint chain keeps
 * retryCount:2 as its only resiliency budget.
 */
export function publicClientFor(chainId: string | number, rpcUrls: string[]): PublicClient {
  const key = publicClientCacheKey(chainId, rpcUrls);
  const cached = publicCache.get(key);
  if (cached) return cached;
  const chain = synthesizeChain(chainId, rpcUrls);
  const multiRpc = rpcUrls.length > 1;
  const transport = fallback(
    rpcUrls.map((url) => {
      const fetchOptions = rpcFetchOptions(url);
      return http(url, {
        batch: { batchSize: 20, wait: 16 },
        timeout: 8_000,
        retryCount: multiRpc ? 0 : 2,
        retryDelay: 200,
        ...(fetchOptions ? { fetchOptions } : {}),
      });
    }),
    { retryCount: 1, retryDelay: 250 },
  );
  const client = createPublicClient({ chain, transport });
  publicCache.set(key, client);
  return client;
}

/**
 * A write client over the connected wallet's EIP-1193 provider. NOT memoized — the active provider
 * changes on wallet swap / disconnect-reconnect, so the caller passes the CURRENT provider from the
 * wallet store and gives the result a short lifetime (typically one tx). The `chain` pins viem's
 * pre-send chain-id assertion so a mid-flow network switch is caught.
 */
export function walletClientFromProvider(chain: Chain, provider: Eip1193Provider): WalletClient {
  return createWalletClient({ chain, transport: custom(provider) });
}

/** Test seam — clear the publicClient cache between unit tests. */
export function _resetClientCacheForTesting(): void {
  publicCache.clear();
}
