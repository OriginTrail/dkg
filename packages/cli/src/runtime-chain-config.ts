import type {
  EVMAdapterConfig,
  RpcRequestGovernor,
} from '@origintrail-official/dkg-chain';
import type { ChainAuthorityReadBudgetsConfig } from '@origintrail-official/dkg-agent';
import {
  resolveApprovalPolicy,
  type ResolvedChainConfig,
} from './config.js';

/**
 * Adapter-facing chain fields shared by daemon and publisher construction,
 * plus the agent-level authority read deadlines that ride along in the same
 * `chain` block (the adapter ignores them; the agent resolves them).
 */
export type RuntimeEvmChainConfig = Pick<
  EVMAdapterConfig,
  | 'rpcUrl' | 'rpcUrls' | 'walletRpcUrls' | 'hubAddress' | 'tokenAddress'
  | 'chainId' | 'receiptTimeoutMs' | 'approvalPolicy' | 'cgRegistryScanPageSize'
  | 'finalityConfirmations' | 'indexTickMs' | 'boundedAuthorityReads'
  | 'maxFeePerGasWei'
  | 'minPublisherNativeWei' | 'minPublisherTracWei'
  | 'rpcRequestAdmission'
> & ChainAuthorityReadBudgetsConfig;

/** Pure resolved values before the composition root attaches process state. */
export type RuntimeEvmChainConfigProjection = Omit<
  RuntimeEvmChainConfig,
  'rpcRequestAdmission'
>;

/** Bind an explicitly process-owned governor to a pure resolved projection. */
export function bindRuntimeRpcRequestGovernor(
  projected: RuntimeEvmChainConfigProjection,
  rpcRequestGovernor: RpcRequestGovernor,
): RuntimeEvmChainConfig {
  return { ...projected, rpcRequestAdmission: rpcRequestGovernor };
}

/** Neutral projection shared by the agent and every publisher adapter. */
export function projectRuntimeEvmChainConfig(
  chain: ResolvedChainConfig | undefined,
): RuntimeEvmChainConfigProjection | undefined {
  if (!chain?.rpcUrl || !chain.hubAddress) return undefined;
  return {
    rpcUrl: chain.rpcUrl,
    rpcUrls: chain.rpcUrls,
    walletRpcUrls: chain.walletRpcUrls,
    hubAddress: chain.hubAddress,
    tokenAddress: chain.tokenAddress,
    chainId: chain.chainId,
    receiptTimeoutMs: chain.receiptTimeoutMs,
    finalityConfirmations: chain.finalityConfirmations,
    indexTickMs: chain.indexTickMs,
    boundedAuthorityReads: chain.boundedAuthorityReads,
    authorityReadTimeoutMs: chain.authorityReadTimeoutMs,
    authorityColdResolutionTimeoutMs: chain.authorityColdResolutionTimeoutMs,
    maxFeePerGasWei: chain.maxFeePerGasWei,
    approvalPolicy: resolveApprovalPolicy(chain.approvalPolicy),
    cgRegistryScanPageSize: chain.cgRegistryScanPageSize,
    minPublisherNativeWei: chain.minPublisherNativeWei,
    minPublisherTracWei: chain.minPublisherTracWei,
  };
}
