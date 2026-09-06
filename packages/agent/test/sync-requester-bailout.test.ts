import { describe, expect, it } from 'vitest';
import { SYSTEM_CONTEXT_GRAPHS, type OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  runDurableSync,
  type DurableSyncCheckpointWrite,
  type DurableSyncFetchRequest,
} from '../src/sync/requester/durable-sync.js';
import { uniformDurableSyncBudget } from './durable-sync-test-helpers.js';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';
import {
  MAX_CONSECUTIVE_PEER_TRANSPORT_FAILURES,
  runOrderedContextGraphSyncs,
} from '../src/sync/requester/ordered-sync.js';
import { SyncBackpressureBusyError } from '../src/sync/backpressure.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { toSyncTransportFailureError } from '../src/sync/error-tags.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { createSwmTargetExecutorSessionFactoryForTest } from
  './_helpers/swm-target-executor-session-fixture.js';

const ctx = { kind: 'system', id: 'test', startedAt: 0 } as OperationContext;
const noop = () => {};

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

function pageResult(
  contextGraphId: string,
  phase: string,
  overrides: Partial<SyncPageResult> = {},
): SyncPageResult {
  return {
    quads: [],
    bytesReceived: 0,
    resumedFromOffset: 0,
    nextOffset: 0,
    checkpointKey: `${contextGraphId}:${phase}`,
    completed: true,
    timedOut: false,
    ...overrides,
  };
}

function transportError(message: string): Error {
  const err = new Error(message);
  return toSyncTransportFailureError(err);
}

function deniedError(): Error & { syncDenied: boolean } {
  const err = new Error('access denied') as Error & { syncDenied: boolean };
  err.syncDenied = true;
  return err;
}

function durableProcessResult() {
  return {
    verifiedData: [] as Quad[],
    verifiedMeta: [] as Quad[],
    totalFetchedDataQuads: 0,
    totalFetchedMetaQuads: 0,
    rejectedKcs: 0,
    emptyResponses: 1,
    metaOnlyResponses: 0,
    dataRejectedMissingMeta: 0,
  };
}

function sharedMemoryProcessResult() {
  return {
    verifiedData: [] as Quad[],
    verifiedMeta: [] as Quad[],
    totalFetchedDataQuads: 0,
    totalFetchedMetaQuads: 0,
    droppedDataTriples: 0,
    emptyResponses: 1,
    entityCreators: [],
  };
}

