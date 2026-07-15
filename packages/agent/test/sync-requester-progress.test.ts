import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { runDurableSync } from '../src/sync/requester/durable-sync.js';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { markSyncTransportFailure } from '../src/sync/error-tags.js';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

const ctx = { kind: 'system', id: 'test', startedAt: 0 } as OperationContext;
const noop = () => {};

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

function deniedError(): Error & { syncDenied: boolean } {
  const err = new Error('access denied') as Error & { syncDenied: boolean };
  err.syncDenied = true;
  return err;
}

function transportError(message: string): Error {
  const err = new Error(message);
  markSyncTransportFailure(err);
  return err;
}

function quad(subject: string): Quad {
  return {
    subject,
    predicate: 'http://example.com/p',
    object: 'http://example.com/o',
    graph: 'http://example.com/g',
  } as Quad;
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
    verifiedPrivateOnlyResponses: 0,
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

describe('sync requester progress accounting', () => {
  it('does not count a denied durable graph but counts the subsequent clean-empty graph', async () => {
    const deniedCgs: string[] = [];
    const fetchSyncPages = recorder(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => {
      if (contextGraphId === 'pending-join') throw deniedError();
      return pageResult(contextGraphId, phase);
    });

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['pending-join', 'open-cg'],
      onAccessDenied: (cg) => deniedCgs.push(cg),
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages,
      processDurableBatchInWorker: async () => durableProcessResult(),
      storeInsert: async () => {},
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(deniedCgs).toEqual(['pending-join']);
    expect(summary.deniedPhases).toBe(1);
    expect(summary.failedPeers).toBe(0);
    expect(summary.completedPhases).toBe(2);
    expect(fetchSyncPages.calls).toContainEqual([ctx, 'peer-a', 'open-cg', false, 'meta', expect.any(String), expect.any(Number)]);
  });

  it('does not count a transport-failed durable graph but counts the subsequent clean-empty graph', async () => {
    const fetchSyncPages = recorder(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => {
      if (contextGraphId === 'shed-cg') throw transportError('sync responder busy');
      return pageResult(contextGraphId, phase);
    });

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['shed-cg', 'next-cg'],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
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
    expect(summary.failedPhases).toBe(0);
    expect(summary.deniedPhases).toBe(0);
    expect(summary.completedPhases).toBe(2);
    expect(fetchSyncPages.calls).toContainEqual([ctx, 'peer-a', 'next-cg', false, 'data', expect.any(String), expect.any(Number), undefined, undefined]);
  });

  it('counts multiple durable context-graph failures as one failed peer', async () => {
    const fetchSyncPages = recorder(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => {
      if (contextGraphId.startsWith('fail-')) throw transportError(`sync responder busy for ${contextGraphId}`);
      return pageResult(contextGraphId, phase);
    });

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['fail-one', 'fail-two', 'next-cg'],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
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
    expect(summary.failedPhases).toBe(0);
    expect(summary.deniedPhases).toBe(0);
    expect(summary.completedPhases).toBe(2);
    expect(fetchSyncPages.calls).toContainEqual([ctx, 'peer-a', 'next-cg', false, 'data', expect.any(String), expect.any(Number), undefined, undefined]);
  });

  it('does not count a verification-failed durable graph but counts the subsequent clean-empty graph', async () => {
    const phases: string[] = [];
    const fetchSyncPages = recorder(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => pageResult(contextGraphId, phase, {
      quads: phase === 'data' && contextGraphId === 'verify-fails'
        ? [quad(contextGraphId)]
        : [],
    }));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['verify-fails', 'next-cg'],
      onPhase: (phase, status) => phases.push(`${phase}:${status}`),
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages,
      processDurableBatchInWorker: async (dataQuads) => {
        if (dataQuads.some((q) => q.subject === 'verify-fails')) {
          throw new Error('verification failed');
        }
        return durableProcessResult();
      },
      storeInsert: async () => {},
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary.failedPeers).toBe(0);
    expect(summary.failedPhases).toBe(1);
    expect(summary.deniedPhases).toBe(0);
    expect(summary.completedPhases).toBe(2);
    expect(fetchSyncPages.calls).toContainEqual([ctx, 'peer-a', 'next-cg', false, 'data', expect.any(String), expect.any(Number), undefined, undefined]);
    expect(phases.slice(0, 4)).toEqual(['fetch:start', 'fetch:end', 'verify:start', 'verify:end']);
  });

  it('does not count a store-failed durable graph but counts the subsequent clean-empty graph', async () => {
    const fetchSyncPages = recorder(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => pageResult(contextGraphId, phase, {
      quads: phase === 'data' && contextGraphId === 'store-fails'
        ? [quad(contextGraphId)]
        : [],
    }));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['store-fails', 'next-cg'],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages,
      processDurableBatchInWorker: async (dataQuads) => ({
        ...durableProcessResult(),
        emptyResponses: dataQuads.length === 0 ? 1 : 0,
        verifiedData: dataQuads,
        totalFetchedDataQuads: dataQuads.length,
      }),
      storeInsert: async (quads) => {
        if (quads.some((q) => q.subject === 'store-fails')) {
          throw new Error('store unavailable');
        }
      },
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary.failedPeers).toBe(0);
    expect(summary.failedPhases).toBe(1);
    expect(summary.insertedDataTriples).toBe(0);
    expect(summary.completedPhases).toBe(2);
    expect(fetchSyncPages.calls).toContainEqual([ctx, 'peer-a', 'next-cg', false, 'data', expect.any(String), expect.any(Number), undefined, undefined]);
  });

  it('counts both clean zero-offset empty durable phases as complete', async () => {
    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['empty-cg'],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages: async (
        _ctx: OperationContext,
        _peer: string,
        contextGraphId: string,
        _includeSharedMemory: boolean,
        phase: 'data' | 'meta',
      ) => pageResult(contextGraphId, phase),
      processDurableBatchInWorker: async () => durableProcessResult(),
      storeInsert: async () => {},
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary.completedPhases).toBe(2);
    expect(summary.checkpointAdvances).toBe(0);
  });

  it('counts resumed durable completion as progress without advancing the checkpoint', async () => {
    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['resumed-cg'],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages: async (
        _ctx: OperationContext,
        _peer: string,
        contextGraphId: string,
        _includeSharedMemory: boolean,
        phase: 'data' | 'meta',
      ) => pageResult(contextGraphId, phase, { resumedFromOffset: 500, nextOffset: 500 }),
      processDurableBatchInWorker: async () => durableProcessResult(),
      storeInsert: async () => {},
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary.resumedPhases).toBe(2);
    expect(summary.completedPhases).toBe(2);
    expect(summary.checkpointAdvances).toBe(0);
  });

  it('counts only the clean-empty durable phase when its sibling times out', async () => {
    const setCheckpoint = recorder((_key: string, _offset: number) => {});
    const deleteCheckpoint = recorder((_key: string) => {});
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
      contextGraphIds: ['large-cg'],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages,
      processDurableBatchInWorker: async () => durableProcessResult(),
      storeInsert: async () => {},
      deleteCheckpoint,
      setCheckpoint,
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary.timedOutPhases).toBe(1);
    expect(summary.completedPhases).toBe(1);
    expect(summary.checkpointAdvances).toBe(1);
    expect(deleteCheckpoint.calls).toContainEqual(['large-cg:meta']);
    expect(setCheckpoint.calls).toContainEqual(['large-cg:data', 500]);
  });

  it('does not report durable checkpoint progress when data is rejected for missing meta', async () => {
    const setCheckpoint = recorder((_key: string, _offset: number) => {});
    const deleteCheckpoint = recorder((_key: string) => {});
    const fetchSyncPages = recorder(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => pageResult(contextGraphId, phase, { nextOffset: phase === 'data' ? 500 : 5 }));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['missing-meta-cg'],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages,
      processDurableBatchInWorker: async () => ({
        ...durableProcessResult(),
        emptyResponses: 0,
        dataRejectedMissingMeta: 1,
      }),
      storeInsert: async () => {},
      deleteCheckpoint,
      setCheckpoint,
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary.dataRejectedMissingMeta).toBe(1);
    expect(summary.completedPhases).toBe(0);
    expect(summary.checkpointAdvances).toBe(0);
    expect(deleteCheckpoint.calls).toEqual([]);
    expect(setCheckpoint.calls).toEqual([]);
  });

  it('does not advance durable checkpoints when integrity verification rejects a KA', async () => {
    const storeInsert = recorder(async (_quads: Quad[]) => {});
    const setCheckpoint = recorder((_key: string, _offset: number) => {});
    const deleteCheckpoint = recorder((_key: string) => {});
    const logWarn = recorder((_ctx: OperationContext, _message: string) => {});
    const fetchSyncPages = recorder(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => pageResult(contextGraphId, phase, {
      nextOffset: phase === 'data' ? 500 : 5,
    }));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['rejected-integrity-cg'],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages,
      processDurableBatchInWorker: async () => ({
        ...durableProcessResult(),
        emptyResponses: 0,
        rejectedKcs: 1,
        totalFetchedDataQuads: 500,
        totalFetchedMetaQuads: 5,
      }),
      storeInsert,
      deleteCheckpoint,
      setCheckpoint,
      logInfo: noop,
      logWarn,
      logDebug: noop,
    });

    expect(summary.rejectedKcs).toBe(1);
    expect(summary.completedPhases).toBe(0);
    expect(summary.checkpointAdvances).toBe(0);
    expect(storeInsert.calls).toEqual([]);
    expect(deleteCheckpoint.calls).toEqual([]);
    expect(setCheckpoint.calls).toEqual([]);
    expect(logWarn.calls).toContainEqual([
      ctx,
      expect.stringContaining('failed durable integrity verification'),
    ]);
  });

  it('advances only the durable meta checkpoint after storing metadata-only responses', async () => {
    const metaQuad = quad('meta-only-meta');
    const storeInsert = recorder(async (_quads: Quad[]) => {});
    const setCheckpoint = recorder((_key: string, _offset: number) => {});
    const deleteCheckpoint = recorder((_key: string) => {});
    const fetchSyncPages = recorder(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => phase === 'meta'
      ? pageResult(contextGraphId, phase, { nextOffset: 5, completed: false, timedOut: true })
      : pageResult(contextGraphId, phase));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['meta-only-cg'],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages,
      processDurableBatchInWorker: async () => ({
        ...durableProcessResult(),
        emptyResponses: 0,
        metaOnlyResponses: 1,
        verifiedMeta: [metaQuad],
        totalFetchedMetaQuads: 1,
      }),
      storeInsert,
      deleteCheckpoint,
      setCheckpoint,
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary.metaOnlyResponses).toBe(1);
    expect(summary.insertedMetaTriples).toBe(1);
    expect(summary.completedPhases).toBe(0);
    expect(summary.checkpointAdvances).toBe(0);
    expect(storeInsert.calls).toContainEqual([[metaQuad]]);
    expect(deleteCheckpoint.calls).toEqual([]);
    expect(setCheckpoint.calls).toHaveLength(1);
    expect(setCheckpoint.calls).toContainEqual(['meta-only-cg:meta', 5]);
  });

  it('deletes only the durable meta checkpoint after completing metadata-only responses', async () => {
    const metaQuad = quad('meta-only-complete-meta');
    const storeInsert = recorder(async (_quads: Quad[]) => {});
    const setCheckpoint = recorder((_key: string, _offset: number) => {});
    const deleteCheckpoint = recorder((_key: string) => {});
    const fetchSyncPages = recorder(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => pageResult(contextGraphId, phase, { nextOffset: phase === 'meta' ? 5 : 0 }));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['meta-only-complete'],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages,
      processDurableBatchInWorker: async () => ({
        ...durableProcessResult(),
        emptyResponses: 0,
        metaOnlyResponses: 1,
        verifiedMeta: [metaQuad],
        totalFetchedMetaQuads: 1,
      }),
      storeInsert,
      deleteCheckpoint,
      setCheckpoint,
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary.metaOnlyResponses).toBe(1);
    expect(summary.insertedMetaTriples).toBe(1);
    expect(summary.completedPhases).toBe(0);
    expect(summary.checkpointAdvances).toBe(0);
    expect(storeInsert.calls).toContainEqual([[metaQuad]]);
    expect(deleteCheckpoint.calls).toHaveLength(1);
    expect(deleteCheckpoint.calls).toContainEqual(['meta-only-complete:meta']);
    expect(setCheckpoint.calls).toEqual([]);
  });

  it('stores verified private-only metadata and advances both durable checkpoints cleanly', async () => {
    const metaQuad = quad('verified-private-only-meta');
    const storeInsert = recorder(async (_quads: Quad[]) => {});
    const setCheckpoint = recorder((_key: string, _offset: number) => {});
    const deleteCheckpoint = recorder((_key: string) => {});
    const fetchSyncPages = recorder(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => pageResult(contextGraphId, phase, {
      quads: phase === 'meta' ? [metaQuad] : [],
      nextOffset: phase === 'meta' ? 1 : 0,
    }));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['verified-private-only-cg'],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages,
      processDurableBatchInWorker: async () => ({
        ...durableProcessResult(),
        emptyResponses: 0,
        verifiedPrivateOnlyResponses: 1,
        verifiedMeta: [metaQuad],
        totalFetchedMetaQuads: 1,
      }),
      storeInsert,
      deleteCheckpoint,
      setCheckpoint,
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary).toMatchObject({
      insertedTriples: 1,
      insertedMetaTriples: 1,
      insertedDataTriples: 0,
      metaOnlyResponses: 0,
      verifiedPrivateOnlyResponses: 1,
      completedPhases: 1,
      checkpointAdvances: 1,
      rejectedKcs: 0,
      dataRejectedMissingMeta: 0,
    });
    expect(storeInsert.calls).toEqual([[[metaQuad]]]);
    expect(deleteCheckpoint.calls).toEqual([
      ['verified-private-only-cg:meta'],
      ['verified-private-only-cg:data'],
    ]);
    expect(setCheckpoint.calls).toEqual([]);
  });

  it('does not count a denied shared-memory graph but counts the subsequent clean-empty graph', async () => {
    const fetchSyncPages = recorder(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => {
      if (contextGraphId === 'denied-swm') throw deniedError();
      return pageResult(contextGraphId, phase);
    });

    const summary = await runSharedMemorySync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['denied-swm', 'open-swm'],
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

    expect(summary.deniedPhases).toBe(1);
    expect(summary.failedPeers).toBe(0);
    expect(summary.completedPhases).toBe(2);
    expect(fetchSyncPages.calls).toContainEqual([ctx, 'peer-a', 'open-swm', true, 'data', expect.any(String), expect.any(Number)]);
  });

  it('counts multiple shared-memory context-graph failures as one failed peer', async () => {
    const fetchSyncPages = recorder(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => {
      if (contextGraphId.startsWith('fail-')) throw transportError(`sync responder busy for ${contextGraphId}`);
      return pageResult(contextGraphId, phase);
    });

    const summary = await runSharedMemorySync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['fail-one', 'fail-two', 'open-swm'],
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
    expect(summary.failedPhases).toBe(0);
    expect(summary.deniedPhases).toBe(0);
    expect(summary.completedPhases).toBe(2);
    expect(fetchSyncPages.calls).toContainEqual([ctx, 'peer-a', 'open-swm', true, 'data', expect.any(String), expect.any(Number)]);
  });

  it('continues shared-memory sync after a post-response verifier failure without marking the peer unreachable', async () => {
    const fetchSyncPages = recorder(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => pageResult(contextGraphId, phase, {
      quads: phase === 'data' ? [quad(contextGraphId)] : [],
    }));

    const summary = await runSharedMemorySync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['verify-fails-swm', 'open-swm'],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages,
      processSharedMemoryBatch: async (dataQuads) => {
        if (dataQuads.some((q) => q.subject === 'verify-fails-swm')) {
          throw new Error('SWM verification failed');
        }
        return sharedMemoryProcessResult();
      },
      ensureContextGraph: async () => {},
      storeInsert: async () => {},
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      ensureOwnedMap: () => new Map(),
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary.failedPeers).toBe(0);
    expect(summary.failedPhases).toBe(1);
    expect(summary.completedPhases).toBe(2);
    expect(fetchSyncPages.calls).toContainEqual([ctx, 'peer-a', 'open-swm', true, 'data', expect.any(String), expect.any(Number)]);
  });

  it('counts shared-memory snapshot validation failures as phase failures after the peer responded', async () => {
    const snapshotMeta: Quad[] = [
      {
        subject: 'did:dkg:assertion:with-bad-snapshot',
        predicate: 'http://dkg.io/ontology/publicSnapshotRef',
        object: '"bad-ref"',
        graph: 'did:dkg:context-graph:bad-snapshot-swm/_shared_memory_meta',
      } as Quad,
      {
        subject: 'did:dkg:assertion:with-bad-snapshot',
        predicate: 'http://dkg.io/ontology/publicQuadsDigest',
        object: '"expected-digest"',
        graph: 'did:dkg:context-graph:bad-snapshot-swm/_shared_memory_meta',
      } as Quad,
      {
        subject: 'did:dkg:assertion:with-bad-snapshot',
        predicate: 'http://dkg.io/ontology/publicQuadsCount',
        object: '"1"',
        graph: 'did:dkg:context-graph:bad-snapshot-swm/_shared_memory_meta',
      } as Quad,
    ];
    const fetchSyncPages = recorder(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta' | 'snapshot',
    ) => pageResult(contextGraphId, phase, {
      checkpointKey: phase === 'snapshot' ? `${contextGraphId}:snapshot:bad-ref` : `${contextGraphId}:${phase}`,
      quads: phase === 'snapshot'
        ? [quad('wrong-snapshot-data')]
        : (phase === 'meta' && contextGraphId === 'bad-snapshot-swm' ? snapshotMeta : []),
    }));

    const summary = await runSharedMemorySync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['bad-snapshot-swm', 'open-swm'],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages,
      processSharedMemoryBatch: async (_dataQuads, metaQuads) => ({
        ...sharedMemoryProcessResult(),
        emptyResponses: metaQuads.length === 0 ? 1 : 0,
        verifiedMeta: metaQuads,
        totalFetchedMetaQuads: metaQuads.length,
      }),
      ensureContextGraph: async () => {},
      storeInsert: async () => {},
      publicSnapshotStore: {
        getSnapshot: async () => null,
        putSnapshot: async () => ({ ref: 'bad-ref', byteLength: 0 }),
      },
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      ensureOwnedMap: () => new Map(),
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary.failedPeers).toBe(0);
    expect(summary.failedPhases).toBe(1);
    expect(summary.completedPhases).toBe(2);
    expect(fetchSyncPages.calls).toContainEqual([ctx, 'peer-a', 'open-swm', true, 'data', expect.any(String), expect.any(Number)]);
  });

  it('counts both clean zero-offset empty shared-memory phases as complete', async () => {
    const summary = await runSharedMemorySync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['empty-swm'],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages: async (
        _ctx: OperationContext,
        _peer: string,
        contextGraphId: string,
        _includeSharedMemory: boolean,
        phase: 'data' | 'meta',
      ) => pageResult(contextGraphId, phase),
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

    expect(summary.completedPhases).toBe(2);
    expect(summary.checkpointAdvances).toBe(0);
  });

  it('counts only the clean-empty shared-memory phase when its sibling times out', async () => {
    const summary = await runSharedMemorySync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['partial-empty-swm'],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages: async (
        _ctx: OperationContext,
        _peer: string,
        contextGraphId: string,
        _includeSharedMemory: boolean,
        phase: 'data' | 'meta',
      ) => phase === 'data'
        ? pageResult(contextGraphId, phase, {
            completed: false,
            timedOut: true,
            nextOffset: 500,
          })
        : pageResult(contextGraphId, phase),
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

    expect(summary.timedOutPhases).toBe(1);
    expect(summary.completedPhases).toBe(1);
    expect(summary.checkpointAdvances).toBe(1);
  });

  it('restarts incomplete shared-memory snapshots because their unverified prefix is not persisted', async () => {
    const setCheckpoint = recorder((_key: string, _offset: number) => {});
    const deleteCheckpoint = recorder((_key: string) => {});
    const storeInsert = recorder(async (_quads: Quad[]) => {});
    const ensureContextGraph = recorder(async (_contextGraphId: string) => {});
    const snapshotMeta: Quad[] = [
      {
        subject: 'did:dkg:assertion:with-snapshot',
        predicate: 'http://dkg.io/ontology/publicSnapshotRef',
        object: '"snapshot-ref"',
        graph: 'did:dkg:context-graph:large-swm/_shared_memory_meta',
      } as Quad,
      {
        subject: 'did:dkg:assertion:with-snapshot',
        predicate: 'http://dkg.io/ontology/publicQuadsDigest',
        object: '"snapshot-digest"',
        graph: 'did:dkg:context-graph:large-swm/_shared_memory_meta',
      } as Quad,
      {
        subject: 'did:dkg:assertion:with-snapshot',
        predicate: 'http://dkg.io/ontology/publicQuadsCount',
        object: '"10"',
        graph: 'did:dkg:context-graph:large-swm/_shared_memory_meta',
      } as Quad,
    ];
    const fetchSyncPages = recorder(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta' | 'snapshot',
    ) => phase === 'snapshot'
      ? pageResult(contextGraphId, phase, {
        checkpointKey: `${contextGraphId}:snapshot:snapshot-ref`,
        completed: false,
        timedOut: true,
        nextOffset: 500,
      })
      : pageResult(contextGraphId, phase));

    const summary = await runSharedMemorySync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['large-swm'],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages,
      processSharedMemoryBatch: async () => ({
        ...sharedMemoryProcessResult(),
        emptyResponses: 0,
        verifiedMeta: snapshotMeta,
        totalFetchedMetaQuads: snapshotMeta.length,
      }),
      ensureContextGraph,
      storeInsert,
      publicSnapshotStore: {
        getSnapshot: async () => null,
        putSnapshot: async () => ({ ref: 'snapshot-ref', byteLength: 0 }),
      },
      deleteCheckpoint,
      setCheckpoint,
      ensureOwnedMap: () => new Map(),
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary.failedPeers).toBe(0);
    expect(summary.timedOutPhases).toBe(1);
    expect(summary.checkpointAdvances).toBe(0);
    expect(summary.insertedTriples).toBe(0);
    expect(setCheckpoint.calls).toEqual([]);
    expect(deleteCheckpoint.calls).toContainEqual(['large-swm:snapshot:snapshot-ref']);
    expect(storeInsert.calls).toEqual([]);
    expect(ensureContextGraph.calls).toEqual([]);
  });

  it('stores shared-memory data and advances only data checkpoints on snapshot timeout', async () => {
    const setCheckpoint = recorder((_key: string, _offset: number) => {});
    const deleteCheckpoint = recorder((_key: string) => {});
    const storeInsert = recorder(async (_quads: Quad[]) => {});
    const ensureContextGraph = recorder(async (_contextGraphId: string) => {});
    const dataQuad = quad('large-swm-data');
    const snapshotMeta: Quad[] = [
      {
        subject: 'did:dkg:assertion:with-snapshot',
        predicate: 'http://dkg.io/ontology/publicSnapshotRef',
        object: '"snapshot-ref"',
        graph: 'did:dkg:context-graph:large-swm/_shared_memory_meta',
      } as Quad,
      {
        subject: 'did:dkg:assertion:with-snapshot',
        predicate: 'http://dkg.io/ontology/publicQuadsDigest',
        object: '"snapshot-digest"',
        graph: 'did:dkg:context-graph:large-swm/_shared_memory_meta',
      } as Quad,
      {
        subject: 'did:dkg:assertion:with-snapshot',
        predicate: 'http://dkg.io/ontology/publicQuadsCount',
        object: '"10"',
        graph: 'did:dkg:context-graph:large-swm/_shared_memory_meta',
      } as Quad,
    ];
    const fetchSyncPages = recorder(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta' | 'snapshot',
    ) => {
      if (phase === 'snapshot') {
        return pageResult(contextGraphId, phase, {
          checkpointKey: `${contextGraphId}:snapshot:snapshot-ref`,
          completed: false,
          timedOut: true,
          nextOffset: 500,
        });
      }
      if (phase === 'data') {
        return pageResult(contextGraphId, phase, {
          completed: false,
          timedOut: true,
          nextOffset: 7,
        });
      }
      return pageResult(contextGraphId, phase, {
        completed: false,
        timedOut: true,
        nextOffset: 5,
      });
    });

    const summary = await runSharedMemorySync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['large-swm'],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages,
      processSharedMemoryBatch: async () => ({
        ...sharedMemoryProcessResult(),
        emptyResponses: 0,
        verifiedData: [dataQuad],
        verifiedMeta: snapshotMeta,
        totalFetchedDataQuads: 1,
        totalFetchedMetaQuads: snapshotMeta.length,
      }),
      ensureContextGraph,
      storeInsert,
      publicSnapshotStore: {
        getSnapshot: async () => null,
        putSnapshot: async () => ({ ref: 'snapshot-ref', byteLength: 0 }),
      },
      deleteCheckpoint,
      setCheckpoint,
      ensureOwnedMap: () => new Map(),
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary.failedPeers).toBe(0);
    expect(summary.timedOutPhases).toBe(2);
    expect(summary.checkpointAdvances).toBe(1);
    expect(summary.insertedDataTriples).toBe(1);
    expect(summary.insertedMetaTriples).toBe(0);
    expect(ensureContextGraph.calls).toContainEqual(['large-swm']);
    expect(storeInsert.calls).toHaveLength(1);
    expect(storeInsert.calls).toContainEqual([[dataQuad]]);
    expect(setCheckpoint.calls).not.toContainEqual(['large-swm:snapshot:snapshot-ref', expect.any(Number)]);
    expect(setCheckpoint.calls).toContainEqual(['large-swm:data', 7]);
    expect(setCheckpoint.calls).not.toContainEqual(['large-swm:meta', expect.any(Number)]);
    expect(deleteCheckpoint.calls).toContainEqual(['large-swm:snapshot:snapshot-ref']);
  });
});
