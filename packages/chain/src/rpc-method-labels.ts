// SPDX-License-Identifier: Apache-2.0

/**
 * The JSON-RPC methods our own code (via ethers v6) can issue. Used to BOUND
 * the metric label — anything outside maps to 'other' so the label set can
 * never grow unbounded. (Methods are self-generated, not peer input, so this is
 * defensive; the raw method still appears verbatim in the rpc_usage log lines,
 * where cardinality is not a concern.)
 */
export const KNOWN_RPC_METHODS: ReadonlySet<string> = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getBalance',
  'eth_getTransactionCount',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getLogs',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_sendRawTransaction',
  'eth_newFilter',
  'eth_getFilterChanges',
  'eth_uninstallFilter',
  'net_version',
  'web3_clientVersion',
]);

/** Bound a method name for use as a metric label (unknown → 'other'). */
export function boundedRpcMethodLabel(method: string): string {
  return KNOWN_RPC_METHODS.has(method) ? method : 'other';
}
