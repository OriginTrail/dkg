// SPDX-License-Identifier: Apache-2.0

import { resolveRpcUrls, type ChainAdapter } from '@origintrail-official/dkg-chain';

/**
 * The trusted RPC endpoints of the node's chain, for reads that open their own
 * pinned snapshot (the RFC-64 finalized precommits). The adapter that reads
 * the chain owns them when it names them, like its finality depth: `DKGAgent`
 * accepts a pre-built `chainAdapter` and then ignores `chainConfig`. The
 * configuration is the fallback for an adapter that names none, and null
 * means the node has no endpoint, so finalized-chain heads are refused.
 */
export function resolveChainRpcEndpointsV1(
  chain: Pick<ChainAdapter, 'getRpcUrls'>,
  config: { readonly rpcUrl: string; readonly rpcUrls?: string[] } | undefined,
): readonly string[] | null {
  // The capability is optional, and an adapter built outside this repository
  // may answer anything: a missing, empty, blank or malformed list falls back.
  const fromAdapter: unknown = typeof chain.getRpcUrls === 'function'
    ? chain.getRpcUrls()
    : undefined;
  if (
    Array.isArray(fromAdapter)
    && fromAdapter.length > 0
    && fromAdapter.every((url) => typeof url === 'string' && url.trim() !== '')
  ) {
    return Object.freeze(resolveRpcUrls(fromAdapter[0], fromAdapter.slice(1)));
  }
  return config === undefined ? null : resolveRpcUrls(config.rpcUrl, config.rpcUrls);
}