describe('sync requester bailout', () => {
  it('stops durable context-graph fanout after a backoff-worthy transport failure', async () => {
    const fetchSyncPages = recorder(async ({
      contextGraphId,
      phase,
    }: DurableSyncFetchRequest) => {
      if (contextGraphId === 'pressured-cg') {
        throw transportError('Too many active durable data sync session snapshots');
      }
      return pageResult(contextGraphId, phase);
    });

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['pressured-cg', 'next-cg'],
      stopOnBackoffWorthyFailure: true,
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages,
      processDurableBatchInWorker: async () => durableProcessResult(),
      storeInsert: async () => {},
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary.failedPeers).toBe(1);
    expect(summary.backoffWorthyFailures).toBe(1);
    expect(fetchSyncPages.calls).toEqual([
      [
        expect.objectContaining({
          ctx,
          remotePeerId: 'peer-a',
          contextGraphId: 'pressured-cg',
          phase: 'meta',
          graphUri: expect.any(String),
          fetchContext: expect.objectContaining({
            deadline: expect.any(Number),
          }),
        }),
      ],
    ]);
  });

  it('continues durable fanout after an ordinary sync denial', async () => {
    const fetchSyncPages = recorder(async ({
      contextGraphId,
      phase,
    }: DurableSyncFetchRequest) => {
      if (contextGraphId === 'denied-cg') throw deniedError();
      return pageResult(contextGraphId, phase);
    });

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['denied-cg', 'next-cg'],
      stopOnBackoffWorthyFailure: true,
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages,
      processDurableBatchInWorker: async () => durableProcessResult(),
      storeInsert: async () => {},
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary.deniedPhases).toBe(1);
    expect(summary.failedPeers).toBe(0);
    expect(summary.backoffWorthyFailures).toBe(0);
    expect(fetchSyncPages.calls).toContainEqual([
      expect.objectContaining({
        ctx,
        remotePeerId: 'peer-a',
        contextGraphId: 'next-cg',
        phase: 'data',
        graphUri: expect.any(String),
        fetchContext: expect.objectContaining({
          deadline: expect.any(Number),
        }),
      }),
    ]);
  });

  it('stops durable fanout after a sync page timeout', async () => {
    const setCheckpoint = recorder((_key: string, _checkpoint: DurableSyncCheckpointWrite) => {});
    const fetchSyncPages = recorder(async ({
      contextGraphId,
      phase,
    }: DurableSyncFetchRequest) => phase === 'data'
      ? pageResult(contextGraphId, phase, { completed: false, timedOut: true, nextOffset: 500 })
      : pageResult(contextGraphId, phase));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['slow-cg', 'next-cg'],
      stopOnBackoffWorthyFailure: true,
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages,
      processDurableBatchInWorker: async () => durableProcessResult(),
      storeInsert: async () => {},
      deleteCheckpoint: () => {},
      setCheckpoint,
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary.timedOutPhases).toBe(1);
    expect(summary.backoffWorthyFailures).toBe(0);
    expect(setCheckpoint.calls).toContainEqual([
      'slow-cg:data',
      { offset: 500, responderSessionOffset: undefined },
    ]);
    expect(fetchSyncPages.calls.some(([request]) => (
      request.contextGraphId === 'next-cg'
    ))).toBe(false);
  });

  it('uses the reserved data window after a meta phase timeout', async () => {
    const fetchSyncPages = recorder(async ({
      contextGraphId,
      phase,
    }: DurableSyncFetchRequest) => phase === 'meta'
      ? pageResult(contextGraphId, phase, { completed: false, timedOut: true })
      : pageResult(contextGraphId, phase));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: [SYSTEM_CONTEXT_GRAPHS.ONTOLOGY, 'next-cg'],
      stopOnBackoffWorthyFailure: true,
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages,
      processDurableBatchInWorker: async () => durableProcessResult(),
      storeInsert: async () => {},
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary.timedOutPhases).toBe(1);
    expect(fetchSyncPages.calls.map(([request]) => ({
      contextGraphId: request.contextGraphId,
      phase: request.phase,
    }))).toEqual([
      { contextGraphId: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY, phase: 'meta' },
      { contextGraphId: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY, phase: 'data' },
    ]);
  });

  it('stops shared-memory context-graph fanout after a backoff-worthy transport failure', async () => {
    const fetchSyncPages = recorder(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => {
      if (contextGraphId === 'pressured-swm') {
        throw transportError('sync responder queue full');
      }
      return pageResult(contextGraphId, phase);
    });

    const summary = await runSharedMemorySync({
      mode: { kind: 'ordinary' },
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['pressured-swm', 'next-swm'],
      stopOnBackoffWorthyFailure: true,
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages,
      processSharedMemoryBatch: async () => sharedMemoryProcessResult(),
      ensureContextGraph: async () => {},
      storeInsert: async () => {},
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      ensureOwnedMap: () => new Map(),
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary.failedPeers).toBe(1);
    expect(summary.backoffWorthyFailures).toBe(1);
    expect(fetchSyncPages.calls).toEqual([
      [ctx, 'peer-a', 'pressured-swm', true, 'meta', expect.any(String), expect.any(Number)],
    ]);
  });
});

