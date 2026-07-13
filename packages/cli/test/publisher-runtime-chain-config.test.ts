import { describe, expect, it } from 'vitest';
import { projectPublisherRuntimeChainConfig } from '../src/publisher-runner.js';

describe('publisher runtime chain config projection', () => {
  it('preserves the configured receipt deadline for standalone startup', () => {
    expect(projectPublisherRuntimeChainConfig({
      rpcUrl: 'http://127.0.0.1:8545',
      hubAddress: '0x1111111111111111111111111111111111111111',
      receiptTimeoutMs: 1_200_000,
    })).toMatchObject({ receiptTimeoutMs: 1_200_000 });
  });

  it('requires both adapter endpoint and Hub address', () => {
    expect(projectPublisherRuntimeChainConfig({
      rpcUrl: 'http://127.0.0.1:8545',
      receiptTimeoutMs: 1_200_000,
    })).toBeUndefined();
  });
});
