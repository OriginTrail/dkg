// SPDX-License-Identifier: Apache-2.0

import { MockChainAdapter, NoChainAdapter, type ChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { describe, expect, it, vi } from 'vitest';
import { createRfc64FinalizedAgentPrecommitsV1 } from '../src/rfc64/finalized-agent-precommits-v1.js';
import { acceptedRfc64VmPolicySnapshot, rfc64FinalizedVmPrecommitPlan } from './support/rfc64-finalized-vm-precommit-fixture.js';
import { RFC64_VM_AUTHOR, RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID } from './support/rfc64-finalized-vm-placement-fixture.js';

function legacyAdapter(): ChainAdapter {
  const adapter = new MockChainAdapter();
  // Model an already compiled custom adapter that predates this capability.
  Object.defineProperty(adapter, 'createFinalizedEvmReadBinding', { value: undefined });
  return adapter;
}

describe('legacy adapters at the finalized catalog composition boundary', () => {
  it.each(['finalizedPolicyPrecommit', 'finalizedVmPrecommit'] as const)(
    '%s rejects a missing capability with the controlled configuration error', async kind => {
      const store = new OxigraphStore();
      const chain = legacyAdapter();
      const handlers = createRfc64FinalizedAgentPrecommitsV1({
        chain, store,
        acceptedPolicySnapshotForCatalogScope: acceptedRfc64VmPolicySnapshot,
        getOnChainContextGraphId: async () => RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
      });
      try {
        await expect(handlers[kind](rfc64FinalizedVmPrecommitPlan(), new AbortController().signal))
          .rejects.toThrow('RFC-64 finalized precommit requires trusted RPC configuration');
        await expect(chain.getIdentityId()).resolves.toBe(0n);
      } finally {
        await store.close();
      }
    },
  );

  it.each([legacyAdapter(), new NoChainAdapter()])('keeps owner-signed policies usable without EVM reads', async chain => {
    const store = new OxigraphStore();
    const accepted = acceptedRfc64VmPolicySnapshot();
    const finalizedPlan = rfc64FinalizedVmPrecommitPlan();
    const resolveOnChain = vi.fn(async () => RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID);
    const { finalizedPolicyPrecommit } = createRfc64FinalizedAgentPrecommitsV1({
      chain, store,
      acceptedPolicySnapshotForCatalogScope: () => ({
        ...accepted,
        policy: {
          ...accepted.policy, governanceChainId: null, governanceContractAddress: null,
          source: { kind: 'owner-signed-unregistered', ownerAddress: RFC64_VM_AUTHOR, ownerAuthorityEra: accepted.policy.era },
        },
      }),
      getOnChainContextGraphId: resolveOnChain,
    });
    try {
      await expect(finalizedPolicyPrecommit({
        ...finalizedPlan,
        catalogScope: { ...finalizedPlan.catalogScope, governanceChainId: null, governanceContractAddress: null },
      }, new AbortController().signal)).resolves.toBeUndefined();
      expect(resolveOnChain).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });
});
