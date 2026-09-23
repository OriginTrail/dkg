import { describe, expect, it, vi } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { contextGraphNameCommitmentOf } from '../src/context-graph-name-candidate.js';
import { ContextGraphRegistryMethods } from '../src/dkg-agent-cg-registry.js';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';

function fixture() {
  const query = vi.fn<TripleStore['query']>(async () => ({
    type: 'bindings',
    bindings: [],
  }));
  const agent: any = {
    store: { query } as unknown as TripleStore,
    subscribedContextGraphs: new Map(),
    contextGraphWireId: (id: string) => id,
    localCgIdForWireId: (id: string) => id,
    // The chain proves slot 7 for 'research', so the fallback reads the store.
    onChainContextGraphFacts: new Map([['7', { nameHash: contextGraphNameCommitmentOf('research') }]]),
    isWireIdKeyedSubscription: () => false,
  };
  agent.provenOnChainIdsFor = (contextGraphId: string) =>
    ContextGraphRegistryMethods.prototype.provenOnChainIdsFor.call(agent, contextGraphId);
  agent.provenOnChainContextGraphClaim = (contextGraphId: string, onChainId: string) =>
    ContextGraphRegistryMethods.prototype.provenOnChainContextGraphClaim.call(agent, contextGraphId, onChainId);
  agent.resolveContextGraphNameHashBindingTarget = (requestedId: string) =>
    ContextGraphResolveMethods.prototype.resolveContextGraphNameHashBindingTarget.call(
      agent,
      requestedId,
    );
  agent.resolveCurrentNameHashContextGraphBinding = (
    requestedId: string,
    options?: { signal?: AbortSignal },
  ) => ContextGraphResolveMethods.prototype.resolveCurrentNameHashContextGraphBinding.call(
    agent,
    requestedId,
    options,
  );
  agent.resolveContextGraphOnChainIdBinding = (
    requestedId: string,
    options?: { signal?: AbortSignal; source?: string },
  ) => ContextGraphRegistryMethods.prototype.resolveContextGraphOnChainIdBinding.call(
    agent,
    requestedId,
    options,
  );
  return { query, agent };
}

describe('context-graph on-chain id source labels', () => {
  it('uses the caller-provided source label', async () => {
    const { query, agent } = fixture();

    await expect(
      ContextGraphRegistryMethods.prototype.getContextGraphOnChainId.call(
        agent as never,
        'research',
        { source: 'agent.vmReconcile.resolveOnChainId' },
      ),
    ).resolves.toBeNull();

    expect(query.mock.calls[0]?.[1]?.source).toBe(
      'agent.vmReconcile.resolveOnChainId',
    );
  });

  it('uses a bounded provider label when the caller omits one', async () => {
    const { query, agent } = fixture();

    await expect(
      ContextGraphRegistryMethods.prototype.getContextGraphOnChainId.call(
        agent as never,
        'research',
      ),
    ).resolves.toBeNull();

    expect(query.mock.calls[0]?.[1]?.source).toBe(
      'agent.contextGraph.onChainId',
    );
  });
});
