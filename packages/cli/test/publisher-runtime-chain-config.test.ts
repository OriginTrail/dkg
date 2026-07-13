import { describe, expect, it } from 'vitest';
import { projectRuntimeEvmChainConfig } from '../src/runtime-chain-config.js';

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
      approvalPolicy: {
        mode: 'replenishing',
        targetAllowance: '123456789',
        refillBelowFraction: 0.25,
      },
      cgRegistryScanPageSize: 777,
      minPublisherNativeWei: 123n,
      minPublisherTracWei: 456n,
    });

    expect(projected).toEqual({
      rpcUrl: 'http://127.0.0.1:8545',
      rpcUrls: ['https://backup.example'],
      walletRpcUrls: ['https://wallet.example'],
      hubAddress: '0x1111111111111111111111111111111111111111',
      tokenAddress: '0x2222222222222222222222222222222222222222',
      chainId: 'evm:31337',
      receiptTimeoutMs: 1_200_000,
      approvalPolicy: {
        mode: 'replenishing',
        targetAllowance: 123456789n,
        refillBelowFraction: 0.25,
      },
      cgRegistryScanPageSize: 777,
      minPublisherNativeWei: 123n,
      minPublisherTracWei: 456n,
    });
  });

  it('requires both adapter endpoint and Hub address', () => {
    expect(projectRuntimeEvmChainConfig({
      rpcUrl: 'http://127.0.0.1:8545',
      receiptTimeoutMs: 1_200_000,
    })).toBeUndefined();
  });
});
