import { describe, expect, it, vi } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ContextGraphRegistryMethods } from '../src/dkg-agent-cg-registry.js';

function fixture() {
  const query = vi.fn<TripleStore['query']>(async () => ({
    type: 'bindings',
    bindings: [],
  }));
  return {
    query,
    agent: {
      store: { query } as unknown as TripleStore,
      subscribedContextGraphs: new Map(),
      contextGraphWireId: (id: string) => id,
      localCgIdForWireId: (id: string) => id,
    },
  };
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
