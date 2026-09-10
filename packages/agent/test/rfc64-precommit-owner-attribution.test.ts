import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  EVMChainAdapter,
  acquireFinalizedChainRead,
  finalizedChainReadRegistryDepth,
} from '@origintrail-official/dkg-chain';
import { describe, expect, it, vi } from 'vitest';
import { createRfc64FinalizedAgentPrecommitsV1 } from '../src/rfc64/finalized-agent-precommits-v1.js';
import {
  acceptedRfc64VmPolicySnapshot,
  rfc64FinalizedVmPrecommitPlan,
} from './support/rfc64-finalized-vm-precommit-fixture.js';
import {
  RFC64_VM_CHAIN_ID,
  RFC64_VM_KAV10,
  RFC64_VM_KA_STORAGE,
  RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
} from './support/rfc64-finalized-vm-placement-fixture.js';

async function waitForPermit(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (finalizedChainReadRegistryDepth(RFC64_VM_CHAIN_ID) === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('production precommit never took the shared finalized-read permit');
}

function adapterForEndpoint(endpoint: string) {
  const adapter = new EVMChainAdapter({
    rpcUrl: endpoint, privateKey: `0x${'11'.repeat(32)}`,
    hubAddress: `0x${'22'.repeat(20)}`, chainId: 'evm:20430',
    staticNetwork: false, allowNoAdminSigner: true,
  });
  const getChainId = vi.spyOn(adapter, 'getEvmChainId').mockResolvedValue(BigInt(RFC64_VM_CHAIN_ID));
  vi.spyOn(adapter, 'getDKGKnowledgeAssetsAddress').mockResolvedValue(RFC64_VM_KA_STORAGE);
  vi.spyOn(adapter, 'getKnowledgeAssetsLifecycleAddress').mockResolvedValue(RFC64_VM_KAV10);
  return { adapter, getChainId };
}

describe('RFC-64 production catalog precommit owner attribution', () => {
  it.each(['finalizedPolicyPrecommit', 'finalizedVmPrecommit'] as const)(
    '%s owns the shared permit as rfc64 and releases it after abort', async (kind) => {
      // A hanging RPC holds the real permit while another owner observes it.
      const server = createServer(() => {});
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const store = new OxigraphStore();
      const { adapter, getChainId } = adapterForEndpoint(endpoint);
      // Spy without replacing the implementation: the production catalog
      // composition selects the owner, and the real adapter builds the scope.
      const createBinding = vi.spyOn(adapter, 'createFinalizedEvmReadBinding');
      const handlers = createRfc64FinalizedAgentPrecommitsV1({
        chain: adapter, store,
        acceptedPolicySnapshotForCatalogScope: acceptedRfc64VmPolicySnapshot,
        getOnChainContextGraphId: async () => RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
      });
      const abort = new AbortController();
      const running = handlers[kind](rfc64FinalizedVmPrecommitPlan(), abort.signal).catch(() => undefined);
      try {
        await waitForPermit();
        expect(createBinding).toHaveBeenCalledExactlyOnceWith('rfc64');
        expect(getChainId).toHaveBeenCalledOnce();
        await expect(acquireFinalizedChainRead(
          { chainId: RFC64_VM_CHAIN_ID, owner: 'w2-page' },
          async () => 'must-not-run',
          (active, owner) => new Error(`saturated:${active}:${owner}`),
        )).rejects.toThrow('saturated:1:rfc64');
      } finally {
        abort.abort();
        await running;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await store.close();
        vi.restoreAllMocks();
      }
      expect(finalizedChainReadRegistryDepth(RFC64_VM_CHAIN_ID)).toBe(0);
      await expect(acquireFinalizedChainRead(
        { chainId: RFC64_VM_CHAIN_ID, owner: 'w2-page' },
        async () => 'reusable',
        (active) => new Error(`saturated:${active}`),
      )).resolves.toBe('reusable');
    }, 40_000,
  );

  it('fails closed when the adapter lacks VM storage address capability', async () => {
    const { adapter } = adapterForEndpoint('http://127.0.0.1:8545');
    Object.defineProperty(adapter, 'getDKGKnowledgeAssetsAddress', { value: undefined });
    const store = new OxigraphStore();
    const { finalizedVmPrecommit } = createRfc64FinalizedAgentPrecommitsV1({
      chain: adapter, store,
      acceptedPolicySnapshotForCatalogScope: acceptedRfc64VmPolicySnapshot,
      getOnChainContextGraphId: async () => RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
    });
    try {
      await expect(finalizedVmPrecommit(
        rfc64FinalizedVmPrecommitPlan(), new AbortController().signal,
      )).rejects.toThrow('RFC-64 finalized VM recovery requires KnowledgeAssetStorage');
      expect(finalizedChainReadRegistryDepth(RFC64_VM_CHAIN_ID)).toBe(0);
    } finally {
      vi.restoreAllMocks();
      await store.close();
    }
  });
});
