import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { runSyncOnConnect } from '../src/sync/on-connect/sync-on-connect.js';
import {
  PEER,
  callSelectedSharedMemorySummary,
  createSelectedSwmLifecycleHarness,
  result,
  snapshotManifest,
} from './selected-swm-test-helpers.js';

describe('selected RFC-64 SWM lifecycle queue and budgets', () => {
  it('does not fetch a selected scope when the caller-supplied plan names a non-provider peer', async () => {
    const publicCg = 'selected-preplanned-non-provider';
    const manifest = snapshotManifest(publicCg, 1);
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      completeSwmProviders: ['12D3KooWAnotherCompleteProvider'],
      clock: { now: () => 1_000, deadline: () => 61_000 },
    });

    try {
      const summary = await callSelectedSharedMemorySummary(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        priority: 2_000,
        sharedMemorySyncPlan: {
          publicContextGraphIds: [publicCg],
          privateRecoverFromCurator: [],
          eligibleContextGraphIds: [publicCg],
        },
      });

      expect(harness.probes.metaFetches()).toBe(0);
      expect(harness.probes.dataFetches()).toBe(0);
      expect(harness.probes.snapshotReads()).toBe(0);
      expect(summary.insertedTriples).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('releases the shared metadata budget before the next serialized owner generation', async () => {
    const publicCg = 'selected-overlap-shared-retention-budget';
    const manifest = snapshotManifest(publicCg, 2);
    let firstFetchStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstFetchStarted = resolve; });
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const acceptedRows: Array<number | undefined> = [];
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => 1_000, deadline: () => 61_000 },
      metaContinuationLimits: {
        rows: manifest.meta.length,
        bytesEstimate: 1024 * 1024,
        globalRows: manifest.meta.length,
        globalBytesEstimate: 1024 * 1024,
      },
      metaPages: [
        {
          quads: manifest.meta,
          resumedFromOffset: 0,
          nextOffset: manifest.meta.length,
          completed: true,
          timedOut: false,
        },
        {
          quads: manifest.meta,
          resumedFromOffset: 0,
          nextOffset: manifest.meta.length,
          completed: true,
          timedOut: false,
        },
      ],
      onMetaFetch: async ({ fetch, maxAcceptedQuads }) => {
        acceptedRows.push(maxAcceptedQuads);
        if (fetch === 1) {
          firstFetchStarted();
          await firstRelease;
        }
      },
    });
    const plan = {
      publicContextGraphIds: [publicCg],
      privateRecoverFromCurator: [],
      eligibleContextGraphIds: [publicCg],
    };

    try {
      const first = callSelectedSharedMemorySummary(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        priority: 2_000,
        sharedMemorySyncPlan: plan,
      });
      await firstStarted;
      const second = callSelectedSharedMemorySummary(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        priority: 2_001,
        sharedMemorySyncPlan: plan,
      });
      await Promise.resolve();
      expect(harness.probes.metaFetches()).toBe(1);
      releaseFirst();

      const [firstSummary, secondSummary] = await Promise.all([first, second]);

      expect(acceptedRows).toEqual([manifest.meta.length, manifest.meta.length]);
      expect(harness.probes.metaFetches()).toBe(2);
      expect(harness.probes.processedMetaBatches).toEqual([manifest.meta, manifest.meta]);
      expect(firstSummary.failedPhases).toBe(0);
      expect(secondSummary.failedPhases).toBe(0);
      expect(harness.agent.syncCheckpoints.size).toBe(0);
    } finally {
      releaseFirst();
      await harness.close();
    }
  });

  it('does not lose a queued incomplete retry marker when an earlier call completes', async () => {
    const completeCg = 'selected-overlap-complete';
    const incompleteCg = 'selected-overlap-incomplete';
    let wallNow = 1_000;
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstBlocked = false;
    const harness = createSelectedSwmLifecycleHarness({
      // The first selected call is a clean empty 0/0 graph. The queued second
      // call owns a five-ref manifest and its four bounded admissions each
      // materialize one ref, so it remains genuinely incomplete after
      // zero-ref completion became explicit terminal evidence. Five is
      // intentional: selected snapshot continuation now skips the resolved
      // prefix, so a two-ref fixture correctly completes on its second pass.
      contextGraphs: { public: incompleteCg },
      manifest: snapshotManifest(incompleteCg, 5),
      clock: { now: () => wallNow, deadline: () => wallNow + 1 },
      reportEmptyResponse: true,
      beforeAdmissionRun: async ({ contextGraphId }) => {
        if (contextGraphId !== completeCg || firstBlocked) return;
        firstBlocked = true;
        signalFirstStarted();
        await firstRelease;
      },
      onSnapshotRead: () => { wallNow += 120_000; },
    });
    const completePlan = {
      publicContextGraphIds: [completeCg],
      privateRecoverFromCurator: [],
      eligibleContextGraphIds: [completeCg],
    };
    const incompletePlan = {
      publicContextGraphIds: [incompleteCg],
      privateRecoverFromCurator: [],
      eligibleContextGraphIds: [incompleteCg],
    };

    try {
      const first = callSelectedSharedMemorySummary(harness.agent, [completeCg], {
        selectedSwmPriority: true,
        priority: 2_000,
        sharedMemorySyncPlan: completePlan,
      });
      await firstStarted;
      const second = callSelectedSharedMemorySummary(harness.agent, [incompleteCg], {
        selectedSwmPriority: true,
        priority: 2_001,
        sharedMemorySyncPlan: incompletePlan,
      });
      await Promise.resolve();
      releaseFirst();

      const [completeSummary, incompleteSummary] = await Promise.all([first, second]);
      expect(completeSummary.swmCoverage).toMatchObject({
        contextGraphId: completeCg,
        snapshotsResolved: 0,
        snapshotsTotal: 0,
      });
      expect(incompleteSummary.swmCoverage).toMatchObject({
        contextGraphId: incompleteCg,
        snapshotsResolved: 4,
        snapshotsTotal: 5,
      });
      expect(harness.agent.selectedSwmBootstrapAdmission.isRetryRequired(PEER)).toBe(true);
    } finally {
      releaseFirst();
      await harness.close();
    }
  });

  it('fails closed when a retained metadata prefix exceeds the local resource budget', async () => {
    const publicCg = 'selected-metadata-resource-cap';
    const manifest = snapshotManifest(publicCg, 2);
    const onMetaFetch = vi.fn();
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => 1_000, deadline: () => 1_001 },
      metaContinuationLimits: { rows: 1, bytesEstimate: 1024 * 1024 },
      onMetaFetch,
      metaPages: [{
        quads: manifest.meta.slice(0, 2),
        resumedFromOffset: 0,
        nextOffset: 2,
        completed: false,
        timedOut: true,
      }],
    });

    try {
      const summary = await callSelectedSharedMemorySummary(
        harness.agent,
        [publicCg],
        {
          selectedSwmPriority: true,
          priority: 2_000,
          sharedMemorySyncPlan: {
            publicContextGraphIds: [publicCg],
            privateRecoverFromCurator: [],
            eligibleContextGraphIds: [publicCg],
          },
        },
      );

      expect(harness.probes.metaFetches()).toBe(1);
      expect(onMetaFetch).toHaveBeenCalledWith(expect.objectContaining({
        maxAcceptedQuads: 1,
        maxAcceptedHeapBytesEstimate: 1024 * 1024,
      }));
      expect(harness.probes.processedMetaBatches).toEqual([]);
      expect(summary.failedPhases).toBe(1);
      expect(summary.continuationPasses).toBe(0);
      expect(harness.agent.syncCheckpoints.size).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('reuses a complete retained manifest when a later aggregate-data phase fails', async () => {
    const publicCg = 'selected-complete-metadata-reuse';
    const manifest = snapshotManifest(publicCg, 3);
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => 1_000, deadline: () => 61_000 },
      dataFailuresBeforeSuccess: 1,
    });

    try {
      const summary = await callSelectedSharedMemorySummary(
        harness.agent,
        [publicCg],
        {
          selectedSwmPriority: true,
          priority: 2_000,
          sharedMemorySyncPlan: {
            publicContextGraphIds: [publicCg],
            privateRecoverFromCurator: [],
            eligibleContextGraphIds: [publicCg],
          },
        },
      );

      expect(harness.probes.publicAdmissions()).toBe(2);
      expect(harness.probes.metaFetches()).toBe(1);
      expect(harness.probes.dataFetches()).toBe(2);
      expect(harness.probes.processedMetaBatches).toEqual([manifest.meta]);
      expect(summary.continuationPasses).toBe(1);
      expect(summary.swmCoverage).toMatchObject({
        snapshotsResolved: 3,
        snapshotsTotal: 3,
      });
      expect(harness.agent.syncCheckpoints.size).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('fails closed instead of splicing a tail from an incompatible metadata offset', async () => {
    const publicCg = 'selected-metadata-offset-mismatch';
    const manifest = snapshotManifest(publicCg, 3);
    const firstPrefix = manifest.meta.slice(0, 4);
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => 1_000, deadline: () => 1_001 },
      metaPages: [
        {
          quads: firstPrefix,
          resumedFromOffset: 0,
          nextOffset: firstPrefix.length,
          completed: false,
          timedOut: true,
        },
        {
          quads: manifest.meta.slice(1),
          resumedFromOffset: 1,
          nextOffset: manifest.meta.length,
          completed: true,
          timedOut: false,
        },
      ],
    });

    try {
      const summary = await callSelectedSharedMemorySummary(
        harness.agent,
        [publicCg],
        {
          selectedSwmPriority: true,
          priority: 2_000,
          stopOnBackoffWorthyFailure: true,
          sharedMemorySyncPlan: {
            publicContextGraphIds: [publicCg],
            privateRecoverFromCurator: [],
            eligibleContextGraphIds: [publicCg],
          },
        },
      );

      expect(harness.probes.metaFetches()).toBe(2);
      expect(harness.probes.processedMetaBatches).toEqual([]);
      expect(summary.failedPhases).toBe(1);
      expect(summary.swmCoverage).toBeUndefined();
      expect(harness.agent.syncCheckpoints.size).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('rechecks the continuation budget after queued scheduler admission', async () => {
    const contextGraphId = 'selected-expired-in-queue';
    const priorBudget = process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS;
    process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS = '50';
    let wallNow = 2_000;
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: contextGraphId },
      manifest: snapshotManifest(contextGraphId, 2),
      clock: { now: () => wallNow, deadline: () => wallNow + 1 },
      onSnapshotRead: ({ publicAdmission, snapshotRead }) => {
        if (publicAdmission === 1 && snapshotRead === 1) wallNow += 120_000;
      },
      beforeAdmissionRun: async ({ publicAdmission }) => {
        if (publicAdmission === 2) {
          await new Promise((resolve) => setTimeout(resolve, 75));
        }
      },
    });

    try {
      const summary = await callSelectedSharedMemorySummary(
        harness.agent,
        [contextGraphId],
        {
        selectedSwmPriority: true,
        priority: 2_000,
        sharedMemorySyncPlan: {
          publicContextGraphIds: [contextGraphId],
          privateRecoverFromCurator: [],
          eligibleContextGraphIds: [contextGraphId],
        },
        },
      );

      expect(harness.probes.publicAdmissions()).toBe(2);
      expect(harness.probes.metaFetches()).toBe(1);
      expect(harness.probes.snapshotReads()).toBe(1);
      expect(summary.continuationPasses).toBe(0);
      expect(summary.swmCoverage).toMatchObject({
        snapshotsResolved: 1,
        snapshotsTotal: 2,
      });
    } finally {
      if (priorBudget === undefined) delete process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS;
      else process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS = priorBudget;
      await harness.close();
    }
  });

  it('does not hide an unrelated shared-memory phase failure', async () => {
    const contextGraphId = 'selected-with-unrelated-failure';
    const onPeerSynced = vi.fn();
    const shared = {
      ...result(contextGraphId, 3, 3),
      failedPhases: 2,
      snapshotPlaneIncomplete: 1,
      resolvedSnapshotPlaneIncomplete: 1,
    };

    await runSyncOnConnect({
      remotePeer: PEER,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      knownCorePeerIdsV2: new Set(),
      getSyncContextGraphs: () => [],
      getDurableSyncContextGraphs: () => [],
      getSharedMemorySyncContextGraphs: () => [contextGraphId],
      selectedSharedMemoryLane: {
        getContextGraphIds: () => [contextGraphId],
        syncFromPeer: async () => ({
          kind: 'selected-shared-memory',
          requestedScope: { kind: 'selected-public' },
          shared,
          scopeComplete: true,
          completion: {
            selectedPublicScopeComplete: true,
            recoveryPlanComplete: true,
          },
        }),
      },
      syncFromPeer: async () => 0,
      refreshMetaSyncedFlags: async () => undefined,
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer: async () => shared,
      onPeerSynced,
      logInfo: () => {},
    });

    expect(onPeerSynced).toHaveBeenCalledWith(PEER, {
      fresh: false,
      progress: true,
    });
  });
});
