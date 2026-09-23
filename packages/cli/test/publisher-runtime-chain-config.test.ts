import { describe, expect, it } from 'vitest';
import { RpcRequestGovernor } from '@origintrail-official/dkg-chain';
import {
  bindRuntimeRpcRequestGovernor,
  projectRuntimeEvmChainConfig,
} from '../src/runtime-chain-config.js';
import { createDaemonRpcRuntime } from '../src/daemon/rpc-runtime.js';

describe('publisher runtime chain config projection', () => {
  it('preserves every adapter-facing runtime knob for standalone startup', () => {
    const projected = projectRuntimeEvmChainConfig({
      rpcUrl: 'http://127.0.0.1:8545',
      rpcUrls: ['https://backup.example'],
      walletRpcUrls: ['https://wallet.example'],
      hubAddress: '0x1111111111111111111111111111111111111111',
      tokenAddress: '0x2222222222222222222222222222222222222222',
      chainId: 'evm:31337',
      receiptTimeoutMs: 1_200_000,
      finalityConfirmations: 1,
      indexTickMs: 12_000,
      maxFeePerGasWei: 100_000_000n,
      approvalPolicy: {
        mode: 'replenishing',
        targetAllowance: '123456789',
        refillBelowFraction: 0.25,
      },
      cgRegistryScanPageSize: 777,
      minPublisherNativeWei: 123n,
      minPublisherTracWei: 456n,
    });

    expect(projected).toMatchObject({
      rpcUrl: 'http://127.0.0.1:8545',
      rpcUrls: ['https://backup.example'],
      walletRpcUrls: ['https://wallet.example'],
      hubAddress: '0x1111111111111111111111111111111111111111',
      tokenAddress: '0x2222222222222222222222222222222222222222',
      chainId: 'evm:31337',
      receiptTimeoutMs: 1_200_000,
      finalityConfirmations: 1,
      indexTickMs: 12_000,
      maxFeePerGasWei: 100_000_000n,
      approvalPolicy: {
        mode: 'replenishing',
        targetAllowance: 123456789n,
        refillBelowFraction: 0.25,
      },
      cgRegistryScanPageSize: 777,
      minPublisherNativeWei: 123n,
      minPublisherTracWei: 456n,
    });
    expect(projected).not.toHaveProperty('rpcRequestAdmission');
  });

  it('requires both adapter endpoint and Hub address', () => {
    expect(projectRuntimeEvmChainConfig({
      rpcUrl: 'http://127.0.0.1:8545',
      receiptTimeoutMs: 1_200_000,
    })).toBeUndefined();
  });

  it('binds configured policy and one shared governor identity to all consumers', () => {
    const projected = projectRuntimeEvmChainConfig({
      rpcUrl: 'http://127.0.0.1:8545',
      hubAddress: '0x1111111111111111111111111111111111111111',
    });
    expect(projected).toBeDefined();
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 7,
      foregroundReservePercent: 60,
      burstRequests: 11,
      maxQueueSize: 13,
      startupJitterMs: 0,
    });
    const agentConfig = bindRuntimeRpcRequestGovernor(projected!, governor);
    const publisherConfig = bindRuntimeRpcRequestGovernor(projected!, governor);

    expect(agentConfig.rpcRequestAdmission).toBe(governor);
    expect(publisherConfig.rpcRequestAdmission).toBe(governor);
    expect(governor.snapshot()).toMatchObject({
      maxRequestsPerSecond: 7,
      availableTokens: 11,
      startupDelayRemainingMs: 0,
    });
    expect(governor.snapshot().backgroundMaxRequestsPerSecond).toBeCloseTo(2.8);
  });

  it('assembles adapter, route admission, and telemetry from one process runtime', async () => {
    const runtime = createDaemonRpcRuntime({
      rpcUrl: 'http://127.0.0.1:8545',
      hubAddress: '0x1111111111111111111111111111111111111111',
      chainId: 'evm:31337',
      rpcRequestBudget: {
        maxRequestsPerSecond: 7,
        foregroundReservePercent: 60,
        burstRequests: 11,
        maxQueueSize: 13,
        startupJitterMs: 0,
      },
    })!;

    expect(runtime.chainConfig?.rpcRequestAdmission).toBe(runtime.governor);
    const probe = await runtime.routeTransport.probeEndpoint('http://127.0.0.1:1', 0);
    expect(probe).toMatchObject({ ok: false, status: 'unhealthy' });
    expect(runtime.drainRouteRpcUsage()).toMatchObject({
      byMethod: { eth_blockNumber: 1 },
      lifetimeTotal: 1,
    });
    await runtime.governor.acquireActiveRequest();
    expect(runtime.governor.snapshot().foregroundAdmitted).toBe(1);
  });

  it('assembles governed route RPC and telemetry from a partial adapter config', async () => {
    const runtime = createDaemonRpcRuntime({
      rpcUrl: 'http://127.0.0.1:1',
      chainId: 'evm:31337',
      rpcRequestBudget: {
        maxRequestsPerSecond: 7,
        foregroundReservePercent: 60,
        burstRequests: 11,
        maxQueueSize: 13,
        startupJitterMs: 0,
      },
    })!;

    expect(runtime.chainConfig).toBeUndefined();
    await expect(runtime.routeTransport.probeEndpoint('http://127.0.0.1:1', 0))
      .resolves.toMatchObject({ ok: false, status: 'unhealthy' });
    expect(runtime.governor.snapshot().backgroundAdmitted).toBe(1);
    expect(runtime.drainRouteRpcUsage()).toMatchObject({
      byMethod: { eth_blockNumber: 1 },
      lifetimeTotal: 1,
    });
  });
});
