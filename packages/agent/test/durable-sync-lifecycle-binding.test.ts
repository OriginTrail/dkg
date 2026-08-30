import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { OperationContext } from '@origintrail-official/dkg-core';

vi.mock('../src/sync/requester/durable-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sync/requester/durable-sync.js')>();
  return {
    ...actual,
    runDurableSync: vi.fn(async () => ({})),
    runDurableSyncDetailed: vi.fn(async () => ({ result: {} })),
  };
});

vi.mock('../src/sync/requester/graph-scoped-materialization.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../src/sync/requester/graph-scoped-materialization.js')
  >();
  return {
    ...actual,
    materializeVerifiedGraphScopedAsset: vi.fn(async () => 'applied' as const),
  };
});

vi.mock('../src/sync/requester/shared-memory-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sync/requester/shared-memory-sync.js')>();
  return {
    ...actual,
    runSharedMemorySync: vi.fn(async () => ({
      insertedTriples: 0,
      fetchedMetaTriples: 0,
      fetchedDataTriples: 0,
      insertedMetaTriples: 0,
      insertedDataTriples: 0,
      bytesReceived: 0,
      resumedPhases: 0,
      timedOutPhases: 0,
      completedPhases: 0,
      checkpointAdvances: 0,
      deniedPhases: 0,
      emptyResponses: 0,
      droppedDataTriples: 0,
      failedPeers: 0,
      failedPhases: 0,
      backoffWorthyFailures: 0,
      deferredBackpressure: 0,
      snapshotPlaneIncomplete: 0,
      metadataContinuationYields: 0,
      replayPhaseBytesReceived: 0,
      snapshotPhaseBytesReceived: 0,
    })),
  };
});

vi.mock('../src/sync/requester/finalized-swm-twin-reconciliation.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../src/sync/requester/finalized-swm-twin-reconciliation.js')
  >();
  return {
    ...actual,
    reconcileFinalizedSwmTwin: vi.fn(async () => 'head-missing-or-ambiguous' as const),
    reconcileFinalizedSwmTwinFromDescriptor: vi.fn(
      async () => 'head-missing-or-ambiguous' as const,
    ),
  };
});

import {
  contextGraphDataUri,
  PROTOCOL_SYNC_CHANGELOG,
  SYSTEM_CONTEXT_GRAPHS,
} from '@origintrail-official/dkg-core';
import {
  createDurableSyncAccumulator,
  createIncompleteDurableSyncResult,
} from '../src/sync/durable-progress.js';
import { DKGAgent } from '../src/dkg-agent.js';
import {
  durableSyncRequestPageSize,
  LifecycleSyncMethods,
} from '../src/dkg-agent-lifecycle.js';
import { ContextGraphBindingState } from '../src/context-graph-binding-state.js';
import {
  runDurableSync,
  runDurableSyncDetailed,
  type DurableSyncContext,
  type DurableSyncGraphScopedStoreRequest,
} from '../src/sync/requester/durable-sync.js';
import {
  materializeVerifiedGraphScopedAsset,
  type VerifiedGraphScopedAsset,
} from '../src/sync/requester/graph-scoped-materialization.js';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';
import {
  reconcileFinalizedSwmTwin,
  reconcileFinalizedSwmTwinFromDescriptor,
  type FinalizedSwmTwinRetirement,
} from '../src/sync/requester/finalized-swm-twin-reconciliation.js';

const DKG = 'http://dkg.io/ontology/';
const contextGraphId = 'agent-blackbox-vm';
const ual = 'did:dkg:otp:2043/0x1111111111111111111111111111111111111111/1';
const assertionGraph = `did:dkg:context-graph:${contextGraphId}/_verifiable_memory/asset/1`;
const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
const ctx = { kind: 'sync', id: 'lifecycle-binding-test', startedAt: 0 } as OperationContext;

const mockedRunDurableSync = vi.mocked(runDurableSync);
const mockedRunDurableSyncDetailed = vi.mocked(runDurableSyncDetailed);
const mockedMaterialize = vi.mocked(materializeVerifiedGraphScopedAsset);
const mockedRunSharedMemorySync = vi.mocked(runSharedMemorySync);
const mockedReconcileFinalizedSwmTwin = vi.mocked(reconcileFinalizedSwmTwin);
const mockedReconcileFinalizedSwmTwinFromDescriptor = vi.mocked(
  reconcileFinalizedSwmTwinFromDescriptor,
);

