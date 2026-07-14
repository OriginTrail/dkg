import { describe, expect, it } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { runDurableSync } from '../src/sync/requester/durable-sync.js';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';
import {
  resolveSyncGlobalBackpressure,
  withGlobalSyncBackpressure,
} from '../src/sync/backpressure.js';
import { syncPriorityClass } from '../src/sync/policy.js';

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
    createContextGraphSyncDeadline: () => Date.now() + 1_000,
    fetchSyncPages: async (
      _ctx: unknown,
      _peer: string,
      contextGraphId: string,
      _swm: boolean,
      phase: 'data' | 'meta',
    ) => page(contextGraphId, phase),
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

describe('requester per-CG priority admission', () => {
  it('runs a mixed durable list in the supplied stable priority order', async () => {
    const admissions: string[] = [];
    await runDurableSync({
      ...durableContext(['high-a', 'high-b', 'default', 'low']),
      runContextGraphSync: async (contextGraphId, _remaining, work) => {
        admissions.push(contextGraphId);
        return work();
      },
    });
    expect(admissions).toEqual(['high-a', 'high-b', 'default', 'low']);
  });

  it('runs a mixed SWM list in the supplied stable priority order', async () => {
    const admissions: string[] = [];
    await runSharedMemorySync({
      ctx,
      remotePeerId: 'peer',
      contextGraphIds: ['high-a', 'high-b', 'default', 'low'],
      createContextGraphSyncDeadline: () => Date.now() + 1_000,
      fetchSyncPages: async (_ctx, _peer, contextGraphId, _swm, phase) => page(contextGraphId, phase),
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
      runContextGraphSync: async (contextGraphId, _remaining, work) => {
        admissions.push(contextGraphId);
        return work();
      },
    });
    expect(admissions).toEqual(['high-a', 'high-b', 'default', 'low']);
  });

  it('lets a later high-priority single-CG job start before a batch low-priority tail', async () => {
    const policy = resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 4 });
    const priorities: Record<string, number> = { 'low-1': -10, 'low-2': -10, high: 100 };
    const starts: string[] = [];
    let releaseLowOne!: () => void;
    let lowOneBlocked = true;
    const runContextGraphSync = <T>(contextGraphId: string, _remaining: number, work: () => Promise<T>) => {
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
    const batch = runDurableSync({
      ...durableContext(['low-1', 'low-2']),
      fetchSyncPages: async (_ctx, _peer, contextGraphId, _swm, phase) => {
        if (contextGraphId === 'low-1' && phase === 'meta' && lowOneBlocked) {
          await new Promise<void>((resolve) => { releaseLowOne = resolve; });
          lowOneBlocked = false;
        }
        return page(contextGraphId, phase);
      },
      runContextGraphSync,
    });
    while (!starts.includes('low-1')) await new Promise((resolve) => setTimeout(resolve, 0));
    const high = runDurableSync({
      ...durableContext(['high']),
      runContextGraphSync,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseLowOne();
    await Promise.all([batch, high]);
    expect(starts).toEqual(['low-1', 'high', 'low-2']);
  });
});
