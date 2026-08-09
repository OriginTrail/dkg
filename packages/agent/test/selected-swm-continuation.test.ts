import { describe, expect, it, vi } from 'vitest';
import {
  contextGraphWorkspaceMetaGraphUri,
  PROTOCOL_SYNC,
} from '@origintrail-official/dkg-core';
import { workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import type {
  SharedMemorySyncResult,
  SwmSnapshotCoverage,
} from '../src/dkg-agent-types.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import {
  runSelectedSwmContinuations,
  SelectedSwmContinuationPlan,
} from '../src/sync/selected-swm-continuation.js';

const PEER = '12D3KooWSelectedCompleteSwmProvider';

const DKG = 'http://dkg.io/ontology/';

function snapshotManifest(contextGraphId: string, count: number): {
  meta: Quad[];
  payloadByRef: Map<string, Quad[]>;
} {
  const metaGraph = contextGraphWorkspaceMetaGraphUri(contextGraphId);
  const meta: Quad[] = [];
  const payloadByRef = new Map<string, Quad[]>();
  for (let index = 0; index < count; index += 1) {
    const payload: Quad[] = [{
      subject: `urn:selected-swm:${index}`,
      predicate: 'http://schema.org/value',
      object: `"${index}"`,
      graph: '',
    }];
    const digest = workspacePublicQuadsDigest(payload);
    const subject = `urn:selected-swm-manifest:${index}`;
    meta.push(
      {
        subject,
        predicate: `${DKG}publicQuadsDigest`,
        object: `"${digest}"`,
        graph: metaGraph,
      },
      {
        subject,
        predicate: `${DKG}publicQuadsCount`,
        object: '"1"',
        graph: metaGraph,
      },
    );
    payloadByRef.set(digest, payload);
  }
  return { meta, payloadByRef };
}

function cleanDurableResult(): SharedMemorySyncResult {
  return {
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
    failedPeers: 0,
    failedPhases: 0,
    deniedPhases: 0,
    backoffWorthyFailures: 0,
    deferredBackpressure: 0,
    snapshotPlaneIncomplete: 0,
    replayPhaseBytesReceived: 0,
    snapshotPhaseBytesReceived: 0,
  };
}

function result(
  contextGraphId: string,
  snapshotsResolved: number,
  snapshotsTotal: number,
  options: {
    completed?: boolean;
    deferredBackpressure?: number;
    insertedDataTriples?: number;
  } = {},
): SharedMemorySyncResult {
  const completed = options.completed ?? snapshotsResolved === snapshotsTotal;
  const swmCoverage: SwmSnapshotCoverage = {
    contextGraphId,
    peerIdSuffix: PEER.slice(-8),
    snapshotsResolved,
    snapshotsTotal,
    manifestComplete: true,
    missingCount: snapshotsTotal - snapshotsResolved,
    missingSample: [],
    materializationFailures: 0,
  };
  return {
    insertedTriples: options.insertedDataTriples ?? snapshotsResolved,
    fetchedMetaTriples: 0,
    fetchedDataTriples: 0,
    insertedMetaTriples: 0,
    insertedDataTriples: options.insertedDataTriples ?? snapshotsResolved,
    bytesReceived: 0,
    resumedPhases: 0,
    timedOutPhases: completed ? 0 : 1,
    completedPhases: completed ? 1 : 0,
    checkpointAdvances: snapshotsResolved > 0 ? 1 : 0,
    emptyResponses: 0,
    droppedDataTriples: 0,
    failedPeers: 0,
    failedPhases: 0,
    deniedPhases: 0,
    backoffWorthyFailures: completed ? 0 : 1,
    deferredBackpressure: options.deferredBackpressure ?? 0,
    snapshotPlaneIncomplete: completed ? 0 : 1,
    replayPhaseBytesReceived: 0,
    snapshotPhaseBytesReceived: 0,
    swmCoverage,
  };
}

function merge(
  summary: SharedMemorySyncResult,
  part: SharedMemorySyncResult,
): SharedMemorySyncResult {
  return {
    ...part,
    insertedTriples: summary.insertedTriples + part.insertedTriples,
    insertedDataTriples: summary.insertedDataTriples + part.insertedDataTriples,
    deferredBackpressure:
      (summary.deferredBackpressure ?? 0) + (part.deferredBackpressure ?? 0),
  };
}

