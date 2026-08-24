import type { EVMAdapterConfig } from '@origintrail-official/dkg-chain';
import {
  resolveApprovalPolicy,
  type ResolvedChainConfig,
} from './config.js';

/** Adapter-facing chain fields shared by daemon and publisher construction. */
export type RuntimeEvmChainConfig = Pick<
  EVMAdapterConfig,
  | 'rpcUrl' | 'rpcUrls' | 'walletRpcUrls' | 'hubAddress' | 'tokenAddress'
  | 'chainId' | 'receiptTimeoutMs' | 'approvalPolicy' | 'cgRegistryScanPageSize'
  | 'finalityConfirmations'
  | 'maxFeePerGasWei'
  | 'minPublisherNativeWei' | 'minPublisherTracWei'
>;

/** Neutral projection shared by the agent and every publisher adapter. */
export function projectRuntimeEvmChainConfig(
  chain: ResolvedChainConfig | undefined,
): RuntimeEvmChainConfig | undefined {
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
    maxFeePerGasWei: chain.maxFeePerGasWei,
    approvalPolicy: resolveApprovalPolicy(chain.approvalPolicy),
    cgRegistryScanPageSize: chain.cgRegistryScanPageSize,
    minPublisherNativeWei: chain.minPublisherNativeWei,
    minPublisherTracWei: chain.minPublisherTracWei,
  };
}