function graphScopedAsset(
  root: Uint8Array,
  assertionVersion: bigint = 2n,
): VerifiedGraphScopedAsset {
  const rootHex = Array.from(root, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return {
    contextGraphId,
    ual,
    assertionVersion,
    assertionGraph,
    metaGraph,
    dataQuads: [],
    metadataQuads: [
      {
        subject: ual,
        predicate: `${DKG}merkleRoot`,
        object: `"${rootHex}"`,
        graph: metaGraph,
      },
      {
        subject: ual,
        predicate: `${DKG}transactionHash`,
        object: `"0x${assertionVersion.toString(16).padStart(64, '0')}"`,
        graph: metaGraph,
      },
    ],
  };
}

function graphScopedStoreRequest(
  asset: VerifiedGraphScopedAsset,
  deadline: number,
  signal?: AbortSignal,
): DurableSyncGraphScopedStoreRequest {
  return {
    asset,
    authenticationDeadline: deadline,
    signal,
  };
}

async function captureGraphScopedStore(
  chain: ChainAdapter,
  warn: ReturnType<typeof vi.fn> = vi.fn(),
  options: {
    totalTimeoutMs?: number;
    signal?: AbortSignal;
    onAtomicCommitStarted?: (contextGraphId: string, ual: string) => void;
    onAgentLike?: (agentLike: any) => void;
  } = {},
) {
  const agentLike: any = {
    config: {},
    chain,
    store: {},
    subscribedContextGraphs: new Map(),
    contextGraphBindingState: new ContextGraphBindingState(),
    wireIdToLocalCgId: new Map(),
    graphScopedStoreClosed: false,
    graphScopedStorePhysicalRuns: new Set<Promise<unknown>>(),
    bindSubscriptionOnChainId: vi.fn(),
    persistContextGraphSubscriptionStrict: vi.fn(),
    processDurableBatchInWorker: async () => ({}),
    insertSyncedQuadsAndInvalidateListCache: async () => {},
    syncCheckpoints: new Map(),
    oversizeTombstoneLog: { record: () => {} },
    invalidateListContextGraphsCache: vi.fn(),
    contextGraphMetaProjection: { markDirtyFromQuads: vi.fn() },
    log: { info: () => {}, warn, debug: () => {} },
    publisher: { clearPublishedKnowledgeAssetSwm: async () => {} },
    writeLocks: new Map(),
  };
  agentLike.localCgMatchesOnChainSlot = (DKGAgent.prototype as any).localCgMatchesOnChainSlot;
  agentLike.requireLocalCgMatchesOnChainSlot = (
    DKGAgent.prototype as any
  ).requireLocalCgMatchesOnChainSlot;
  agentLike.isWireIdKeyedSubscription = (DKGAgent.prototype as any).isWireIdKeyedSubscription;
  agentLike.raceChainPolicyRead = (DKGAgent.prototype as any).raceChainPolicyRead;
  agentLike.retireFinalizedSwmTwinCandidate = (
    LifecycleSyncMethods.prototype as any
  ).retireFinalizedSwmTwinCandidate;
  options.onAgentLike?.(agentLike);

  await LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraph.call(
    agentLike,
    ctx,
    'peer-remote',
    contextGraphId,
    1,
    {
      ...(options.totalTimeoutMs === undefined ? {} : {
        fetchTimeoutMs: options.totalTimeoutMs,
        authenticationTimeoutMs: options.totalTimeoutMs,
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onAtomicCommitStarted === undefined
        ? {}
        : { onAtomicCommitStarted: options.onAtomicCommitStarted }),
    },
  );
  return mockedRunDurableSync.mock.calls[0]![0].storeGraphScopedAsset!;
}

describe('durable sync lifecycle chain binding', () => {
  it('keeps metadata byte-budgeted when durable data is tuned to 128 rows', () => {
    expect(durableSyncRequestPageSize('data', 128)).toBe(128);
    expect(durableSyncRequestPageSize('meta', 128)).toBe(8_192);
  });

  beforeEach(() => {
    mockedRunDurableSync.mockClear();
    mockedRunDurableSyncDetailed.mockClear();
    mockedMaterialize.mockClear();
    mockedRunSharedMemorySync.mockClear();
    mockedReconcileFinalizedSwmTwin.mockReset();
    mockedReconcileFinalizedSwmTwin.mockResolvedValue('not-found');
    mockedReconcileFinalizedSwmTwinFromDescriptor.mockReset();
    mockedReconcileFinalizedSwmTwinFromDescriptor.mockResolvedValue('not-found');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts a fresh bounded authentication phase after network fetch', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    await captureGraphScopedStore({ chainId: 'none' } as ChainAdapter);

    const syncContext = mockedRunDurableSync.mock.calls[0]![0];
    const contextGraphBudget = syncContext.durableSyncBudget.createContextGraphBudget({
      contextGraphId,
      remainingContextGraphs: 1,
    });
    expect(contextGraphBudget.fetchDeadline).toBe(1_800_000_120_000);
    vi.mocked(Date.now).mockReturnValue(1_800_000_300_000);
    expect(contextGraphBudget.createGraphScopedAuthenticationDeadline())
      .toBe(1_800_000_420_000);
  });

  it('threads a caller-supplied authentication budget through the lifecycle', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    await captureGraphScopedStore(
      { chainId: 'none' } as ChainAdapter,
      vi.fn(),
      { totalTimeoutMs: 299_000 },
    );

    const syncContext = mockedRunDurableSync.mock.calls[0]![0];
    const contextGraphBudget = syncContext.durableSyncBudget.createContextGraphBudget({
      contextGraphId,
      remainingContextGraphs: 1,
    });
    expect(contextGraphBudget.createGraphScopedAuthenticationDeadline())
      .toBe(1_800_000_299_000);
  });

  it('stops fetching before the outer totalTimeoutMs boundary without a caller signal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const agentLike: any = {
      config: {},
      processDurableBatchInWorker: async () => ({}),
      runContextGraphSyncWithBackpressure: async (
        _ctx: unknown,
        _contextGraphId: string,
        _lane: string,
        _operationId: string,
        work: () => Promise<unknown>,
      ) => work(),
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };
    let capturedContext: DurableSyncContext | undefined;
    mockedRunDurableSync.mockImplementationOnce(async (syncContext) => {
      capturedContext = syncContext;
      await new Promise<void>((resolve) => {
        if (syncContext.signal?.aborted) resolve();
        else syncContext.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return {} as Awaited<ReturnType<typeof runDurableSync>>;
    });

    try {
      const sync = LifecycleSyncMethods.prototype.runLegacyDurableSync.call(
        agentLike,
        ctx,
        'peer-total-timeout',
        [contextGraphId],
        undefined,
        undefined,
        undefined,
        { totalTimeoutMs: 299_000 },
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(capturedContext?.signal).toBeDefined();
      expect(capturedContext?.signal?.aborted).toBe(false);
      const contextGraphBudget = capturedContext!.durableSyncBudget.createContextGraphBudget({
        contextGraphId,
        remainingContextGraphs: 1,
      });
      expect(contextGraphBudget.fetchDeadline).toBe(1_800_000_239_000);

      await vi.advanceTimersByTimeAsync(239_000);
      expect(capturedContext?.signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(60_000);
      await sync;

      expect(capturedContext?.signal?.aborted).toBe(true);
      expect(contextGraphBudget.createGraphScopedAuthenticationDeadline())
        .toBe(1_800_000_299_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not admit a later Context Graph after the operation is aborted', async () => {
    const controller = new AbortController();
    const admittedContextGraphs: string[] = [];
    const agentLike: any = {
      config: {},
      processDurableBatchInWorker: async () => ({}),
      runContextGraphSyncWithBackpressure: async (
        _ctx: unknown,
        admittedContextGraphId: string,
        _lane: string,
        _operationId: string,
        work: () => Promise<unknown>,
      ) => {
        admittedContextGraphs.push(admittedContextGraphId);
        return work();
      },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };
    mockedRunDurableSync.mockImplementationOnce(async () => {
      controller.abort(new Error('whole operation cancelled'));
      return {
        complete: true,
        completedPhases: 2,
      } as Awaited<ReturnType<typeof runDurableSync>>;
    });

    const result = await LifecycleSyncMethods.prototype.runLegacyDurableSync.call(
      agentLike,
      ctx,
      'peer-operation-abort',
      ['cg-a', 'cg-b'],
      undefined,
      undefined,
      undefined,
      { signal: controller.signal },
    );

    expect(controller.signal.aborted).toBe(true);
    expect(admittedContextGraphs).toEqual(['cg-a']);
    expect(mockedRunDurableSync).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      complete: false,
      completedPhases: 2,
    });
  });

  it('forwards the operation signal through the lifecycle store bridge', async () => {
    const controller = new AbortController();
    const insertSyncedQuadsAndInvalidateListCache = vi.fn(async () => {});
    const agentLike: any = {
      config: {},
      chain: { chainId: 'none' },
      store: {},
      subscribedContextGraphs: new Map(),
      contextGraphBindingState: new ContextGraphBindingState(),
      wireIdToLocalCgId: new Map(),
      bindSubscriptionOnChainId: vi.fn(),
      persistContextGraphSubscriptionStrict: vi.fn(),
      processDurableBatchInWorker: async () => ({}),
      insertSyncedQuadsAndInvalidateListCache,
      syncCheckpoints: new Map(),
      oversizeTombstoneLog: { record: () => {} },
      invalidateListContextGraphsCache: vi.fn(),
      contextGraphMetaProjection: { markDirtyFromQuads: vi.fn() },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };

    await LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraph.call(
      agentLike,
      ctx,
      'peer-store-signal',
      contextGraphId,
      1,
      { signal: controller.signal },
    );
    const storeInsert = mockedRunDurableSync.mock.calls[0]![0].storeInsert;
    expect(storeInsert).toBeTypeOf('function');

    await storeInsert!({ quads: [], signal: controller.signal });

    expect(insertSyncedQuadsAndInvalidateListCache).toHaveBeenCalledWith([], {
      priority: 'background',
      source: 'agent.durableSync.storeInsert',
      signal: controller.signal,
    });
  });

  it('selects the dedicated field-sized exact-recovery transfer policy', async () => {
    const physicalResult = {} as Awaited<ReturnType<typeof runDurableSync>>;
    const runLegacyDurableSyncDetailed = vi.fn(async () => ({
      result: physicalResult,
      exactFetchDisposition: 'clean-absent' as const,
    }));
    const agentLike = { runLegacyDurableSyncDetailed };
    const exactUal = 'did:dkg:base:84532/0x1111111111111111111111111111111111111111/1';
    const controller = new AbortController();

    const detailed = await LifecycleSyncMethods.prototype.syncExactKnowledgeAssetsFromPeerDetailed.call(
      agentLike as any,
      '12D3KooWExactRecoveryPeer',
      '0x1111111111111111111111111111111111111111/blackbox',
      { kind: 'ual-only', assetUals: [exactUal] },
      { signal: controller.signal },
    );

    expect(runLegacyDurableSyncDetailed).toHaveBeenCalledTimes(1);
    expect(runLegacyDurableSyncDetailed.mock.calls[0]?.[6]).toMatchObject({
      exactAssetSelection: { kind: 'ual-only', assetUals: [exactUal] },
      stopOnBackoffWorthyFailure: true,
      priority: 1_000,
      // The admission SOURCE is what makes this show up as `durable:vm-recovery`
      // rather than `durable:unspecified` on the sync-global scheduler, which is
      // the whole point of the label. Without this line, deleting it from the
      // call site keeps every test green and only the Grafana attribution rots.
      source: 'vm-recovery',
      signal: controller.signal,
    });
    expect(runLegacyDurableSyncDetailed.mock.calls[0]?.[6]).not.toHaveProperty('totalTimeoutMs');
    expect(detailed).toEqual({ result: physicalResult, disposition: 'clean-absent' });
  });

  it('projects the public exact-sync result from the detailed implementation', async () => {
    const result = {} as Awaited<ReturnType<typeof runDurableSync>>;
    const syncExactKnowledgeAssetsFromPeerDetailed = vi.fn(async () => ({
      result,
      disposition: 'found' as const,
    }));
    const requestedAssetUals = [ual];

    const projected = await LifecycleSyncMethods.prototype.syncExactKnowledgeAssetsFromPeer.call(
      { syncExactKnowledgeAssetsFromPeerDetailed } as any,
      '12D3KooWExactProjectionPeer',
      contextGraphId,
      requestedAssetUals,
    );

    expect(syncExactKnowledgeAssetsFromPeerDetailed).toHaveBeenCalledWith(
      '12D3KooWExactProjectionPeer',
      contextGraphId,
      { kind: 'ual-only', assetUals: requestedAssetUals },
      {},
    );
    expect(projected).toBe(result);

    const challengePinnedSelection = {
      kind: 'challenge-pinned' as const,
      commitments: [{
        assetUal: ual,
        merkleRootHex: '11'.repeat(32),
        merkleLeafCount: 1n,
      }],
    };
    await LifecycleSyncMethods.prototype.syncExactKnowledgeAssetsFromPeer.call(
      { syncExactKnowledgeAssetsFromPeerDetailed } as any,
      '12D3KooWExactProjectionPeer',
      contextGraphId,
      challengePinnedSelection,
    );
    expect(syncExactKnowledgeAssetsFromPeerDetailed).toHaveBeenLastCalledWith(
      '12D3KooWExactProjectionPeer',
      contextGraphId,
      expect.objectContaining({ kind: 'challenge-pinned' }),
      {},
    );
  });

  it.each([
    ['a positional priority override', [2000]],
    ['a positional AbortSignal', ['SIGNAL']],
    // The shape the 6th-argument check alone cannot see: the 6th is absent-looking
    // and defaults to `{}`, so only the PRESENCE of a 7th reveals that the caller
    // still believes it is passing a cancellation signal. Before the rest-parameter
    // guard this returned normally and dropped the signal.
    ['a cancellation-only legacy call', [undefined, 'SIGNAL']],
    ['both legacy positionals', [2000, 'SIGNAL']],
  ])('rejects the pre-#2006 positional admission shape: %s', async (_label, tail) => {
    // The old signature was (ctx, cg, lane, label, work, priorityOverride?, signal?).
    // A JS caller compiled against it would destructure to undefined and silently
    // lose its priority AND its cancellation — an operation that ignores its abort
    // signal keeps running after the caller gave up. That must fail loudly.
    const legacyArgs = (tail as unknown[]).map(
      (a) => (a === 'SIGNAL' ? new AbortController().signal : a),
    );
    const agentLike = {
      config: {},
      log: { info: () => {}, warn: () => {}, debug: () => {} },
      node: { stopSignal: undefined },
      syncScheduler: { acquire: async () => ({ release: () => {} }) },
    };

    await expect(
      (LifecycleSyncMethods.prototype.runContextGraphSyncWithBackpressure as any).call(
        agentLike,
        {},
        'cg-legacy',
        'durable',
        'label',
        async () => 'done',
        ...legacyArgs,
      ),
    ).rejects.toThrow(/takes a single .admission. object/);
  });

  it('labels changelog-lane admissions at the call site', async () => {
    // The changelog delta lane (OT-RFC-59) is a SEPARATE production admission path
    // from the durable and shared-memory ones already covered. A public Context
    // Graph on a changelog-capable peer never reaches `runLegacyDurableSync`, so a
    // dropped source here would surface only as `changelog:unspecified` on
    // /api/diagnostics/backpressure while every existing source test stayed green.
    const admissions: unknown[][] = [];
    const agentLike = {
      config: {},
      log: { info: () => {}, warn: () => {}, debug: () => {} },
      getPeerProtocols: async () => [PROTOCOL_SYNC_CHANGELOG],
      isPrivateContextGraph: async () => false,
      // Record the admission and return a real accumulator: the lane folds the
      // result, so an empty object would fail inside the merge before the
      // assertion below could run.
      runContextGraphSyncWithBackpressure: async (...args: unknown[]) => {
        admissions.push(args);
        return createDurableSyncAccumulator();
      },
    };

    await LifecycleSyncMethods.prototype.runChangelogLane.call(
      agentLike as never,
      ctx,
      '12D3KooWChangelogPeer',
      ['public-cg'],
      undefined,
      2_000,
      'catchup-foreground',
    );

    expect(admissions).toHaveLength(1);
    const [, contextGraphId, lane, , , admission] = admissions[0] as unknown[];
    expect(contextGraphId).toBe('public-cg');
    expect(lane).toBe('changelog');
    expect(admission).toMatchObject({
      priorityOverride: 2_000,
      source: 'catchup-foreground',
    });
  });

  it('atomically replaces the completed AGENTS snapshot and removes obsolete rows', async () => {
    const graph = contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const obsolete = {
      subject: 'did:dkg:agent:old',
      predicate: `${DKG}peerId`,
      object: '"peer-old"',
      graph,
    };
    const fresh = {
      subject: 'did:dkg:agent:new',
      predicate: `${DKG}peerId`,
      object: '"peer-new"',
      graph,
    };
    let live = [obsolete];
    const replaceGraph = vi.fn(async (_graph: string, quads: typeof live) => {
      live = [...quads];
    });
    const insertSyncedQuadsAndInvalidateListCache = vi.fn(async () => {});
    const agentLike: any = {
      config: {},
      store: { replaceGraph },
      processDurableBatchInWorker: async () => ({}),
      insertSyncedQuadsAndInvalidateListCache,
      oversizeTombstoneLog: { record: vi.fn() },
      invalidateListContextGraphsCache: vi.fn(),
      contextGraphMetaProjection: { markDirtyFromQuads: vi.fn() },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };
    mockedRunDurableSync.mockImplementationOnce(async (syncContext) => {
      await syncContext.storeInsert({ quads: [fresh] });
      await syncContext.onVerifiedFullSnapshot?.({
        contextGraphId: SYSTEM_CONTEXT_GRAPHS.AGENTS,
        verifiedDataGraphs: new Set([graph]),
        verifiedMetaGraphs: new Set(),
        metaFetched: false,
      });
      return {
        ...createIncompleteDurableSyncResult(),
        insertedTriples: 1,
        insertedDataTriples: 1,
        completedPhases: 2,
        complete: true,
      };
    });

    const result = await LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraph.call(
      agentLike,
      ctx,
      'peer-agents',
      SYSTEM_CONTEXT_GRAPHS.AGENTS,
      1,
    );

    expect(result.complete).toBe(true);
    expect(replaceGraph).toHaveBeenCalledWith(
      graph,
      [fresh],
      expect.objectContaining({ source: 'agent.durableSync.authoritativeAgentsReplace' }),
    );
    expect(insertSyncedQuadsAndInvalidateListCache).not.toHaveBeenCalled();
    expect(live).toEqual([fresh]);
    expect(live).not.toContainEqual(obsolete);
  });

  it('keeps the previous AGENTS snapshot intact when row-paged sync is interrupted', async () => {
    const graph = contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const obsolete = {
      subject: 'did:dkg:agent:old',
      predicate: `${DKG}peerId`,
      object: '"peer-old"',
      graph,
    };
    const fresh = {
      subject: 'did:dkg:agent:new',
      predicate: `${DKG}peerId`,
      object: '"peer-new"',
      graph,
    };
    let live = [obsolete];
    const replaceGraph = vi.fn(async (_graph: string, quads: typeof live) => {
      live = [...quads];
    });
    const agentLike: any = {
      config: {},
      store: { replaceGraph },
      processDurableBatchInWorker: async () => ({}),
      insertSyncedQuadsAndInvalidateListCache: vi.fn(async () => {}),
      oversizeTombstoneLog: { record: vi.fn() },
      invalidateListContextGraphsCache: vi.fn(),
      contextGraphMetaProjection: { markDirtyFromQuads: vi.fn() },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };
    mockedRunDurableSync.mockImplementationOnce(async (syncContext) => {
      await syncContext.storeInsert({ quads: [fresh] });
      return {
        ...createIncompleteDurableSyncResult(),
        insertedTriples: 1,
        insertedDataTriples: 1,
      };
    });

    const result = await LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraph.call(
      agentLike,
      ctx,
      'peer-agents',
      SYSTEM_CONTEXT_GRAPHS.AGENTS,
      1,
    );

    expect(result.complete).toBe(false);
    expect(result.insertedTriples).toBe(0);
    expect(replaceGraph).not.toHaveBeenCalled();
    expect(live).toEqual([obsolete]);
  });

  it('labels standalone SWM recovery admissions at the call site', async () => {
    // The sibling of the VM-recovery assertion above, and the one that had NO
    // coverage: a regression dropping this source would report SWM recovery
    // pressure as `shared-memory:unspecified` on the sync-global scheduler.
    // Asserted on the real prototype so it pins the production call site, not a
    // re-statement of it.
    const runContextGraphSyncWithBackpressure = vi.fn(async () => ({}));
    const agentLike = {
      config: {},
      log: { info: () => {}, warn: () => {}, debug: () => {} },
      runContextGraphSyncWithBackpressure,
    };

    await LifecycleSyncMethods.prototype.recoverContextGraphSwmFromPeer.call(
      agentLike as any,
      '12D3KooWSwmRecoveryPeer',
      'private-cg',
    );

    expect(runContextGraphSyncWithBackpressure).toHaveBeenCalledTimes(1);
    const [, contextGraphId, lane, , , admission] =
      runContextGraphSyncWithBackpressure.mock.calls[0] as unknown as unknown[];
    expect(contextGraphId).toBe('private-cg');
    expect(lane).toBe('swm_recovery');
    expect(admission).toEqual({ source: 'swm-recovery' });
  });

  it('reserves settlement time inside an explicit exact-asset timeout while internal VM recovery keeps 600 seconds', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const exactUal = 'did:dkg:base:84532/0x1111111111111111111111111111111111111111/1';
    const agentLike: any = {
      config: {},
      processDurableBatchInWorker: async () => ({}),
      runContextGraphSyncWithBackpressure: async (
        _ctx: unknown,
        _contextGraphId: string,
        _lane: string,
        _operationId: string,
        work: () => Promise<unknown>,
      ) => work(),
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };

    await LifecycleSyncMethods.prototype.runLegacyDurableSync.call(
      agentLike,
      ctx,
      'peer-explicit-exact-budget',
      [contextGraphId],
      undefined,
      undefined,
      undefined,
      {
        exactAssetSelection: { kind: 'ual-only', assetUals: [exactUal] },
        totalTimeoutMs: 30_000,
      },
    );
    expect(mockedRunDurableSyncDetailed).toHaveBeenCalledTimes(1);
    expect(
      mockedRunDurableSyncDetailed.mock.calls[0]![0].durableSyncBudget
        .createContextGraphBudget({ contextGraphId, remainingContextGraphs: 1 })
        .fetchDeadline,
    ).toBe(1_800_000_010_000);

    mockedRunDurableSyncDetailed.mockClear();
    agentLike.runLegacyDurableSyncDetailed = LifecycleSyncMethods.prototype.runLegacyDurableSyncDetailed;
    agentLike.syncExactKnowledgeAssetsFromPeerDetailed =
      LifecycleSyncMethods.prototype.syncExactKnowledgeAssetsFromPeerDetailed;
    await LifecycleSyncMethods.prototype.syncExactKnowledgeAssetsFromPeer.call(
      agentLike,
      'peer-internal-exact-recovery',
      contextGraphId,
      { kind: 'ual-only', assetUals: [exactUal] },
    );
    expect(mockedRunDurableSyncDetailed).toHaveBeenCalledTimes(1);
    expect(
      mockedRunDurableSyncDetailed.mock.calls[0]![0].durableSyncBudget
        .createContextGraphBudget({ contextGraphId, remainingContextGraphs: 1 })
        .fetchDeadline,
    ).toBe(1_800_000_600_000);
  });

  it('keeps a multi-graph exact lifecycle result incomplete after a later clean absence', async () => {
    const exactUal = 'did:dkg:base:84532/0x1111111111111111111111111111111111111111/1';
    const agentLike: any = {
      config: {},
      processDurableBatchInWorker: async () => ({}),
      runContextGraphSyncWithBackpressure: async (
        _ctx: unknown,
        _contextGraphId: string,
        _lane: string,
        _operationId: string,
        work: () => Promise<unknown>,
      ) => work(),
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };
    mockedRunDurableSyncDetailed
      .mockResolvedValueOnce({
        result: {} as Awaited<ReturnType<typeof runDurableSync>>,
        exactFetchDisposition: 'incomplete',
      })
      .mockResolvedValueOnce({
        result: {} as Awaited<ReturnType<typeof runDurableSync>>,
        exactFetchDisposition: 'clean-absent',
      });

    const detailed = await LifecycleSyncMethods.prototype.runLegacyDurableSyncDetailed.call(
      agentLike,
      ctx,
      'peer-multi-exact',
      ['exact-incomplete-cg', 'exact-clean-cg'],
      undefined,
      undefined,
      undefined,
      { exactAssetSelection: { kind: 'ual-only', assetUals: [exactUal] } },
    );

    expect(mockedRunDurableSyncDetailed).toHaveBeenCalledTimes(2);
    expect(detailed.exactFetchDisposition).toBe('incomplete');
  });

  it('keeps caller-signalled durable sync off the non-cancellable changelog lane', async () => {
    const runChangelogLane = vi.fn(async () => ({ remainingLegacyCgs: [] }));
    const runLegacyDurableSync = vi.fn(async () => ({
      insertedTriples: 0,
      complete: false,
    }));
    const changelogCapableStore = {
      changelogHead: async () => undefined,
      readChanges: async () => [],
      headSeq: async () => 0,
      clearReconcileFlag: async () => {},
      needsReconcile: false,
    };
    const agentLike: any = {
      config: {},
      store: changelogCapableStore,
      runChangelogLane,
      runLegacyDurableSync,
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };

    await LifecycleSyncMethods.prototype.syncFromPeerDetailed.call(
      agentLike,
      'peer-changelog-capable',
      [contextGraphId],
    );
    expect(runChangelogLane).toHaveBeenCalledTimes(1);
    expect(runLegacyDurableSync).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort(new Error('caller cancelled before lane selection'));
    await LifecycleSyncMethods.prototype.syncFromPeerDetailed.call(
      agentLike,
      'peer-changelog-capable',
      [contextGraphId],
      undefined,
      undefined,
      undefined,
      { signal: controller.signal },
    );
    expect(runChangelogLane).toHaveBeenCalledTimes(1);
    expect(runLegacyDurableSync).toHaveBeenCalledTimes(1);
    expect(runLegacyDurableSync.mock.calls[0]?.[6]).toMatchObject({
      signal: controller.signal,
    });
  });

  it('retries a transient binding read, caches only the successful proof, and persists the CG id', async () => {
    const root = new Uint8Array(32);
    root[31] = 2;
    const rootHex = Array.from(root, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const getContextGraphNameHash = vi.fn()
      .mockRejectedValueOnce(Object.assign(
        new Error('all configured RPC endpoints failed'),
        { code: 'RPC_ENDPOINTS_EXHAUSTED' },
      ))
      .mockResolvedValue(ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)));
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => root,
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 14n,
      getContextGraphNameHash,
      getLatestMerkleRootPublisher: async () => '0x2222222222222222222222222222222222222222',
      verifyKAUpdate: async () => ({
        verified: true,
        onChainMerkleRoot: root,
        blockNumber: 123,
        txIndex: 4,
        merkleRootCount: 2n,
      }),
    } as ChainAdapter;
    const subscription: { onChainId?: string; subscribed: boolean } = { subscribed: true };
    const bindSubscriptionOnChainId = vi.fn(
      (_localId: string, sub: typeof subscription, onChainId: string) => {
        sub.onChainId = onChainId;
      },
    );
    const persistContextGraphSubscriptionStrict = vi.fn();
    const onAtomicCommitStarted = vi.fn();
    const agentLike: any = {
      config: {},
      chain,
      store: {},
      subscribedContextGraphs: new Map([[contextGraphId, subscription]]),
      contextGraphBindingState: new ContextGraphBindingState(),
      wireIdToLocalCgId: new Map(),
      graphScopedStoreClosed: false,
      graphScopedStorePhysicalRuns: new Set<Promise<unknown>>(),
      bindSubscriptionOnChainId,
      persistContextGraphSubscriptionStrict,
      processDurableBatchInWorker: async () => ({}),
      insertSyncedQuadsAndInvalidateListCache: async () => {},
      syncCheckpoints: new Map(),
      oversizeTombstoneLog: { record: () => {} },
      invalidateListContextGraphsCache: vi.fn(),
      contextGraphMetaProjection: { markDirtyFromQuads: vi.fn() },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };
    agentLike.localCgMatchesOnChainSlot = (DKGAgent.prototype as any).localCgMatchesOnChainSlot;
    agentLike.requireLocalCgMatchesOnChainSlot = (
      DKGAgent.prototype as any
    ).requireLocalCgMatchesOnChainSlot;
    agentLike.isWireIdKeyedSubscription = (DKGAgent.prototype as any).isWireIdKeyedSubscription;
    agentLike.raceChainPolicyRead = (DKGAgent.prototype as any).raceChainPolicyRead;

    await LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraph.call(
      agentLike,
      ctx,
      'peer-remote',
      contextGraphId,
      1,
      { onAtomicCommitStarted },
    );
    expect(mockedRunDurableSync).toHaveBeenCalledTimes(1);
    const storeGraphScopedAsset = mockedRunDurableSync.mock.calls[0]![0].storeGraphScopedAsset;
    expect(storeGraphScopedAsset).toBeTypeOf('function');

    const asset: VerifiedGraphScopedAsset = {
      contextGraphId,
      ual,
      assertionVersion: 2n,
      assertionGraph,
      metaGraph,
      dataQuads: [],
      metadataQuads: [
        {
          subject: ual,
          predicate: `${DKG}merkleRoot`,
          object: `"${rootHex}"`,
          graph: metaGraph,
        },
        {
          subject: ual,
          predicate: `${DKG}transactionHash`,
          object: `"0x${'02'.padStart(64, '0')}"`,
          graph: metaGraph,
        },
      ],
    };
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const firstMaterialization = storeGraphScopedAsset!(
        graphScopedStoreRequest(asset, Date.now() + 120_000),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(getContextGraphNameHash).toHaveBeenCalledTimes(1);
      expect(bindSubscriptionOnChainId).not.toHaveBeenCalled();
      expect(persistContextGraphSubscriptionStrict).not.toHaveBeenCalled();
      expect(onAtomicCommitStarted).not.toHaveBeenCalled();
      expect(mockedMaterialize).not.toHaveBeenCalled();
      expect(agentLike.invalidateListContextGraphsCache).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_099);
      expect(getContextGraphNameHash).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(firstMaterialization).resolves.toBe('applied');
      expect(onAtomicCommitStarted).toHaveBeenCalledTimes(1);
      expect(onAtomicCommitStarted).toHaveBeenCalledWith(contextGraphId, ual);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
    await expect(storeGraphScopedAsset!(
      graphScopedStoreRequest(asset, Date.now() + 60_000),
    )).resolves.toBe('applied');

    expect(getContextGraphNameHash).toHaveBeenCalledTimes(2);

    expect(bindSubscriptionOnChainId).toHaveBeenCalledWith(
      contextGraphId,
      subscription,
      '14',
    );
    expect(subscription.onChainId).toBe('14');
    expect(persistContextGraphSubscriptionStrict).toHaveBeenCalledWith(
      contextGraphId,
      expect.objectContaining({ onChainId: '14', lastReconciledOrdinal: 0 }),
      undefined,
      expect.any(Function),
    );
    expect(bindSubscriptionOnChainId.mock.invocationCallOrder[0]).toBeLessThan(
      mockedMaterialize.mock.invocationCallOrder[0]!,
    );
    expect(persistContextGraphSubscriptionStrict.mock.invocationCallOrder[0]).toBeLessThan(
      mockedMaterialize.mock.invocationCallOrder[0]!,
    );
    expect(onAtomicCommitStarted.mock.invocationCallOrder[0]).toBeLessThan(
      mockedMaterialize.mock.invocationCallOrder[0]!,
    );
    expect(onAtomicCommitStarted).toHaveBeenCalledTimes(2);
    const materializedAsset = mockedMaterialize.mock.calls[0]![0].asset as unknown as Record<
      string,
      unknown
    >;
    expect('verifiedOnChainContextGraphId' in materializedAsset).toBe(false);
    const shouldQuarantineCommitted = mockedMaterialize.mock.calls[0]![0]
      .shouldQuarantineCommitted;
    expect(shouldQuarantineCommitted?.()).toBe(false);
    subscription.onChainId = undefined;
    expect(shouldQuarantineCommitted?.()).toBe(true);
    subscription.onChainId = '14';
    agentLike.subscribedContextGraphs.delete(contextGraphId);
    expect(shouldQuarantineCommitted?.()).toBe(true);
    agentLike.subscribedContextGraphs.set(contextGraphId, subscription);

    subscription.onChainId = undefined;
    persistContextGraphSubscriptionStrict.mockRejectedValueOnce(new Error('subscription store unavailable'));
    const bindsBeforeRejectedSave = bindSubscriptionOnChainId.mock.calls.length;
    const materializationsBeforeRejectedSave = mockedMaterialize.mock.calls.length;
    await expect(storeGraphScopedAsset!(
      graphScopedStoreRequest(asset, Date.now() + 60_000),
    )).rejects.toThrow('subscription store unavailable');
    expect(subscription.onChainId).toBeUndefined();
    expect(bindSubscriptionOnChainId).toHaveBeenCalledTimes(bindsBeforeRejectedSave);
    expect(mockedMaterialize).toHaveBeenCalledTimes(materializationsBeforeRejectedSave);
  });

  it('retains a chain-authenticated public asset when no subscription exists', async () => {
    const root = new Uint8Array(32);
    root[31] = 2;
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => root,
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 14n,
      getContextGraphNameHash: async () => (
        ethers.keccak256(ethers.toUtf8Bytes(contextGraphId))
      ),
      getLatestMerkleRootPublisher: async () => '0x2222222222222222222222222222222222222222',
      verifyKAUpdate: async () => ({
        verified: true,
        onChainMerkleRoot: root,
        blockNumber: 123,
        txIndex: 4,
        merkleRootCount: 2n,
      }),
    } as ChainAdapter;

    const storeGraphScopedAsset = await captureGraphScopedStore(chain);
    await expect(storeGraphScopedAsset(
      graphScopedStoreRequest(graphScopedAsset(root), Date.now() + 60_000),
    )).resolves.toBe('applied');

    expect(mockedMaterialize).toHaveBeenCalledOnce();
    expect(mockedMaterialize.mock.calls[0]![0].shouldQuarantineCommitted?.()).toBe(false);
  });

  it('wires durable VM reconciliation to named-lifecycle cleanup without failing materialization', async () => {
    const root = new Uint8Array(32);
    root[31] = 2;
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => root,
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 14n,
      getContextGraphNameHash: async () => ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)),
      getLatestMerkleRootPublisher: async () => '0x2222222222222222222222222222222222222222',
      verifyKAUpdate: async () => ({
        verified: true,
        onChainMerkleRoot: root,
        blockNumber: 123,
        txIndex: 4,
        merkleRootCount: 2n,
      }),
    } as ChainAdapter;
    const clearPublishedKnowledgeAssetSwm = vi.fn(async () => {
      throw new Error('cleanup store unavailable');
    });
    const warnings = vi.fn();
    let agentLike!: any;
    mockedReconcileFinalizedSwmTwin.mockImplementationOnce(async ({ retire }) => {
      await retire({
        contextGraphId,
        kaUal: ual,
        agentAddress: '0x1111111111111111111111111111111111111111',
        kaNumber: 1n,
        swmGraph: 'urn:swm',
      } satisfies FinalizedSwmTwinRetirement);
      return 'retired';
    });
    const storeGraphScopedAsset = await captureGraphScopedStore(chain, warnings, {
      onAgentLike: (value) => {
        agentLike = value;
        value.publisher = { clearPublishedKnowledgeAssetSwm };
      },
    });

    await expect(storeGraphScopedAsset(
      graphScopedStoreRequest(graphScopedAsset(root), Date.now() + 60_000),
    )).resolves.toBe('applied');

    expect(clearPublishedKnowledgeAssetSwm).toHaveBeenCalledWith(
      contextGraphId,
      {
        kind: 'named-lifecycle',
        identity: {
          agentAddress: '0x1111111111111111111111111111111111111111',
          kaNumber: 1n,
        },
      },
      undefined,
      ctx,
      ual,
    );
    expect(warnings).toHaveBeenCalledWith(
      ctx,
      expect.stringContaining('Deferred SWM twin reconciliation'),
    );
    expect(mockedMaterialize).toHaveBeenCalledOnce();
    expect(agentLike.invalidateListContextGraphsCache).toHaveBeenCalled();
  });

  it('maps already-retired SWM recovery evidence to metadata suppression at the lifecycle boundary', async () => {
    let disposition: unknown;
    mockedReconcileFinalizedSwmTwinFromDescriptor.mockResolvedValueOnce(
      'already-retired-finalized',
    );
    mockedRunSharedMemorySync.mockImplementationOnce(async (syncContext) => {
      disposition = await syncContext.reconcileFinalizedTwin?.(contextGraphId, {
        kaUal: ual,
      } as never);
      return {
        insertedTriples: 0,
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        bytesReceived: 0,
        resumedPhases: 0,
        timedOutPhases: 0,
        completedPhases: 1,
        checkpointAdvances: 0,
        deniedPhases: 0,
        emptyResponses: 0,
        droppedDataTriples: 0,
        failedPeers: 0,
        failedPhases: 0,
        backoffWorthyFailures: 0,
        deferredBackpressure: 0,
        snapshotPlaneIncomplete: 0,
        metadataContinuationYields: 0,
        replayPhaseBytesReceived: 0,
        snapshotPhaseBytesReceived: 0,
      };
    });
    const agentLike: any = {
      config: {},
      store: {},
      writeLocks: new Map(),
      publicSnapshotStore: undefined,
      syncCheckpoints: new Map(),
      workspaceOwnedEntities: new Map(),
      oversizeTombstoneLog: { record: () => {} },
      contextGraphMetaProjection: { markDirtyFromQuads: () => {} },
      invalidateListContextGraphsCache: vi.fn(),
      listSubGraphs: async () => [],
      fetchSyncPages: async () => { throw new Error('unexpected fetch'); },
      getOrCreateSyncVerifyWorker: () => { throw new Error('unexpected verifier'); },
      runContextGraphSyncWithBackpressure: async (
        _ctx: unknown,
        _cg: string,
        _lane: string,
        _operation: string,
        work: () => Promise<unknown>,
      ) => work(),
      publisher: { clearPublishedKnowledgeAssetSwm: vi.fn() },
      // Ordinary public CG: no RFC-64 complete-provider authority applies.
      // Required once #2271's execution-boundary source fence is in the base.
      resolveRfc64CompleteSwmProviderPeerIdsV1: () => [],
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
    agentLike.retireFinalizedSwmTwinCandidate = (
      LifecycleSyncMethods.prototype as any
    ).retireFinalizedSwmTwinCandidate;

    await LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailedExecution.call(
      agentLike,
      '12D3KooWLifecyclePeer',
      [contextGraphId],
      {
        sharedMemorySyncPlan: {
          targets: [{ contextGraphId, lane: 'selected-public' }],
        },
      },
    );

    expect(mockedReconcileFinalizedSwmTwinFromDescriptor).toHaveBeenCalledOnce();
    expect(disposition).toBe('suppress-metadata');
  });

  it('retires a fresh SWM twin through named lifecycle cleanup and suppresses its metadata', async () => {
    let disposition: unknown;
    const retirement = {
      contextGraphId,
      kaUal: ual,
      agentAddress: '0x1111111111111111111111111111111111111111',
      kaNumber: 1n,
      swmGraph: 'urn:swm',
    } satisfies FinalizedSwmTwinRetirement;
    mockedReconcileFinalizedSwmTwinFromDescriptor.mockImplementationOnce(
      async ({ retire }) => {
        await retire(retirement);
        return 'retired';
      },
    );
    mockedRunSharedMemorySync.mockImplementationOnce(async (syncContext) => {
      disposition = await syncContext.reconcileFinalizedTwin?.(contextGraphId, {
        kaUal: ual,
      } as never);
      return {
        insertedTriples: 0,
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        bytesReceived: 0,
        resumedPhases: 0,
        timedOutPhases: 0,
        completedPhases: 1,
        checkpointAdvances: 0,
        deniedPhases: 0,
        emptyResponses: 0,
        droppedDataTriples: 0,
        failedPeers: 0,
        failedPhases: 0,
        backoffWorthyFailures: 0,
        deferredBackpressure: 0,
        snapshotPlaneIncomplete: 0,
        metadataContinuationYields: 0,
        replayPhaseBytesReceived: 0,
        snapshotPhaseBytesReceived: 0,
      };
    });
    const clearPublishedKnowledgeAssetSwm = vi.fn(async () => {});
    const agentLike: any = {
      config: {},
      store: {},
      writeLocks: new Map(),
      publicSnapshotStore: undefined,
      syncCheckpoints: new Map(),
      workspaceOwnedEntities: new Map(),
      oversizeTombstoneLog: { record: () => {} },
      contextGraphMetaProjection: { markDirtyFromQuads: () => {} },
      invalidateListContextGraphsCache: vi.fn(),
      listSubGraphs: async () => [],
      fetchSyncPages: async () => { throw new Error('unexpected fetch'); },
      getOrCreateSyncVerifyWorker: () => { throw new Error('unexpected verifier'); },
      runContextGraphSyncWithBackpressure: async (
        _ctx: unknown,
        _cg: string,
        _lane: string,
        _operation: string,
        work: () => Promise<unknown>,
      ) => work(),
      publisher: { clearPublishedKnowledgeAssetSwm },
      // Ordinary public CG: no RFC-64 complete-provider authority applies.
      resolveRfc64CompleteSwmProviderPeerIdsV1: () => [],
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
    agentLike.retireFinalizedSwmTwinCandidate = (
      LifecycleSyncMethods.prototype as any
    ).retireFinalizedSwmTwinCandidate;

    await LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailedExecution.call(
      agentLike,
      '12D3KooWLifecyclePeer',
      [contextGraphId],
      {
        sharedMemorySyncPlan: {
          targets: [{ contextGraphId, lane: 'selected-public' }],
        },
      },
    );

    expect(mockedReconcileFinalizedSwmTwinFromDescriptor).toHaveBeenCalledOnce();
    expect(clearPublishedKnowledgeAssetSwm).toHaveBeenCalledWith(
      contextGraphId,
      {
        kind: 'named-lifecycle',
        identity: {
          agentAddress: retirement.agentAddress,
          kaNumber: retirement.kaNumber,
        },
      },
      undefined,
      expect.objectContaining({ operationName: 'sync' }),
      ual,
    );
    expect(agentLike.invalidateListContextGraphsCache).toHaveBeenCalledOnce();
    expect(disposition).toBe('suppress-metadata');
  });

  it('does not let a stale strict snapshot overwrite a newer host-only persistence write', async () => {
    const oldSubscription = { subscribed: true, onChainId: '14' };
    const hostOnlySubscription = { subscribed: false, coreHosted: true, onChainId: '14' };
    let durableRecord: Record<string, unknown> | undefined;
    let releaseHostWrite!: () => void;
    const hostWriteGate = new Promise<void>((resolve) => { releaseHostWrite = resolve; });
    let persistChain = Promise.resolve();
    const enqueueContextGraphSubscriptionPersistWrite = (
      _contextGraphId: string,
      write: () => Promise<void>,
    ) => {
      const run = persistChain.then(write);
      persistChain = run.catch(() => undefined);
      return run;
    };
    const agentLike: any = {
      config: {
        contextGraphSubscriptionStore: {
          loadAll: async () => [],
          save: async (record: Record<string, unknown>) => { durableRecord = { ...record }; },
          delete: async () => { durableRecord = undefined; },
        },
      },
      subscribedContextGraphs: new Map([[contextGraphId, oldSubscription]]),
      contextGraphBindingState: new ContextGraphBindingState(),
      enqueueContextGraphSubscriptionPersistWrite,
    };

    const capturedSubscription = oldSubscription;
    agentLike.subscribedContextGraphs.set(contextGraphId, hostOnlySubscription);
    const hostWrite = enqueueContextGraphSubscriptionPersistWrite(contextGraphId, async () => {
      await hostWriteGate;
      durableRecord = { id: contextGraphId, ...hostOnlySubscription };
    });
    const staleStrictWrite = LifecycleSyncMethods.prototype.persistContextGraphSubscriptionStrict.call(
      agentLike,
      contextGraphId,
      { ...capturedSubscription, onChainId: '15', lastReconciledOrdinal: 0 },
      undefined,
      () => agentLike.subscribedContextGraphs.get(contextGraphId) === capturedSubscription,
    );

    releaseHostWrite();
    await hostWrite;
    await expect(staleStrictWrite).rejects.toThrow(/changed before.*persisted/);
    expect(durableRecord).toEqual({ id: contextGraphId, ...hostOnlySubscription });
  });

  it('does not reuse a proof or roll an authoritative binding across same-name CG slots', async () => {
    const root = new Uint8Array(32);
    root[31] = 2;
    const rootHex = Array.from(root, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const expectedNameHash = ethers.keccak256(ethers.toUtf8Bytes(contextGraphId));
    const getContextGraphNameHash = vi.fn(async () => expectedNameHash);
    const kaNumberMask = (1n << 96n) - 1n;
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => root,
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async (kaId: bigint) => (
        (kaId & kaNumberMask) === 1n ? 14n : 15n
      ),
      getContextGraphNameHash,
      getLatestMerkleRootPublisher: async () => '0x2222222222222222222222222222222222222222',
      verifyKAUpdate: async () => ({
        verified: true,
        onChainMerkleRoot: root,
        blockNumber: 123,
        txIndex: 4,
        merkleRootCount: 2n,
      }),
    } as ChainAdapter;
    const subscription: { onChainId?: string; subscribed: boolean } = { subscribed: true };
    const agentLike: any = {
      config: {},
      chain,
      store: {},
      subscribedContextGraphs: new Map([[contextGraphId, subscription]]),
      contextGraphBindingState: new ContextGraphBindingState(),
      wireIdToLocalCgId: new Map(),
      graphScopedStoreClosed: false,
      graphScopedStorePhysicalRuns: new Set<Promise<unknown>>(),
      bindSubscriptionOnChainId: vi.fn(
        (_localId: string, sub: typeof subscription, onChainId: string) => {
          sub.onChainId = onChainId;
        },
      ),
      persistContextGraphSubscriptionStrict: vi.fn(),
      processDurableBatchInWorker: async () => ({}),
      insertSyncedQuadsAndInvalidateListCache: async () => {},
      syncCheckpoints: new Map(),
      oversizeTombstoneLog: { record: () => {} },
      invalidateListContextGraphsCache: vi.fn(),
      contextGraphMetaProjection: { markDirtyFromQuads: vi.fn() },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };
    agentLike.localCgMatchesOnChainSlot = (DKGAgent.prototype as any).localCgMatchesOnChainSlot;
    agentLike.requireLocalCgMatchesOnChainSlot = (
      DKGAgent.prototype as any
    ).requireLocalCgMatchesOnChainSlot;
    agentLike.isWireIdKeyedSubscription = (DKGAgent.prototype as any).isWireIdKeyedSubscription;
    agentLike.raceChainPolicyRead = (DKGAgent.prototype as any).raceChainPolicyRead;

    await LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraph.call(
      agentLike,
      ctx,
      'peer-remote',
      contextGraphId,
      1,
    );
    const storeGraphScopedAsset = mockedRunDurableSync.mock.calls[0]![0].storeGraphScopedAsset;
    const asset = (kaNumber: number): VerifiedGraphScopedAsset => {
      const assetUal = `did:dkg:otp:2043/0x1111111111111111111111111111111111111111/${kaNumber}`;
      return {
        contextGraphId,
        ual: assetUal,
        assertionVersion: 2n,
        assertionGraph: `${assertionGraph}-${kaNumber}`,
        metaGraph,
        dataQuads: [],
        metadataQuads: [
          {
            subject: assetUal,
            predicate: `${DKG}merkleRoot`,
            object: `"${rootHex}"`,
            graph: metaGraph,
          },
          {
            subject: assetUal,
            predicate: `${DKG}transactionHash`,
            object: `"0x${'02'.padStart(64, '0')}"`,
            graph: metaGraph,
          },
        ],
      };
    };

    await expect(storeGraphScopedAsset!(
      graphScopedStoreRequest(asset(1), Date.now() + 60_000),
    )).resolves.toBe('applied');
    await expect(storeGraphScopedAsset!(
      graphScopedStoreRequest(asset(2), Date.now() + 60_000),
    )).rejects.toMatchObject({
      code: 'VM_CHAIN_CONTEXT_GRAPH_MISMATCH',
    });

    expect(getContextGraphNameHash).toHaveBeenCalledTimes(2);
    expect(getContextGraphNameHash.mock.calls.map(([id]) => id)).toEqual([14n, 15n]);
    expect(agentLike.persistContextGraphSubscriptionStrict).toHaveBeenCalledOnce();
    expect(agentLike.bindSubscriptionOnChainId).toHaveBeenCalledOnce();
    expect(subscription.onChainId).toBe('14');
    expect(mockedMaterialize).toHaveBeenCalledTimes(1);
  });

  it('aborts real graph-scoped authentication before materialization', async () => {
    const controller = new AbortController();
    const timeoutError = new Error('whole durable operation expired');
    timeoutError.name = 'AbortError';
    let authenticationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      authenticationStarted = resolve;
    });
    let authenticationSignal: AbortSignal | undefined;
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: (
        _kaId: bigint,
        options?: { signal?: AbortSignal },
      ) => new Promise<Uint8Array>((_resolve, reject) => {
        authenticationSignal = options?.signal;
        if (!authenticationSignal) {
          reject(new Error('authentication root read received no abort signal'));
          return;
        }
        authenticationStarted();
        authenticationSignal.addEventListener(
          'abort',
          () => reject(authenticationSignal?.reason),
          { once: true },
        );
      }),
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 14n,
    } as ChainAdapter;
    const onAtomicCommitStarted = vi.fn();
    const storeGraphScopedAsset = await captureGraphScopedStore(
      chain,
      vi.fn(),
      {
        signal: controller.signal,
        onAtomicCommitStarted,
      },
    );

    const pending = storeGraphScopedAsset(graphScopedStoreRequest(
      graphScopedAsset(new Uint8Array(32)),
      Date.now() + 120_000,
      controller.signal,
    ));
    await started;
    controller.abort(timeoutError);

    await expect(pending).rejects.toBe(timeoutError);
    expect(authenticationSignal?.aborted).toBe(true);
    expect(onAtomicCommitStarted).not.toHaveBeenCalled();
    expect(mockedMaterialize).not.toHaveBeenCalled();
  });

  it('registers the physical store before invoking a pluggable chain adapter', async () => {
    const root = new Uint8Array(32);
    let agentLike: any;
    let physicalRunsSeenByAdapter = -1;
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => {
        physicalRunsSeenByAdapter = agentLike.graphScopedStorePhysicalRuns.size;
        return root;
      },
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 14n,
      getContextGraphNameHash: async () => ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)),
      getLatestMerkleRootPublisher: async () => '0x2222222222222222222222222222222222222222',
      verifyKAUpdate: async () => ({
        verified: true,
        onChainMerkleRoot: root,
        blockNumber: 123,
        txIndex: 4,
        merkleRootCount: 2n,
      }),
    } as ChainAdapter;
    const storeGraphScopedAsset = await captureGraphScopedStore(chain, vi.fn(), {
      onAgentLike: (captured) => { agentLike = captured; },
    });

    const pending = storeGraphScopedAsset(graphScopedStoreRequest(
      graphScopedAsset(root),
      Date.now() + 120_000,
    ));
    expect(agentLike.graphScopedStorePhysicalRuns.size).toBe(1);
    await expect(pending).resolves.toBe('applied');
    expect(physicalRunsSeenByAdapter).toBe(1);
    expect(agentLike.graphScopedStorePhysicalRuns.size).toBe(0);
  });

  it('rejects an ordinary durable asset when its subscription rebinds during authentication', async () => {
    const root = new Uint8Array(32);
    let releaseRoot!: () => void;
    let markRootReadStarted!: () => void;
    const rootReadStarted = new Promise<void>((resolve) => { markRootReadStarted = resolve; });
    const rootGate = new Promise<void>((resolve) => { releaseRoot = resolve; });
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => {
        markRootReadStarted();
        await rootGate;
        return root;
      },
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 14n,
      getContextGraphNameHash: async () => ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)),
      getLatestMerkleRootPublisher: async () => '0x2222222222222222222222222222222222222222',
      verifyKAUpdate: async () => ({
        verified: true,
        onChainMerkleRoot: root,
        blockNumber: 123,
        txIndex: 4,
        merkleRootCount: 2n,
      }),
    } as ChainAdapter;
    const subscription = { subscribed: true, onChainId: '14', lastReconciledOrdinal: 9 };
    const bindSubscriptionOnChainId = vi.fn();
    const persistContextGraphSubscriptionStrict = vi.fn();
    const syncCheckpoints = new Map([['unchanged', 17]]);
    const agentLike: any = {
      config: {},
      chain,
      store: {},
      subscribedContextGraphs: new Map([[contextGraphId, subscription]]),
      contextGraphBindingState: new ContextGraphBindingState(),
      wireIdToLocalCgId: new Map(),
      graphScopedStoreClosed: false,
      graphScopedStorePhysicalRuns: new Set<Promise<unknown>>(),
      bindSubscriptionOnChainId,
      persistContextGraphSubscriptionStrict,
      processDurableBatchInWorker: async () => ({}),
      insertSyncedQuadsAndInvalidateListCache: async () => {},
      syncCheckpoints,
      oversizeTombstoneLog: { record: () => {} },
      invalidateListContextGraphsCache: vi.fn(),
      contextGraphMetaProjection: { markDirtyFromQuads: vi.fn() },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };
    agentLike.localCgMatchesOnChainSlot = (DKGAgent.prototype as any).localCgMatchesOnChainSlot;
    agentLike.requireLocalCgMatchesOnChainSlot = (
      DKGAgent.prototype as any
    ).requireLocalCgMatchesOnChainSlot;
    agentLike.isWireIdKeyedSubscription = (DKGAgent.prototype as any).isWireIdKeyedSubscription;
    agentLike.raceChainPolicyRead = (DKGAgent.prototype as any).raceChainPolicyRead;
    await LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraph.call(
      agentLike,
      ctx,
      'peer-stale-exact',
      contextGraphId,
      1,
    );
    const storeGraphScopedAsset = mockedRunDurableSync.mock.calls[0]![0]
      .storeGraphScopedAsset!;
    const pending = storeGraphScopedAsset(graphScopedStoreRequest(
      graphScopedAsset(root),
      Date.now() + 120_000,
    ));
    await rootReadStarted;
    const reboundSubscription = { subscribed: true, onChainId: '15', lastReconciledOrdinal: 0 };
    agentLike.subscribedContextGraphs.set(contextGraphId, reboundSubscription);
    releaseRoot();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(bindSubscriptionOnChainId).not.toHaveBeenCalled();
    expect(persistContextGraphSubscriptionStrict).not.toHaveBeenCalled();
    expect(mockedMaterialize).not.toHaveBeenCalled();
    expect(syncCheckpoints).toEqual(new Map([['unchanged', 17]]));
    expect(subscription).toEqual({ subscribed: true, onChainId: '14', lastReconciledOrdinal: 9 });
    expect(agentLike.subscribedContextGraphs.get(contextGraphId)).toBe(reboundSubscription);
  });

  it('cancels and retries a hung root read within the graph deadline', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const signals: AbortSignal[] = [];
      const getLatestMerkleRoot = vi.fn((
        _kaId: bigint,
        options?: { signal?: AbortSignal },
      ) => new Promise<Uint8Array>((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) throw new Error('authentication root read received no abort signal');
        signals.push(signal);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
      const chain = {
        chainId: 'otp:2043',
        getLatestMerkleRoot,
        getMerkleRootCount: async () => 2n,
        getKAContextGraphId: async () => 14n,
      } as ChainAdapter;
      const warnings = vi.fn();
      const storeGraphScopedAsset = await captureGraphScopedStore(chain, warnings);
      const pending = storeGraphScopedAsset(graphScopedStoreRequest(
        graphScopedAsset(new Uint8Array(32)),
        Date.now() + 120_000,
      ));
      const rejection = expect(pending).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });

      await vi.runAllTimersAsync();
      await rejection;
      expect(getLatestMerkleRoot).toHaveBeenCalledTimes(5);
      expect(signals).toHaveLength(5);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(warnings).toHaveBeenCalledTimes(4);
      expect(mockedMaterialize).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it('cancels and retries a hung V1 publish provenance read within the graph deadline', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const root = new Uint8Array(32);
      root[31] = 1;
      const signals: AbortSignal[] = [];
      const resolvePublishByTxHash = vi.fn((
        _txHash: string,
        options?: { signal?: AbortSignal },
      ) => new Promise<never>((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) throw new Error('V1 provenance read received no abort signal');
        signals.push(signal);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
      const chain = {
        chainId: 'otp:2043',
        getLatestMerkleRoot: async () => root,
        getMerkleRootCount: async () => 1n,
        getKAContextGraphId: async () => 14n,
        getContextGraphNameHash: async () => ethers.keccak256(
          ethers.toUtf8Bytes(contextGraphId),
        ),
        resolvePublishByTxHash,
      } as ChainAdapter;
      const warnings = vi.fn();
      const storeGraphScopedAsset = await captureGraphScopedStore(chain, warnings);
      const pending = storeGraphScopedAsset(graphScopedStoreRequest(
        graphScopedAsset(root, 1n),
        Date.now() + 120_000,
      ));
      const rejection = expect(pending).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });

      await vi.runAllTimersAsync();
      await rejection;
      expect(resolvePublishByTxHash).toHaveBeenCalledTimes(5);
      expect(signals).toHaveLength(5);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(warnings).toHaveBeenCalledTimes(4);
      expect(mockedMaterialize).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not retry deterministic chain evidence mismatches', async () => {
    const expectedRoot = new Uint8Array(32);
    const actualRoot = new Uint8Array(32);
    actualRoot[31] = 1;
    const getLatestMerkleRoot = vi.fn(async () => actualRoot);
    const warnings = vi.fn();
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot,
      getMerkleRootCount: async () => 2n,
      getKAContextGraphId: async () => 14n,
    } as ChainAdapter;
    const storeGraphScopedAsset = await captureGraphScopedStore(chain, warnings);

    await expect(storeGraphScopedAsset(graphScopedStoreRequest(
      graphScopedAsset(expectedRoot),
      Date.now() + 60_000,
    ))).rejects.toMatchObject({ code: 'VM_CHAIN_ROOT_MISMATCH' });
    expect(getLatestMerkleRoot).toHaveBeenCalledTimes(1);
    expect(warnings).not.toHaveBeenCalled();
    expect(mockedMaterialize).not.toHaveBeenCalled();
  });

  it('cancels sibling chain reads when one authentication read fails early', async () => {
    const deterministicError = Object.assign(new Error('contract view reverted'), {
      code: 'CALL_EXCEPTION',
    });
    let siblingSignal: AbortSignal | undefined;
    const chain = {
      chainId: 'otp:2043',
      getLatestMerkleRoot: async () => { throw deterministicError; },
      getMerkleRootCount: (
        _kaId: bigint,
        options?: { signal?: AbortSignal },
      ) => new Promise<bigint>((_resolve, reject) => {
        siblingSignal = options?.signal;
        siblingSignal?.addEventListener(
          'abort',
          () => reject(siblingSignal?.reason),
          { once: true },
        );
      }),
      getKAContextGraphId: async () => 14n,
    } as ChainAdapter;
    const storeGraphScopedAsset = await captureGraphScopedStore(chain);

    await expect(storeGraphScopedAsset(graphScopedStoreRequest(
      graphScopedAsset(new Uint8Array(32)),
      Date.now() + 60_000,
    ))).rejects.toBe(deterministicError);
    expect(siblingSignal?.aborted).toBe(true);
    expect(mockedMaterialize).not.toHaveBeenCalled();
  });
});
