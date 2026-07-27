import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';

import {
  createContextGraphSyncDeadline,
  createDurableSyncBudget,
  createGraphScopedAuthenticationDeadline,
  type DurableSyncBudget,
} from '../src/sync/requester/durable-sync-budget.js';
import {
  runDurableSync,
  type DurableSyncContext,
  type DurableSyncFetchContext,
  type DurableSyncGraphScopedStoreRequest,
  type DurableSyncStoreInsertRequest,
  type LegacyDurableSyncContext,
} from '../src/sync/requester/durable-sync.js';
import type {
  GraphScopedMaterializationOutcome,
} from '../src/sync/requester/graph-scoped-materialization.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';

const DKG = 'http://dkg.io/ontology/';
const contextGraphId = 'durable-sync-budget';
const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
const ctx = { kind: 'sync', id: 'durable-sync-budget-test', startedAt: 0 } as OperationContext;

function requesterFixture(index: number): {
  data: Quad;
  metadata: Quad[];
  assertionGraph: string;
} {
  const ual = `did:dkg:otp:2043/0x1111111111111111111111111111111111111111/${index}`;
  const assertionGraph = `did:dkg:context-graph:${contextGraphId}/_verifiable_memory/${index}`;
  const metadata = [
    ['contentScopeVersion', '"2"'],
    ['kaUal', ual],
    ['assertionVersion', `"${index}"`],
    ['assertionGraph', assertionGraph],
    ['contextGraph', `did:dkg:context-graph:${contextGraphId}`],
    ['merkleRoot', `"${String(index).padStart(64, '0')}"`],
    ['transactionHash', `"0x${index.toString(16).padStart(64, '0')}"`],
  ].map(([predicate, object]) => ({
    subject: ual,
    predicate: `${DKG}${predicate}`,
    object,
    graph: metaGraph,
  }));
  return {
    data: {
      subject: `http://example.com/budget/${index}`,
      predicate: 'http://example.com/value',
      object: `"${index}"`,
      graph: assertionGraph,
    },
    metadata,
    assertionGraph,
  };
}

function requesterPage(phase: 'data' | 'meta', quads: Quad[]): SyncPageResult {
  return {
    quads,
    bytesReceived: 0,
    resumedFromOffset: 0,
    nextOffset: quads.length,
    checkpointKey: `${contextGraphId}:${phase}`,
    completed: true,
    timedOut: false,
  };
}

function requesterBudgetContext(options: {
  assetCount?: number;
  durableSyncBudget: DurableSyncBudget;
  signal?: AbortSignal;
  graphScoped?: boolean;
  onFetchPhase?: (phase: 'data' | 'meta') => void;
  onFetchContext?: (fetchContext: DurableSyncFetchContext) => void;
  onVerify?: () => void;
  storeInsert?: (request: DurableSyncStoreInsertRequest) => Promise<void>;
  storeGraphScopedAsset: (
    request: DurableSyncGraphScopedStoreRequest,
  ) => Promise<GraphScopedMaterializationOutcome>;
}): DurableSyncContext {
  const fixtures = Array.from(
    { length: options.assetCount ?? 1 },
    (_, index) => requesterFixture(index + 1),
  );
  const dataQuads = fixtures.map((fixture) => fixture.data);
  const metadataQuads = fixtures.flatMap((fixture) => fixture.metadata);

  return {
    ctx,
    remotePeerId: 'peer-durable-sync-budget',
    contextGraphIds: [contextGraphId],
    durableSyncBudget: options.durableSyncBudget,
    signal: options.signal,
    fetchSyncPages: async ({
      phase,
      fetchContext,
    }) => {
      options.onFetchPhase?.(phase);
      options.onFetchContext?.(fetchContext);
      return phase === 'data'
        ? requesterPage(phase, dataQuads)
        : requesterPage(phase, metadataQuads);
    },
    processDurableBatchInWorker: async () => {
      options.onVerify?.();
      return {
        verifiedData: dataQuads,
        verifiedMeta: metadataQuads,
        verifiedGraphScopedDataGraphs: options.graphScoped === false
          ? []
          : fixtures.map((fixture) => fixture.assertionGraph),
        consumedUnpersistedMetaTriples: 0,
        totalFetchedDataQuads: dataQuads.length,
        totalFetchedMetaQuads: metadataQuads.length,
        rejectedKcs: 0,
        emptyResponses: 0,
        metaOnlyResponses: 0,
        verifiedPrivateOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
      };
    },
    storeInsert: options.storeInsert ?? (async () => {}),
    storeGraphScopedAsset: options.storeGraphScopedAsset,
    deleteCheckpoint: () => {},
    setCheckpoint: () => {},
    logInfo: () => {},
    logWarn: () => {},
    logDebug: () => {},
  };
}

