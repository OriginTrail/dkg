import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { runDurableSync } from '../src/sync/requester/durable-sync.js';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { markSyncTransportFailure } from '../src/sync/error-tags.js';

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
  markSyncTransportFailure(err);
  return err;
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
    const fetchSyncPages = recorder(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => {
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
      createPhaseDeadline: () => Date.now() + 60_000,
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
      [ctx, 'peer-a', 'pressured-cg', false, 'meta', expect.any(String), expect.any(Number)],
    ]);
  });

  it('continues durable fanout after an ordinary sync denial', async () => {
    const fetchSyncPages = recorder(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => {
      if (contextGraphId === 'denied-cg') throw deniedError();
      return pageResult(contextGraphId, phase);
    });

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['denied-cg', 'next-cg'],
      stopOnBackoffWorthyFailure: true,
      createPhaseDeadline: () => Date.now() + 60_000,
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
      ctx,
      'peer-a',
      'next-cg',
      false,
      'data',
      expect.any(String),
      expect.any(Number),
      undefined,
      undefined,
    ]);
  });

  it('stops durable fanout after a sync page timeout', async () => {
    const setCheckpoint = recorder((_key: string, _offset: number) => {});
    const fetchSyncPages = recorder(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => phase === 'data'
      ? pageResult(contextGraphId, phase, { completed: false, timedOut: true, nextOffset: 500 })
      : pageResult(contextGraphId, phase));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['slow-cg', 'next-cg'],
      stopOnBackoffWorthyFailure: true,
      createPhaseDeadline: () => Date.now() + 60_000,
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
    expect(setCheckpoint.calls).toContainEqual(['slow-cg:data', 500]);
    expect(fetchSyncPages.calls.some((call) => call[2] === 'next-cg')).toBe(false);
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
