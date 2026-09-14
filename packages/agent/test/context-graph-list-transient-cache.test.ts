import { contextGraphDataUri } from '@origintrail-official/dkg-core';
import { describe, expect, it, vi } from 'vitest';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';

const CONTEXT_GRAPH_ID = 'listing-transient-authority-failure';

function projectedMeta() {
  return {
    id: CONTEXT_GRAPH_ID,
    uri: contextGraphDataUri(CONTEXT_GRAPH_ID),
    declared: true,
    isSystem: false,
    name: CONTEXT_GRAPH_ID,
    creators: [],
    curators: [],
    allowedPeers: [],
    allowedAgents: [],
    participantAgents: [],
    participantIdentityIds: [],
    revokedAgents: [],
    subGraphs: [],
    hasAgentGate: false,
    hasPeerGate: false,
    hasLegacyParticipantGate: false,
    accessPolicy: 'public',
  };
}

function transientFailureAgent() {
  let authorityAttempt = 0;
  const resolveFinalized = vi.fn(async () => {
    authorityAttempt += 1;
    if (authorityAttempt === 1) throw new Error('transient finalized reader failure');
    return {
      kind: 'finalized-index' as const,
      targets: new Map([[CONTEXT_GRAPH_ID, {
        expectedNameHash: `0x${'44'.repeat(32)}`,
        expectedOnChainId: 944n,
      }]]),
    };
  });
  const fakeAgent = {
    subscribedContextGraphs: new Map(),
    store: {
      query: async () => ({
        type: 'bindings' as const,
        bindings: [{
          ctxGraph: contextGraphDataUri(CONTEXT_GRAPH_ID),
          name: `"${CONTEXT_GRAPH_ID}"`,
          access: '"public"',
        }],
      }),
      listGraphsByPrefix: async () => [],
    },
    getCgMeta: async () => projectedMeta(),
    resolveFinalizedContextGraphAuthorityTargetsV1: resolveFinalized,
    readLocalContextGraphRegistrationStatus: async () => null,
    getContextGraphOnChainId: vi.fn(async () => null),
    getContextGraphCurator: async () => undefined,
    isPrivateContextGraph: async () => false,
    curatorDidMatchesChecksumAgent: () => false,
    callerIsAllowlistedAgentParticipant: async () => false,
    listContextGraphsCacheAllowed: () => true,
    listContextGraphsCacheNow: () => 1_000,
    listContextGraphsCacheGeneration: 0,
    listContextGraphsCache: new Map(),
    listContextGraphsInFlight: new Map(),
    listContextGraphsUncached:
      (ContextGraphResolveMethods.prototype as any).listContextGraphsUncached,
  };
  return { fakeAgent, resolveFinalized };
}

describe('context graph listing transient failure cache policy', () => {
  it('marks a direct degraded authority result as non-cacheable', async () => {
    const { fakeAgent } = transientFailureAgent();

    const result = await (ContextGraphResolveMethods.prototype as any)
      .listContextGraphsUncached.call(fakeAgent, null, true);

    expect(result.rows).toEqual([
      expect.objectContaining({ id: CONTEXT_GRAPH_ID, onChainId: undefined }),
    ]);
    expect(result.cacheable).toBe(false);
  });

  it('retries after a degraded public listing and caches only the recovered result', async () => {
    const { fakeAgent, resolveFinalized } = transientFailureAgent();
    const listContextGraphs = ContextGraphResolveMethods.prototype.listContextGraphs;

    const degraded = await listContextGraphs.call(fakeAgent as any, {
      callerAgentAddress: null,
    });
    expect(degraded).toEqual([
      expect.objectContaining({ id: CONTEXT_GRAPH_ID, onChainId: undefined }),
    ]);
    expect(fakeAgent.listContextGraphsCache.size).toBe(0);

    const recovered = await listContextGraphs.call(fakeAgent as any, {
      callerAgentAddress: null,
    });
    expect(recovered).toEqual([
      expect.objectContaining({ id: CONTEXT_GRAPH_ID, onChainId: '944' }),
    ]);
    expect(resolveFinalized).toHaveBeenCalledTimes(2);
    expect(fakeAgent.listContextGraphsCache.size).toBe(1);
  });
});
