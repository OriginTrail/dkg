import { contextGraphDataUri } from '@origintrail-official/dkg-core';
import { describe, expect, it, vi } from 'vitest';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import { ContextGraphRegistryMethods } from '../src/dkg-agent-cg-registry.js';
import { ContextGraphBindingState } from '../src/context-graph-binding-state.js';
import { enrichContextGraphListAuthorityV1 } from
  '../src/context-graph-list-authority-enrichment.js';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';
import { Rfc64AuthorityReadCoordinatorV1 } from
  '../src/rfc64/authority-rpc-circuit-breaker-v1.js';

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
  registrationStatus?: (
    id: string,
  ) => Promise<'registered' | 'unregistered' | 'pending' | null>;
  resolveCurrent?: (
    id: string,
    options?: { signal?: AbortSignal; source?: string },
  ) => Promise<string | null>;
}) {
  const resolveCurrent = vi.fn(input.resolveCurrent ?? (async () => null));
  const readRegistrationStatus = vi.fn(
    input.registrationStatus ?? (async () => null),
  );
  const resolveFinalized = vi.fn(input.resolveFinalized);
  const fakeAgent = {
    // Listing enrichment runs under the shared authority governor. This
    // host is a plain object, so it carries the coordinator directly
    // rather than through the agent's owner-backed accessor.
    rfc64AuthorityReadCoordinatorV1: new Rfc64AuthorityReadCoordinatorV1(),
    subscribedContextGraphs: new Map(),
    wireIdToLocalCgId: new Map(),
    onChainContextGraphFacts: new Map(),
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
    getContextGraphOnChainId: resolveCurrent,
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
  };
}

async function list(fakeAgent: object) {
  return (ContextGraphResolveMethods.prototype as any)
    .listContextGraphsUncached.call(fakeAgent, CALLER_ADDRESS, true);
}

