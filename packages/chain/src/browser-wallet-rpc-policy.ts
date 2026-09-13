import type { BrowserWalletRpcMethod } from './chain-adapter.js';

const TIP_BLOCK_TAGS = new Set<string>(['latest', 'pending', 'safe', 'finalized']);

export type BrowserWalletReadStrategy =
  | 'tipTransparent'
  | 'tipNullableTransparent'
  | 'stickyNullable'
  | 'sticky';

/** Select failover semantics for the bounded read methods used by browser wallets. */
export function classifyBrowserWalletRead(
  method: BrowserWalletRpcMethod,
  params: readonly unknown[],
): BrowserWalletReadStrategy {
  const isLatestFamilyTag = (tag: unknown): boolean =>
    typeof tag === 'string' && TIP_BLOCK_TAGS.has(tag);
  switch (method) {
    case 'eth_blockNumber':
      return 'tipTransparent';
    case 'eth_call':
      return params[1] === undefined || isLatestFamilyTag(params[1])
        ? 'tipTransparent'
        : 'sticky';
    case 'eth_getBlockByNumber':
      return isLatestFamilyTag(params[0]) ? 'tipNullableTransparent' : 'stickyNullable';
    case 'eth_getTransactionReceipt':
    case 'eth_getTransactionByHash':
      return 'stickyNullable';
    case 'eth_chainId':
      return 'sticky';
  }
  const exhaustive: never = method;
  return exhaustive;
}