describe('selected RFC-64 SWM continuation', () => {
  it('re-enters admission promptly until incomplete coverage becomes complete', async () => {
    const contextGraphId = 'selected-public';
    const plan = new SelectedSwmContinuationPlan(
      PEER,
      [contextGraphId],
      { maxPasses: 4, budgetMs: 600_000 },
      0,
    );
    plan.recordRound(contextGraphId, result(contextGraphId, 1, 3));
    const admissions: number[] = [];

    const summary = await runSelectedSwmContinuations({
      plan,
      initialResult: result(contextGraphId, 1, 3),
      nowMs: () => 1,
      runPass: async (contextGraphIds) => {
        admissions.push(plan.startContinuationPass(contextGraphIds[0]!));
        const complete = result(contextGraphId, 3, 3, { insertedDataTriples: 2 });
        plan.recordRound(contextGraphId, complete);
        return complete;
      },
      merge,
    });

    expect(admissions).toEqual([1]);
    expect(summary.continuationPasses).toBe(1);
    expect(summary.swmCoverage).toMatchObject({ snapshotsResolved: 3, snapshotsTotal: 3 });
  });

  it('allows one capable zero-progress retry, then stops when coverage stalls', async () => {
    const contextGraphId = 'selected-stalled';
    const plan = new SelectedSwmContinuationPlan(
      PEER,
      [contextGraphId],
      { maxPasses: 4, budgetMs: 600_000 },
      0,
    );
    const stalled = result(contextGraphId, 0, 3);
    plan.recordRound(contextGraphId, stalled);
    const stop = vi.fn();
    let admissions = 0;

    const summary = await runSelectedSwmContinuations({
      plan,
      initialResult: stalled,
      nowMs: () => 1,
      runPass: async (contextGraphIds) => {
        admissions += 1;
        plan.startContinuationPass(contextGraphIds[0]!);
        plan.recordRound(contextGraphId, stalled);
        return stalled;
      },
      merge,
      onStop: stop,
    });

    expect(admissions).toBe(1);
    expect(summary.continuationPasses).toBe(1);
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId,
      reason: 'coverage-stalled',
    }));
  });

  it('keeps independent per-CG coverage and continues only the incomplete graph', () => {
    const plan = new SelectedSwmContinuationPlan(
      PEER,
      ['complete-cg', 'incomplete-cg'],
      { maxPasses: 4, budgetMs: 600_000 },
      0,
    );
    plan.recordRound('complete-cg', result('complete-cg', 2, 2));
    plan.recordRound('incomplete-cg', result('incomplete-cg', 1, 5));

    const selection = plan.selectNextPass(1);

    expect(selection.contextGraphIds).toEqual(['incomplete-cg']);
    expect(selection.stops).toEqual([
      expect.objectContaining({ contextGraphId: 'complete-cg', reason: 'plane-proven' }),
    ]);
  });

  it('stops at four total passes even while coverage keeps advancing', () => {
    const contextGraphId = 'selected-bounded';
    const plan = new SelectedSwmContinuationPlan(
      PEER,
      [contextGraphId],
      { maxPasses: 4, budgetMs: 600_000 },
      0,
    );
    plan.recordRound(contextGraphId, result(contextGraphId, 1, 5));

    for (const resolved of [2, 3, 4]) {
      expect(plan.selectNextPass(1).contextGraphIds).toEqual([contextGraphId]);
      plan.startContinuationPass(contextGraphId);
      plan.recordRound(contextGraphId, result(contextGraphId, resolved, 5));
    }

    expect(plan.selectNextPass(1).stops).toEqual([
      expect.objectContaining({
        contextGraphId,
        continuationPasses: 3,
        reason: 'max-passes-reached',
      }),
    ]);
  });

  it('does not start a continuation after the absolute budget expires', () => {
    const contextGraphId = 'selected-expired';
    const plan = new SelectedSwmContinuationPlan(
      PEER,
      [contextGraphId],
      { maxPasses: 4, budgetMs: 10 },
      100,
    );
    plan.recordRound(contextGraphId, result(contextGraphId, 1, 2));

    expect(plan.selectNextPass(110)).toEqual({
      contextGraphIds: [],
      stops: [expect.objectContaining({ contextGraphId, reason: 'budget-exhausted' })],
    });
  });

  it('stops immediately on initial or continuation backpressure', async () => {
    const contextGraphId = 'selected-pressure';
    const initialBackpressure = result(contextGraphId, 1, 3, { deferredBackpressure: 1 });
    const initialPlan = new SelectedSwmContinuationPlan(
      PEER,
      [contextGraphId],
      { maxPasses: 4, budgetMs: 600_000 },
      0,
    );
    initialPlan.recordRound(contextGraphId, initialBackpressure);
    const initialRun = vi.fn();
    const initialStop = vi.fn();

    await runSelectedSwmContinuations({
      plan: initialPlan,
      initialResult: initialBackpressure,
      nowMs: () => 1,
      runPass: initialRun,
      merge,
      onBackpressure: initialStop,
    });
    expect(initialRun).not.toHaveBeenCalled();
    expect(initialStop).toHaveBeenCalledOnce();

    const continuationPlan = new SelectedSwmContinuationPlan(
      PEER,
      [contextGraphId],
      { maxPasses: 4, budgetMs: 600_000 },
      0,
    );
    const incomplete = result(contextGraphId, 1, 3);
    continuationPlan.recordRound(contextGraphId, incomplete);
    const continuationStop = vi.fn();
    const continuationRun = vi.fn(async (contextGraphIds: readonly string[]) => {
      continuationPlan.startContinuationPass(contextGraphIds[0]!);
      return result(contextGraphId, 1, 3, { deferredBackpressure: 1 });
    });

    await runSelectedSwmContinuations({
      plan: continuationPlan,
      initialResult: incomplete,
      nowMs: () => 1,
      runPass: continuationRun,
      merge,
      onBackpressure: continuationStop,
    });
    expect(continuationRun).toHaveBeenCalledOnce();
    expect(continuationStop).toHaveBeenCalledOnce();
  });
});

