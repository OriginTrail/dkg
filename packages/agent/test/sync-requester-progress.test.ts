import { describe, expect, it } from 'vitest';
import { SYSTEM_CONTEXT_GRAPHS, type OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  runDurableSync,
  runDurableSyncDetailed,
  type DurableSyncFetchRequest,
  type DurableSyncStoreInsertRequest,
} from '../src/sync/requester/durable-sync.js';
import { uniformDurableSyncBudget } from './durable-sync-test-helpers.js';
import { workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';
import { runSharedMemorySync, selectSwmSnapshotCoverage } from '../src/sync/requester/shared-memory-sync.js';
import type { SwmSnapshotCoverage } from '../src/dkg-agent-types.js';
import {
  SyncPageAccumulationLimitError,
  type SyncPageResult,
} from '../src/sync/requester/page-fetch.js';
import { markSyncTransportFailure } from '../src/sync/error-tags.js';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

function durableFetchRecorder(
  impl: (request: DurableSyncFetchRequest) => Promise<SyncPageResult>,
) {
  return recorder(impl);
}

const ctx = { kind: 'system', id: 'test', startedAt: 0 } as OperationContext;
const noop = () => {};
const EXACT_UAL = 'did:dkg:base:84532/0x1111111111111111111111111111111111111111/7';

function pageResult(
  contextGraphId: string,
  phase: string,
  overrides: Partial<SyncPageResult> = {},
): SyncPageResult {
  return {
    quads: [],
    bytesReceived: 0,
    resumedFromOffset: 0,
    responderSessionStartedFresh: true,
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
    consumedUnpersistedMetaTriples: 0,
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
    const fetchSyncPages = durableFetchRecorder(async ({
      contextGraphId,
      phase,
    }) => {
      if (contextGraphId === 'pending-join') throw deniedError();
      return pageResult(contextGraphId, phase);
    });

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['pending-join', 'open-cg'],
      onAccessDenied: (cg) => deniedCgs.push(cg),
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

    expect(deniedCgs).toEqual(['pending-join']);
    expect(summary.deniedPhases).toBe(1);
    expect(summary.failedPeers).toBe(0);
    expect(summary.completedPhases).toBe(2);
    expect(fetchSyncPages.calls).toContainEqual([
      expect.objectContaining({
        ctx,
        remotePeerId: 'peer-a',
        contextGraphId: 'open-cg',
        phase: 'meta',
        graphUri: expect.any(String),
        fetchContext: expect.objectContaining({
          deadline: expect.any(Number),
        }),
      }),
    ]);
  });

  it('does not count a transport-failed durable graph but counts the subsequent clean-empty graph', async () => {
    const fetchSyncPages = durableFetchRecorder(async ({
      contextGraphId,
      phase,
    }) => {
      if (contextGraphId === 'shed-cg') throw transportError('sync responder busy');
      return pageResult(contextGraphId, phase);
    });

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['shed-cg', 'next-cg'],
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
    expect(summary.failedPhases).toBe(0);
    expect(summary.deniedPhases).toBe(0);
    expect(summary.completedPhases).toBe(2);
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

  it('counts multiple durable context-graph failures as one failed peer', async () => {
    const fetchSyncPages = durableFetchRecorder(async ({
      contextGraphId,
      phase,
    }) => {
      if (contextGraphId.startsWith('fail-')) throw transportError(`sync responder busy for ${contextGraphId}`);
      return pageResult(contextGraphId, phase);
    });

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['fail-one', 'fail-two', 'next-cg'],
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
    expect(summary.failedPhases).toBe(0);
    expect(summary.deniedPhases).toBe(0);
    expect(summary.completedPhases).toBe(2);
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

  it('does not count a verification-failed durable graph but counts the subsequent clean-empty graph', async () => {
    const phases: string[] = [];
    const fetchSyncPages = durableFetchRecorder(async ({
      contextGraphId,
      phase,
    }) => pageResult(contextGraphId, phase, {
      quads: phase === 'data' && contextGraphId === 'verify-fails'
        ? [quad(contextGraphId)]
        : [],
    }));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['verify-fails', 'next-cg'],
      onPhase: (phase, status) => phases.push(`${phase}:${status}`),
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
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
    expect(phases.slice(0, 4)).toEqual(['fetch:start', 'fetch:end', 'verify:start', 'verify:end']);
  });

  it('does not count a store-failed durable graph but counts the subsequent clean-empty graph', async () => {
    const fetchSyncPages = durableFetchRecorder(async ({
      contextGraphId,
      phase,
    }) => pageResult(contextGraphId, phase, {
      quads: phase === 'data' && contextGraphId === 'store-fails'
        ? [quad(contextGraphId)]
        : [],
    }));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['store-fails', 'next-cg'],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages,
      processDurableBatchInWorker: async (dataQuads) => ({
        ...durableProcessResult(),
        emptyResponses: dataQuads.length === 0 ? 1 : 0,
        verifiedData: dataQuads,
        totalFetchedDataQuads: dataQuads.length,
      }),
      storeInsert: async ({ quads }) => {
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

  it('counts both clean zero-offset empty durable phases as complete', async () => {
    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['empty-cg'],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages: async ({ contextGraphId, phase }) => (
        pageResult(contextGraphId, phase)
      ),
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
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages: async ({ contextGraphId, phase }) => (
        pageResult(contextGraphId, phase, { resumedFromOffset: 500, nextOffset: 500 })
      ),
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
    const fetchSyncPages = durableFetchRecorder(async ({
      contextGraphId,
      phase,
    }) => phase === 'data'
      ? pageResult(contextGraphId, phase, { completed: false, timedOut: true, nextOffset: 500 })
      : pageResult(contextGraphId, phase));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['large-cg'],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
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
    const fetchSyncPages = durableFetchRecorder(async ({
      contextGraphId,
      phase,
    }) => pageResult(contextGraphId, phase, {
      nextOffset: phase === 'data' ? 500 : 5,
    }));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['missing-meta-cg'],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
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
    const storeInsert = recorder(async (_request: DurableSyncStoreInsertRequest) => {});
    const setCheckpoint = recorder((_key: string, _offset: number) => {});
    const deleteCheckpoint = recorder((_key: string) => {});
    const logWarn = recorder((_ctx: OperationContext, _message: string) => {});
    const fetchSyncPages = durableFetchRecorder(async ({
      contextGraphId,
      phase,
    }) => pageResult(contextGraphId, phase, {
      nextOffset: phase === 'data' ? 500 : 5,
    }));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['rejected-integrity-cg'],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
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
    const storeInsert = recorder(async (_request: DurableSyncStoreInsertRequest) => {});
    const setCheckpoint = recorder((_key: string, _offset: number) => {});
    const deleteCheckpoint = recorder((_key: string) => {});
    const fetchSyncPages = durableFetchRecorder(async ({
      contextGraphId,
      phase,
    }) => phase === 'meta'
      ? pageResult(contextGraphId, phase, { nextOffset: 5, completed: false, timedOut: true })
      : pageResult(contextGraphId, phase));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['meta-only-cg'],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
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
    expect(storeInsert.calls).toHaveLength(1);
    expect(storeInsert.calls[0]![0].quads).toEqual([metaQuad]);
    expect(storeInsert.calls[0]![0]).toHaveProperty('signal', undefined);
    expect(deleteCheckpoint.calls).toEqual([]);
    expect(setCheckpoint.calls).toHaveLength(1);
    expect(setCheckpoint.calls).toContainEqual(['meta-only-cg:meta', 5]);
  });

  it('advances the meta cursor when every fetched metadata row was deliberately discarded', async () => {
    const setCheckpoint = recorder((_key: string, _offset: number) => {});
    const deleteCheckpoint = recorder((_key: string) => {});
    const storeInsert = recorder(async (_request: DurableSyncStoreInsertRequest) => {});
    const fetchSyncPages = durableFetchRecorder(async ({
      contextGraphId,
      phase,
    }) => phase === 'meta'
      ? pageResult(contextGraphId, phase, { nextOffset: 3, completed: false })
      : pageResult(contextGraphId, phase));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['discarded-controls'],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages,
      processDurableBatchInWorker: async () => ({
        ...durableProcessResult(),
        emptyResponses: 0,
        metaOnlyResponses: 1,
        // Pure-sync-control page: worker aggregates 3 discarded controls into
        // consumedUnpersistedMetaTriples. Regression guard for the shipped path.
        consumedUnpersistedMetaTriples: 3,
        totalFetchedMetaQuads: 3,
      }),
      storeInsert,
      deleteCheckpoint,
      setCheckpoint,
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary.metaOnlyResponses).toBe(1);
    expect(summary.checkpointAdvances).toBe(0);
    expect(storeInsert.calls).toEqual([]);
    expect(deleteCheckpoint.calls).toEqual([]);
    expect(setCheckpoint.calls).toEqual([['discarded-controls:meta', 3]]);
  });

  it('keeps the meta cursor pinned when discarded rows do not account for the whole page', async () => {
    const setCheckpoint = recorder((_key: string, _offset: number) => {});
    const deleteCheckpoint = recorder((_key: string) => {});
    const fetchSyncPages = durableFetchRecorder(async ({
      contextGraphId,
      phase,
    }) => phase === 'meta'
      ? pageResult(contextGraphId, phase, { nextOffset: 3, completed: false })
      : pageResult(contextGraphId, phase));

    await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['partially-discarded-controls'],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages,
      processDurableBatchInWorker: async () => ({
        ...durableProcessResult(),
        emptyResponses: 0,
        metaOnlyResponses: 1,
        consumedUnpersistedMetaTriples: 2,
        totalFetchedMetaQuads: 3,
      }),
      storeInsert: async () => {},
      deleteCheckpoint,
      setCheckpoint,
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(deleteCheckpoint.calls).toEqual([]);
    expect(setCheckpoint.calls).toEqual([]);
  });

  it('advances the meta cursor when the whole page is non-IRI subjects dropped at ingest (#1921)', async () => {
    // All-non-IRI metadata-only page: the worker aggregates every dropped row
    // into consumedUnpersistedMetaTriples === totalFetchedMetaQuads and no meta
    // is persisted. The requester must still advance the meta cursor (the rows
    // were deliberately consumed) or durable sync pins on the same poisoned page.
    const setCheckpoint = recorder((_key: string, _offset: number) => {});
    const deleteCheckpoint = recorder((_key: string) => {});
    const storeInsert = recorder(async (_request: DurableSyncStoreInsertRequest) => {});
    const fetchSyncPages = durableFetchRecorder(async ({
      contextGraphId,
      phase,
    }) => phase === 'meta'
      ? pageResult(contextGraphId, phase, { nextOffset: 3, completed: false })
      : pageResult(contextGraphId, phase));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['discarded-non-iri'],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages,
      processDurableBatchInWorker: async () => ({
        ...durableProcessResult(),
        emptyResponses: 0,
        metaOnlyResponses: 1,
        consumedUnpersistedMetaTriples: 3,
        totalFetchedMetaQuads: 3,
      }),
      storeInsert,
      deleteCheckpoint,
      setCheckpoint,
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary.metaOnlyResponses).toBe(1);
    expect(summary.checkpointAdvances).toBe(0);
    expect(storeInsert.calls).toEqual([]);
    expect(deleteCheckpoint.calls).toEqual([]);
    expect(setCheckpoint.calls).toEqual([['discarded-non-iri:meta', 3]]);
  });

  it('advances the meta cursor when a mixed page is fully discarded by controls + non-IRI drops (#1921)', async () => {
    // A mixed all-discarded page (some unverified controls + some non-IRI rows):
    // the worker sums both reasons into consumedUnpersistedMetaTriples === the
    // fetched total, so the requester advances the cursor rather than pinning.
    const setCheckpoint = recorder((_key: string, _offset: number) => {});
    const deleteCheckpoint = recorder((_key: string) => {});
    const storeInsert = recorder(async (_request: DurableSyncStoreInsertRequest) => {});
    const fetchSyncPages = durableFetchRecorder(async ({
      contextGraphId,
      phase,
    }) => phase === 'meta'
      ? pageResult(contextGraphId, phase, { nextOffset: 3, completed: false })
      : pageResult(contextGraphId, phase));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['discarded-mixed'],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages,
      processDurableBatchInWorker: async () => ({
        ...durableProcessResult(),
        emptyResponses: 0,
        metaOnlyResponses: 1,
        consumedUnpersistedMetaTriples: 3,
        totalFetchedMetaQuads: 3,
      }),
      storeInsert,
      deleteCheckpoint,
      setCheckpoint,
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(summary.metaOnlyResponses).toBe(1);
    expect(storeInsert.calls).toEqual([]);
    expect(deleteCheckpoint.calls).toEqual([]);
    expect(setCheckpoint.calls).toEqual([['discarded-mixed:meta', 3]]);
  });

  it('deletes only the durable meta checkpoint after completing metadata-only responses', async () => {
    const metaQuad = quad('meta-only-complete-meta');
    const storeInsert = recorder(async (_request: DurableSyncStoreInsertRequest) => {});
    const setCheckpoint = recorder((_key: string, _offset: number) => {});
    const deleteCheckpoint = recorder((_key: string) => {});
    const fetchSyncPages = durableFetchRecorder(async ({
      contextGraphId,
      phase,
    }) => pageResult(contextGraphId, phase, {
      nextOffset: phase === 'meta' ? 5 : 0,
    }));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['meta-only-complete'],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
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
    expect(storeInsert.calls).toHaveLength(1);
    expect(storeInsert.calls[0]![0].quads).toEqual([metaQuad]);
    expect(storeInsert.calls[0]![0]).toHaveProperty('signal', undefined);
    expect(deleteCheckpoint.calls).toHaveLength(1);
    expect(deleteCheckpoint.calls).toContainEqual(['meta-only-complete:meta']);
    expect(setCheckpoint.calls).toEqual([]);
  });

  it('stores verified private-only metadata and advances both durable checkpoints cleanly', async () => {
    const metaQuad = quad('verified-private-only-meta');
    const storeInsert = recorder(async (_request: DurableSyncStoreInsertRequest) => {});
    const setCheckpoint = recorder((_key: string, _offset: number) => {});
    const deleteCheckpoint = recorder((_key: string) => {});
    const fetchSyncPages = durableFetchRecorder(async ({
      contextGraphId,
      phase,
    }) => pageResult(contextGraphId, phase, {
      quads: phase === 'meta' ? [metaQuad] : [],
      nextOffset: phase === 'meta' ? 1 : 0,
    }));

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: ['verified-private-only-cg'],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
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
    expect(storeInsert.calls).toEqual([
      [
        expect.objectContaining({
          quads: [metaQuad],
          signal: undefined,
        }),
      ],
    ]);
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

describe('exact durable fetch disposition', () => {
  async function runExact(options: {
    meta?: Partial<SyncPageResult>;
    data?: Partial<SyncPageResult>;
    rawMeta?: Quad[];
    rawData?: Quad[];
    rejectedKcs?: number;
    dataRejectedMissingMeta?: number;
    fetchError?: Error;
    abortAfterMeta?: boolean;
  } = {}) {
    const controller = new AbortController();
    return runDurableSyncDetailed({
      ctx,
      remotePeerId: 'exact-peer',
      contextGraphIds: ['exact-cg'],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      exactAssetUalsFor: () => [EXACT_UAL],
      fetchSyncPages: async ({ phase }) => {
        if (options.fetchError) throw options.fetchError;
        const page = pageResult('exact-cg', phase, {
          quads: phase === 'meta' ? (options.rawMeta ?? []) : (options.rawData ?? []),
          ...(phase === 'meta' ? options.meta : options.data),
        });
        if (phase === 'meta' && options.abortAfterMeta) {
          controller.abort(new Error('cancelled after exact metadata'));
        }
        return page;
      },
      signal: controller.signal,
      processDurableBatchInWorker: async (data, meta) => ({
        ...durableProcessResult(),
        verifiedData: data,
        verifiedMeta: meta,
        totalFetchedDataQuads: data.length,
        totalFetchedMetaQuads: meta.length,
        emptyResponses: data.length === 0 && meta.length === 0 ? 1 : 0,
        rejectedKcs: options.rejectedKcs ?? 0,
        dataRejectedMissingMeta: options.dataRejectedMissingMeta ?? 0,
      }),
      storeInsert: async () => {},
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });
  }

  it('distinguishes fresh clean absence without changing public completion', async () => {
    const detailed = await runExact();
    const projected = await runDurableSync({
      ctx,
      remotePeerId: 'exact-peer-public',
      contextGraphIds: ['exact-cg'],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      exactAssetUalsFor: () => [EXACT_UAL],
      fetchSyncPages: async ({ phase }) => pageResult('exact-cg', phase),
      processDurableBatchInWorker: async () => durableProcessResult(),
      storeInsert: async () => {},
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(detailed.exactFetchDisposition).toBe('clean-absent');
    expect(detailed.result.complete).toBe(false);
    expect(projected.complete).toBe(false);
    expect(projected).not.toHaveProperty('exactFetchDisposition');
  });

  it('classifies returned exact descriptor and content as found', async () => {
    const assertionGraph = 'did:dkg:context-graph:exact-cg/_verifiable_memory/asset/7';
    const detailed = await runExact({
      rawMeta: [
        {
          subject: EXACT_UAL,
          predicate: 'http://dkg.io/ontology/kaUal',
          object: EXACT_UAL,
          graph: 'did:dkg:context-graph:exact-cg/_meta',
        } as Quad,
        {
          subject: EXACT_UAL,
          predicate: 'http://dkg.io/ontology/assertionGraph',
          object: assertionGraph,
          graph: 'did:dkg:context-graph:exact-cg/_meta',
        } as Quad,
      ],
      rawData: [{
        subject: 'http://example.com/entity',
        predicate: 'http://example.com/value',
        object: '"present"',
        graph: assertionGraph,
      } as Quad],
      meta: { nextOffset: 2 },
      data: { nextOffset: 1 },
    });

    expect(detailed.exactFetchDisposition).toBe('found');
  });

  it.each([
    ['resumed empty suffix', { meta: { resumedFromOffset: 4, nextOffset: 4 } }],
    ['reused offset-zero responder session', { meta: { responderSessionStartedFresh: false } }],
    ['resumed empty data suffix', { data: { resumedFromOffset: 4, nextOffset: 4 } }],
    ['reused offset-zero data responder session', { data: { responderSessionStartedFresh: false } }],
    ['partial phase', { data: { completed: false } }],
    ['timed out phase', { data: { completed: false, timedOut: true } }],
    ['integrity rejection', { rejectedKcs: 1 }],
    ['missing metadata rejection', { dataRejectedMissingMeta: 1 }],
    ['denial', { fetchError: deniedError() }],
    ['abort', { abortAfterMeta: true }],
  ])('keeps %s incomplete', async (_label, options) => {
    const detailed = await runExact(options);
    expect(detailed.exactFetchDisposition).toBe('incomplete');
  });

  it('keeps an old responder filtered prefix incomplete', async () => {
    const detailed = await runExact({
      rawMeta: [quad('did:dkg:other-asset')],
      rawData: [quad('http://example.com/unrelated')],
      meta: { nextOffset: 1 },
      data: { nextOffset: 1 },
    });
    expect(detailed.exactFetchDisposition).toBe('incomplete');
  });

  it('does not verify or store an exact phase rejected by its accumulation limit', async () => {
    const processDurableBatchInWorker = recorder(async () => durableProcessResult());
    const storeInsert = recorder(async (_request: DurableSyncStoreInsertRequest) => {});
    const fetchSyncPages = durableFetchRecorder(async () => {
      throw new SyncPageAccumulationLimitError('bytes', 11, 10);
    });
    const detailed = await runDurableSyncDetailed({
      ctx,
      remotePeerId: 'legacy-exact-peer',
      contextGraphIds: ['exact-cg'],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      exactAssetUalsFor: () => [EXACT_UAL],
      fetchSyncPages,
      processDurableBatchInWorker,
      storeInsert,
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(detailed.exactFetchDisposition).toBe('incomplete');
    expect(detailed.result.failedPhases).toBe(1);
    expect(fetchSyncPages.calls).toHaveLength(1);
    expect(fetchSyncPages.calls[0][0].phase).toBe('meta');
    expect(processDurableBatchInWorker.calls).toHaveLength(0);
    expect(storeInsert.calls).toHaveLength(0);
  });

  it('does not treat skipped agents metadata as a clean exact response', async () => {
    const fetchedPhases: string[] = [];
    const detailed = await runDurableSyncDetailed({
      ctx,
      remotePeerId: 'exact-agents-peer',
      contextGraphIds: [SYSTEM_CONTEXT_GRAPHS.AGENTS],
      syncAgentsMeta: false,
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      exactAssetUalsFor: () => [EXACT_UAL],
      fetchSyncPages: async ({ contextGraphId, phase }) => {
        fetchedPhases.push(phase);
        return pageResult(contextGraphId, phase);
      },
      processDurableBatchInWorker: async () => durableProcessResult(),
      storeInsert: async () => {},
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(fetchedPhases).toEqual(['data']);
    expect(detailed.exactFetchDisposition).toBe('incomplete');
  });

  it('aggregates exact outcomes across Context Graphs without overwriting an incomplete result', async () => {
    const detailed = await runDurableSyncDetailed({
      ctx,
      remotePeerId: 'exact-multi-cg-peer',
      contextGraphIds: ['exact-incomplete-cg', 'exact-clean-cg'],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      exactAssetUalsFor: () => [EXACT_UAL],
      fetchSyncPages: async ({ contextGraphId, phase }) => pageResult(contextGraphId, phase, {
        ...(contextGraphId === 'exact-incomplete-cg' && phase === 'data'
          ? { completed: false }
          : {}),
      }),
      processDurableBatchInWorker: async () => durableProcessResult(),
      storeInsert: async () => {},
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    expect(detailed.exactFetchDisposition).toBe('incomplete');
  });

  it('keeps normalization failures on the asynchronous requester boundary', async () => {
    let publicResult: ReturnType<typeof runDurableSync> | undefined;
    let detailedResult: ReturnType<typeof runDurableSyncDetailed> | undefined;

    expect(() => {
      publicResult = runDurableSync(null as never);
      detailedResult = runDurableSyncDetailed(null as never);
    }).not.toThrow();
    await expect(publicResult).rejects.toThrow();
    await expect(detailedResult).rejects.toThrow();
  });
});

describe('public SWM snapshot coverage (#2050)', () => {
  const COVERAGE_CG = 'coverage-swm';
  const META_GRAPH = `did:dkg:context-graph:${COVERAGE_CG}/_shared_memory_meta`;

  function snapshotMeta(subject: string, digest: string, count: number): Quad[] {
    return [
      {
        subject,
        predicate: 'http://dkg.io/ontology/publicQuadsDigest',
        object: `"${digest}"`,
        graph: META_GRAPH,
      } as Quad,
      {
        subject,
        predicate: 'http://dkg.io/ontology/publicQuadsCount',
        object: `"${count}"`,
        graph: META_GRAPH,
      } as Quad,
    ];
  }

  // The external review's M2 case, verbatim: independent maxima over ready and
  // total turn these two peers into `200/250` — a graph state neither reported.
  const partialOfLarge: SwmSnapshotCoverage = {
    contextGraphId: COVERAGE_CG,
    peerIdSuffix: 'aaaa1111',
    snapshotsResolved: 178,
    snapshotsTotal: 250,
    manifestComplete: true,
    missingCount: 72,
    missingSample: ['did:dkg:ka:from-the-large-manifest'],
  };
  const completeSmaller: SwmSnapshotCoverage = {
    contextGraphId: COVERAGE_CG,
    peerIdSuffix: 'bbbb2222',
    snapshotsResolved: 200,
    snapshotsTotal: 200,
    manifestComplete: true,
    missingCount: 0,
    missingSample: [],
  };

  it('reports the shortfall against the largest manifest, not the best fraction', () => {
    const bothOrders = [
      selectSwmSnapshotCoverage(partialOfLarge, completeSmaller),
      selectSwmSnapshotCoverage(completeSmaller, partialOfLarge),
    ];

    for (const selected of bothOrders) {
      // Whole record from ONE peer: reducing numerator and denominator
      // independently would give 200/250, which equals neither input and
      // carries a sample from neither manifest.
      expect([partialOfLarge, completeSmaller]).toContainEqual(selected);
      expect(selected).not.toMatchObject({ snapshotsResolved: 200, snapshotsTotal: 250 });
      // And the winner must be the peer that knows the graph is 250 KAs, not
      // the one whose smaller view is fully resolved. Picking `200/200` would
      // report "0 outstanding" on a job that is 72 short — self-consistent,
      // undetectable downstream, and worse than the synthetic pair above.
      expect(selected).toEqual(partialOfLarge);
      expect(selected?.missingCount).toBe(72);
    }
    expect(bothOrders[0]).toEqual(bothOrders[1]);
  });

  it('prefers authority evidence even when another peer knows a larger manifest', () => {
    // Deliberately the record that LOSES on every later rule: smaller total,
    // fewer outstanding. Only the authority rule can select it, so this fails
    // if authority stops sorting first.
    const authoritySmaller: SwmSnapshotCoverage = { ...completeSmaller, fromAuthority: true };

    expect(selectSwmSnapshotCoverage(authoritySmaller, partialOfLarge)).toEqual(authoritySmaller);
    expect(selectSwmSnapshotCoverage(partialOfLarge, authoritySmaller)).toEqual(authoritySmaller);
  });

  it('prefers a complete manifest, whose denominator is not merely a lower bound', () => {
    // Larger total than `partialOfLarge`, so the largest-manifest rule alone
    // would select it; only `manifestComplete` rejects it.
    const truncatedButLarger: SwmSnapshotCoverage = {
      contextGraphId: COVERAGE_CG,
      peerIdSuffix: 'cccc3333',
      snapshotsResolved: 9,
      snapshotsTotal: 300,
      manifestComplete: false,
      missingCount: 291,
      missingSample: [],
    };

    expect(selectSwmSnapshotCoverage(truncatedButLarger, partialOfLarge)).toEqual(partialOfLarge);
    expect(selectSwmSnapshotCoverage(partialOfLarge, truncatedButLarger)).toEqual(partialOfLarge);
  });

  it('prefers the most resolved when two peers report the same manifest size', () => {
    const behind: SwmSnapshotCoverage = {
      ...partialOfLarge,
      peerIdSuffix: 'dddd4444',
      snapshotsResolved: 12,
      missingCount: 238,
    };

    expect(selectSwmSnapshotCoverage(behind, partialOfLarge)).toEqual(partialOfLarge);
    expect(selectSwmSnapshotCoverage(partialOfLarge, behind)).toEqual(partialOfLarge);
  });

  it('breaks a genuine tie deterministically on the peer id', () => {
    const later: SwmSnapshotCoverage = { ...partialOfLarge, peerIdSuffix: 'zzzz9999' };

    expect(selectSwmSnapshotCoverage(partialOfLarge, later)).toEqual(partialOfLarge);
    expect(selectSwmSnapshotCoverage(later, partialOfLarge)).toEqual(partialOfLarge);
  });

  it('carries the round coverage onto the summary when the snapshot phase does not finish', async () => {
    const cachedQuads = [quad('cached-snapshot-row')];
    const cachedDigest = workspacePublicQuadsDigest(cachedQuads);
    const meta = [
      ...snapshotMeta('did:dkg:assertion:cached', cachedDigest, cachedQuads.length),
      ...snapshotMeta('did:dkg:assertion:unreachable', 'digest-never-served', 5),
    ];

    const summary = await runSharedMemorySync({
      ctx,
      remotePeerId: 'peer-coverage-abcd1234',
      contextGraphIds: [COVERAGE_CG],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages: async (
        _ctx: OperationContext,
        _peer: string,
        contextGraphId: string,
        _includeSharedMemory: boolean,
        phase: string,
      ) => (phase === 'snapshot'
        ? pageResult(contextGraphId, phase, { completed: false, timedOut: true })
        : pageResult(contextGraphId, phase)),
      processSharedMemoryBatch: async () => ({
        ...sharedMemoryProcessResult(),
        emptyResponses: 0,
        verifiedMeta: meta,
        totalFetchedMetaQuads: meta.length,
      }),
      ensureContextGraph: async () => {},
      storeInsert: async () => {},
      publicSnapshotStore: {
        getSnapshot: async (ref: string) => (ref === cachedDigest ? cachedQuads : null),
        putSnapshot: async () => ({ ref: 'unused', byteLength: 0 }),
      },
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      ensureOwnedMap: () => new Map(),
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    // One cached snapshot resolved, one never served, and the manifest itself
    // paged cleanly — so the shortfall is real rather than an artefact of a
    // truncated denominator.
    expect(summary.swmCoverage).toEqual({
      contextGraphId: COVERAGE_CG,
      peerIdSuffix: 'abcd1234',
      snapshotsResolved: 0,
      snapshotsTotal: 2,
      manifestComplete: true,
      missingCount: 2,
      // The ref that was never served, named — not an empty placeholder. The
      // sample and the count come from the same walk, so they cannot disagree.
      missingSample: ['digest-never-served'],
      // Fetch shortfall only — every ref that DID arrive was written.
      materializationFailures: 0,
    });
  });
});

/**
 * T13 (#2050) — the coverage reduction reduces COHERENTLY and selects the
 * record that names the shortfall.
 *
 * Two properties, and the second is the one that matters. Every return in
 * `selectSwmSnapshotCoverage` yields `a` or `b` — it never constructs — so a
 * whole-record assertion is satisfied BY CONSTRUCTION and cannot fail for any
 * mutation confined to the comparison logic. It dies only under a mutant that
 * SYNTHESIZES a record. That is real coverage of the no-synthesis property and
 * it is worth keeping, but it is not what AC-5 depends on.
 *
 * The defect it cannot see: ranking by `resolved/total` returns `200/200` with
 * `missingCount: 0` for a job 72 Knowledge Assets short — a real record, from a
 * real peer, internally self-consistent, and wrong. Assert selection too, or the
 * ordering is untested.
 */
function t13Coverage(over: Partial<SwmSnapshotCoverage> & {
  peerIdSuffix: string; snapshotsResolved: number; snapshotsTotal: number;
}): SwmSnapshotCoverage {
  return {
    contextGraphId: 'cg-t13',
    manifestComplete: true,
    missingCount: over.snapshotsTotal - over.snapshotsResolved,
    missingSample: [],
    ...over,
  };
}

describe('T13 — swmCoverage reduction', () => {
  /** The r26 shape: the peer that actually holds the graph, 72 short. */
  const shortfallPeer = t13Coverage({ peerIdSuffix: 'aaaa1111', snapshotsResolved: 178, snapshotsTotal: 250 });
  /** A peer hosting a SMALLER view of the same graph, fully resolved against it. */
  const smallerPeer = t13Coverage({ peerIdSuffix: 'bbbb2222', snapshotsResolved: 200, snapshotsTotal: 200 });

  it('never synthesizes a pair: the result is always one whole input record', () => {
    for (const [a, b] of [[shortfallPeer, smallerPeer], [smallerPeer, shortfallPeer]] as const) {
      expect([a, b]).toContainEqual(selectSwmSnapshotCoverage(a, b));
    }
  });

  it('selects the record that NAMES THE SHORTFALL, not the best-looking fraction', () => {
    for (const [a, b] of [[shortfallPeer, smallerPeer], [smallerPeer, shortfallPeer]] as const) {
      const selected = selectSwmSnapshotCoverage(a, b);
      expect(selected).toEqual(shortfallPeer);
      expect(selected?.missingCount).toBe(72);
      expect(selected?.peerIdSuffix).toBe('aaaa1111');
    }
  });

  it('prefers a large partial manifest over a tiny complete one', () => {
    // The residual the original implementation accepted in its own doc comment:
    // `1/1` is complete and fully resolved, and reporting it would tell the
    // operator the graph had converged.
    const tiny = t13Coverage({ peerIdSuffix: 'cccc3333', snapshotsResolved: 1, snapshotsTotal: 1 });
    expect(selectSwmSnapshotCoverage(tiny, shortfallPeer)).toEqual(shortfallPeer);
    expect(selectSwmSnapshotCoverage(shortfallPeer, tiny)).toEqual(shortfallPeer);
  });

  it('prefers a complete manifest over an incomplete one, whatever the counts', () => {
    // An incomplete manifest's denominator is only a lower bound, so its
    // shortfall is not comparable. Completeness outranks size.
    const truncatedButBigger = t13Coverage({
      peerIdSuffix: 'dddd4444', snapshotsResolved: 250, snapshotsTotal: 400, manifestComplete: false,
    });
    expect(selectSwmSnapshotCoverage(truncatedButBigger, shortfallPeer)).toEqual(shortfallPeer);
    expect(selectSwmSnapshotCoverage(shortfallPeer, truncatedButBigger)).toEqual(shortfallPeer);
  });

  it('lets authority evidence outrank everything below it', () => {
    // Residual, stated deliberately: a stale or smaller CURATOR manifest still
    // reports converged. Accepted — the curator is definitionally authoritative
    // about its own graph's inventory — but it is a property of trusting the
    // curator, not an artefact of the reduction.
    const curator = t13Coverage({ peerIdSuffix: '9999cccc', snapshotsResolved: 5, snapshotsTotal: 5, fromAuthority: true });
    expect(selectSwmSnapshotCoverage(curator, shortfallPeer)).toEqual(curator);
    expect(selectSwmSnapshotCoverage(shortfallPeer, curator)).toEqual(curator);
  });

  it('is order-independent across records with DISTINCT peer suffixes', () => {
    // Scoped to distinct suffixes, which is what this asserts and all it
    // asserts — the final tiebreak is only asymmetric when they differ.
    const records = [shortfallPeer, smallerPeer,
      t13Coverage({ peerIdSuffix: 'cccc3333', snapshotsResolved: 1, snapshotsTotal: 1 }),
      t13Coverage({ peerIdSuffix: 'dddd4444', snapshotsResolved: 250, snapshotsTotal: 400, manifestComplete: false }),
    ];
    for (const a of records) {
      for (const b of records) {
        expect(selectSwmSnapshotCoverage(a, b)).toEqual(selectSwmSnapshotCoverage(b, a));
      }
    }
  });

  it('passes absent operands through rather than erasing the known record', () => {
    expect(selectSwmSnapshotCoverage(undefined, shortfallPeer)).toEqual(shortfallPeer);
    expect(selectSwmSnapshotCoverage(shortfallPeer, undefined)).toEqual(shortfallPeer);
    expect(selectSwmSnapshotCoverage(undefined, undefined)).toBeUndefined();
  });
});

/**
 * T14 (#2050) — a throw must not erase the progress the round actually made.
 *
 * This is a CONVERGENCE property, not a diagnostics one. The continuation loop
 * reads `swmCoverage.snapshotsResolved` as its progress signal, and that record
 * is assembled from `syncPublicSnapshotsForMeta`'s RETURN value. A snapshot-
 * phase transport failure throws, so before this fix the return never happened,
 * no coverage record was built, the high-water mark did not move, and the loop
 * declared `coverage-stalled` and abandoned a peer that had just materialized
 * real Knowledge Assets — the r26 shape, and the exact behaviour #2050 exists
 * to remove.
 */
describe('T14 — a throwing snapshot round still reports what it resolved', () => {
  const T14_CG = 'throwing-swm';
  const T14_META = `did:dkg:context-graph:${T14_CG}/_shared_memory_meta`;

  function snapshotRow(subject: string, digest: string, count: number): Quad[] {
    return [
      { subject, predicate: 'http://dkg.io/ontology/publicQuadsDigest', object: `"${digest}"`, graph: T14_META } as Quad,
      { subject, predicate: 'http://dkg.io/ontology/publicQuadsCount', object: `"${count}"`, graph: T14_META } as Quad,
    ];
  }

  it('carries the resolved count out through the throw instead of reporting zero', async () => {
    // Two snapshots cached and resolvable, then one whose fetch blows up.
    const cachedA = [quad('t14-a')];
    const cachedB = [quad('t14-b')];
    const digestA = workspacePublicQuadsDigest(cachedA);
    const digestB = workspacePublicQuadsDigest(cachedB);
    const meta = [
      ...snapshotRow('did:dkg:assertion:a', digestA, cachedA.length),
      ...snapshotRow('did:dkg:assertion:b', digestB, cachedB.length),
      ...snapshotRow('did:dkg:assertion:boom', 'digest-that-throws', 4),
    ];

    const summary = await runSharedMemorySync({
      ctx,
      remotePeerId: 'peer-throwing-99887766',
      contextGraphIds: [T14_CG],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages: async (
        _ctx: OperationContext,
        _peer: string,
        contextGraphId: string,
        _includeSharedMemory: boolean,
        phase: string,
      ) => {
        if (phase === 'snapshot') throw transportError('snapshot stream reset');
        return pageResult(contextGraphId, phase);
      },
      processSharedMemoryBatch: async () => ({
        ...sharedMemoryProcessResult(),
        emptyResponses: 0,
        verifiedMeta: meta,
        totalFetchedMetaQuads: meta.length,
      }),
      ensureContextGraph: async () => {},
      storeInsert: async () => {},
      publicSnapshotStore: {
        getSnapshot: async (ref: string) => {
          if (ref === digestA) return cachedA;
          if (ref === digestB) return cachedB;
          return null;
        },
        putSnapshot: async () => ({ ref: 'unused', byteLength: 0 }),
      },
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      ensureOwnedMap: () => new Map(),
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    // Pre-fix this was `undefined` — the throw unwound past the record
    // entirely, so the pass looked non-advancing and the peer was dropped.
    // Existence of the record, with the peer's real denominator, is what this
    // row pins.
    //
    // `snapshotsResolved` is 0 because this fixture wires no
    // `snapshotMaterializer`, so nothing is written — and resolved counts
    // Knowledge Assets MATERIALIZED, not refs fetched. That is deliberate:
    // counting fetches here is the defect that let an all-cached round whose
    // writes all failed report maximal coverage and silently end the
    // continuation.
    expect(summary.swmCoverage).toEqual({
      contextGraphId: T14_CG,
      peerIdSuffix: '99887766',
      snapshotsResolved: 0,
      snapshotsTotal: 3,
      manifestComplete: true,
      missingCount: 3,
      missingSample: ['digest-that-throws'],
      materializationFailures: 0,
    });
  });

  // The `resolved + missing === total` invariant is deliberately NOT asserted
  // here. `recordSnapshotCoverage` derives `missingCount` as
  // `totalSnapshots - snapshotsResolved`, so the invariant holds by
  // construction and any test of it restates numbers the deep-equal above
  // already pinned. An assertion that cannot fail is worse than none: it reads
  // as coverage of a property nothing is checking.
});
