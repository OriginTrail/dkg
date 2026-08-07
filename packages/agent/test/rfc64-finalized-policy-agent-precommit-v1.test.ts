import { describe, expect, it, vi } from 'vitest';

import { createRfc64FinalizedPolicyAgentPrecommitV1 } from '../src/rfc64/finalized-policy-agent-precommit-v1.js';
import {
  RFC64_VM_CHAIN_ID,
  RFC64_VM_CONTEXT_GRAPH_NAME,
  RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
} from './support/rfc64-finalized-vm-placement-fixture.js';
import {
  rfc64FinalizedVmPrecommitOptions,
  rfc64FinalizedVmPrecommitPlan,
} from './support/rfc64-finalized-vm-precommit-fixture.js';

function options() {
  const fixture = rfc64FinalizedVmPrecommitOptions();
  return {
    acceptedPolicySnapshotForCatalogScope: fixture.acceptedPolicySnapshotForCatalogScope,
    rpcEndpoints: fixture.rpcEndpoints,
    getOnChainContextGraphId: fixture.getOnChainContextGraphId,
    getEvmChainId: fixture.getEvmChainId,
  };
}

describe('RFC-64 finalized policy agent precommit', () => {
  it('accepts a chain-bound SWM catalog without invoking VM materialization', async () => {
    const getOnChainContextGraphId = vi.fn(async () => RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID);
    const getEvmChainId = vi.fn(async () => BigInt(RFC64_VM_CHAIN_ID));
    const handler = createRfc64FinalizedPolicyAgentPrecommitV1({
      ...options(),
      getOnChainContextGraphId,
      getEvmChainId,
    });

    await expect(handler(
      rfc64FinalizedVmPrecommitPlan(),
      new AbortController().signal,
    )).resolves.toBeUndefined();
    expect(getOnChainContextGraphId).toHaveBeenCalledWith(
      RFC64_VM_CONTEXT_GRAPH_NAME,
      expect.any(AbortSignal),
    );
    expect(getEvmChainId).toHaveBeenCalledOnce();
  });

  it('rejects before chain resolution when trusted RPC endpoints are absent', async () => {
    const getOnChainContextGraphId = vi.fn(async () => RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID);
    const getEvmChainId = vi.fn(async () => BigInt(RFC64_VM_CHAIN_ID));
    const handler = createRfc64FinalizedPolicyAgentPrecommitV1({
      ...options(),
      rpcEndpoints: [],
      getOnChainContextGraphId,
      getEvmChainId,
    });

    await expect(handler(
      rfc64FinalizedVmPrecommitPlan(),
      new AbortController().signal,
    )).rejects.toThrow('requires trusted RPC configuration');
    expect(getOnChainContextGraphId).not.toHaveBeenCalled();
    expect(getEvmChainId).not.toHaveBeenCalled();
  });

  it('rejects a missing CG mapping or a different live chain', async () => {
    const missingContextGraph = createRfc64FinalizedPolicyAgentPrecommitV1({
      ...options(),
      getOnChainContextGraphId: async () => null,
    });
    await expect(missingContextGraph(
      rfc64FinalizedVmPrecommitPlan(),
      new AbortController().signal,
    )).rejects.toThrow('could not resolve the numeric context graph id');

    const differentChain = createRfc64FinalizedPolicyAgentPrecommitV1({
      ...options(),
      getEvmChainId: async () => 1n,
    });
    await expect(differentChain(
      rfc64FinalizedVmPrecommitPlan(),
      new AbortController().signal,
    )).rejects.toThrow('differs from the configured chain id');
  });
});