describe('ordered fanout failure isolation', () => {
  type RoundRecord = { contextGraphId: string; transport: boolean };
  type Summary = { rounds: RoundRecord[]; deferred: number };
  const emptySummary = (): Summary => ({ rounds: [], deferred: 0 });
  const mergeSummaries = (a: Summary, b: Summary): Summary => ({
    rounds: [...a.rounds, ...b.rounds],
    deferred: a.deferred + b.deferred,
  });

  function runBatch(
    contextGraphIds: string[],
    transportFailing: (contextGraphId: string) => boolean,
    options: {
      admissionError?: (contextGraphId: string) => Error | undefined;
      priorities?: Record<string, number>;
    } = {},
  ) {
    return runOrderedContextGraphSyncs<Summary>({
      work: contextGraphIds.map((contextGraphId) => ({
        contextGraphId,
        lane: 'durable' as const,
        operationId: contextGraphId,
        run: async () => ({
          rounds: [{ contextGraphId, transport: transportFailing(contextGraphId) }],
          deferred: 0,
        }),
      })),
      priorities: options.priorities,
      emptyResult: emptySummary,
      runWithAdmission: async (item, work) => {
        const error = options.admissionError?.(item.contextGraphId);
        if (error) throw error;
        return work();
      },
      merge: mergeSummaries,
      markDeferred: (summary) => ({ ...summary, deferred: summary.deferred + 1 }),
      isPeerTransportFailure: (part) => part.rounds.some((round) => round.transport),
    });
  }

  it('continues past a failed Context Graph and keeps its failure in the merged summary', async () => {
    const summary = await runBatch(
      ['a', 'poison', 'c', 'd'],
      (contextGraphId) => contextGraphId === 'poison',
      { priorities: { poison: 100 } },
    );

    expect(summary.rounds.map((round) => round.contextGraphId)).toEqual(['poison', 'a', 'c', 'd']);
    expect(summary.rounds.filter((round) => round.transport)).toEqual([
      { contextGraphId: 'poison', transport: true },
    ]);
  });

  it('stops the batch after consecutive peer transport failures', async () => {
    const summary = await runBatch(
      ['a', 'b', 'c', 'd', 'e'],
      () => true,
    );

    expect(summary.rounds).toHaveLength(MAX_CONSECUTIVE_PEER_TRANSPORT_FAILURES);
    expect(summary.rounds.map((round) => round.contextGraphId)).toEqual(['a', 'b', 'c']);
  });

  it('resets the transport-failure streak whenever the peer answers a round', async () => {
    const summary = await runBatch(
      ['a', 'b', 'ok-1', 'c', 'd', 'ok-2'],
      (contextGraphId) => !contextGraphId.startsWith('ok'),
    );

    expect(summary.rounds).toHaveLength(6);
  });

  it('still stops the whole batch on a backpressure deferral', async () => {
    const summary = await runBatch(
      ['a', 'b', 'c'],
      () => false,
      {
        admissionError: (contextGraphId) => (
          contextGraphId === 'b' ? new SyncBackpressureBusyError('queue full') : undefined
        ),
      },
    );

    expect(summary.rounds.map((round) => round.contextGraphId)).toEqual(['a']);
    expect(summary.deferred).toBe(1);
  });
});

describe('lifecycle durable fanout isolation', () => {
  function fanoutAgent(
    admissions: string[],
    failFor: (contextGraphId: string) => Error | undefined,
    priorities: Record<string, number> = {},
  ) {
    return {
      config: { syncContextGraphPriorities: priorities },
      fetchSyncPages: async (
        _ctx: unknown,
        _peer: string,
        contextGraphId: string,
        _swm: boolean,
        phase: 'data' | 'meta',
      ) => {
        const error = failFor(contextGraphId);
        if (error) throw error;
        return {
          ...pageResult(contextGraphId, phase),
          quads: phase === 'data'
            ? [{
                subject: `urn:${contextGraphId}`,
                predicate: 'urn:predicate',
                object: 'urn:object',
                graph: 'urn:graph',
              }]
            : [],
        };
      },
      processDurableBatchInWorker: async (dataQuads: Quad[], metaQuads: Quad[]) => ({
        verifiedData: dataQuads,
        verifiedMeta: metaQuads,
        consumedUnpersistedMetaTriples: 0,
        totalFetchedDataQuads: dataQuads.length,
        totalFetchedMetaQuads: metaQuads.length,
        rejectedKcs: 0,
        emptyResponses: 0,
        metaOnlyResponses: 0,
        verifiedPrivateOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
      }),
      insertSyncedQuadsAndInvalidateListCache: async () => {},
      syncCheckpoints: new Map(),
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
      log: { info: noop, warn: noop, debug: noop },
    };
  }

  it('keeps syncing later Context Graphs after a poison CG dies mid-stream', async () => {
    const admissions: string[] = [];
    const agent = fanoutAgent(
      admissions,
      // Untagged relay-stream death: without the transport tag there is no
      // proof the peer never answered, so this must NOT read as peer-dead.
      (contextGraphId) => (contextGraphId === 'poison' ? new Error('pooled stream reset') : undefined),
      { poison: 100 },
    );

    const summary = await (LifecycleSyncMethods.prototype.runLegacyDurableSync as any).call(
      agent,
      ctx,
      'peer-a',
      ['second', 'poison', 'third'],
      undefined,
      undefined,
      undefined,
      { stopOnBackoffWorthyFailure: true },
    );

    expect(admissions).toEqual(['poison', 'second', 'third']);
    expect(summary.insertedTriples).toBe(2);
    expect(summary.insertedDataTriples).toBe(2);
    expect(summary.backoffWorthyFailures).toBe(1);
    expect(summary.failedPhases).toBe(1);
    expect(summary.failedPeers).toBe(0);
    expect(summary.complete).toBe(false);
  });

  it('stops dialing a peer that never responds after consecutive transport failures', async () => {
    const admissions: string[] = [];
    const agent = fanoutAgent(admissions, () => transportError('all multiaddr dials failed'));

    const summary = await (LifecycleSyncMethods.prototype.runLegacyDurableSync as any).call(
      agent,
      ctx,
      'peer-a',
      ['cg-1', 'cg-2', 'cg-3', 'cg-4', 'cg-5'],
      undefined,
      undefined,
      undefined,
      { stopOnBackoffWorthyFailure: true },
    );

    expect(admissions).toEqual(['cg-1', 'cg-2', 'cg-3']);
    expect(summary.failedPeers).toBe(1);
    expect(summary.backoffWorthyFailures).toBe(MAX_CONSECUTIVE_PEER_TRANSPORT_FAILURES);
    expect(summary.insertedTriples).toBe(0);
    expect(summary.complete).toBe(false);
  });

  it('leaves the batch unguarded when the caller did not opt into early stopping', async () => {
    const admissions: string[] = [];
    const agent = fanoutAgent(admissions, () => transportError('all multiaddr dials failed'));

    await (LifecycleSyncMethods.prototype.runLegacyDurableSync as any).call(
      agent,
      ctx,
      'peer-a',
      ['cg-1', 'cg-2', 'cg-3', 'cg-4', 'cg-5'],
    );

    expect(admissions).toEqual(['cg-1', 'cg-2', 'cg-3', 'cg-4', 'cg-5']);
  });
});

