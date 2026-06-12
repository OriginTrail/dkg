import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { runDurableSync } from '../src/sync/requester/durable-sync.js';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';

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
  it('continues durable sync after a denied context graph and records only that CG as denied', async () => {
    const deniedCgs: string[] = [];
    const fetchSyncPages = vi.fn(async (
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
    expect(summary.completedPhases).toBe(0);
    expect(fetchSyncPages).toHaveBeenCalledWith(ctx, 'peer-a', 'open-cg', false, 'meta', expect.any(String), expect.any(Number));
  });

  it('continues durable sync after a transport failure and preserves next-CG progress', async () => {
    const fetchSyncPages = vi.fn(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => {
      if (contextGraphId === 'shed-cg') throw new Error('sync responder busy');
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
    expect(summary.deniedPhases).toBe(0);
    expect(summary.completedPhases).toBe(0);
    expect(fetchSyncPages).toHaveBeenCalledWith(ctx, 'peer-a', 'next-cg', false, 'data', expect.any(String), expect.any(Number), undefined, undefined);
  });

  it('counts multiple durable context-graph failures as one failed peer', async () => {
    const fetchSyncPages = vi.fn(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => {
      if (contextGraphId.startsWith('fail-')) throw new Error(`sync responder busy for ${contextGraphId}`);
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
    expect(summary.deniedPhases).toBe(0);
    expect(fetchSyncPages).toHaveBeenCalledWith(ctx, 'peer-a', 'next-cg', false, 'data', expect.any(String), expect.any(Number), undefined, undefined);
  });

  it('continues durable sync after a verification failure and closes the active phase', async () => {
    const phases: string[] = [];
    const fetchSyncPages = vi.fn(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => pageResult(contextGraphId, phase, {
      quads: phase === 'data' ? [quad(contextGraphId)] : [],
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

    expect(summary.failedPeers).toBe(1);
    expect(summary.deniedPhases).toBe(0);
    expect(summary.completedPhases).toBe(0);
    expect(fetchSyncPages).toHaveBeenCalledWith(ctx, 'peer-a', 'next-cg', false, 'data', expect.any(String), expect.any(Number), undefined, undefined);
    expect(phases.slice(0, 4)).toEqual(['fetch:start', 'fetch:end', 'verify:start', 'verify:end']);
  });

  it('does not count zero-offset empty durable completions as progress', async () => {
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

    expect(summary.completedPhases).toBe(0);
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

  it('counts timeout with an advanced durable checkpoint as progress', async () => {
    const setCheckpoint = vi.fn();
    const deleteCheckpoint = vi.fn();
    const fetchSyncPages = vi.fn(async (
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
    expect(summary.completedPhases).toBe(0);
    expect(summary.checkpointAdvances).toBe(1);
    expect(deleteCheckpoint).toHaveBeenCalledWith('large-cg:meta');
    expect(setCheckpoint).toHaveBeenCalledWith('large-cg:data', 500);
  });

  it('does not report durable checkpoint progress when data is rejected for missing meta', async () => {
    const setCheckpoint = vi.fn();
    const deleteCheckpoint = vi.fn();
    const fetchSyncPages = vi.fn(async (
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
    expect(deleteCheckpoint).not.toHaveBeenCalled();
    expect(setCheckpoint).not.toHaveBeenCalled();
  });

  it('continues shared-memory sync after a denied context graph', async () => {
    const fetchSyncPages = vi.fn(async (
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
    expect(summary.completedPhases).toBe(0);
    expect(fetchSyncPages).toHaveBeenCalledWith(ctx, 'peer-a', 'open-swm', true, 'data', expect.any(String), expect.any(Number));
  });

  it('counts multiple shared-memory context-graph failures as one failed peer', async () => {
    const fetchSyncPages = vi.fn(async (
      _ctx: OperationContext,
      _peer: string,
      contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => {
      if (contextGraphId.startsWith('fail-')) throw new Error(`sync responder busy for ${contextGraphId}`);
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
    expect(summary.deniedPhases).toBe(0);
    expect(fetchSyncPages).toHaveBeenCalledWith(ctx, 'peer-a', 'open-swm', true, 'data', expect.any(String), expect.any(Number));
  });

  it('does not count zero-offset empty shared-memory completions as progress', async () => {
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

    expect(summary.completedPhases).toBe(0);
    expect(summary.checkpointAdvances).toBe(0);
  });

  it('reports resume-capable shared-memory snapshot timeouts as checkpoint progress', async () => {
    const setCheckpoint = vi.fn();
    const deleteCheckpoint = vi.fn();
    const storeInsert = vi.fn();
    const ensureContextGraph = vi.fn();
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
    const fetchSyncPages = vi.fn(async (
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
    expect(summary.checkpointAdvances).toBe(1);
    expect(summary.insertedTriples).toBe(0);
    expect(setCheckpoint).toHaveBeenCalledWith('large-swm:snapshot:snapshot-ref', 500);
    expect(deleteCheckpoint).not.toHaveBeenCalled();
    expect(storeInsert).not.toHaveBeenCalled();
    expect(ensureContextGraph).not.toHaveBeenCalled();
  });
});
