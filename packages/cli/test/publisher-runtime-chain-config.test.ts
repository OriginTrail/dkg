import { describe, expect, it } from 'vitest';
import { RpcRequestGovernor } from '@origintrail-official/dkg-chain';
import {
  bindRuntimeRpcRequestGovernor,
  projectRuntimeEvmChainConfig,
} from '../src/runtime-chain-config.js';

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
    expect(projected).not.toHaveProperty('rpcRequestGovernor');
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

    expect(agentConfig.rpcRequestGovernor).toBe(governor);
    expect(publisherConfig.rpcRequestGovernor).toBe(governor);
    expect(governor.snapshot()).toMatchObject({
      maxRequestsPerSecond: 7,
      availableTokens: 11,
      startupDelayRemainingMs: 0,
    });
    expect(governor.snapshot().backgroundMaxRequestsPerSecond).toBeCloseTo(2.8);
  });
});
