import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { InMemoryPeerSyncLease, runSyncOnConnect } from '../src/sync/on-connect/sync-on-connect.js';
import { ordinaryLane } from './_helpers/run-sync-on-connect.js';
import {
  Rfc64SwmRecoveryTargetLeaseV1,
  Rfc64SwmRecoveryTargetRevokedErrorV1,
} from '../src/dkg-agent-rfc64-swm-recovery-runtime.js';
import { classifySharedMemoryFreshness } from '../src/sync/shared-memory-freshness.js';
import {
  PEER,
  callSelectedSharedMemoryFromPeerDetailed,
  callSelectedSharedMemorySummary,
  createSelectedSwmLifecycleHarness,
  result,
  snapshotManifest,
} from './selected-swm-test-helpers.js';

const ACTIVE_SYNC_LIFETIME = new AbortController().signal;

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
        recoveryTargets: [{ contextGraphId: publicCg, lane: 'selected-public' }],
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
      targets: [{ contextGraphId: publicCg, lane: 'selected-public' as const }],
    };

    try {
      const first = callSelectedSharedMemorySummary(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        priority: 2_000,
        recoveryTargets: plan.targets,
      });
      await firstStarted;
      const second = callSelectedSharedMemorySummary(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        priority: 2_001,
        recoveryTargets: plan.targets,
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

  it('asks every peer of a walk wider than the metadata pool about a graph that holds nothing', async () => {
    // A public graph without content, followed from a node with eight
    // sync-capable peers. The limits are the defaults: each metadata fetch
    // reserves one whole prefix allowance and the pool holds three. An empty
    // graph can only be proven empty by a round in which every peer answered,
    // so a peer that is reported as timed out without having been asked makes
    // that proof impossible.
    const publicCg = 'selected-empty-graph-wide-walk';
    const peers = Array.from({ length: 8 }, (_, index) => `12D3KooWEmptyGraphWalkPeer${index}`);
    let releaseOpening!: () => void;
    const openingRelease = new Promise<void>((resolve) => { releaseOpening = resolve; });
    let signalPoolReserved!: () => void;
    const poolReserved = new Promise<void>((resolve) => { signalPoolReserved = resolve; });
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest: snapshotManifest(publicCg, 0),
      clock: { now: () => 1_000, deadline: () => 61_000 },
      completeSwmProviders: [],
      reportEmptyResponse: true,
      onMetaFetch: async ({ fetch }) => {
        if (fetch > 3) return;
        if (fetch === 3) signalPoolReserved();
        await openingRelease;
      },
    });

    try {
      const walk = peers.map((remotePeerId) => callSelectedSharedMemoryFromPeerDetailed(
        harness.agent,
        [publicCg],
        {
          remotePeerId,
          selectedSwmPriority: true,
          priority: 2_000,
          recoveryTargets: [{ contextGraphId: publicCg, lane: 'selected-public' }],
        },
      ));
      await poolReserved;
      await new Promise((resolve) => setImmediate(resolve));
      // Three fetches hold the pool. The other five have neither asked their
      // peer nor given up on it.
      expect(harness.probes.metaFetches()).toBe(3);
      let settled = 0;
      for (const round of walk) void round.then(() => { settled += 1; });
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(0);

      releaseOpening();
      const rounds = await Promise.all(walk);

      expect(harness.probes.metaFetches()).toBe(peers.length);
      for (const round of rounds) {
        expect(round.shared).toMatchObject({
          emptyResponses: 1,
          completedPhases: 2,
          timedOutPhases: 0,
          failedPhases: 0,
          failedPeers: 0,
          metadataContinuationYields: 0,
        });
        expect(round.shared.swmCoverage).toMatchObject({
          snapshotsTotal: 0,
          manifestComplete: true,
        });
        // What the catch-up job reads from each peer of the walk.
        expect(classifySharedMemoryFreshness(round.shared, { complete: true }))
          .toMatchObject({ completedWithoutFailure: true, timedOut: false });
      }
    } finally {
      releaseOpening();
      await harness.close();
    }
  });

  it('ends a waiting round when its graph recovery is revoked, while the pool is still held', async () => {
    const publicCg = 'selected-revoked-while-waiting';
    const peers = Array.from({ length: 4 }, (_, index) => `12D3KooWRevokedWhileWaitingPeer${index}`);
    let releaseOpening!: () => void;
    const openingRelease = new Promise<void>((resolve) => { releaseOpening = resolve; });
    let signalPoolReserved!: () => void;
    const poolReserved = new Promise<void>((resolve) => { signalPoolReserved = resolve; });
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest: snapshotManifest(publicCg, 0),
      clock: { now: () => 1_000, deadline: () => 61_000 },
      completeSwmProviders: [],
      reportEmptyResponse: true,
      onMetaFetch: async ({ fetch }) => {
        if (fetch === 3) signalPoolReserved();
        await openingRelease;
      },
    });
    // One revocable lease a round, in the order the rounds start.
    const leases: AbortController[] = [];
    Reflect.set(harness.agent, 'acquireRfc64SwmRecoveryTargetLeaseV1', (
      target: { contextGraphId: string },
    ) => {
      const lease = new AbortController();
      leases.push(lease);
      return new Rfc64SwmRecoveryTargetLeaseV1(
        target.contextGraphId,
        lease.signal,
        () => !lease.signal.aborted,
      );
    });

    try {
      const walk = peers.map((remotePeerId) => callSelectedSharedMemoryFromPeerDetailed(
        harness.agent,
        [publicCg],
        {
          remotePeerId,
          selectedSwmPriority: true,
          priority: 2_000,
          recoveryTargets: [{ contextGraphId: publicCg, lane: 'selected-public' }],
        },
      ));
      let fourthEnded = false;
      void walk[3]!.then(() => { fourthEnded = true; }, () => { fourthEnded = true; });
      await poolReserved;
      await new Promise((resolve) => setImmediate(resolve));
      expect(harness.probes.metaFetches()).toBe(3);
      expect(fourthEnded).toBe(false);

      // The fourth round waits for the pool. Its recovery authority goes away
      // (an unsubscribe, say) while the three fetches are still in flight.
      // The round ends with it, well before its wait for the pool would.
      leases[3]!.abort(new Rfc64SwmRecoveryTargetRevokedErrorV1(publicCg));
      await vi.waitFor(() => expect(fourthEnded).toBe(true), { timeout: 2_000 });
      const revoked = await walk[3]!;

      // The round is over although nothing has freed the pool, it did not ask
      // its peer, and it does not count as an answer.
      expect(harness.probes.metaFetches()).toBe(3);
      expect(revoked.scopeComplete).toBe(false);
      expect(revoked.shared).toMatchObject({
        completedPhases: 0,
        emptyResponses: 0,
        failedPhases: 1,
        timedOutPhases: 0,
      });
      releaseOpening();
      const others = await Promise.all(walk.slice(0, 3));
      for (const round of others) expect(round.shared).toMatchObject({ emptyResponses: 1, failedPhases: 0 });
    } finally {
      releaseOpening();
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
      targets: [{ contextGraphId: completeCg, lane: 'selected-public' as const }],
    };
    const incompletePlan = {
      targets: [{ contextGraphId: incompleteCg, lane: 'selected-public' as const }],
    };

    try {
      const first = callSelectedSharedMemorySummary(harness.agent, [completeCg], {
        selectedSwmPriority: true,
        priority: 2_000,
        recoveryTargets: completePlan.targets,
      });
      await firstStarted;
      const second = callSelectedSharedMemorySummary(harness.agent, [incompleteCg], {
        selectedSwmPriority: true,
        priority: 2_001,
        recoveryTargets: incompletePlan.targets,
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
          recoveryTargets: [{ contextGraphId: publicCg, lane: 'selected-public' }],
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
          recoveryTargets: [{ contextGraphId: publicCg, lane: 'selected-public' }],
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
          recoveryTargets: [{ contextGraphId: publicCg, lane: 'selected-public' }],
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
        recoveryTargets: [{ contextGraphId, lane: 'selected-public' }],
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
    const ordinaryContextGraphId = 'ordinary-with-failure';
    const onSyncAccounting = vi.fn();
    const shared = {
      ...result(ordinaryContextGraphId, 3, 3),
      failedPhases: 2,
      localYield: true as const,
      snapshotPlaneIncomplete: 1,
      resolvedSnapshotPlaneIncomplete: 1,
    };

    await runSyncOnConnect({
      signal: ACTIVE_SYNC_LIFETIME,
      ordinarySharedMemoryLane: ordinaryLane(() => [ordinaryContextGraphId], async () => shared),
      remotePeer: PEER,
      syncingPeers: new InMemoryPeerSyncLease(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      knownCorePeerIdsV2: new Set(),
      getSyncContextGraphs: () => [],
      getDurableSyncContextGraphs: () => [],
      syncFromPeer: async () => 0,
      refreshMetaSyncedFlags: async () => undefined,
      discoverContextGraphsFromStore: async () => 0,
      onSyncAccounting,
      logInfo: () => {},
    });

    expect(onSyncAccounting).toHaveBeenCalledWith(PEER, {
      reconcilerDisposition: 'clear',
      fresh: false,
      progress: true,
    });
  });
});
