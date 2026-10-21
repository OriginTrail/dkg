import type { RpcUsageWindow } from './rpc-usage.js';
import type { RpcUsageScope } from './rpc-usage-scope.js';
// SPDX-License-Identifier: Apache-2.0
import type { ChainAdapter, ChainReadOptions } from './chain-adapter.js';
import type { PublicGraphSnapshot } from './public-graph-snapshot.js';

/** Locally configured DKG deployment. A remote peer cannot nominate a registry or RPC endpoint. */
export interface CoreChainCacheRegistry {
  readonly chainId: string;
  readonly deploymentId: string;
  verifyACKIdentity: NonNullable<ChainAdapter['verifyACKIdentity']>;
  readPublicGraphSnapshot(contextGraphId: string, onChainId: string, options: ChainReadOptions): Promise<PublicGraphSnapshot>;
  drainRpcUsage?(): RpcUsageWindow;
  rpcUsage(scope?: RpcUsageScope): Readonly<Record<string, number>>;
  destroy(): void;
}
