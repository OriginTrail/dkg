import type { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { describe, expect, it } from 'vitest';
import { sealChainTargetMismatch } from '../src/seal-chain-target.js';

describe('sealChainTargetMismatch', () => {
  const kav10Address = `0x${'12'.repeat(20)}`;
  const seal = { chainId: 31337n, kav10Address };
  const chainAt = (chainId: bigint, kav10: string) => ({
    getEvmChainId: async () => chainId,
    getKnowledgeAssetsLifecycleAddress: async () => kav10,
  }) as unknown as MockChainAdapter;

  it('accepts a seal for this chain and deployment, and an adapter without an EVM identity', async () => {
    await expect(sealChainTargetMismatch(chainAt(31337n, kav10Address.toUpperCase().replace('0X', '0x')), seal)).resolves.toBeUndefined();
    await expect(sealChainTargetMismatch({} as MockChainAdapter, seal)).resolves.toBeUndefined();
  });

  it('names the chain or deployment the seal binds instead', async () => {
    await expect(sealChainTargetMismatch(chainAt(100n, kav10Address), seal))
      .resolves.toMatch(/^seal binds chainId=31337 but daemon is configured for chainId=100\./);
    await expect(sealChainTargetMismatch(chainAt(31337n, `0x${'34'.repeat(20)}`), seal))
      .resolves.toMatch(/^seal binds KAv10=0x1212.* but daemon is configured for KAv10=0x3434/);
  });
});
