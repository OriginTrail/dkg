import { describe, expect, it } from 'vitest';
import { createOperationContext, PROTOCOL_SYNC_CHANGELOG } from '@origintrail-official/dkg-core';
import {
  runDurableSync,
  type DurableSyncFetchRequest,
} from '../src/sync/requester/durable-sync.js';
import { uniformDurableSyncBudget } from './durable-sync-test-helpers.js';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';
import {
  runOrderedContextGraphSyncs,
  runOrderedContextGraphSyncsWithOutcomes,
} from '../src/sync/requester/ordered-sync.js';
import {
  resolveSyncGlobalBackpressure,
  SyncBackpressureBusyError,
  withGlobalSyncBackpressure,
} from '../src/sync/backpressure.js';
import { syncPriorityClass } from '../src/sync/policy.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';

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
  it('returns an immutable terminal outcome for every planned ordered item', async () => {
    const execution = await runOrderedContextGraphSyncsWithOutcomes({
      work: ['settled', 'deferred', 'tail'].map((contextGraphId) => ({
        contextGraphId,
        lane: 'shared_memory' as const,
        operationId: contextGraphId,
        run: async () => 1,
      })),
      emptyResult: () => 0,
      runWithAdmission: async (item, work) => {
        if (item.contextGraphId === 'deferred') {
          throw new SyncBackpressureBusyError('queue full');
        }
        return work();
      },
      merge: (summary, part) => summary + part,
      markDeferred: (summary) => summary,
    });

    expect(execution.summary).toBe(1);
    expect(execution.outcomes).toEqual([
      {
        contextGraphId: 'settled',
        lane: 'shared_memory',
        disposition: 'settled',
        result: 1,
      },
      {
        contextGraphId: 'deferred',
        lane: 'shared_memory',
        disposition: 'deferred',
      },
      {
        contextGraphId: 'tail',
        lane: 'shared_memory',
        disposition: 'skipped',
        reason: 'prior-deferral',
      },
    ]);
    expect(Object.isFrozen(execution.outcomes)).toBe(true);
    expect(execution.outcomes.every(Object.isFrozen)).toBe(true);
  });

  it('records stop-policy outcomes for every item after the terminating result', async () => {
    const executed: string[] = [];
    const execution = await runOrderedContextGraphSyncsWithOutcomes({
      work: ['first', 'stop', 'tail'].map((contextGraphId) => ({
        contextGraphId,
        lane: 'shared_memory' as const,
        operationId: contextGraphId,
        run: async () => {
          executed.push(contextGraphId);
          return contextGraphId;
        },
      })),
      emptyResult: () => [] as string[],
      runWithAdmission: async (_item, work) => work(),
      merge: (summary, part) => [...summary, part],
      markDeferred: (summary) => summary,
      shouldStop: (part) => part === 'stop',
    });

    expect(executed).toEqual(['first', 'stop']);
    expect(execution.summary).toEqual(['first', 'stop']);
    expect(execution.outcomes).toEqual([
      expect.objectContaining({ contextGraphId: 'first', disposition: 'settled' }),
      expect.objectContaining({ contextGraphId: 'stop', disposition: 'settled' }),
      {
        contextGraphId: 'tail',
        lane: 'shared_memory',
        disposition: 'skipped',
        reason: 'stop-policy',
      },
    ]);
    expect(Object.isFrozen(execution.outcomes)).toBe(true);
    expect(execution.outcomes.every(Object.isFrozen)).toBe(true);
  });

  it('records continuation-stopped outcomes for the entire remaining tail', async () => {
    let shouldContinue = true;
    const executed: string[] = [];
    const execution = await runOrderedContextGraphSyncsWithOutcomes({
      work: ['first', 'second', 'third'].map((contextGraphId) => ({
        contextGraphId,
        lane: 'shared_memory' as const,
        operationId: contextGraphId,
        run: async () => {
          executed.push(contextGraphId);
          shouldContinue = false;
          return contextGraphId;
        },
      })),
      emptyResult: () => [] as string[],
      runWithAdmission: async (_item, work) => work(),
      merge: (summary, part) => [...summary, part],
      markDeferred: (summary) => summary,
      shouldContinue: () => shouldContinue,
    });

    expect(executed).toEqual(['first']);
    expect(execution.summary).toEqual(['first']);
    expect(execution.outcomes).toEqual([
      expect.objectContaining({ contextGraphId: 'first', disposition: 'settled' }),
      {
        contextGraphId: 'second',
        lane: 'shared_memory',
        disposition: 'skipped',
        reason: 'continuation-stopped',
      },
      {
        contextGraphId: 'third',
        lane: 'shared_memory',
        disposition: 'skipped',
        reason: 'continuation-stopped',
      },
    ]);
    expect(Object.isFrozen(execution.outcomes)).toBe(true);
    expect(execution.outcomes.every(Object.isFrozen)).toBe(true);
  });

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
    const emptyResult = {
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
      emptyResponses: 0,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
      rejectedKcs: 0,
      failedPeers: 0,
      failedPhases: 0,
      deniedPhases: 0,
      backoffWorthyFailures: 0,
      deferredBackpressure: 0,
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
        if (contextGraphId === 'second') {
          throw new SyncBackpressureBusyError('queue full');
        }
        return work();
      },
      runChangelogSyncForCg: async () => ({ ...emptyResult, completedPhases: 1 }),
      log: { info: noop, warn: noop },
    };

    const lane = await (LifecycleSyncMethods.prototype.runChangelogLane as any).call(
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
    };

    const summary = await (
      LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailed as any
    ).call(agent, 'peer', contextGraphIds, {
      sharedMemorySyncPlan: {
        publicContextGraphIds: contextGraphIds,
        privateRecoverFromCurator: [],
        eligibleContextGraphIds: contextGraphIds,
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

  it('emits a stop-policy terminal for the untouched shared-memory tail', async () => {
    const admissions: string[] = [];
    const contextGraphIds = ['stop', 'tail'];
    const stopResult = {
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
      emptyResponses: 0,
      droppedDataTriples: 0,
      failedPeers: 1,
      failedPhases: 1,
      deniedPhases: 0,
      backoffWorthyFailures: 1,
      deferredBackpressure: 0,
    };
    const agent = {
      config: { syncContextGraphPriorities: {} },
      store: {},
      listSubGraphs: async () => [],
      createContextGraphSyncDeadline: () => Date.now() + 1_000,
      runContextGraphSyncWithBackpressure: async (
        _ctx: unknown,
        contextGraphId: string,
        _lane: string,
        _label: string,
        work: () => Promise<unknown>,
      ) => {
        admissions.push(contextGraphId);
        if (contextGraphId === 'stop') return stopResult;
        return work();
      },
      syncCheckpoints: new Map(),
      workspaceOwnedEntities: new Map(),
      log: { info: noop, warn: noop, debug: noop },
    };

    const result = await (
      LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailed as any
    ).call(agent, 'peer', contextGraphIds, {
      stopOnBackoffWorthyFailure: true,
      sharedMemorySyncPlan: {
        publicContextGraphIds: contextGraphIds,
        privateRecoverFromCurator: [],
        eligibleContextGraphIds: contextGraphIds,
      },
    });

    expect(admissions).toEqual(['stop']);
    expect(result.contextGraphTerminals).toEqual([
      {
        contextGraphId: 'stop',
        lane: 'shared_memory',
        disposition: 'settled',
        result: stopResult,
      },
      {
        contextGraphId: 'tail',
        lane: 'shared_memory',
        disposition: 'skipped',
        reason: 'stop-policy',
      },
    ]);
    expect(Object.isFrozen(result.contextGraphTerminals)).toBe(true);
    expect(result.contextGraphTerminals.every(Object.isFrozen)).toBe(true);
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
    };

    const summary = await (
      LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailed as any
    ).call(agent, 'peer', contextGraphIds, {
      sharedMemorySyncPlan: {
        publicContextGraphIds: [],
        privateRecoverFromCurator: contextGraphIds,
        eligibleContextGraphIds: contextGraphIds,
      },
    });

    expect(summary.failedPeers).toBe(1);
    expect(summary.backoffWorthyFailures).toBe(2);
    expect(summary.contextGraphTerminals).toHaveLength(2);
    for (const [index, terminal] of summary.contextGraphTerminals.entries()) {
      expect(terminal).toMatchObject({
        contextGraphId: contextGraphIds[index],
        lane: 'swm_recovery',
        disposition: 'settled',
        result: {
          failedPeers: 1,
          backoffWorthyFailures: 1,
        },
      });
      expect(Object.isFrozen(terminal)).toBe(true);
      expect(Object.isFrozen(terminal.result)).toBe(true);
    }
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