describe('selected RFC-64 SWM lifecycle wiring', () => {
  it('keeps the reserved selected-provider lane public-only and leaves private recovery ordinary', async () => {
    const publicCg = 'selected-public-cg';
    const privateCg = 'did:dkg:agent:0x1111111111111111111111111111111111111111/private-cg';
    const syncCalls: Array<{
      contextGraphIds: readonly string[];
      selected: boolean;
    }> = [];
    const mixedPlan = {
      publicContextGraphIds: [publicCg],
      privateRecoverFromCurator: [privateCg],
      eligibleContextGraphIds: [publicCg, privateCg],
    };
    const agent = {
      started: true,
      config: {
        syncOnConnect: true,
        syncSharedMemoryOnConnect: true,
        syncContextGraphs: [publicCg, privateCg],
        rfc64PublicCatalogBootstrap: {
          acceptedPublicPolicies: [{ completeSwmProviders: [PEER] }],
        },
      },
      networkAdmissionCoordinator: { isAcceptedPeer: () => true },
      syncingPeers: new Set<string>(),
      knownCorePeerIds: new Set<string>(),
      knownCorePeerIdsV2: new Set<string>(),
      skippedNoSyncPeers: new Set<string>(),
      lastSuccessfulSyncAt: new Map<string, number>(),
      lastSyncProgressAt: new Map<string, number>(),
      syncReconcilerBackoff: new Map<string, unknown>(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      planSharedMemorySyncContextGraphs: async () => mixedPlan,
      resolveRfc64CompleteSwmProviderPeerIdsV1: (contextGraphId: string) => (
        contextGraphId === publicCg ? [PEER] : []
      ),
      syncFromPeerDetailed: async () => 0,
      refreshMetaSyncedFlags: async () => undefined,
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeerDetailed: async (
        _peerId: string,
        contextGraphIds: readonly string[],
        options: { selectedSwmPriority?: boolean } = {},
      ) => {
        syncCalls.push({
          contextGraphIds: [...contextGraphIds],
          selected: options.selectedSwmPriority === true,
        });
        return cleanDurableResult();
      },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };

    await (LifecycleSyncMethods.prototype.trySyncFromPeer as any).call(agent, PEER);

    expect(syncCalls).toEqual([
      { contextGraphIds: [publicCg], selected: true },
      { contextGraphIds: [privateCg], selected: false },
    ]);
  });

  it('continues a voluntary 672/905 public snapshot yield to 905/905 with fresh admission', async () => {
    const publicCg = 'selected-production-shape';
    const privateCg = 'selected-private-unaffected';
    const { meta, payloadByRef } = snapshotManifest(publicCg, 905);
    const store = new OxigraphStore();
    const admissions: Array<{
      contextGraphId: string;
      selected: boolean;
      priority: number | undefined;
      event: 'start' | 'end';
    }> = [];
    let activeAdmissions = 0;
    let maxActiveAdmissions = 0;
    let publicAdmissions = 0;
    let initialSnapshotReads = 0;
    let wallNow = 1_000;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => wallNow);
    const snapshotFetches: string[] = [];

    const publicSnapshotStore = {
      getSnapshot: async (ref: string) => {
        const payload = payloadByRef.get(ref) ?? null;
        if (publicAdmissions === 1) {
          initialSnapshotReads += 1;
          if (initialSnapshotReads === 672) wallNow += 120_000;
        }
        return payload;
      },
      putSnapshot: async ({ digest }: { digest: string }) => ({ ref: digest, byteLength: 0 }),
    };
    const agent = {
      config: {
        syncContextGraphPriorities: { [publicCg]: 100, [privateCg]: 0 },
      },
      store,
      writeLocks: new Map<string, Promise<void>>(),
      publicSnapshotStore,
      listSubGraphs: async () => [],
      createContextGraphSyncDeadline: () => wallNow + 1,
      fetchSyncPages: async (
        _ctx: unknown,
        _peerId: string,
        contextGraphId: string,
        _includeSharedMemory: boolean,
        phase: string,
        _graphUri: string,
        _deadline: number,
        snapshotRef?: string,
      ) => {
        if (phase === 'snapshot') {
          snapshotFetches.push(snapshotRef ?? 'missing-ref');
          throw new Error('all snapshot fixtures should be cache hits');
        }
        const quads = phase === 'meta' && contextGraphId === publicCg ? meta : [];
        return {
          quads,
          bytesReceived: quads.length,
          resumedFromOffset: 0,
          nextOffset: quads.length,
          checkpointKey: `${contextGraphId}:${phase}`,
          completed: true,
          timedOut: false,
        };
      },
      getOrCreateSyncVerifyWorker: () => ({
        processSharedMemoryBatch: async (dataQuads: Quad[], metaQuads: Quad[]) => ({
          verifiedData: dataQuads,
          verifiedMeta: metaQuads,
          totalFetchedDataQuads: dataQuads.length,
          totalFetchedMetaQuads: metaQuads.length,
          droppedDataTriples: 0,
          emptyResponses: 0,
          entityCreators: [],
        }),
      }),
      runContextGraphSyncWithBackpressure: async (
        _ctx: unknown,
        contextGraphId: string,
        _lane: string,
        _operationId: string,
        work: () => Promise<SharedMemorySyncResult>,
        admission: { priorityOverride?: number; selectedSwmPriority?: boolean },
      ) => {
        activeAdmissions += 1;
        maxActiveAdmissions = Math.max(maxActiveAdmissions, activeAdmissions);
        if (contextGraphId === publicCg) publicAdmissions += 1;
        const row = {
          contextGraphId,
          selected: admission.selectedSwmPriority === true,
          priority: admission.priorityOverride,
        };
        admissions.push({ ...row, event: 'start' });
        try {
          return await work();
        } finally {
          admissions.push({ ...row, event: 'end' });
          activeAdmissions -= 1;
        }
      },
      syncCheckpoints: new Map<string, number>(),
      workspaceOwnedEntities: new Map<string, Map<string, string>>(),
      invalidateListContextGraphsCache: () => {},
      contextGraphMetaProjection: { markDirtyFromQuads: () => {} },
      oversizeTombstoneLog: { record: () => {} },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };

    try {
      const summary = await (
        LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailed as any
      ).call(agent, PEER, [publicCg, privateCg], {
        selectedSwmPriority: true,
        priority: 2_000,
        sharedMemorySyncPlan: {
          publicContextGraphIds: [publicCg],
          privateRecoverFromCurator: [privateCg],
          eligibleContextGraphIds: [publicCg, privateCg],
        },
      });

      expect(summary.swmCoverage).toMatchObject({
        contextGraphId: publicCg,
        snapshotsResolved: 905,
        snapshotsTotal: 905,
        missingCount: 0,
      });
      expect(summary.continuationPasses).toBe(1);
      expect(summary.snapshotPlaneIncomplete).toBe(1);
      expect(summary.failedPhases).toBe(1);
      expect(summary.timedOutPhases).toBe(0);
      expect(summary.backoffWorthyFailures).toBe(0);
      expect(initialSnapshotReads).toBe(672);
      expect(snapshotFetches).toEqual([]);
      expect(maxActiveAdmissions).toBe(1);
      expect(admissions).toEqual([
        { contextGraphId: publicCg, selected: true, priority: 2_000, event: 'start' },
        { contextGraphId: publicCg, selected: true, priority: 2_000, event: 'end' },
        { contextGraphId: privateCg, selected: false, priority: undefined, event: 'start' },
        { contextGraphId: privateCg, selected: false, priority: undefined, event: 'end' },
        { contextGraphId: publicCg, selected: true, priority: 2_000, event: 'start' },
        { contextGraphId: publicCg, selected: true, priority: 2_000, event: 'end' },
      ]);
    } finally {
      dateNow.mockRestore();
      await store.close();
    }
  });

  it('rechecks the continuation budget after queued scheduler admission', async () => {
    const contextGraphId = 'selected-expired-in-queue';
    const { meta, payloadByRef } = snapshotManifest(contextGraphId, 2);
    const store = new OxigraphStore();
    const priorBudget = process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS;
    process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS = '50';
    let wallNow = 2_000;
    let publicAdmissions = 0;
    let snapshotReads = 0;
    let metaFetches = 0;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => wallNow);
    const agent = {
      config: { syncContextGraphPriorities: {} },
      store,
      writeLocks: new Map<string, Promise<void>>(),
      publicSnapshotStore: {
        getSnapshot: async (ref: string) => {
          snapshotReads += 1;
          if (publicAdmissions === 1 && snapshotReads === 1) wallNow += 120_000;
          return payloadByRef.get(ref) ?? null;
        },
        putSnapshot: async ({ digest }: { digest: string }) => ({ ref: digest, byteLength: 0 }),
      },
      listSubGraphs: async () => [],
      createContextGraphSyncDeadline: () => wallNow + 1,
      fetchSyncPages: async (
        _ctx: unknown,
        _peerId: string,
        _contextGraphId: string,
        _includeSharedMemory: boolean,
        phase: string,
      ) => {
        if (phase === 'meta') metaFetches += 1;
        if (phase === 'snapshot') throw new Error('unexpected snapshot fetch');
        const quads = phase === 'meta' ? meta : [];
        return {
          quads,
          bytesReceived: 0,
          resumedFromOffset: 0,
          nextOffset: quads.length,
          checkpointKey: `${contextGraphId}:${phase}`,
          completed: true,
          timedOut: false,
        };
      },
      getOrCreateSyncVerifyWorker: () => ({
        processSharedMemoryBatch: async (dataQuads: Quad[], metaQuads: Quad[]) => ({
          verifiedData: dataQuads,
          verifiedMeta: metaQuads,
          totalFetchedDataQuads: dataQuads.length,
          totalFetchedMetaQuads: metaQuads.length,
          droppedDataTriples: 0,
          emptyResponses: 0,
          entityCreators: [],
        }),
      }),
      runContextGraphSyncWithBackpressure: async (
        _ctx: unknown,
        _contextGraphId: string,
        _lane: string,
        _operationId: string,
        work: () => Promise<SharedMemorySyncResult>,
      ) => {
        publicAdmissions += 1;
        if (publicAdmissions === 2) {
          await new Promise((resolve) => setTimeout(resolve, 75));
        }
        return work();
      },
      syncCheckpoints: new Map<string, number>(),
      workspaceOwnedEntities: new Map<string, Map<string, string>>(),
      invalidateListContextGraphsCache: () => {},
      contextGraphMetaProjection: { markDirtyFromQuads: () => {} },
      oversizeTombstoneLog: { record: () => {} },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };

    try {
      const summary = await (
        LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailed as any
      ).call(agent, PEER, [contextGraphId], {
        selectedSwmPriority: true,
        priority: 2_000,
        sharedMemorySyncPlan: {
          publicContextGraphIds: [contextGraphId],
          privateRecoverFromCurator: [],
          eligibleContextGraphIds: [contextGraphId],
        },
      });

      expect(publicAdmissions).toBe(2);
      expect(metaFetches).toBe(1);
      expect(snapshotReads).toBe(1);
      expect(summary.continuationPasses).toBe(0);
      expect(summary.swmCoverage).toMatchObject({
        snapshotsResolved: 1,
        snapshotsTotal: 2,
      });
    } finally {
      dateNow.mockRestore();
      if (priorBudget === undefined) delete process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS;
      else process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS = priorBudget;
      await store.close();
    }
  });
});
