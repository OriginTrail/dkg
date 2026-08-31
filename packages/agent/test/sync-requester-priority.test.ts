import { describe, expect, it } from 'vitest';
import { createOperationContext, PROTOCOL_SYNC_CHANGELOG, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import {
  runDurableSync,
  type DurableSyncFetchRequest,
} from '../src/sync/requester/durable-sync.js';
import { uniformDurableSyncBudget } from './durable-sync-test-helpers.js';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';
import { runOrderedContextGraphSyncs } from '../src/sync/requester/ordered-sync.js';
import {
  resolveSyncGlobalBackpressure,
  SyncBackpressureBusyError,
  withGlobalSyncBackpressure,
} from '../src/sync/backpressure.js';
import { syncPriorityClass } from '../src/sync/policy.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import {
  createDurableSyncAccumulator,
  createIncompleteDurableSyncResult,
} from '../src/sync/durable-progress.js';

const ctx = createOperationContext('sync');
const noop = () => {};

function page(contextGraphId: string, phase: string) {
  return {
    quads: [],
    bytesReceived: 0,
    resumedFromOffset: 0,
    nextOffset: 0,
    checkpointKey: `${contextGraphId}:${phase}`,
    completed: true,
    timedOut: false,
  };
}

function durableContext(contextGraphIds: string[]) {
  return {
    ctx,
    remotePeerId: 'peer',
    contextGraphIds,
    durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 1_000),
    fetchSyncPages: async ({
      contextGraphId,
      phase,
    }: DurableSyncFetchRequest) => page(contextGraphId, phase),
    processDurableBatchInWorker: async () => ({
      verifiedData: [], verifiedMeta: [], totalFetchedDataQuads: 0, totalFetchedMetaQuads: 0,
      rejectedKcs: 0, emptyResponses: 1, metaOnlyResponses: 0, dataRejectedMissingMeta: 0,
    }),
    storeInsert: async () => {},
    deleteCheckpoint: noop,
    setCheckpoint: noop,
    logInfo: noop,
    logWarn: noop,
    logDebug: noop,
  };
}

function lifecycleAgent(
  priorities: Record<string, number>,
  runAdmission: (contextGraphId: string, work: () => Promise<unknown>) => Promise<unknown>,
) {
  return {
    config: { syncContextGraphPriorities: priorities },
    createContextGraphSyncDeadline: () => Date.now() + 1_000,
    createGraphScopedAuthenticationDeadline: () => Date.now() + 1_000,
    fetchSyncPages: async (
      _ctx: unknown,
      _peer: string,
      contextGraphId: string,
      _swm: boolean,
      phase: 'data' | 'meta',
    ) => ({
      ...page(contextGraphId, phase),
      quads: phase === 'data'
        ? [{
            subject: `urn:${contextGraphId}`,
            predicate: 'urn:predicate',
            object: 'urn:object',
            graph: 'urn:graph',
          }]
        : [],
    }),
    processDurableBatchInWorker: async (dataQuads: unknown[], metaQuads: unknown[]) => ({
      verifiedData: dataQuads,
      verifiedMeta: metaQuads,
      totalFetchedDataQuads: dataQuads.length,
      totalFetchedMetaQuads: metaQuads.length,
      rejectedKcs: 0,
      emptyResponses: 0,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
    }),
    insertSyncedQuadsAndInvalidateListCache: async () => {},
    syncCheckpoints: new Map(),
    runLegacyDurableSyncForContextGraph: LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraph,
    runContextGraphSyncWithBackpressure: async (
      _ctx: unknown,
      contextGraphId: string,
      _lane: string,
      _label: string,
      work: () => Promise<unknown>,
    ) => runAdmission(contextGraphId, work),
    log: { info: noop, warn: noop, debug: noop },
  };
}

