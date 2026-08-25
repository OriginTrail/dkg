import { describe, expect, it, vi } from 'vitest';

import { createRfc64FinalizedVmAgentPrecommitV1 } from '../src/rfc64/finalized-vm-agent-precommit-v1.js';
import { FinalizedVmCompositionErrorV1 } from '../src/rfc64/finalized-vm-composer-v1.js';
import {
  RFC64_VM_CHAIN_ID,
  RFC64_VM_CONTEXT_GRAPH_NAME,
  RFC64_VM_KA_STORAGE,
  RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
} from './support/rfc64-finalized-vm-placement-fixture.js';
import {
  rfc64FinalizedVmPrecommitOptions as baseOptions,
  rfc64FinalizedVmPrecommitPlan as plan,
} from './support/rfc64-finalized-vm-precommit-fixture.js';


describe('RFC-64 finalized VM agent precommit', () => {
  it('rejects named-subgraph recovery before chain resolution in Release 2', async () => {
    const getOnChainContextGraphId = vi.fn(async () => RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID);
    const getEvmChainId = vi.fn(async () => BigInt(RFC64_VM_CHAIN_ID));
    const handler = createRfc64FinalizedVmAgentPrecommitV1({
      ...baseOptions(),
      getOnChainContextGraphId,
      getEvmChainId,
    });
    const namedPlan = {
      ...plan(),
      catalogScope: { ...plan().catalogScope, subGraphName: 'private-lane' },
    } as never;

    await expect(handler(namedPlan, new AbortController().signal)).rejects.toMatchObject({
      name: 'FinalizedVmCompositionErrorV1',
      code: 'finalized-vm-composition-input',
    } satisfies Partial<FinalizedVmCompositionErrorV1>);
    expect(getOnChainContextGraphId).not.toHaveBeenCalled();
    expect(getEvmChainId).not.toHaveBeenCalled();
  });

  it('rejects when the cleartext catalog lane has no numeric on-chain binding', async () => {
    const getOnChainContextGraphId = vi.fn(async () => null);
    const handler = createRfc64FinalizedVmAgentPrecommitV1({
      ...baseOptions(),
      getOnChainContextGraphId,
    });

    await expect(handler(plan(), new AbortController().signal)).rejects.toThrow(
      'could not resolve the numeric context graph id',
    );
    expect(getOnChainContextGraphId).toHaveBeenCalledWith(
      RFC64_VM_CONTEXT_GRAPH_NAME,
      expect.any(AbortSignal),
    );
  });

  it('rejects before chain resolution when trusted RPC endpoints are empty', async () => {
    const getOnChainContextGraphId = vi.fn(async () => RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID);
    const getEvmChainId = vi.fn(async () => BigInt(RFC64_VM_CHAIN_ID));
    const getKnowledgeAssetStorageAddress = vi.fn(async () => RFC64_VM_KA_STORAGE);
    const handler = createRfc64FinalizedVmAgentPrecommitV1({
      ...baseOptions(),
      rpcEndpoints: [],
      getOnChainContextGraphId,
      getEvmChainId,
      getKnowledgeAssetStorageAddress,
    });

    await expect(handler(plan(), new AbortController().signal)).rejects.toThrow(
      'requires trusted RPC configuration',
    );
    expect(getOnChainContextGraphId).not.toHaveBeenCalled();
    expect(getEvmChainId).not.toHaveBeenCalled();
    expect(getKnowledgeAssetStorageAddress).not.toHaveBeenCalled();
  });

  it('rejects when the live adapter chain differs from the accepted finalized policy', async () => {
    const handler = createRfc64FinalizedVmAgentPrecommitV1({
      ...baseOptions(),
      getEvmChainId: async () => 1n,
    });

    await expect(handler(plan(), new AbortController().signal)).rejects.toThrow(
      'policy differs from the configured chain id',
    );
  });

  it('canonicalizes chain-service scalar responses at the precommit boundary', async () => {
    const noncanonicalContextGraphId = createRfc64FinalizedVmAgentPrecommitV1({
      ...baseOptions(),
      getOnChainContextGraphId: async () => '01',
    });
    await expect(
      noncanonicalContextGraphId(plan(), new AbortController().signal),
    ).rejects.toThrow('on-chain context graph id must be a canonical unsigned decimal');

    const noncanonicalKnowledgeAssetStorage = createRfc64FinalizedVmAgentPrecommitV1({
      ...baseOptions(),
      getKnowledgeAssetStorageAddress: async () => '0x1234',
    });
    await expect(
      noncanonicalKnowledgeAssetStorage(plan(), new AbortController().signal),
    ).rejects.toThrow('knowledge asset storage address must be a lowercase 20-byte');

    const noncanonicalKnowledgeAssetsLifecycle = createRfc64FinalizedVmAgentPrecommitV1({
      ...baseOptions(),
      getKnowledgeAssetsLifecycleAddress: async () => '0x1234',
    });
    await expect(
      noncanonicalKnowledgeAssetsLifecycle(plan(), new AbortController().signal),
    ).rejects.toThrow('knowledge assets lifecycle address must be a lowercase 20-byte');
  });
});