function runRequesterBudgetHarness(
  options: Parameters<typeof requesterBudgetContext>[0],
) {
  return runDurableSync(requesterBudgetContext(options));
}

function requesterBudget(
  createFetchDeadline: () => number,
  createAuthenticationDeadline: () => number = createFetchDeadline,
): DurableSyncBudget {
  return {
    createContextGraphBudget: () => ({
      fetchDeadline: createFetchDeadline(),
      createGraphScopedAuthenticationDeadline: createAuthenticationDeadline,
    }),
  };
}

describe('durable sync deadline budget', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses a caller-supplied bounded total budget', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    expect(
      createContextGraphSyncDeadline({
        remainingContextGraphs: 1,
        totalTimeoutMs: 299_000,
      }),
    ).toBe(1_299_000);
  });

  it('clamps untrusted oversized budgets to five minutes', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    expect(
      createContextGraphSyncDeadline({
        remainingContextGraphs: 1,
        totalTimeoutMs: 900_000,
      }),
    ).toBe(1_300_000);
  });

  it('preserves the two-minute default for normal sync callers', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    expect(
      createContextGraphSyncDeadline({ remainingContextGraphs: 1 }),
    ).toBe(1_120_000);
  });

  it('uses a caller-supplied bounded graph-scoped authentication budget', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    expect(
      createGraphScopedAuthenticationDeadline({ totalTimeoutMs: 299_000 }),
    ).toBe(1_299_000);
  });

  it('clamps oversized graph-scoped authentication budgets to five minutes', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    expect(
      createGraphScopedAuthenticationDeadline({ totalTimeoutMs: 900_000 }),
    ).toBe(1_300_000);
  });

  it('preserves the two-minute graph-scoped authentication default', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    expect(
      createGraphScopedAuthenticationDeadline(),
    ).toBe(1_120_000);
  });

  it('clamps fresh phase budgets to the caller outer deadline', () => {
    const now = vi.fn(() => 1_800_000_000_000);
    const budget = createDurableSyncBudget({
      fetchTimeoutMs: 60_000,
      authenticationTimeoutMs: 60_000,
      operationDeadline: 1_800_000_030_000,
      now,
    }).createContextGraphBudget({
      contextGraphId,
      remainingContextGraphs: 1,
    });

    expect(budget.fetchDeadline).toBe(1_800_000_030_000);
    now.mockReturnValue(1_800_000_029_000);
    expect(budget.createGraphScopedAuthenticationDeadline())
      .toBe(1_800_000_030_000);
  });

  it('passes graph identity and remaining work into one explicit budget factory call', async () => {
    const createContextGraphBudget = vi.fn(() => ({
      fetchDeadline: Date.now() + 60_000,
      createGraphScopedAuthenticationDeadline: () => Date.now() + 60_000,
    }));
    const syncContext = requesterBudgetContext({
      durableSyncBudget: { createContextGraphBudget },
      graphScoped: false,
      storeGraphScopedAsset: async () => 'applied',
    });
    const secondContextGraphId = `${contextGraphId}-second`;
    syncContext.contextGraphIds = [contextGraphId, secondContextGraphId];

    await runDurableSync(syncContext);

    expect(createContextGraphBudget.mock.calls).toEqual([
      [{ contextGraphId, remainingContextGraphs: 2 }],
      [{ contextGraphId: secondContextGraphId, remainingContextGraphs: 1 }],
    ]);
  });

  it('starts graph-scoped authentication after both fetch phases complete', async () => {
    let phaseTime = 1_800_000_000_000;
    const completedFetchPhases: Array<'data' | 'meta'> = [];
    const graphScopedAuthenticationDeadline = vi.fn(() => phaseTime + 60_000);
    const storeGraphScopedAsset = vi.fn(async (
      _request: DurableSyncGraphScopedStoreRequest,
    ): Promise<GraphScopedMaterializationOutcome> => 'applied');

    await runRequesterBudgetHarness({
      durableSyncBudget: requesterBudget(
        () => phaseTime + 60_000,
        graphScopedAuthenticationDeadline,
      ),
      onFetchPhase: (phase) => {
        completedFetchPhases.push(phase);
        phaseTime += phase === 'meta' ? 10_000 : 20_000;
      },
      storeGraphScopedAsset,
    });

    expect(completedFetchPhases).toEqual(['meta', 'data']);
    expect(graphScopedAuthenticationDeadline).toHaveBeenCalledTimes(1);
    expect(storeGraphScopedAsset).toHaveBeenCalledTimes(1);
    expect(storeGraphScopedAsset.mock.calls[0]?.[0].authenticationDeadline).toBe(
      1_800_000_090_000,
    );
  });

  it('shares one provider authentication deadline across the verified page', async () => {
    const authenticationDeadline = 1_800_000_345_678;
    const graphScopedAuthenticationDeadline = vi.fn(() => authenticationDeadline);
    const storeGraphScopedAsset = vi.fn(async (
      _request: DurableSyncGraphScopedStoreRequest,
    ): Promise<GraphScopedMaterializationOutcome> => 'applied');

    await runRequesterBudgetHarness({
      assetCount: 2,
      durableSyncBudget: requesterBudget(
        () => Date.now() + 60_000,
        graphScopedAuthenticationDeadline,
      ),
      storeGraphScopedAsset,
    });

    expect(graphScopedAuthenticationDeadline).toHaveBeenCalledTimes(1);
    expect(
      storeGraphScopedAsset.mock.calls.map(([request]) => request.authenticationDeadline),
    ).toEqual([
      authenticationDeadline,
      authenticationDeadline,
    ]);
  });

  it('starts graph-scoped authentication after durable verification completes', async () => {
    let phaseTime = 1_800_000_000_000;
    let verificationComplete = false;
    const graphScopedAuthenticationDeadline = vi.fn(() => {
      expect(verificationComplete).toBe(true);
      return phaseTime + 60_000;
    });
    const storeGraphScopedAsset = vi.fn(async (
      _request: DurableSyncGraphScopedStoreRequest,
    ): Promise<GraphScopedMaterializationOutcome> => 'applied');

    await runRequesterBudgetHarness({
      durableSyncBudget: requesterBudget(
        () => phaseTime + 60_000,
        graphScopedAuthenticationDeadline,
      ),
      onVerify: () => {
        phaseTime += 45_000;
        verificationComplete = true;
      },
      storeGraphScopedAsset,
    });

    expect(graphScopedAuthenticationDeadline).toHaveBeenCalledTimes(1);
    expect(storeGraphScopedAsset.mock.calls[0]?.[0].authenticationDeadline).toBe(
      1_800_000_105_000,
    );
  });

  it('adapts the complete legacy positional callback ABI at runtime', async () => {
    const deadline = 1_800_000_123_456;
    const createContextGraphSyncDeadline = vi.fn(() => deadline);
    const fixture = requesterFixture(1);
    const legacyFetchCalls: Array<Parameters<LegacyDurableSyncContext['fetchSyncPages']>> = [];
    const fetchSyncPages: LegacyDurableSyncContext['fetchSyncPages'] = async (...args) => {
      legacyFetchCalls.push(args);
      const phase = args[4];
      return requesterPage(
        phase,
        phase === 'data' ? [fixture.data] : fixture.metadata,
      );
    };
    const legacyStoreInsertCalls: Quad[][] = [];
    const storeInsert: LegacyDurableSyncContext['storeInsert'] = async (quads) => {
      legacyStoreInsertCalls.push(quads);
    };
    const graphScopedStoreCalls: Array<{
      asset: Parameters<NonNullable<LegacyDurableSyncContext['storeGraphScopedAsset']>>[0];
      deadline: number;
    }> = [];
    const storeGraphScopedAsset: NonNullable<
      LegacyDurableSyncContext['storeGraphScopedAsset']
    > = async (asset, suppliedDeadline) => {
      graphScopedStoreCalls.push({ asset, deadline: suppliedDeadline });
      return 'applied';
    };
    const legacyBase = (graphScoped: boolean) => {
      const {
        durableSyncBudget: _budget,
        fetchSyncPages: _fetchSyncPages,
        storeInsert: _storeInsert,
        storeGraphScopedAsset: _storeGraphScopedAsset,
        ...sharedContext
      } = requesterBudgetContext({
        durableSyncBudget: requesterBudget(() => deadline),
        graphScoped,
        storeGraphScopedAsset: async () => 'applied',
      });
      return sharedContext;
    };

    await runDurableSync({
      ...legacyBase(false),
      createContextGraphSyncDeadline,
      fetchSyncPages,
      storeInsert,
      storeGraphScopedAsset,
    });
    await runDurableSync({
      ...legacyBase(true),
      createContextGraphSyncDeadline,
      fetchSyncPages,
      storeInsert,
      storeGraphScopedAsset,
    });

    expect(createContextGraphSyncDeadline).toHaveBeenCalledTimes(2);
    expect(createContextGraphSyncDeadline).toHaveBeenNthCalledWith(1, 1);
    expect(createContextGraphSyncDeadline).toHaveBeenNthCalledWith(2, 1);
    expect(legacyFetchCalls.map((args) => ({
      argumentCount: args.length,
      contextGraphId: args[2],
      includeSharedMemory: args[3],
      phase: args[4],
      deadline: args[6],
    }))).toEqual([
      {
        argumentCount: 10,
        contextGraphId,
        includeSharedMemory: false,
        phase: 'meta',
        deadline,
      },
      {
        argumentCount: 10,
        contextGraphId,
        includeSharedMemory: false,
        phase: 'data',
        deadline,
      },
      {
        argumentCount: 10,
        contextGraphId,
        includeSharedMemory: false,
        phase: 'meta',
        deadline,
      },
      {
        argumentCount: 10,
        contextGraphId,
        includeSharedMemory: false,
        phase: 'data',
        deadline,
      },
    ]);
    expect(legacyStoreInsertCalls).toHaveLength(2);
    expect(legacyStoreInsertCalls.every(Array.isArray)).toBe(true);
    expect(legacyStoreInsertCalls.flat()).toContainEqual(fixture.data);
    expect(
      legacyStoreInsertCalls.flat().every((quad) => (
        typeof quad.subject === 'string'
        && typeof quad.predicate === 'string'
        && typeof quad.graph === 'string'
      )),
    ).toBe(true);
    expect(graphScopedStoreCalls).toHaveLength(1);
    expect(graphScopedStoreCalls[0]?.asset.ual).toContain('/1');
    expect(graphScopedStoreCalls[0]?.deadline).toBe(deadline);
  });

  it('does not enter authentication or commit after whole-operation cancellation during verification', async () => {
    const controller = new AbortController();
    const graphScopedAuthenticationDeadline = vi.fn(() => Date.now() + 60_000);
    const storeGraphScopedAsset = vi.fn(async (
      _request: DurableSyncGraphScopedStoreRequest,
    ): Promise<GraphScopedMaterializationOutcome> => 'applied');

    const result = await runRequesterBudgetHarness({
      durableSyncBudget: requesterBudget(
        () => Date.now() + 60_000,
        graphScopedAuthenticationDeadline,
      ),
      signal: controller.signal,
      onVerify: () => controller.abort(new Error('whole operation expired')),
      storeGraphScopedAsset,
    });

    expect(result).toMatchObject({
      insertedTriples: 0,
      complete: false,
      failedPhases: 1,
    });
    expect(graphScopedAuthenticationDeadline).not.toHaveBeenCalled();
    expect(storeGraphScopedAsset).not.toHaveBeenCalled();
  });

  it('awaits an in-flight graph-scoped commit but aborts before the next asset and checkpoint', async () => {
    const controller = new AbortController();
    let releaseFirstCommit!: () => void;
    let firstCommitStarted!: () => void;
    const firstCommitGate = new Promise<void>((resolve) => { releaseFirstCommit = resolve; });
    const firstCommitObserved = new Promise<void>((resolve) => { firstCommitStarted = resolve; });
    const setCheckpoint = vi.fn();
    const storeGraphScopedAsset = vi.fn(async (
      _request: DurableSyncGraphScopedStoreRequest,
    ): Promise<GraphScopedMaterializationOutcome> => {
      firstCommitStarted();
      await firstCommitGate;
      return 'applied';
    });
    const syncContext = requesterBudgetContext({
      assetCount: 2,
      durableSyncBudget: requesterBudget(() => Date.now() + 60_000),
      signal: controller.signal,
      storeGraphScopedAsset,
    });
    syncContext.setCheckpoint = setCheckpoint;

    const sync = runDurableSync(syncContext);
    await firstCommitObserved;
    controller.abort(new Error('deadline expired during atomic materialization'));
    releaseFirstCommit();
    const result = await sync;

    expect(storeGraphScopedAsset).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      insertedTriples: 9,
      complete: false,
      failedPhases: 1,
    });
    expect(setCheckpoint).not.toHaveBeenCalled();
  });

  it('passes distinct fetch and graph-scoped authentication boundaries', async () => {
    const controller = new AbortController();
    const fetchContexts: DurableSyncFetchContext[] = [];
    const storeGraphScopedAsset = vi.fn(async ({
      signal,
    }: DurableSyncGraphScopedStoreRequest): Promise<GraphScopedMaterializationOutcome> => (
      signal?.aborted ? 'stale' : 'applied'
    ));

    await runRequesterBudgetHarness({
      durableSyncBudget: requesterBudget(
        () => Date.now() + 60_000,
        () => Date.now() + 90_000,
      ),
      signal: controller.signal,
      onFetchContext: (fetchContext) => fetchContexts.push(fetchContext),
      storeGraphScopedAsset,
    });

    expect(fetchContexts).toHaveLength(2);
    expect(
      fetchContexts.every((fetchContext) => fetchContext.signal === controller.signal),
    ).toBe(true);
    expect(storeGraphScopedAsset.mock.calls[0]?.[0].signal).toBe(
      controller.signal,
    );
    expect(storeGraphScopedAsset.mock.calls[0]?.[0].authenticationDeadline).toBeGreaterThan(
      Date.now(),
    );
  });

  it('does not enter plain storeInsert after cancellation during verification', async () => {
    const controller = new AbortController();
    const storeInsert = vi.fn(async (_request: DurableSyncStoreInsertRequest) => {});

    const result = await runRequesterBudgetHarness({
      durableSyncBudget: requesterBudget(() => Date.now() + 60_000),
      signal: controller.signal,
      graphScoped: false,
      onVerify: () => controller.abort(new Error('cancel before plain insert')),
      storeInsert,
      storeGraphScopedAsset: async () => 'applied',
    });

    expect(result).toMatchObject({
      insertedTriples: 0,
      complete: false,
      failedPhases: 1,
    });
    expect(storeInsert).not.toHaveBeenCalled();
  });
});