describe('requester per-CG priority admission', () => {
  it('wires configured priority order through the durable lifecycle admission boundary', async () => {
    const admissions: string[] = [];
    const agent = lifecycleAgent(
      { high: 100, low: -10 },
      async (contextGraphId, work) => {
        admissions.push(contextGraphId);
        return work();
      },
    );

    await (LifecycleSyncMethods.prototype.runLegacyDurableSync as any).call(
      agent,
      ctx,
      'peer',
      ['low', 'high', 'default'],
    );

    expect(admissions).toEqual(['high', 'default', 'low']);
  });

  it('admits system Context Graphs last so their failures cannot starve user graphs', async () => {
    // System graphs are the observed poison transfers in the per-peer fanout,
    // and the fanout stops on the first failure — so they must run after every
    // user graph even when the agent config never mentions them. An explicit
    // operator entry (0 here) restores ordinary scheduling.
    const admissions: string[] = [];
    const agent = lifecycleAgent(
      { [SYSTEM_CONTEXT_GRAPHS.ONTOLOGY]: 0 },
      async (contextGraphId, work) => {
        admissions.push(contextGraphId);
        return work();
      },
    );

    await (LifecycleSyncMethods.prototype.runLegacyDurableSync as any).call(
      agent,
      ctx,
      'peer',
      [SYSTEM_CONTEXT_GRAPHS.AGENTS, 'user-a', SYSTEM_CONTEXT_GRAPHS.ONTOLOGY, 'user-b'],
    );

    expect(admissions).toEqual([
      'user-a', SYSTEM_CONTEXT_GRAPHS.ONTOLOGY, 'user-b', SYSTEM_CONTEXT_GRAPHS.AGENTS,
    ]);
  });

  it('preserves completed durable progress when a later admission is deferred', async () => {
    const admissions: string[] = [];
    const agent = lifecycleAgent({}, async (contextGraphId, work) => {
      admissions.push(contextGraphId);
      if (contextGraphId === 'second') {
        throw new SyncBackpressureBusyError('queue full');
      }
      return work();
    });

    const summary = await (LifecycleSyncMethods.prototype.runLegacyDurableSync as any).call(
      agent,
      ctx,
      'peer',
      ['first', 'second', 'third'],
    );

    expect(admissions).toEqual(['first', 'second']);
    expect(summary.insertedDataTriples).toBe(1);
    expect(summary.insertedTriples).toBe(1);
    expect(summary.deferredBackpressure).toBe(1);
    expect(summary.failedPeers).toBe(0);
    expect(summary.backoffWorthyFailures).toBe(0);
    expect(summary.complete).toBe(false);
  });

  it('marks changelog admission pressure deferred without routing that graph to legacy', async () => {
    const admissions: string[] = [];
    const emptyResult = createIncompleteDurableSyncResult();
    const agent = {
      config: { syncContextGraphPriorities: {} },
      getPeerProtocols: async () => [PROTOCOL_SYNC_CHANGELOG],
      isPrivateContextGraph: async () => false,
      runContextGraphSyncWithBackpressure: async (
        _ctx: unknown,
        contextGraphId: string,
        _lane: string,
        _label: string,
        work: () => Promise<unknown>,
      ) => {
        admissions.push(contextGraphId);
        if (contextGraphId === 'second') {
          throw new SyncBackpressureBusyError('queue full');
        }
        return work();
      },
      runChangelogSyncForCg: async () => ({ ...emptyResult, completedPhases: 1 }),
      log: { info: noop, warn: noop },
    };

    const lane = await (LifecycleSyncMethods.prototype.runPrioritizedSyncPlan as any).call(
      agent,
      ctx,
      'peer',
      ['first', 'second', 'third'],
    );

    expect(admissions).toEqual(['first', 'second']);
    expect(lane.result.completedPhases).toBe(1);
    expect(lane.result.deferredBackpressure).toBe(1);
    expect(lane.remainingLegacyCgs).toEqual([]);
  });

  it('routes the growing agents phonebook directly to row-paged legacy sync', async () => {
    const admissions: string[] = [];
    const changelogRuns: string[] = [];
    const legacyRuns: string[] = [];
    const emptyResult = {
      ...createIncompleteDurableSyncResult(),
      completedPhases: 1,
    };
    const agent = {
      config: { syncContextGraphPriorities: {} },
      getPeerProtocols: async () => [PROTOCOL_SYNC_CHANGELOG],
      isPrivateContextGraph: async () => false,
      runContextGraphSyncWithBackpressure: async (
        _ctx: unknown,
        contextGraphId: string,
        _lane: string,
        _label: string,
        work: () => Promise<unknown>,
      ) => {
        admissions.push(contextGraphId);
        return work();
      },
      runChangelogSyncForCg: async (
        _ctx: unknown,
        _peer: string,
        contextGraphId: string,
      ) => {
        changelogRuns.push(contextGraphId);
        return emptyResult;
      },
      runLegacyDurableSyncForContextGraph: async (
        _ctx: unknown,
        _peer: string,
        contextGraphId: string,
      ) => {
        legacyRuns.push(contextGraphId);
        return { ...emptyResult, complete: true };
      },
      log: { info: noop, warn: noop },
    };

    const lane = await (LifecycleSyncMethods.prototype.runPrioritizedSyncPlan as any).call(
      agent,
      ctx,
      'peer',
      [SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY, 'public-cg'],
    );

    expect(admissions).toEqual([
      'public-cg', SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
    ]);
    expect(changelogRuns).toEqual(['public-cg', SYSTEM_CONTEXT_GRAPHS.ONTOLOGY]);
    expect(legacyRuns).toEqual([SYSTEM_CONTEXT_GRAPHS.AGENTS]);
    expect(lane.remainingLegacyCgs).toEqual([]);
  });

  it('runs an elevated agents legacy sync before lower-priority changelog backpressure', async () => {
    const admissions: string[] = [];
    const legacyRuns: string[] = [];
    const agent = {
      config: {
        syncContextGraphPriorities: {
          [SYSTEM_CONTEXT_GRAPHS.AGENTS]: 100,
          bulk: -10,
        },
      },
      getPeerProtocols: async () => [PROTOCOL_SYNC_CHANGELOG],
      isPrivateContextGraph: async () => false,
      runContextGraphSyncWithBackpressure: async (
        _ctx: unknown,
        contextGraphId: string,
        _lane: string,
        _label: string,
        work: () => Promise<unknown>,
      ) => {
        admissions.push(contextGraphId);
        if (contextGraphId === 'bulk') throw new SyncBackpressureBusyError('queue full');
        return work();
      },
      runLegacyDurableSyncForContextGraph: async (
        _ctx: unknown,
        _peer: string,
        contextGraphId: string,
      ) => {
        legacyRuns.push(contextGraphId);
        return {
          ...createIncompleteDurableSyncResult(),
          insertedTriples: 2,
          insertedDataTriples: 2,
          completedPhases: 2,
          complete: true,
        };
      },
      runChangelogSyncForCg: async () => ({
        ...createIncompleteDurableSyncResult(),
        completedPhases: 1,
        complete: true,
      }),
      log: { info: noop, warn: noop },
    };

    const lane = await (LifecycleSyncMethods.prototype.runPrioritizedSyncPlan as any).call(
      agent,
      ctx,
      'peer',
      [SYSTEM_CONTEXT_GRAPHS.AGENTS, 'bulk'],
    );

    expect(admissions).toEqual([SYSTEM_CONTEXT_GRAPHS.AGENTS, 'bulk']);
    expect(legacyRuns).toEqual([SYSTEM_CONTEXT_GRAPHS.AGENTS]);
    expect(lane.result.insertedTriples).toBe(2);
    expect(lane.result.deferredBackpressure).toBe(1);
    expect(lane.remainingLegacyCgs).toEqual([]);
  });

  it('keeps private durable work in the same cross-lane priority plan', async () => {
    const admissions: string[] = [];
    const durableRuns: string[] = [];
    const agent = {
      config: { syncContextGraphPriorities: { private: 50, public: -10 } },
      getPeerProtocols: async () => [PROTOCOL_SYNC_CHANGELOG],
      isPrivateContextGraph: async (contextGraphId: string) => contextGraphId === 'private',
      runContextGraphSyncWithBackpressure: async (
        _ctx: unknown,
        contextGraphId: string,
        _lane: string,
        _label: string,
        work: () => Promise<unknown>,
      ) => {
        admissions.push(contextGraphId);
        return work();
      },
      runLegacyDurableSyncForContextGraph: async (
        _ctx: unknown,
        _peer: string,
        contextGraphId: string,
      ) => {
        durableRuns.push(contextGraphId);
        return { ...createIncompleteDurableSyncResult(), completedPhases: 2, complete: true };
      },
      runChangelogSyncForCg: async () => ({
        ...createIncompleteDurableSyncResult(),
        completedPhases: 1,
        complete: true,
      }),
      log: { info: noop, warn: noop },
    };

    const plan = await (LifecycleSyncMethods.prototype.runPrioritizedSyncPlan as any).call(
      agent,
      ctx,
      'peer',
      ['public', 'private'],
    );

    expect(admissions).toEqual(['private', 'public']);
    expect(durableRuns).toEqual(['private']);
    expect(plan.remainingLegacyCgs).toEqual([]);
  });

  it('serializes ordinary and planned AGENTS entry points before admission', async () => {
    let releaseFirst!: () => void;
    let signalFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { signalFirstEntered = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let admissionCalls = 0;
    let activeAdmissions = 0;
    let maximumActiveAdmissions = 0;
    const agent: any = {
      config: { syncContextGraphPriorities: {} },
      getPeerProtocols: async () => [PROTOCOL_SYNC_CHANGELOG],
      isPrivateContextGraph: async () => false,
      runContextGraphSyncWithBackpressure: async () => {
        admissionCalls += 1;
        activeAdmissions += 1;
        maximumActiveAdmissions = Math.max(maximumActiveAdmissions, activeAdmissions);
        if (admissionCalls === 1) {
          signalFirstEntered();
          await firstGate;
        }
        activeAdmissions -= 1;
        return createDurableSyncAccumulator();
      },
      runLegacyDurableSyncForContextGraph: async () => createIncompleteDurableSyncResult(),
      runChangelogSyncForCg: async () => createIncompleteDurableSyncResult(),
      log: { info: noop, warn: noop, debug: noop },
    };

    const ordinary = LifecycleSyncMethods.prototype.runLegacyDurableSync.call(
      agent,
      ctx,
      'same-peer',
      [SYSTEM_CONTEXT_GRAPHS.AGENTS],
    );
    await firstEntered;
    const planned = LifecycleSyncMethods.prototype.runPrioritizedSyncPlan.call(
      agent,
      ctx,
      'same-peer',
      [SYSTEM_CONTEXT_GRAPHS.AGENTS],
    );
    await Promise.resolve();
    await Promise.resolve();

    // The planned entry point waits on the shared peer+CG durable lock before
    // consuming a global admission slot or starting physical paging.
    expect(admissionCalls).toBe(1);
    releaseFirst();
    await Promise.all([ordinary, planned]);

    expect(admissionCalls).toBe(2);
    expect(maximumActiveAdmissions).toBe(1);
  });

  it('preserves completed shared-memory progress when a later admission is deferred', async () => {
    const admissions: string[] = [];
    const warnings: string[] = [];
    const contextGraphIds = ['first', 'second', 'third'];
    const agent = {
      config: { syncContextGraphPriorities: {} },
      store: {},
      listSubGraphs: async () => [],
      createContextGraphSyncDeadline: () => Date.now() + 1_000,
      fetchSyncPages: async (
        _ctx: unknown,
        _peer: string,
        contextGraphId: string,
        _swm: boolean,
        phase: string,
      ) => ({
        ...page(contextGraphId, phase),
        nextOffset: 1,
      }),
      getOrCreateSyncVerifyWorker: () => ({
        processSharedMemoryBatch: async () => ({
          verifiedData: [],
          verifiedMeta: [],
          totalFetchedDataQuads: 0,
          totalFetchedMetaQuads: 0,
          droppedDataTriples: 0,
          emptyResponses: 1,
          entityCreators: [],
        }),
      }),
      runContextGraphSyncWithBackpressure: async (
        _ctx: unknown,
        contextGraphId: string,
        _lane: string,
        _label: string,
        work: () => Promise<unknown>,
      ) => {
        admissions.push(contextGraphId);
        if (contextGraphId === 'second') {
          throw new SyncBackpressureBusyError('queue full');
        }
        return work();
      },
      syncCheckpoints: new Map(),
      workspaceOwnedEntities: new Map(),
      log: {
        info: noop,
        warn: (_ctx: unknown, message: string) => warnings.push(message),
        debug: noop,
      },
      resolveRfc64CompleteSwmProviderPeerIdsV1: () => [],
      syncSharedMemoryFromPeerDetailedExecution:
        LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailedExecution,
    };

    const summary = await (
      LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailed as any
    ).call(agent, 'peer', contextGraphIds, {
      sharedMemorySyncPlan: {
        targets: contextGraphIds.map((contextGraphId) => ({
          contextGraphId,
          lane: 'selected-public',
        })),
      },
    });

    expect(admissions).toEqual(['first', 'second']);
    expect(warnings).toEqual([]);
    expect(summary.completedPhases).toBe(2);
    expect(summary.checkpointAdvances).toBe(2);
    expect(summary.deferredBackpressure).toBe(1);
    expect(summary.failedPeers).toBe(0);
    expect(summary.backoffWorthyFailures).toBe(0);
  });

  it('counts several failed Context Graphs from one remote as one failed peer', async () => {
    const contextGraphIds = ['private-a', 'private-b'];
    const agent = {
      config: { syncContextGraphPriorities: {} },
      store: {},
      listSubGraphs: async () => { throw new Error('local admission lookup failed'); },
      createContextGraphSyncDeadline: () => Date.now() + 1_000,
      runContextGraphSyncWithBackpressure: async (
        _ctx: unknown,
        _contextGraphId: string,
        _lane: string,
        _label: string,
        work: () => Promise<unknown>,
      ) => work(),
      syncCheckpoints: new Map(),
      workspaceOwnedEntities: new Map(),
      log: { info: noop, warn: noop, debug: noop },
      resolveRfc64CompleteSwmProviderPeerIdsV1: () => [],
      syncSharedMemoryFromPeerDetailedExecution:
        LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailedExecution,
    };

    const summary = await (
      LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailed as any
    ).call(agent, 'peer', contextGraphIds, {
      sharedMemorySyncPlan: {
        targets: contextGraphIds.map((contextGraphId) => ({
          contextGraphId,
          lane: 'ordinary-private',
        })),
      },
    });

    expect(summary.failedPeers).toBe(1);
    expect(summary.backoffWorthyFailures).toBe(2);
  });

  it('runs a mixed durable list in the supplied stable priority order', async () => {
    const admissions: string[] = [];
    await runOrderedContextGraphSyncs({
      work: ['high-a', 'high-b', 'default', 'low'].map((contextGraphId) => ({
        contextGraphId,
        lane: 'durable' as const,
        operationId: contextGraphId,
        run: async () => {
          await runDurableSync(durableContext([contextGraphId]));
          return 0;
        },
      })),
      emptyResult: () => 0,
      runWithAdmission: async (item, work) => {
        admissions.push(item.contextGraphId);
        return work();
      },
      merge: (summary) => summary,
      markDeferred: (summary) => summary,
    });
    expect(admissions).toEqual(['high-a', 'high-b', 'default', 'low']);
  });

  it('runs a mixed SWM list in the supplied stable priority order', async () => {
    const admissions: string[] = [];
    await runOrderedContextGraphSyncs({
      work: ['high-a', 'high-b', 'default', 'low'].map((contextGraphId) => ({
        contextGraphId,
        lane: 'shared_memory' as const,
        operationId: contextGraphId,
        run: async () => {
          await runSharedMemorySync({
            ctx,
            remotePeerId: 'peer',
            contextGraphIds: [contextGraphId],
            createContextGraphSyncDeadline: () => Date.now() + 1_000,
            fetchSyncPages: async (_ctx, _peer, id, _swm, phase) => page(id, phase),
            processSharedMemoryBatch: async () => ({
              verifiedData: [], verifiedMeta: [], totalFetchedDataQuads: 0, totalFetchedMetaQuads: 0,
              droppedDataTriples: 0, emptyResponses: 1, entityCreators: [],
            }),
            ensureContextGraph: async () => {},
            storeInsert: async () => {},
            deleteCheckpoint: noop,
            setCheckpoint: noop,
            ensureOwnedMap: () => new Map(),
            logInfo: noop,
            logWarn: noop,
            logDebug: noop,
          });
          return 0;
        },
      })),
      emptyResult: () => 0,
      runWithAdmission: async (item, work) => {
        admissions.push(item.contextGraphId);
        return work();
      },
      merge: (summary) => summary,
      markDeferred: (summary) => summary,
    });
    expect(admissions).toEqual(['high-a', 'high-b', 'default', 'low']);
  });

  it('lets a later high-priority single-CG job start before a batch low-priority tail', async () => {
    const policy = resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 4 });
    const priorities: Record<string, number> = { 'low-1': -10, 'low-2': -10, high: 100 };
    const starts: string[] = [];
    let releaseLowOne!: () => void;
    let lowOneBlocked = true;
    const runContextGraphSync = <T>(contextGraphId: string, work: () => Promise<T>) => {
      const priority = priorities[contextGraphId] ?? 0;
      return withGlobalSyncBackpressure({
        policy,
        ctx,
        label: contextGraphId,
        contextGraphId,
        priority,
        priorityClass: syncPriorityClass(priority),
      }, async () => {
        starts.push(contextGraphId);
        return work();
      });
    };
    const runBatch = (contextGraphIds: string[]) => runOrderedContextGraphSyncs({
      work: contextGraphIds.map((contextGraphId) => ({
        contextGraphId,
        lane: 'durable' as const,
        operationId: contextGraphId,
        run: async () => {
          await runDurableSync({
            ...durableContext([contextGraphId]),
            fetchSyncPages: async ({
              contextGraphId: id,
              phase,
            }: DurableSyncFetchRequest) => {
              if (id === 'low-1' && phase === 'meta' && lowOneBlocked) {
                await new Promise<void>((resolve) => { releaseLowOne = resolve; });
                lowOneBlocked = false;
              }
              return page(id, phase);
            },
          });
          return 0;
        },
      })),
      priorities,
      emptyResult: () => 0,
      runWithAdmission: (item, work) => runContextGraphSync(item.contextGraphId, work),
      merge: (summary) => summary,
      markDeferred: (summary) => summary,
    });
    const batch = runBatch(['low-1', 'low-2']);
    while (!starts.includes('low-1')) await new Promise((resolve) => setTimeout(resolve, 0));
    const high = runBatch(['high']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseLowOne();
    await Promise.all([batch, high]);
    expect(starts).toEqual(['low-1', 'high', 'low-2']);
  });
});
