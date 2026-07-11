export * from './chain-adapter.js';
// RPC-usage accounting: ONLY the typed window contract is public API (consumed
// by the ChainAdapter.drainRpcUsage capability, the agent boundary, and the
// daemon's rpc_usage log emission). The parsing/label-bounding helpers stay
// package-internal (imported via ./rpc-usage.js) so the transport accounting
// implementation can change without a public-API break.
export {
  emptyRpcUsageWindow,
  mergeRpcUsageWindows,
  normalizeRpcUsageWindow,
  rpcUsageWindowTotal,
  type NormalizedRpcUsageWindow,
  type RpcUsageDrainable,
  type RpcUsageWindow,
} from './rpc-usage.js';
export { MockChainAdapter, MOCK_DEFAULT_SIGNER } from './mock-adapter.js';
export {
  EVMChainAdapter,
  type EVMAdapterConfig,
  decodeEvmError,
  enrichEvmError,
  isRetryableRpcError,
  isKnownTransactionError,
  resolveRpcUrls,
  effectivePublishAllowance,
  computeApprovalAction,
  V10_PUBLISH_ONCHAIN_MIN_ALLOWANCE,
  InsufficientPublisherFundsError,
  isNoFundedPublisherWalletError,
  NO_FUNDED_PUBLISHER_WALLET_CODE,
  type PublisherWalletBalance,
} from './evm-adapter.js';
export { NoChainAdapter } from './no-chain-adapter.js';
export {
  ChainRpcTransportError,
  isChainRpcTransportError,
  createRpcTimeoutError,
  type ChainRpcTransportCode,
  type ChainRpcTransportErrorLike,
} from './chain-rpc-transport-error.js';
export {
  // Surfaced for the daemon /api/status counter + the CLI failover loop.
  // Test-only hook exported so cross-package route tests can reset the exact
  // package singleton that production code reads. Internal helpers
  // (classifyRpcFailoverError/rpcHost) stay private.
  getRpcFailoverStats,
  type RpcFailoverStatsSnapshot,
  _resetRpcFailoverStatsForTest,
  noteRpcFailover,
  noteRpcExhaustion,
  notePreferredEndpoint,
  noteRpcServed,
} from './rpc-failover-log.js';
export {
  HubResolutionCache,
  type HubResolutionCacheOptions,
} from './hub-resolution-cache.js';
export { PcaUnavailableError, isPcaUnavailableError } from './pca-errors.js';