describe('context graph list authority enrichment', () => {
  it('exposes degraded indexed mode without fanning out into durable repair', async () => {
    const rows = ['registered-local', 'unregistered-local'].map((id) => ({
      id,
      uri: contextGraphDataUri(id),
      name: id,
      isSystem: false,
      subscribed: true,
      synced: true,
    }));
    const readCurrentOnChainId = vi.fn(async (id: string) => ({
      ok: true as const,
      value: id === 'registered-local' ? '71' : null,
    }));

    const result = await enrichContextGraphListAuthorityV1({
      rows,
      readFinalizedTargets: async () => ({
        ok: false,
        error: new Error('index unavailable'),
      }),
      readRegistrationStatus: async (id) => ({
        ok: true,
        value: id === 'registered-local' ? 'registered' : 'unregistered',
      }),
      readCurrentOnChainId,
    });

    expect(result.mode).toEqual({ kind: 'degraded-finalized-index' });
    expect(result.cacheable).toBe(false);
    expect(result.rows).toEqual(rows);
    expect(readCurrentOnChainId).not.toHaveBeenCalled();
  });

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
    expect(fixture.resolveCurrent).not.toHaveBeenCalled();
  });

  it('keeps resolved and omitted rows on the same finalized horizon', async () => {
    const resolvedId = 'listing-finalized-mixed-hit';
    const omittedId = 'listing-finalized-mixed-omission';
    const fixture = listingAgent({
      ids: [resolvedId, omittedId],
      resolveFinalized: async () => ({
        kind: 'finalized-index',
        targets: new Map([[resolvedId, {
          expectedNameHash: `0x${'22'.repeat(32)}`,
          expectedOnChainId: 903n,
        }]]),
      }),
      registrationStatus: async () => 'registered',
      resolveCurrent: async () => '999',
    });

    const result = await list(fixture.fakeAgent);

    expect(result.rows).toEqual([
      expect.objectContaining({ id: resolvedId, onChainId: '903' }),
      expect.not.objectContaining({ onChainId: expect.anything() }),
    ]);
    expect(fixture.readRegistrationStatus).not.toHaveBeenCalled();
    expect(fixture.resolveCurrent).not.toHaveBeenCalled();
  });

  it('preserves current resolution for remote registered rows on legacy adapters', async () => {
    const id = 'listing-legacy-remote-registered';
    const fixture = listingAgent({
      ids: [id],
      resolveFinalized: async () => ({ kind: 'legacy-current' }),
      registrationStatus: async () => null,
      resolveCurrent: async () => '902',
    });

    const result = await list(fixture.fakeAgent);

    expect(result.rows).toEqual([
      expect.objectContaining({ id, onChainId: '902' }),
    ]);
    expect(fixture.readRegistrationStatus).not.toHaveBeenCalled();
    expect(fixture.resolveCurrent).toHaveBeenCalledOnce();
    expect(fixture.resolveCurrent).toHaveBeenCalledWith(
      id,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        source: 'agent.contextGraph.list.onChainId',
      }),
    );
  });

  it('does not fan 400+ registered finalized omissions into current RPC resolution', async () => {
    const ids = Array.from({ length: MISS_COUNT }, (_, index) => `listing-miss-${index}`);
    const fixture = listingAgent({
      ids,
      resolveFinalized: async () => ({
        kind: 'finalized-index',
        targets: new Map(),
      }),
      registrationStatus: async () => 'registered',
      resolveCurrent: async (id) => `9${ids.indexOf(id) + 1}`,
    });

    const result = await list(fixture.fakeAgent);

    expect(result.rows).toHaveLength(MISS_COUNT);
    expect(result.rows.every((row: { onChainId?: string }) => row.onChainId === undefined))
      .toBe(true);
    expect(fixture.readRegistrationStatus).not.toHaveBeenCalled();
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
    expect(fixture.readRegistrationStatus).not.toHaveBeenCalled();
    expect(fixture.resolveCurrent).not.toHaveBeenCalled();
  });

  it('delegates 4,097 finalized listing targets once and ignores superset results', async () => {
    const ids = Array.from({ length: 4_097 }, (_, index) => `listing-boundary-${index}`);
    const hashById = new Map(ids.map((id, index) => [
      id,
      `0x${(index + 1).toString(16).padStart(64, '0')}`,
    ]));
    const onChainIdByHash = new Map(ids.map((id, index) => [
      hashById.get(id)!,
      BigInt(index + 1_000),
    ]));
    const resolveMany = vi.fn(async (
      nameHashes: readonly string[],
      _options?: {
        signal?: AbortSignal;
        onContextGraphAuthorityProjectionServed?: (evidence: unknown) => void;
      },
    ) => {
      const resolved = new Map(nameHashes.map((nameHash) => [
        nameHash,
        onChainIdByHash.get(nameHash)!,
      ]));
      resolved.set(`0x${'ff'.repeat(32)}`, 999_999n);
      return resolved;
    });
    const readRegistrationStatus = vi.fn(async () => null);
    const resolveCurrent = vi.fn(async () => null);
    const fakeAgent = {
      // Listing enrichment runs under the shared authority governor.
      rfc64AuthorityReadCoordinatorV1: new Rfc64AuthorityReadCoordinatorV1(),
      subscribedContextGraphs: new Map(),
      wireIdToLocalCgId: new Map(),
      onChainContextGraphFacts: new Map(),
      contextGraphBindingState: new ContextGraphBindingState(),
      chain: {
        contextGraphAuthorityIndexRevisionReader: {
          resolveFinalizedContextGraphIdsByNameHashes: resolveMany,
        },
      },
      resolveContextGraphNameHashBindingTarget: () => undefined,
      contextGraphNameCommitment: (id: string) => hashById.get(id)!,
      store: {
        query: async () => ({
          type: 'bindings' as const,
          bindings: ids.map((id) => ({
            ctxGraph: contextGraphDataUri(id),
            name: `"${id}"`,
            access: '"public"',
          })),
        }),
        listGraphsByPrefix: async () => [],
      },
      getCgMeta: async (id: string) => projectedMeta(id),
      resolveFinalizedContextGraphAuthorityTargetsV1:
        ContextGraphRegistryMethods.prototype.resolveFinalizedContextGraphAuthorityTargetsV1,
      readLocalContextGraphRegistrationStatus: readRegistrationStatus,
      getContextGraphOnChainId: resolveCurrent,
      getContextGraphCurator: async () => undefined,
      isPrivateContextGraph: async () => false,
      curatorDidMatchesChecksumAgent: () => false,
      callerIsAllowlistedAgentParticipant: async () => false,
    };

    const result = await list(fakeAgent);

    expect(resolveMany).toHaveBeenCalledOnce();
    expect(resolveMany.mock.calls[0]?.[0]).toHaveLength(4_097);
    expect(resolveMany.mock.calls[0]?.[1]).toEqual({
      signal: expect.any(AbortSignal),
      onContextGraphAuthorityProjectionServed: expect.any(Function),
    });
    expect(result.rows).toHaveLength(ids.length);
    expect(result.rows.every((row: { id: string; onChainId?: string }, index: number) => (
      row.id === ids[index] && row.onChainId === String(index + 1_000)
    ))).toBe(true);
    expect(result.rows[0]?.onChainId).toBe('1000');
    expect(readRegistrationStatus).not.toHaveBeenCalled();
    expect(resolveCurrent).not.toHaveBeenCalled();
  });

  it('rejects when cancellation lands inside the logical reader', async () => {
    const id = 'listing-cancelled-final-chunk';
    const nameHash = `0x${'ab'.repeat(32)}`;
    const controller = new AbortController();
    const abortReason = new Error('listing authority projection cancelled');
    const resolveMany = vi.fn(async () => {
      controller.abort(abortReason);
      return new Map([[nameHash, 9_001n]]);
    });
    const fakeAgent = {
      // Listing enrichment runs under the shared authority governor.
      rfc64AuthorityReadCoordinatorV1: new Rfc64AuthorityReadCoordinatorV1(),
      subscribedContextGraphs: new Map(),
      wireIdToLocalCgId: new Map(),
      onChainContextGraphFacts: new Map(),
      contextGraphBindingState: new ContextGraphBindingState(),
      chain: {
        contextGraphAuthorityIndexRevisionReader: {
          resolveFinalizedContextGraphIdsByNameHashes: resolveMany,
        },
      },
      resolveContextGraphNameHashBindingTarget: () => undefined,
      contextGraphNameCommitment: () => nameHash,
    };

    await expect(
      ContextGraphRegistryMethods.prototype.resolveFinalizedContextGraphAuthorityTargetsV1
        .call(fakeAgent as any, [id], { signal: controller.signal }),
    ).rejects.toBe(abortReason);
    expect(resolveMany).toHaveBeenCalledOnce();
  });

  it('does not mix a just-mined local registration into a finalized listing horizon', async () => {
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
      .toEqual(expect.not.objectContaining({ onChainId: expect.anything() }));
    expect(fixture.readRegistrationStatus).not.toHaveBeenCalled();
    expect(fixture.resolveCurrent).not.toHaveBeenCalled();
  });

  it('cancels a legacy-current lookup when its listing budget expires', async () => {
    const originalRowBudget = DKGAgentBase.LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS;
    Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS', {
      value: 1,
      configurable: true,
    });
    try {
      const id = 'listing-current-repair-timeout';
      let repairSignal: AbortSignal | undefined;
      const fixture = listingAgent({
        ids: [id],
        resolveFinalized: async () => ({ kind: 'legacy-current' }),
        registrationStatus: async () => 'registered',
        resolveCurrent: async (_id, options) => {
          repairSignal = options?.signal;
          return new Promise<string | null>((_resolve, reject) => {
            repairSignal?.addEventListener('abort', () => reject(repairSignal?.reason), {
              once: true,
            });
          });
        },
      });

      const result = await list(fixture.fakeAgent);

      expect(result.rows).toEqual([expect.objectContaining({ id })]);
      expect(result.rows[0]?.onChainId).toBeUndefined();
      expect(repairSignal?.aborted).toBe(true);
      expect(fixture.resolveCurrent).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(DKGAgentBase, 'LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS', {
        value: originalRowBudget,
        configurable: true,
      });
    }
  });
});
