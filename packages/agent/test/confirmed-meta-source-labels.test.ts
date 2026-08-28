import { describe, expect, it, vi } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';

describe('confirmed context-graph metadata source labels', () => {
  it('attributes every direct store proof by its bounded provider step', async () => {
    const query = vi.fn<TripleStore['query']>(async () => ({
      type: 'boolean',
      value: false,
    }));
    const store = { query } as unknown as TripleStore;
    const agent = {
      store,
      localApprovedAgentByCG: new Map(),
      subscribedContextGraphs: new Map(),
      resolveActivePublicContextGraphChainProof: vi.fn(async () => ({
        state: 'not-public',
        reason: 'unregistered',
      } as const)),
      isPrivateContextGraph: vi.fn(async () => false),
    };

    await expect(
      LifecycleSyncMethods.prototype.hasConfirmedMetaState.call(
        agent as never,
        'research',
      ),
    ).resolves.toBe(false);

    expect(query.mock.calls.map(([, options]) => options?.source)).toEqual([
      'agent.contextGraph.confirmedMeta.unregisteredPlaceholder',
      'agent.contextGraph.confirmedMeta.privateDefinition',
      'agent.contextGraph.confirmedMeta.publicDefinition',
      'agent.contextGraph.confirmedMeta.ontologyDeclaration',
    ]);
  });
});
