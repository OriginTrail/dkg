import { contextGraphDataUri } from '@origintrail-official/dkg-core';
import { describe, expect, it, vi } from 'vitest';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';

const CALLER_ADDRESS = '0x1111111111111111111111111111111111111111';
const MISS_COUNT = 417;

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
    accessPolicy: 'public',
  };
}

function listingAgent(input: {
  ids: readonly string[];
  resolveFinalized: (ids: readonly string[]) => Promise<
    | { kind: 'finalized-index'; targets: ReadonlyMap<string, {
        expectedNameHash: string;
        expectedOnChainId: bigint;
      }> }
    | { kind: 'legacy-current' }
  >;
  registrationStatus?: (id: string) => Promise<'registered' | 'unregistered' | null>;
  resolveCurrent?: (id: string) => Promise<string | null>;
}) {
  const resolveCurrent = vi.fn(input.resolveCurrent ?? (async () => null));
  const resolveForListing = vi.fn(async (id: string) => resolveCurrent(id));
  const readRegistrationStatus = vi.fn(
    input.registrationStatus ?? (async () => null),
  );
  const resolveFinalized = vi.fn(input.resolveFinalized);
  const fakeAgent = {
    subscribedContextGraphs: new Map(),
    store: {
      query: async () => ({
        type: 'bindings' as const,
        bindings: input.ids.map((id) => ({
          ctxGraph: contextGraphDataUri(id),
          name: `"${id}"`,
          access: '"public"',
        })),
      }),
      listGraphsByPrefix: async () => [],
    },
    getCgMeta: async (id: string) => projectedMeta(id),
    resolveFinalizedContextGraphAuthorityTargetsV1: resolveFinalized,
    readLocalContextGraphRegistrationStatus: readRegistrationStatus,
    resolveContextGraphOnChainIdForListing: resolveForListing,
    getContextGraphCurator: async () => undefined,
    isPrivateContextGraph: async () => false,
    curatorDidMatchesChecksumAgent: () => false,
    callerIsAllowlistedAgentParticipant: async () => false,
  };
  return {
    fakeAgent,
    readRegistrationStatus,
    resolveCurrent,
    resolveFinalized,
    resolveForListing,
  };
}

async function list(fakeAgent: object) {
  return (ContextGraphResolveMethods.prototype as any)
    .listContextGraphsUncached.call(fakeAgent, CALLER_ADDRESS, true);
}

describe('context graph list authority enrichment', () => {
  it('uses finalized hits without current-state resolution', async () => {
    const id = 'listing-finalized-hit';
    const fixture = listingAgent({
      ids: [id],
      resolveFinalized: async () => ({
        kind: 'finalized-index',
        targets: new Map([[id, {
          expectedNameHash: `0x${'11'.repeat(32)}`,
          expectedOnChainId: 901n,
        }]]),
      }),
    });

    const result = await list(fixture.fakeAgent);

    expect(result.rows).toEqual([
      expect.objectContaining({ id, onChainId: '901' }),
    ]);
    expect(fixture.readRegistrationStatus).not.toHaveBeenCalled();
    expect(fixture.resolveForListing).not.toHaveBeenCalled();
    expect(fixture.resolveCurrent).not.toHaveBeenCalled();
  });

  it('does not fan 400+ ordinary finalized misses into current RPC resolution', async () => {
    const ids = Array.from({ length: MISS_COUNT }, (_, index) => `listing-miss-${index}`);
    const fixture = listingAgent({
      ids,
      resolveFinalized: async () => ({
        kind: 'finalized-index',
        targets: new Map(),
      }),
    });

    const result = await list(fixture.fakeAgent);

    expect(result.rows).toHaveLength(MISS_COUNT);
    expect(result.rows.every((row: { onChainId?: string }) => row.onChainId === undefined))
      .toBe(true);
    expect(fixture.readRegistrationStatus).toHaveBeenCalledTimes(MISS_COUNT);
    expect(fixture.resolveForListing).not.toHaveBeenCalled();
    expect(fixture.resolveCurrent).not.toHaveBeenCalled();
  });

  it('does not fan a failed finalized batch into current RPC resolution', async () => {
    const ids = Array.from(
      { length: MISS_COUNT },
      (_, index) => `listing-batch-failure-${index}`,
    );
    const fixture = listingAgent({
      ids,
      resolveFinalized: async () => {
        throw new Error('finalized batch unavailable');
      },
    });

    const result = await list(fixture.fakeAgent);

    expect(result.rows).toHaveLength(MISS_COUNT);
    expect(fixture.readRegistrationStatus).toHaveBeenCalledTimes(MISS_COUNT);
    expect(fixture.resolveForListing).not.toHaveBeenCalled();
    expect(fixture.resolveCurrent).not.toHaveBeenCalled();
  });

  it('repairs a just-mined local registration only after durable registered evidence', async () => {
    const registeredId = 'listing-just-mined-registered';
    const unregisteredId = 'listing-local-unregistered';
    const unknownId = 'listing-registration-unknown';
    const fixture = listingAgent({
      ids: [registeredId, unregisteredId, unknownId],
      resolveFinalized: async () => ({
        kind: 'finalized-index',
        targets: new Map(),
      }),
      registrationStatus: async (id) => (
        id === registeredId
          ? 'registered'
          : id === unregisteredId
            ? 'unregistered'
            : null
      ),
      resolveCurrent: async (id) => id === registeredId ? '904' : null,
    });

    const result = await list(fixture.fakeAgent);

    expect(result.rows.find((row: { id: string }) => row.id === registeredId))
      .toEqual(expect.objectContaining({ onChainId: '904' }));
    expect(fixture.resolveForListing).toHaveBeenCalledOnce();
    expect(fixture.resolveForListing).toHaveBeenCalledWith(
      registeredId,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        finalizedTarget: null,
      }),
    );
    expect(fixture.resolveCurrent).toHaveBeenCalledOnce();
    expect(fixture.resolveCurrent).toHaveBeenCalledWith(registeredId);
  });
});
