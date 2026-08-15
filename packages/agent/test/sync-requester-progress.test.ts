import { afterEach, describe, expect, it } from 'vitest';
import { SYSTEM_CONTEXT_GRAPHS, type OperationContext } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  createSharedMemorySnapshotMaterializer,
  type SharedMemorySnapshotMaterializer,
} from '../src/sync/requester/swm-snapshot-materializer.js';
import { swmFixtures } from './swm-descriptor-fixtures.js';
import {
  runDurableSync,
  runDurableSyncDetailed,
  type DurableSyncCheckpointWrite,
  type DurableSyncFetchRequest,
  type DurableSyncStoreInsertRequest,
} from '../src/sync/requester/durable-sync.js';
import { uniformDurableSyncBudget } from './durable-sync-test-helpers.js';
import { generateShareMetadata, workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';
import { parseGraphScopedSwmRecoveryDescriptors } from '../src/sync/graph-scoped-swm-recovery.js';
import {
  collectPublicSnapshotMetadata,
  runSharedMemorySync,
  selectSwmSnapshotCoverage,
  syncPublicSnapshotsForMeta,
} from '../src/sync/requester/shared-memory-sync.js';
import type { SwmSnapshotCoverage } from '../src/dkg-agent-types.js';
import {
  SyncPageAccumulationLimitError,
  type SyncPageResult,
} from '../src/sync/requester/page-fetch.js';
import { toSyncTransportFailureError } from '../src/sync/error-tags.js';

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
  return toSyncTransportFailureError(err);
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

describe('selected snapshot walk continuation', () => {
  it('skips an exact resolved prefix and spends the next slice on unresolved snapshots', async () => {
    const first = [quad('resolved-prefix')].map((row) => ({ ...row, graph: '' }));
    const second = [quad('next-unresolved')].map((row) => ({ ...row, graph: '' }));
    const firstDigest = workspacePublicQuadsDigest(first);
    const secondDigest = workspacePublicQuadsDigest(second);
    const snapshots = [
      { ref: firstDigest, digest: firstDigest, count: first.length },
      { ref: secondDigest, digest: secondDigest, count: second.length },
    ];
    const cacheReads: string[] = [];
    const fetchedRefs: string[] = [];
    const readyRefs: string[] = [];

    const result = await syncPublicSnapshotsForMeta({
      ctx,
      remotePeerId: 'peer-resume-prefix',
      contextGraphId: 'cg-resume-prefix',
      deadline: Date.now() + 60_000,
      snapshotWalk: {
        orderedManifestSnapshot: () => snapshots.map((snapshot) => ({ ...snapshot })),
        isResolved: (ref) => ref === firstDigest,
        resolvedCount: () => 1,
        resolvedRefsSnapshot: () => [firstDigest],
        suppressedMetadataRows: () => [],
        markResolved: () => {},
      },
      publicSnapshotStore: {
        getSnapshot: async (ref) => {
          cacheReads.push(ref);
          return null;
        },
        putSnapshot: async ({ digest }) => ({ ref: digest, byteLength: 1 }),
      },
      fetchSyncPages: async (
        _ctx,
        _peer,
        contextGraphId,
        _includeSharedMemory,
        phase,
        _graph,
        _deadline,
        options,
      ) => {
        expect(phase).toBe('snapshot');
        fetchedRefs.push(options!.snapshotRef!);
        return pageResult(contextGraphId, phase, { quads: second });
      },
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      onSnapshotReady: async (snapshot) => { readyRefs.push(snapshot.ref); },
    });

    expect(cacheReads).toEqual([secondDigest]);
    expect(fetchedRefs).toEqual([secondDigest]);
    expect(readyRefs).toEqual([secondDigest]);
    expect(result).toMatchObject({
      readySnapshots: 2,
      totalSnapshots: 2,
      completed: true,
      missingCount: 0,
    });
  });

  it('starts at the first snapshot when a changed manifest has no retained resolution', async () => {
    const first = [quad('changed-manifest-first')].map((row) => ({ ...row, graph: '' }));
    const second = [quad('changed-manifest-second')].map((row) => ({ ...row, graph: '' }));
    const firstDigest = workspacePublicQuadsDigest(first);
    const secondDigest = workspacePublicQuadsDigest(second);
    const snapshots = [
      { ref: firstDigest, digest: firstDigest, count: first.length },
      { ref: secondDigest, digest: secondDigest, count: second.length },
    ];
    const fetchedRefs: string[] = [];

    const result = await syncPublicSnapshotsForMeta({
      ctx,
      remotePeerId: 'peer-changed-manifest',
      contextGraphId: 'cg-changed-manifest',
      deadline: Date.now() + 60_000,
      snapshotWalk: {
        orderedManifestSnapshot: () => snapshots.map((snapshot) => ({ ...snapshot })),
        isResolved: () => false,
        resolvedCount: () => 0,
        resolvedRefsSnapshot: () => [],
        suppressedMetadataRows: () => [],
        markResolved: () => {},
      },
      publicSnapshotStore: {
        getSnapshot: async () => null,
        putSnapshot: async ({ digest }) => ({ ref: digest, byteLength: 1 }),
      },
      fetchSyncPages: async (
        _ctx,
        _peer,
        contextGraphId,
        _includeSharedMemory,
        phase,
        _graph,
        _deadline,
        options,
      ) => {
        const ref = options!.snapshotRef!;
        fetchedRefs.push(ref);
        return pageResult(contextGraphId, phase, {
          quads: ref === firstDigest ? first : second,
        });
      },
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
    });

    expect(fetchedRefs).toEqual([firstDigest, secondDigest]);
    expect(result).toMatchObject({
      readySnapshots: 2,
      totalSnapshots: 2,
      completed: true,
      missingCount: 0,
    });
  });
});

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
      // Full rootless snapshots now require a fresh, complete META manifest
      // before DATA. Exercise phase-level progress accounting on the delta
      // path, where independent resumed META/DATA cursors remain valid.
      sinceBatchIdFor: () => 'progress-cursor',
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
    const setCheckpoint = recorder((_key: string, _checkpoint: DurableSyncCheckpointWrite) => {});
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
    expect(setCheckpoint.calls).toContainEqual([
      'large-cg:data',
      { offset: 500, responderSessionOffset: undefined },
    ]);
  });

  it('does not report durable checkpoint progress when data is rejected for missing meta', async () => {
    const setCheckpoint = recorder((_key: string, _checkpoint: DurableSyncCheckpointWrite) => {});
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
    const setCheckpoint = recorder((_key: string, _checkpoint: DurableSyncCheckpointWrite) => {});
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
    const setCheckpoint = recorder((_key: string, _checkpoint: DurableSyncCheckpointWrite) => {});
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
      sinceBatchIdFor: () => 'meta-only-cursor',
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
    expect(setCheckpoint.calls).toContainEqual([
      'meta-only-cg:meta',
      { offset: 5, responderSessionOffset: undefined },
    ]);
  });

  it('advances the meta cursor when every fetched metadata row was deliberately discarded', async () => {
    const setCheckpoint = recorder((_key: string, _checkpoint: DurableSyncCheckpointWrite) => {});
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
      sinceBatchIdFor: () => 'discarded-controls-cursor',
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
    expect(setCheckpoint.calls).toEqual([[
      'discarded-controls:meta',
      { offset: 3, responderSessionOffset: undefined },
    ]]);
  });

  it('keeps the meta cursor pinned when discarded rows do not account for the whole page', async () => {
    const setCheckpoint = recorder((_key: string, _checkpoint: DurableSyncCheckpointWrite) => {});
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
    const setCheckpoint = recorder((_key: string, _checkpoint: DurableSyncCheckpointWrite) => {});
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
      sinceBatchIdFor: () => 'discarded-non-iri-cursor',
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
    expect(setCheckpoint.calls).toEqual([[
      'discarded-non-iri:meta',
      { offset: 3, responderSessionOffset: undefined },
    ]]);
  });

  it('advances the meta cursor when a mixed page is fully discarded by controls + non-IRI drops (#1921)', async () => {
    // A mixed all-discarded page (some unverified controls + some non-IRI rows):
    // the worker sums both reasons into consumedUnpersistedMetaTriples === the
    // fetched total, so the requester advances the cursor rather than pinning.
    const setCheckpoint = recorder((_key: string, _checkpoint: DurableSyncCheckpointWrite) => {});
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
      sinceBatchIdFor: () => 'discarded-mixed-cursor',
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
    expect(setCheckpoint.calls).toEqual([[
      'discarded-mixed:meta',
      { offset: 3, responderSessionOffset: undefined },
    ]]);
  });

  it('deletes only the durable meta checkpoint after completing metadata-only responses', async () => {
    const metaQuad = quad('meta-only-complete-meta');
    const storeInsert = recorder(async (_request: DurableSyncStoreInsertRequest) => {});
    const setCheckpoint = recorder((_key: string, _checkpoint: DurableSyncCheckpointWrite) => {});
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
    const setCheckpoint = recorder((_key: string, _checkpoint: DurableSyncCheckpointWrite) => {});
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
    expect(fetchSyncPages.calls).toContainEqual([ctx, 'peer-a', 'open-swm', true, 'data', expect.any(String), expect.any(Number), undefined]);
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
    expect(fetchSyncPages.calls).toContainEqual([ctx, 'peer-a', 'open-swm', true, 'data', expect.any(String), expect.any(Number), undefined]);
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
    expect(fetchSyncPages.calls).toContainEqual([ctx, 'peer-a', 'open-swm', true, 'data', expect.any(String), expect.any(Number), undefined]);
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
    expect(fetchSyncPages.calls).toContainEqual([ctx, 'peer-a', 'open-swm', true, 'data', expect.any(String), expect.any(Number), undefined]);
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
    expect(setCheckpoint.calls).toContainEqual(['large-swm:data', 7, 7]);
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
    materializationFailures: 0,
  };
  const completeSmaller: SwmSnapshotCoverage = {
    contextGraphId: COVERAGE_CG,
    peerIdSuffix: 'bbbb2222',
    snapshotsResolved: 200,
    snapshotsTotal: 200,
    manifestComplete: true,
    missingCount: 0,
    missingSample: [],
    materializationFailures: 0,
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
      materializationFailures: 0,
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
      descriptorsAuthoritative: true,
      missingCount: 2,
      // The ref that was never served, named — not an empty placeholder. The
      // sample and the count come from the same walk, so they cannot disagree.
      missingSample: ['digest-never-served'],
      // Fetch shortfall only — every ref that DID arrive was written.
      materializationFailures: 0,
    });
  });

  it('counts a complete manifest ref with NO descriptor as resolved, so a fully synced peer stops being capable', async () => {
    // The defect behind this row is NON-TERMINATION, not a cosmetically wrong
    // number. `snapshotsTotal` counts refs in the PEER'S MANIFEST
    // (`collectPublicSnapshotMetadata` over the round's verified meta);
    // `snapshotsResolved` counts refs this node MATERIALIZED. A manifest ref
    // that the round's verified metadata does not DESCRIBE has no descriptor,
    // so it could never enter `materializedRefs` — and `snapshotsResolved <
    // snapshotsTotal` is exactly the predicate `capablePeersForNextPass`
    // (packages/cli/src/catchup-runner-worker-impl.ts) uses to decide a peer
    // still owes us Knowledge Assets. It therefore held FOREVER: every later
    // catch-up job spent its whole pass budget re-walking a Context Graph that
    // was already complete, at O(KA size) per cached ref, and no number of
    // passes could ever clear it.
    //
    // THE MANIFEST MUST BE MIXED, and that is the whole difficulty of this
    // fixture. `onSnapshotReady` USED TO BE wired only when
    // `snapshotDescriptorsByRef` was non-empty, so on the pre-fix tree a
    // manifest in which NO ref had a descriptor never called
    // `materializeReadySnapshot` at all: it would report `0/N` for a reason
    // that has nothing to do with the code under test, and would read green
    // both with the fix and without it. At least one described ref is what
    // opened the hook the undescribed ref then had to travel through — which is
    // why THIS row, and not an all-undescribed one, is the row that fails on
    // the pre-fix tree. The hook is now wired unconditionally, and the
    // all-undescribed manifest that guard hid — the entity-share shape, which
    // is most Context Graphs — is pinned by the row below.
    //
    // The two halves are the real production shape rather than two invented
    // rows: ONE Knowledge Asset shared TWICE. `replaceHeadMetadata` is
    // head-subject scoped, so a peer that re-shares a KA keeps the SUPERSEDED
    // share-operation row in its metadata graph while its head names the
    // current operation. `parseGraphScopedSwmRecoveryDescriptors` only visits
    // operation subjects a head names, so the superseded row yields no
    // descriptor — while still carrying `publicQuadsDigest`/`publicQuadsCount`,
    // which is all `collectPublicSnapshotMetadata` needs to put it in the
    // manifest. That asymmetry between the two readers IS the bug.
    //
    // Only the CURRENT share's head rows are kept. Both versions share one head
    // subject (`<ual>#dkg-swm-head`), so including both would merge their rows
    // and `requirePositiveInteger(assertionVersion)` would throw; the surrounding
    // catch clears ALL descriptors and materialization is silently disabled for
    // the whole Context Graph — the fixture would stop testing rather than fail.
    //
    // Both halves come from ONE `swmFixtures(COVERAGE_CG)` call, so every
    // metadata-graph URI agrees with the Context Graph under sync by
    // construction instead of by a hand-matched constant.
    //
    // What this row does NOT pin: the `manifestComplete` half of the gate. A
    // truncated meta phase parses no descriptors at all, so "no descriptor"
    // there means "not known yet" and must NOT count — that boundary needs its
    // own row and is deliberately not smuggled into this one.
    const { share } = swmFixtures(COVERAGE_CG);
    const RESHARED_UAL = 'did:dkg:hardhat:31337/0xcccccccccccccccccccccccccccccccccccccccc/1';
    const superseded = share({
      version: 1, operationId: 'op-superseded', marker: 'superseded', ual: RESHARED_UAL, payloadCount: 2,
    });
    const current = share({
      version: 2, operationId: 'op-current', marker: 'current', ual: RESHARED_UAL, payloadCount: 3,
    });
    const meta = [
      ...current.meta,
      ...superseded.meta.filter((quadRow) => quadRow.subject === superseded.operationSubject),
    ];

    // Both snapshots already cached: this is the state of a node whose earlier
    // passes did the work. Distinct payload sizes give distinct digests, so the
    // manifest really carries two refs (see the `snapshotsTotal` note below).
    const cached = new Map<string, Quad[]>([
      [current.digest, current.payload],
      [superseded.digest, superseded.payload],
    ]);
    const snapshotFetches: string[] = [];

    // A real store and the real materializer, for the same reason T14 uses
    // them: a hand-rolled stub that silently fails to materialize reproduces a
    // shortfall for a NEW reason and looks identical to the defect under test.
    const store = new OxigraphStore();
    const materializer = createSharedMemorySnapshotMaterializer({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });

    try {
      const summary = await runSharedMemorySync({
        ctx,
        remotePeerId: 'peer-resharing-5a5a5a5a',
        contextGraphIds: [COVERAGE_CG],
        createContextGraphSyncDeadline: () => Date.now() + 60_000,
        fetchSyncPages: async (
          _ctx: OperationContext,
          _peer: string,
          contextGraphId: string,
          _includeSharedMemory: boolean,
          phase: string,
          _graph: string,
          _deadline: number,
          fetchOptions?: { snapshotRef?: string },
        ) => {
          const snapshotRef = fetchOptions?.snapshotRef;
          if (phase === 'snapshot') snapshotFetches.push(String(snapshotRef));
          return pageResult(contextGraphId, phase);
        },
        processSharedMemoryBatch: async () => ({
          ...sharedMemoryProcessResult(),
          emptyResponses: 0,
          verifiedMeta: meta,
          totalFetchedMetaQuads: meta.length,
        }),
        ensureContextGraph: async () => {},
        storeInsert: async (quads: Quad[]) => { await store.insert(quads); },
        snapshotMaterializer: materializer,
        publicSnapshotStore: {
          getSnapshot: async (ref: string) => cached.get(ref) ?? null,
          putSnapshot: async () => ({ ref: 'unused', byteLength: 0 }),
        },
        deleteCheckpoint: () => {},
        setCheckpoint: () => {},
        ensureOwnedMap: () => new Map(),
        logInfo: noop,
        logWarn: noop,
        logDebug: noop,
      });

      // Fixture integrity first, so a broken fixture names itself instead of
      // surfacing as an unexplained count: both refs are pre-cached, so neither
      // may touch the transport. A digest that stopped matching would turn a
      // cache hit into a fetch and quietly change what the row measures.
      expect(snapshotFetches).toEqual([]);
      // The DESCRIBED half genuinely WROTE — which is what makes this manifest
      // mixed rather than two vacuous resolutions. If the described half ever
      // stopped materializing (a fixture the parser silently rejects, a
      // `replaceGraph` that no-ops, wiring that drops the materializer), the
      // coverage record could still read `2/2` by counting two undescribed refs
      // while nothing at all was written; the counters alone cannot see that.
      // `verifiedData` is empty here, so in-lock materialization is the only
      // possible source of data triples.
      expect(summary.insertedDataTriples).toBeGreaterThanOrEqual(current.payload.length);
      expect(summary.failedPhases).toBe(0);
      // Pre-fix this record was `1/2` with `missingCount: 1` — a peer that owed
      // this node nothing, reported as still owing it one Knowledge Asset, on
      // every pass forever. `snapshotsTotal: 2` doubles as the anti-vacuity
      // guard: if the two payloads ever collided on a digest, `byRef` would fold
      // them into a single ref and the manifest would stop being mixed while the
      // row went on passing.
      expect(summary.swmCoverage).toEqual({
        contextGraphId: COVERAGE_CG,
        peerIdSuffix: '5a5a5a5a',
        snapshotsResolved: 2,
        snapshotsTotal: 2,
        manifestComplete: true,
        descriptorsAuthoritative: true,
        missingCount: 0,
        missingSample: [],
        materializationFailures: 0,
      });
    } finally {
      await store.close().catch(() => {});
    }
  });

  it('counts a complete manifest with NO descriptor on ANY ref as resolved, so an entity-share Context Graph stops nominating its peer', async () => {
    // The row above has to build a MIXED manifest — one described ref, one
    // undescribed — because the old `snapshotDescriptorsByRef.size > 0` guard
    // wired `onSnapshotReady` only when SOMETHING was described. That guard hid
    // the larger case: a Context Graph in which NOTHING is described.
    //
    // That case is not a corner, it is the primary shared-memory write API.
    // `storeWorkspaceOperationPublicQuads` (packages/publisher/src/
    // workspace-resolution.ts) — the entity-level share — writes each root's
    // public slice under a `urn:dkg:public-stage:<cg>:<subGraph>:<op>:<root>`
    // subject carrying `dkg:publicQuadsDigest` + `dkg:publicQuadsCount`, and
    // writes NO `#dkg-swm-head` row at all; heads belong to the graph-scoped KA
    // path (`storeKnowledgeAssetOperationPublicQuads`). The two readers then
    // disagree about the very same metadata: `collectPublicSnapshotMetadata`
    // accepts ANY subject with digest+count, so the slice IS a manifest ref,
    // while `parseGraphScopedSwmRecoveryDescriptors` anchors ONLY on head
    // subjects, so it yields nothing. A Context Graph written entirely by
    // entity shares therefore advertises refs and produces zero descriptors —
    // for EVERY ref, not just one.
    //
    // Pre-fix such a graph could not reach `snapshotsResolved ===
    // snapshotsTotal` by ANY path: the hook was never wired, so
    // `materializeReadySnapshot` — and with it the vacuity branch the row above
    // pins — never ran. `snapshotsResolved < snapshotsTotal` is exactly the
    // predicate `capablePeersForNextPass` (packages/cli/src/
    // catchup-runner-worker-impl.ts) reads as "this peer still owes us
    // Knowledge Assets", so it nominated a peer that owed nothing on every pass
    // of every catch-up job, at O(KA size) per cached ref, for ever.
    //
    // BOTH writers are wired here, and that is the whole difference from
    // 'carries the round coverage onto the summary when the snapshot phase does
    // not finish' above, which asserts `0/2` with NO materializer. The two must
    // stay distinct: missing WIRING means nothing CAN be written, so those refs
    // are unresolved; no DESCRIPTOR under a COMPLETE manifest means there is
    // nothing to write, so these are resolved. Wiring the hook unconditionally
    // must not collapse that.
    //
    // The meta graph comes from `swmFixtures(COVERAGE_CG)` — the same builder
    // whose rows parse into REAL descriptors in the row above — so the empty
    // descriptor list asserted below is attributable to the subject shape
    // alone, not to a meta-graph URI the parser refuses to visit.
    const { metaGraph } = swmFixtures(COVERAGE_CG);
    const SHARE_OP = 'op-entity-share-1';
    const ROOT = 'https://example.org/thing/1';
    // One root's public slice, as `filterQuadsForRoot` hands it to
    // `putSnapshot`. Digest and count are taken FROM this payload because
    // `hasValidSnapshot` re-checks both against the cached blob: a hand-written
    // count would turn a cache hit into a network fetch and quietly move the
    // row onto a different branch of the walk.
    const payload: Quad[] = [
      { subject: ROOT, predicate: 'https://schema.org/name', object: '"Thing One"', graph: '' } as Quad,
      { subject: ROOT, predicate: 'https://schema.org/color', object: '"blue"', graph: '' } as Quad,
    ];
    const digest = workspacePublicQuadsDigest(payload);
    const sliceSubject = `urn:dkg:public-stage:${[COVERAGE_CG, '_', SHARE_OP, ROOT].map(encodeURIComponent).join(':')}`;
    const meta: Quad[] = [
      // Production-generated, not invented: these are the share-operation rows
      // an entity share writes alongside the slice. They contribute neither a
      // manifest ref (no digest/count) nor a descriptor (no head names this
      // operation), which is what leaves the slice row as the only thing under
      // test while keeping the fixture the shape a real peer would serve.
      ...generateShareMetadata({
        shareOperationId: SHARE_OP,
        contextGraphId: COVERAGE_CG,
        rootEntities: [ROOT],
        publisherPeerId: 'peer-source',
        timestamp: new Date(0),
      }, metaGraph),
      // The slice rows themselves, in `storeWorkspaceOperationPublicQuads`
      // order. Deliberately NO `dkg:publicSnapshotGraph` row: with a snapshot
      // store configured the blob is keyed by its digest and `ref === digest`,
      // and that absence is precisely what makes this row a snapshot-FETCH
      // target instead of a graph-sync one. `publicQuadsCount` keeps its
      // `xsd:integer` type because that is how production writes it.
      { subject: sliceSubject, predicate: 'http://dkg.io/ontology/contextGraphId', object: `"${COVERAGE_CG}"`, graph: metaGraph } as Quad,
      { subject: sliceSubject, predicate: 'http://dkg.io/ontology/shareOperationId', object: `"${SHARE_OP}"`, graph: metaGraph } as Quad,
      { subject: sliceSubject, predicate: 'http://dkg.io/ontology/publicSliceRootEntity', object: ROOT, graph: metaGraph } as Quad,
      { subject: sliceSubject, predicate: 'http://dkg.io/ontology/publicQuadsDigest', object: `"${digest}"`, graph: metaGraph } as Quad,
      {
        subject: sliceSubject,
        predicate: 'http://dkg.io/ontology/publicQuadsCount',
        object: `"${payload.length}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
        graph: metaGraph,
      } as Quad,
      { subject: sliceSubject, predicate: 'http://dkg.io/ontology/publisherPeerId', object: '"peer-source"', graph: metaGraph } as Quad,
      { subject: sliceSubject, predicate: 'http://dkg.io/ontology/publishedAt', object: `"${new Date(0).toISOString()}"`, graph: metaGraph } as Quad,
    ];

    // Fixture integrity across BOTH readers, asserted before the sync so a
    // fixture that drifted names itself instead of surfacing as an unexplained
    // count. The manifest must really carry this one ref (or `snapshotsTotal:
    // 1` below would be measuring something else), and NOTHING may be
    // described (or this row would silently become a second copy of the mixed
    // row above, travelling the described path it is meant to avoid).
    expect(collectPublicSnapshotMetadata(meta)).toEqual([{
      ref: digest,
      digest,
      count: payload.length,
      publishedAtMs: 0,
    }]);
    expect(parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: COVERAGE_CG, metaQuads: meta })).toEqual([]);

    // The blob is already cached: the state of a node whose earlier pass
    // fetched it. Nothing here is missing — the peer owes this node nothing.
    const cached = new Map<string, Quad[]>([[digest, payload]]);
    const snapshotFetches: string[] = [];

    // A real store and the real materializer, as the rows above use them: with
    // a hand-rolled stub, "nothing was written" would be unfalsifiable, and the
    // `insertedDataTriples` witness below could not distinguish a vacuous
    // resolution from a materializer that silently does nothing.
    const store = new OxigraphStore();
    const materializer = createSharedMemorySnapshotMaterializer({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });

    try {
      const summary = await runSharedMemorySync({
        ctx,
        remotePeerId: 'peer-entity-share-1a2b3c4d',
        contextGraphIds: [COVERAGE_CG],
        createContextGraphSyncDeadline: () => Date.now() + 60_000,
        fetchSyncPages: async (
          _ctx: OperationContext,
          _peer: string,
          contextGraphId: string,
          _includeSharedMemory: boolean,
          phase: string,
          _graph: string,
          _deadline: number,
          fetchOptions?: { snapshotRef?: string },
        ) => {
          const snapshotRef = fetchOptions?.snapshotRef;
          if (phase === 'snapshot') snapshotFetches.push(String(snapshotRef));
          // Every phase completes cleanly, so `manifestComplete` is true — the
          // other half of the vacuity gate. A truncated meta phase parses no
          // descriptors either, and there "no descriptor" means "not known
          // yet"; that boundary is a separate row and is not smuggled in here.
          return pageResult(contextGraphId, phase);
        },
        processSharedMemoryBatch: async () => ({
          ...sharedMemoryProcessResult(),
          emptyResponses: 0,
          verifiedMeta: meta,
          totalFetchedMetaQuads: meta.length,
        }),
        ensureContextGraph: async () => {},
        storeInsert: async (quads: Quad[]) => { await store.insert(quads); },
        snapshotMaterializer: materializer,
        publicSnapshotStore: {
          getSnapshot: async (ref: string) => cached.get(ref) ?? null,
          putSnapshot: async () => ({ ref: 'unused', byteLength: 0 }),
        },
        deleteCheckpoint: () => {},
        setCheckpoint: () => {},
        ensureOwnedMap: () => new Map(),
        logInfo: noop,
        logWarn: noop,
        logDebug: noop,
      });

      // Pre-cached, so the ref must not touch the transport; a digest that
      // stopped matching the payload would turn this into a fetch.
      expect(snapshotFetches).toEqual([]);
      expect(summary.failedPhases).toBe(0);
      // The vacuity witness, and what separates this row from the mixed one
      // above, where the described half genuinely writes: here there is nothing
      // to write, so nothing IS written. The ref is resolved because a complete
      // manifest does not describe it — not because a materializer ran.
      expect(summary.insertedDataTriples).toBe(0);
      // Pre-fix: `0/1`, `missingCount: 1`, permanently — for a peer this node
      // was fully synced with, and for EVERY Context Graph written by entity
      // shares. `snapshotsResolved === snapshotsTotal` is what makes
      // `capablePeersForNextPass`'s `resolved < total` false and finally stops
      // the nomination.
      expect(summary.swmCoverage).toEqual({
        contextGraphId: COVERAGE_CG,
        peerIdSuffix: '1a2b3c4d',
        snapshotsResolved: 1,
        snapshotsTotal: 1,
        manifestComplete: true,
        descriptorsAuthoritative: true,
        missingCount: 0,
        missingSample: [],
        materializationFailures: 0,
      });
    } finally {
      await store.close().catch(() => {});
    }
  });

  it('does NOT resolve a manifest ref when the descriptors failed to PARSE, so a round that wrote nothing cannot report full coverage', async () => {
    // THE THIRD STATE, and the one neither row above can see. Both of them
    // reach the vacuity branch of `materializeReadySnapshot` with an EMPTY
    // descriptor map under a COMPLETE manifest, and both are right to count the
    // ref resolved: nothing was described because there was nothing to
    // describe. A parse FAILURE lands on the same branch with the same two
    // observables — and there "no descriptor" means the round never learned
    // what it was supposed to write.
    //
    // `manifestComplete` cannot discriminate, and that is the whole defect.
    // `parseGraphScopedSwmRecoveryDescriptors` is called inside a block whose
    // entry condition is `wsMetaResult.completed` — the same value that becomes
    // `manifestComplete` — so on the failure path it is guaranteed TRUE exactly
    // where the map is guaranteed empty for the wrong reason. With the hook now
    // wired unconditionally (see the row above, which is what opened this path
    // to every ref), the consequences compounded: every manifest ref took the
    // vacuity branch, a round that wrote ZERO Knowledge Assets reported FULL
    // coverage, `materializationFailures` stayed 0 because nothing was ever
    // ATTEMPTED, `snapshotPhaseUsable` therefore read true, the bulk
    // `storeInsert(processed.verifiedMeta)` landed head rows certifying
    // assertion graphs that hold nothing, the peer was dropped as satisfied,
    // and the next round's `isGraphAssetMaterialized` sees those markers and
    // skips the Knowledge Assets for good. Every one of those is wrong in the
    // FLATTERING direction, which is the direction no downstream reader can
    // detect — the operator is told the graph is complete.
    //
    // THE POISON IS PRODUCTION-REACHABLE, which is why it is this shape and not
    // an invented malformed row. Two `dkg:assertionVersion` rows on one
    // `#dkg-swm-head` subject is union-insert residue: what a pass that
    // replaced a graph and stopped before the metadata swap leaves behind. This
    // branch's own materializer names and REPAIRS that state
    // (`storedHead.needsRepair`), so it demonstrably occurs — and any peer
    // still running the pre-repair code serves it to us verbatim. (A head at a
    // `contentScopeVersion` above `GRAPH_KA_CONTENT_SCOPE_VERSION`, written by
    // a newer node, is the other reachable trigger for the same catch and
    // produces these same numbers by the same path.)
    //
    // The residue sits on the SECOND Knowledge Asset deliberately. The first
    // one's rows are impeccable and it is STILL not written, because the parser
    // builds its whole array before returning: one malformed head discards the
    // descriptors of every valid KA alongside it. On the first KA the counters
    // would come out identical while pinning none of that.
    const { manifest, metaGraph } = swmFixtures(COVERAGE_CG);
    const [validKa, residueKa] = manifest(2);
    const meta: Quad[] = [
      ...validKa.meta,
      ...residueKa.meta,
      {
        subject: residueKa.headSubject,
        predicate: 'http://dkg.io/ontology/assertionVersion',
        object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: metaGraph,
      } as Quad,
    ];

    // Fixture integrity BY MESSAGE and before the sync, because every counter
    // below is `0` and a fixture that started throwing for an unrelated reason
    // (a meta-graph URI the parser refuses to visit, a drifted operation
    // subject) would reproduce all of them while testing nothing — the "a wrong
    // fixture stops testing rather than failing" trap `swm-descriptor-fixtures`
    // documents. Called the way production calls it: no `registeredSubGraphNames`,
    // since both Knowledge Assets are root-lane.
    expect(() => parseGraphScopedSwmRecoveryDescriptors({
      contextGraphId: COVERAGE_CG,
      metaQuads: meta,
    })).toThrow(/ambiguous assertionVersion/);
    // ...and the manifest really carries TWO refs, so `snapshotsTotal: 2` below
    // is measuring what it claims. `manifest()` gives the two KAs different
    // payload sizes precisely so their digests cannot collide; a collision
    // would fold them into one ref and `snapshotsResolved: 0` would go on
    // passing against a one-ref manifest.
    expect(collectPublicSnapshotMetadata(meta).map((entry) => entry.ref).sort())
      .toEqual([validKa.digest, residueKa.digest].sort());

    // Both blobs already cached — the state of a node whose earlier passes
    // fetched them. Nothing here is missing from the TRANSPORT's point of view,
    // so the shortfall asserted below can only come from the parse failure.
    const cached = new Map<string, Quad[]>([
      [validKa.digest, validKa.payload],
      [residueKa.digest, residueKa.payload],
    ]);
    const snapshotFetches: string[] = [];

    // The real materializer over a real store, as the rows above use it — a
    // hand-rolled stub that silently writes nothing would reproduce
    // `resolved: 0` for a NEW reason and look identical to a pass. Wrapped in
    // an explicitly delegating counter rather than a spread: `withKaWriteLock`
    // is the gate everything else runs behind, and a wrapper that broke it
    // would make "nothing was written" true for the wrong reason.
    const store = new OxigraphStore();
    const real = createSharedMemorySnapshotMaterializer({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });
    const replacedGraphs: string[] = [];
    const materializer: SharedMemorySnapshotMaterializer = {
      withKaWriteLock: (contextGraphId, subGraphName, kaUal, fn) => (
        real.withKaWriteLock(contextGraphId, subGraphName, kaUal, fn)
      ),
      readStoredHead: (descriptor) => real.readStoredHead(descriptor),
      isGraphAssetMaterialized: (descriptor) => real.isGraphAssetMaterialized(descriptor),
      replaceGraph: async (graphUri, quads) => {
        replacedGraphs.push(graphUri);
        await real.replaceGraph(graphUri, quads);
      },
      replaceHeadMetadata: (contextGraphId, descriptor) => (
        real.replaceHeadMetadata(contextGraphId, descriptor)
      ),
    };

    try {
      const summary = await runSharedMemorySync({
        ctx,
        remotePeerId: 'peer-head-residue-7c7c7c7c',
        contextGraphIds: [COVERAGE_CG],
        createContextGraphSyncDeadline: () => Date.now() + 60_000,
        fetchSyncPages: async (
          _ctx: OperationContext,
          _peer: string,
          contextGraphId: string,
          _includeSharedMemory: boolean,
          phase: string,
          _graph: string,
          _deadline: number,
          fetchOptions?: { snapshotRef?: string },
        ) => {
          const snapshotRef = fetchOptions?.snapshotRef;
          if (phase === 'snapshot') snapshotFetches.push(String(snapshotRef));
          // Every phase completes cleanly. That is not incidental: it is what
          // makes `manifestComplete` true, which is the field that turns this
          // into the third state rather than the truncated-meta one.
          return pageResult(contextGraphId, phase);
        },
        processSharedMemoryBatch: async () => ({
          ...sharedMemoryProcessResult(),
          emptyResponses: 0,
          verifiedMeta: meta,
          totalFetchedMetaQuads: meta.length,
        }),
        ensureContextGraph: async () => {},
        storeInsert: async (quads: Quad[]) => { await store.insert(quads); },
        snapshotMaterializer: materializer,
        publicSnapshotStore: {
          getSnapshot: async (ref: string) => cached.get(ref) ?? null,
          putSnapshot: async () => ({ ref: 'unused', byteLength: 0 }),
        },
        deleteCheckpoint: () => {},
        setCheckpoint: () => {},
        ensureOwnedMap: () => new Map(),
        logInfo: noop,
        logWarn: noop,
        logDebug: noop,
      });

      // Both refs were served from cache, so the snapshot plane completed and
      // the transport is exonerated: a digest that stopped matching its payload
      // would turn a cache hit into a fetch and move this row onto the
      // fetch-shortfall branch that the first coverage row already owns.
      expect(snapshotFetches).toEqual([]);
      // THE ANTI-VACUITY WITNESS, and the reason this row cannot pass under an
      // implementation that writes everything correctly: not one assertion
      // graph was replaced. Without it, `snapshotsResolved: 0` alone would also
      // be satisfied by a materializer that ran and wrote all of them, and the
      // coverage number would have nothing to agree WITH.
      //
      // That the builder's descriptors are MATERIALIZABLE at all is the one
      // property this row cannot self-witness, and it is pinned by T14 below,
      // which shares this builder and asserts two Knowledge Assets written
      // against a real store. An empty list here is therefore attributable to
      // the parse failure rather than to a fixture that could never have
      // written anything — the `/ambiguous assertionVersion/` guard above
      // constrains the parser, not the materializer.
      expect(replacedGraphs).toEqual([]);
      // Corroboration from the summary's own ledger: `verifiedData` is empty
      // here, so in-lock materialization is the only possible source of data
      // triples, and there were none.
      expect(summary.insertedDataTriples).toBe(0);
      // Pre-fix this record read `2/2` with `missingCount: 0` for a round that
      // wrote nothing at all. `manifestComplete: true` is the discriminator and
      // is pinned deliberately: if it ever came out `false`, these counts would
      // be right for the FIRST coverage row's reason (a truncated meta phase)
      // and this row would silently stop testing the flag. `missingSample` is
      // empty because the sample is only populated on the materialization-
      // FAILURE path, and here nothing was ever attempted — a known diagnostics
      // residual, not a disagreement with `missingCount`.
      expect(summary.swmCoverage).toEqual({
        contextGraphId: COVERAGE_CG,
        peerIdSuffix: '7c7c7c7c',
        snapshotsResolved: 0,
        snapshotsTotal: 2,
        manifestComplete: true,
        descriptorsAuthoritative: false,
        missingCount: 2,
        missingSample: [],
        materializationFailures: 0,
      });
      // The second half of the flag, and an INDEPENDENT one: coverage is what
      // the continuation loop reads, `failedPhases` is what stops the round
      // being stamped as caught up. A parse failure produces no
      // `materializationFailures` — nothing was attempted — so
      // `snapshotPhaseUsable` needs `descriptorsAuthoritative` in its
      // conjunction or the phase reads usable on a round that wrote nothing.
      expect(summary.failedPhases).toBeGreaterThanOrEqual(1);
      // ...which is what withholds the CERTIFICATION, the durable half of the
      // harm: the bulk `storeInsert(processed.verifiedMeta)` sits below the
      // unusable-phase `continue`, so no head row landed claiming an assertion
      // graph that holds nothing. Had it landed, the next round's
      // `isGraphAssetMaterialized` would see the marker and skip these
      // Knowledge Assets permanently.
      expect(summary.insertedMetaTriples).toBe(0);
    } finally {
      await store.close().catch(() => {});
    }
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
  const T14_UAL = 'did:dkg:hardhat:31337/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const { share } = swmFixtures(T14_CG);

  const stores: OxigraphStore[] = [];
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  });

  it('carries the resolved count out through the throw instead of reporting zero', async () => {
    // Two Knowledge Assets whose snapshots are already cached — and therefore
    // materializable without a fetch — then a third whose fetch blows up.
    //
    // The metadata is DESCRIPTOR-shaped, built by the shared fixtures, rather
    // than the bare `publicQuadsDigest`/`publicQuadsCount` pair this row used
    // to carry. That is the entire point of the row. Materialization is gated
    // on `snapshotDescriptorsByRef.size > 0`, which only descriptor-shaped meta
    // populates — so under the old shape nothing could ever materialize and
    // `snapshotsResolved` was `0` BY CONSTRUCTION, under a title promising a
    // non-zero count. The row passed while unable to observe its own property.
    //
    // Two opposite properties live on this field and a no-materializer fixture
    // collapses them to the same number:
    //   - do not OVER-report: a round that fetches N and materializes 0 must
    //     not claim `N/N` (covered by the coverage rows in this file);
    //   - do not UNDER-report: a round that materializes some and then THROWS
    //     must report what it wrote, not zero — which is what this row pins,
    //     and the reason the carry-through-the-throw change exists at all.
    const resolvedA = share({ version: 1, operationId: 'op-a', marker: 't14-a', ual: `${T14_UAL}/1` });
    const resolvedB = share({ version: 1, operationId: 'op-b', marker: 't14-b', ual: `${T14_UAL}/2`, payloadCount: 3 });
    const unreachable = share({ version: 1, operationId: 'op-boom', marker: 't14-boom', ual: `${T14_UAL}/3`, payloadCount: 4 });
    const meta = [...resolvedA.meta, ...resolvedB.meta, ...unreachable.meta];

    // A real store and the real materializer: a hand-rolled stub that silently
    // fails to materialize would reproduce `resolved: 0` for a NEW reason and
    // look identical to a pass.
    const store = new OxigraphStore();
    stores.push(store);
    const materializer = createSharedMemorySnapshotMaterializer({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });

    const cached = new Map<string, Quad[]>([
      [resolvedA.digest, resolvedA.payload],
      [resolvedB.digest, resolvedB.payload],
    ]);

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
        // Only the uncached third ref reaches a fetch; the other two are served
        // from cache and never touch the transport.
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
      storeInsert: async (quads: Quad[]) => { await store.insert(quads); },
      snapshotMaterializer: materializer,
      publicSnapshotStore: {
        getSnapshot: async (ref: string) => cached.get(ref) ?? null,
        putSnapshot: async () => ({ ref: 'unused', byteLength: 0 }),
      },
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      ensureOwnedMap: () => new Map(),
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    // Pre-fix the whole record was `undefined` — the throw unwound past it, so
    // the pass looked non-advancing and the peer was dropped. What this row now
    // pins is stronger: the record survives the throw carrying the count of
    // Knowledge Assets actually MATERIALIZED (2), not refs fetched and not zero.
    expect(summary.swmCoverage).toEqual({
      contextGraphId: T14_CG,
      peerIdSuffix: '99887766',
      snapshotsResolved: 2,
      snapshotsTotal: 3,
      manifestComplete: true,
      descriptorsAuthoritative: true,
      missingCount: 1,
      missingSample: [unreachable.digest],
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
