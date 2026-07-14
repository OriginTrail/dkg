import { describe, expect, it } from 'vitest';
import { contextGraphDataUri } from '@origintrail-official/dkg-core';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';

const CALLER_ADDRESS = '0x1111111111111111111111111111111111111111';
const IDS = Array.from({ length: 24 }, (_, index) => `bounded-list-${index}`);

function projectedMeta(id: string) {
  return {
    id,
    uri: contextGraphDataUri(id),
    declared: true,
    isSystem: false,
    name: id,
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
  };
}

function concurrencyProbe() {
  let inFlight = 0;
  let peak = 0;
  return {
    run: async <T>(value: T): Promise<T> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return value;
      } finally {
        inFlight -= 1;
      }
    },
    peak: () => peak,
  };
}

describe('context graph list row concurrency', () => {
  it('bounds projection metadata and privacy fan-out', async () => {
    const probe = concurrencyProbe();
    const fakeAgent = {
      contextGraphMetaProjection: {
        listDeclaredContextGraphIds: async () => IDS,
      },
      subscribedContextGraphs: new Map(),
      store: {
        listGraphsByPrefix: async () => [],
      },
      getCgMeta: async (id: string) => probe.run({
        ...projectedMeta(id),
        accessPolicy: 'public',
      }),
      curatorDidMatchesChecksumAgent: () => false,
      callerIsAllowlistedAgentParticipant: async () => probe.run(false),
    };

    const rows = await (ContextGraphResolveMethods.prototype.listContextGraphsFromProjection as any)
      .call(fakeAgent, { callerAgentAddress: CALLER_ADDRESS });

    expect(rows).toHaveLength(IDS.length);
    expect(probe.peak()).toBeGreaterThan(1);
    expect(probe.peak()).toBeLessThanOrEqual(DKGAgentBase.LIST_CONTEXT_GRAPHS_ROW_CONCURRENCY);
  });

  it('bounds every legacy per-row enrichment wave', async () => {
    const probe = concurrencyProbe();
    const fakeAgent = {
      subscribedContextGraphs: new Map(),
      store: {
        query: async () => ({
          type: 'bindings',
          bindings: IDS.map((id) => ({
            ctxGraph: contextGraphDataUri(id),
            name: `"${id}"`,
          })),
        }),
        listGraphsByPrefix: async () => [],
      },
      getContextGraphOnChainId: async () => probe.run(undefined),
      getCgMeta: async (id: string) => probe.run(projectedMeta(id)),
      getContextGraphCurator: async () => probe.run(undefined),
      isPrivateContextGraph: async () => probe.run(false),
      curatorDidMatchesChecksumAgent: () => false,
      callerIsAllowlistedAgentParticipant: async () => probe.run(false),
    };

    const result = await (ContextGraphResolveMethods.prototype as any)
      .listContextGraphsUncached.call(fakeAgent, CALLER_ADDRESS, true);

    expect(result.rows).toHaveLength(IDS.length);
    expect(probe.peak()).toBeGreaterThan(1);
    expect(probe.peak()).toBeLessThanOrEqual(DKGAgentBase.LIST_CONTEXT_GRAPHS_ROW_CONCURRENCY);
  });
});
