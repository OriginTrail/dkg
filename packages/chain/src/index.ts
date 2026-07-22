export * from './chain-adapter.js';
export {
  CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1,
  CONTROL_EIP1271_CALL_FROM_V1,
  CONTROL_EIP1271_ENDPOINT_ATTEMPT_POLICY_V1,
  CONTROL_EIP1271_GAS_LIMIT_V1,
  CONTROL_EIP1271_MAX_ATTEMPTS_V1,
  CONTROL_EIP1271_MAX_CONCURRENT_CALLS_PER_CHAIN_V1,
  CONTROL_EIP1271_MAX_RPC_RESPONSE_BYTES_V1,
  CONTROL_EIP1271_MAX_RETURN_BYTES_V1,
  CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1,
  CONTROL_SIGNATURE_VERIFICATION_ERROR_CODES_V1,
  CURRENT_FINALIZED_EVM_CALL_ERROR_CODES_V1,
  EIP1271_CANONICAL_ABI_RETURN_V1,
  EIP1271_MAGIC_VALUE_V1,
  ControlSignatureVerificationErrorV1,
  CurrentFinalizedEvmCallErrorV1,
  assertVerifiedControlEnvelopeIssuerSignatureV1,
  readVerifiedControlEnvelopeIssuerSignatureV1,
  verifyControlEnvelopeIssuerSignatureV1,
  type ControlSignatureVerificationDispositionV1,
  type ControlSignatureVerificationErrorCodeV1,
  type ControlSignatureVerificationReasonV1,
  type CurrentFinalizedEvmCallErrorCodeV1,
  type CurrentFinalizedEvmCallRequestV1,
  type CurrentFinalizedEvmCallResultV1,
  type CurrentFinalizedEvmCallV1,
  type VerifiedControlEnvelopeIssuerSignatureV1,
  type VerifiedControlEnvelopeIssuerSignatureSnapshotV1,
  type VerifyControlEnvelopeIssuerSignatureOptionsV1,
} from './control-object-signature-verifier.js';
export {
  createCurrentFinalizedEvmCallRouterV1,
  type CurrentFinalizedEvmChainAdapterRegistrationV1,
  type CurrentFinalizedEvmChainAdapterV1,
} from './current-finalized-evm-call.js';
export {
  CURRENT_FINALIZED_EVM_BLOCK_REFERENCE_PROFILES_V1,
  createStrictCurrentFinalizedEvmChainAdapterV1,
  type CurrentFinalizedEvmBlockReferenceProfileV1,
  type StrictCurrentFinalizedEvmRpcConfigV1,
} from './strict-current-finalized-evm-rpc.js';
export {
  FinalizedContextGraphReadErrorV1,
  composeFinalizedContextGraphReadV1,
  resolveFinalizedContextGraphReadV1,
  validateFinalizedContextGraphReadRequestV1,
  type FinalizedContextGraphBindingV1,
  type FinalizedContextGraphReadErrorCodeV1,
  type FinalizedContextGraphReadRequestV1,
  type FinalizedContextGraphReadResolverV1,
  type FinalizedContextGraphReadV1,
  type UntrustedFinalizedContextGraphFieldsV1,
} from './finalized-context-graph-read.js';
export {
  resolveQuotedPublisherCandidatePricing,
  resolveLegacyPublisherCandidatePricing,
  type QuotedPublisherCandidatePricing,
  type QuotedPublisherCandidatePricingRequest,
  type LegacyPublisherCandidatePricing,
  type LegacyPublisherCandidatePricingRequest,
  type PublisherConvictionPlanReader,
  type LegacyPublisherConvictionPlanReader,
} from './publisher-plan.js';
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
export {
  MIN_RPC_RECEIPT_TIMEOUT_MS,
  RPC_RECEIPT_TIMEOUT_MS,
  resolveReceiptTimeoutMs,
} from './evm-adapter-constants.js';
export {
  waitForTransactionReceiptWithFailover,
  type TransactionReceiptEndpoint,
  type TransactionReceiptWaitOptions,
} from './rpc-failover-client.js';
