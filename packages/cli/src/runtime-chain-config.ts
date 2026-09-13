import type {
  EVMAdapterConfig,
  RpcRequestAdmission,
  RpcRequestGovernor,
  RpcUsageWindow,
} from '@origintrail-official/dkg-chain';
import {
  createRpcUsageRecorder,
  RpcRequestGovernor as ProcessRpcRequestGovernor,
} from '@origintrail-official/dkg-chain';
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
  | 'rpcRequestGovernor'
>;

/** Pure resolved values before the composition root attaches process state. */
export type RuntimeEvmChainConfigProjection = Omit<
  RuntimeEvmChainConfig,
  'rpcRequestGovernor'
>;

/** One explicit transport policy shared by every daemon-owned route provider. */
export interface DaemonRouteRpcTransport {
  readonly admission: RpcRequestAdmission;
  readonly diagnosticAdmission: RpcRequestAdmission;
  readonly onRequest: (method: string, endpointSlot?: number) => void;
}

/** Process-owned RPC state assembled once at the daemon composition root. */
export interface DaemonRpcRuntime {
  readonly governor: RpcRequestGovernor;
  readonly chainConfig: RuntimeEvmChainConfig;
  readonly routeTransport: DaemonRouteRpcTransport;
  readonly drainRouteRpcUsage: () => RpcUsageWindow;
}

export function createDaemonRpcRuntime(
  chain: ResolvedChainConfig | undefined,
): DaemonRpcRuntime | undefined {
  const projected = projectRuntimeEvmChainConfig(chain);
  if (projected === undefined) return undefined;
  const governor = new ProcessRpcRequestGovernor(chain?.rpcRequestBudget);
  const usage = createRpcUsageRecorder(() => chain?.chainId ?? 'unknown');
  return Object.freeze({
    governor,
    chainConfig: bindRuntimeRpcRequestGovernor(projected, governor),
    routeTransport: Object.freeze({
      admission: governor,
      diagnosticAdmission: Object.freeze({
        acquireActiveRequest: (signal?: AbortSignal) =>
          governor.acquireDiagnosticRequestImmediately(signal),
      }),
      onRequest: (method: string, endpointSlot?: number) => usage.record(method, endpointSlot),
    }),
    drainRouteRpcUsage: () => usage.drainRpcUsage(),
  });
}

/** Bind an explicitly process-owned governor to a pure resolved projection. */
export function bindRuntimeRpcRequestGovernor(
  projected: RuntimeEvmChainConfigProjection,
  rpcRequestGovernor: RpcRequestGovernor,
): RuntimeEvmChainConfig {
  return { ...projected, rpcRequestGovernor };
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
    maxFeePerGasWei: chain.maxFeePerGasWei,
    approvalPolicy: resolveApprovalPolicy(chain.approvalPolicy),
    cgRegistryScanPageSize: chain.cgRegistryScanPageSize,
    minPublisherNativeWei: chain.minPublisherNativeWei,
    minPublisherTracWei: chain.minPublisherTracWei,
  };
}