describe('lifecycle shared-memory fanout isolation', () => {
  function swmAgent(
    admissions: string[],
    failFor: (contextGraphId: string) => Error | undefined,
  ) {
    let createTargetExecutorSession:
      | ReturnType<typeof createSwmTargetExecutorSessionFactoryForTest>
      | undefined;
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
      ) => {
        const error = failFor(contextGraphId);
        if (error) throw error;
        return {
          ...pageResult(contextGraphId, phase),
          nextOffset: 1,
        };
      },
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
        return work();
      },
      syncCheckpoints: new Map(),
      workspaceOwnedEntities: new Map(),
      log: { info: noop, warn: noop, debug: noop },
      // This fixture exercises ordinary public SWM fanout, not an RFC-64
      // selected scope.
      resolveRfc64CompleteSwmProviderPeerIdsV1: () => [],
      resolveRfc64CatalogReceiverAuthorityV1: () => ({ legacySyncAllowed: true }),
      createSwmTargetExecutorSessionV1: () => {
        createTargetExecutorSession ??=
          createSwmTargetExecutorSessionFactoryForTest(agent as never);
        return createTargetExecutorSession();
      },
      syncSharedMemoryFromPeerDetailedExecution:
        LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailedExecution,
    };
    return agent;
  }

  function swmPlan(contextGraphIds: string[]) {
    return {
      targets: contextGraphIds.map((contextGraphId) => ({
        contextGraphId,
        lane: 'selected-public' as const,
      })),
    };
  }

  it('keeps syncing later Context Graphs after a poison SWM round the peer answered', async () => {
    const admissions: string[] = [];
    const contextGraphIds = ['poison', 'second', 'third'];
    const agent = swmAgent(
      admissions,
      (contextGraphId) => (contextGraphId === 'poison' ? new Error('pooled stream reset') : undefined),
    );

    const summary = await (
      LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailed as any
    ).call(agent, 'peer-a', contextGraphIds, {
      stopOnBackoffWorthyFailure: true,
      sharedMemorySyncPlan: swmPlan(contextGraphIds),
    });

    expect(admissions).toEqual(contextGraphIds);
    expect(summary.backoffWorthyFailures).toBe(1);
    expect(summary.failedPhases).toBe(1);
    expect(summary.failedPeers).toBe(0);
    // Both clean CGs completed both their phases (meta + data).
    expect(summary.completedPhases).toBe(4);
    expect(summary.checkpointAdvances).toBe(4);
  });

  it('stops the SWM fanout after consecutive unanswered transport failures', async () => {
    const admissions: string[] = [];
    const contextGraphIds = ['cg-1', 'cg-2', 'cg-3', 'cg-4'];
    const agent = swmAgent(admissions, () => transportError('connection reset'));

    const summary = await (
      LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailed as any
    ).call(agent, 'peer-a', contextGraphIds, {
      stopOnBackoffWorthyFailure: true,
      sharedMemorySyncPlan: swmPlan(contextGraphIds),
    });

    expect(admissions).toEqual(['cg-1', 'cg-2', 'cg-3']);
    expect(summary.failedPeers).toBe(1);
    expect(summary.backoffWorthyFailures).toBe(MAX_CONSECUTIVE_PEER_TRANSPORT_FAILURES);
  });
});
