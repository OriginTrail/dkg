import type {
  RpcRequestGovernor,
  RpcRequestGovernorWindow,
  RpcUsageWindow,
} from '@origintrail-official/dkg-chain';
import {
  createRpcRequestProvider,
  createRpcUsageRecorder,
  isRpcRequestGovernorQueueFullError,
  numericChainIdOf,
  resolveRpcUrls,
  RpcRequestGovernor as ProcessRpcRequestGovernor,
  withRpcRequestContext,
  withRpcRequestTimeout,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import type { ResolvedChainConfig } from '../config.js';
import {
  bindRuntimeRpcRequestGovernor,
  projectRuntimeEvmChainConfig,
  type RuntimeEvmChainConfig,
} from '../runtime-chain-config.js';

export interface DaemonRpcEndpointProbe {
  readonly index: number;
  readonly role: 'primary' | 'backup';
  readonly ok: boolean;
  readonly status: 'healthy' | 'unhealthy' | 'skipped-local-capacity';
  readonly latencyMs: number | null;
  readonly blockNumber: number | null;
  readonly error?: string;
}

/** One bound transport shared by every daemon-owned direct RPC route. */
export interface DaemonRouteRpcTransport {
  /** Non-draining snapshot; interval counters reset only at the daemon's log tick. */
  snapshotGovernor(): RpcRequestGovernorWindow;
  /**
   * Run `read` over providers built for this call and destroyed once it settles.
   *
   * ethers retries network discovery once a second for as long as a provider
   * lives, so a provider left behind keeps asking an endpoint that never
   * answers `eth_chainId` through the shared governor until the process exits.
   * The providers take the configured chain's network and send no discovery;
   * when the chain id has no numeric part they discover it, and destruction
   * ends that.
   */
  withProvider<T>(
    rpcUrl: string,
    rpcUrls: readonly string[] | undefined,
    read: (provider: ethers.JsonRpcProvider | ethers.FallbackProvider) => Promise<T>,
  ): Promise<T>;
  probeEndpoint(rpcUrl: string, index: number): Promise<DaemonRpcEndpointProbe>;
}

/** Process-owned RPC state assembled once at the daemon composition root. */
export interface DaemonRpcRuntime {
  readonly governor: RpcRequestGovernor;
  /** Omitted until the Hub fields required by the EVM adapter are complete. */
  readonly chainConfig?: RuntimeEvmChainConfig;
  readonly routeTransport: DaemonRouteRpcTransport;
  readonly drainRouteRpcUsage: () => RpcUsageWindow;
}

export function createDaemonRpcRuntime(
  chain: ResolvedChainConfig | undefined,
): DaemonRpcRuntime | undefined {
  // Direct daemon routes can use an RPC endpoint before the Hub/adaptor
  // configuration is complete. Own their governor and accounting as soon as
  // an endpoint exists; adapter projection remains independently optional.
  if (!chain?.rpcUrl) return undefined;
  const projected = projectRuntimeEvmChainConfig(chain);
  const governor = new ProcessRpcRequestGovernor(chain.rpcRequestBudget);
  const usage = createRpcUsageRecorder(() => chain.chainId ?? 'unknown', 'route_runtime');
  const onRequest = (method: string, endpointSlot?: number) => {
    usage.record(method, endpointSlot);
  };
  const staticChainId = numericChainIdOf(chain.chainId);
  const createProvider = (
    rpcUrl: string,
    rpcUrls?: readonly string[],
  ): ethers.JsonRpcProvider | ethers.FallbackProvider => {
    const urls = resolveRpcUrls(rpcUrl, rpcUrls === undefined ? undefined : [...rpcUrls]);
    const providers = urls.map((url, index) => createRpcRequestProvider(url, {
      maxRetries: urls.length > 1 ? 0 : undefined,
      providerOptions: { cacheTimeout: -1, batchMaxCount: 1 },
      ...(staticChainId === undefined ? {} : { network: ethers.Network.from(staticChainId) }),
      endpointSlot: index,
      admission: governor,
      onRequest,
    }));
    if (providers.length === 1) return providers[0];
    return new ethers.FallbackProvider(
      providers.map((provider, index) => ({
        provider,
        priority: index + 1,
        stallTimeout: 4_000,
        weight: 1,
      })),
      undefined,
      { quorum: 1 },
    );
  };
  const withProvider = async <T>(
    rpcUrl: string,
    rpcUrls: readonly string[] | undefined,
    read: (provider: ethers.JsonRpcProvider | ethers.FallbackProvider) => Promise<T>,
  ): Promise<T> => {
    const provider = createProvider(rpcUrl, rpcUrls);
    try {
      return await read(provider);
    } finally {
      // A FallbackProvider destroys each endpoint provider with itself.
      await provider.destroy();
    }
  };
  const probeEndpoint = async (
    rpcUrl: string,
    index: number,
  ): Promise<DaemonRpcEndpointProbe> => {
    const provider = createRpcRequestProvider(rpcUrl, {
      maxRetries: 0,
      providerOptions: { cacheTimeout: -1, batchMaxCount: 1 },
      endpointSlot: index,
      admission: {
        acquireActiveRequest: (signal?: AbortSignal) => (
          governor.acquireDiagnosticRequestImmediately(signal)
        ),
      },
      onRequest,
    });
    const start = Date.now();
    try {
      const response = await withRpcRequestContext(
        { requestClass: 'background' },
        () => withRpcRequestTimeout(
          3_000,
          'RPC health probe',
          () => provider._send({
            id: index + 1,
            jsonrpc: '2.0',
            method: 'eth_blockNumber',
            params: [],
          }),
        ),
      );
      const first = response[0];
      if (first === undefined || 'error' in first) {
        throw new Error('RPC health probe returned an error');
      }
      const rawBlockNumber = BigInt(String(first.result));
      if (rawBlockNumber > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('RPC health probe block number exceeds the safe integer range');
      }
      return Object.freeze({
        index,
        role: index === 0 ? 'primary' : 'backup',
        ok: true,
        status: 'healthy',
        latencyMs: Date.now() - start,
        blockNumber: Number(rawBlockNumber),
      });
    } catch (error) {
      const localCapacity = isRpcRequestGovernorQueueFullError(error);
      return Object.freeze({
        index,
        role: index === 0 ? 'primary' : 'backup',
        ok: false,
        status: localCapacity ? 'skipped-local-capacity' : 'unhealthy',
        latencyMs: null,
        blockNumber: null,
        error: localCapacity
          ? 'RPC health probe skipped: local diagnostic capacity unavailable'
          : error instanceof Error && error.message.includes('timed out')
            ? 'RPC health probe timed out'
            : 'RPC health probe failed',
      });
    } finally {
      provider.destroy();
    }
  };
  return Object.freeze({
    governor,
    ...(projected === undefined
      ? {}
      : { chainConfig: bindRuntimeRpcRequestGovernor(projected, governor) }),
    routeTransport: Object.freeze({ withProvider, probeEndpoint, snapshotGovernor: () => governor.snapshot() }),
    drainRouteRpcUsage: () => usage.drainRpcUsage(),
  });
}
