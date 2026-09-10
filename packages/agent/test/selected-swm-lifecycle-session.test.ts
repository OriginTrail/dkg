import { describe, expect, it, vi } from 'vitest';
import type { SharedMemorySyncResult } from '../src/dkg-agent-types.js';
import { classifySharedMemoryFreshness } from '../src/sync/shared-memory-freshness.js';
import {
  PEER,
  callSelectedSharedMemoryFromPeerDetailed,
  callSelectedSharedMemorySummary,
  callSyncSharedMemoryFromPeerDetailed,
  createSelectedSwmLifecycleHarness,
  snapshotManifest,
} from './selected-swm-test-helpers.js';

describe('selected RFC-64 SWM lifecycle retained sessions', () => {
  it('completes private-only recovery without creating a public metadata transfer', async () => {
    const publicCg = 'private-only-public-control';
    const privateCg = '0x1111111111111111111111111111111111111111/private-only';
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg, private: privateCg },
      manifest: snapshotManifest(publicCg, 0),
      clock: { now: () => 1_000, deadline: () => 61_000 },
      reportEmptyResponse: true,
    });
    const getTransfers = vi.spyOn(harness.agent, 'getSwmMetaTransfers');

    try {
      const recovery = await callSelectedSharedMemoryFromPeerDetailed(
        harness.agent,
        [privateCg],
        {
          selectedSwmPriority: true,
          requestedScope: { kind: 'rfc64-recovery-plan' },
          recoveryTargets: [{ contextGraphId: privateCg, lane: 'ordinary-private' }],
        },
      );

      expect(recovery.scopeComplete).toBe(true);
      expect(recovery.targetDiagnostics.ordinaryPrivate).toEqual({ completed: 1, total: 1 });
      expect(getTransfers).not.toHaveBeenCalled();
      // Private recovery still reads its own metadata page without allocating
      // a public retained-transfer scope.
      expect(harness.probes.metaRequesterScopes).toEqual([undefined]);
    } finally {
      getTransfers.mockRestore();
      await harness.close();
    }
  });

  it('releases retained prefixes on node-lifecycle cleanup', async () => {
    const publicCg = 'selected-cross-outer-node-close';
    const manifest = snapshotManifest(publicCg, 2);
    const previousBudget = process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS;
    process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS = '0';
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => 1_000, deadline: () => 1_001 },
      metaPages: [
        {
          quads: manifest.meta.slice(0, 2),
          resumedFromOffset: 0,
          nextOffset: 2,
          completed: false,
          timedOut: true,
        },
        {
          quads: manifest.meta,
          resumedFromOffset: 0,
          nextOffset: manifest.meta.length,
          completed: true,
          timedOut: false,
        },
      ],
    });
    const plan = {
      targets: [{ contextGraphId: publicCg, lane: 'selected-public' as const }],
    };

    try {
      await callSelectedSharedMemorySummary(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        recoveryTargets: plan.targets,
      });
      await harness.agent.closeSwmMetaTransfers();
      await callSelectedSharedMemorySummary(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        recoveryTargets: plan.targets,
      });

      expect(harness.probes.metaRequesterScopes).toHaveLength(2);
      expect(harness.probes.metaRequesterScopes[1]).not.toBe(
        harness.probes.metaRequesterScopes[0],
      );
      expect(harness.probes.processedMetaBatches).toEqual([manifest.meta]);
    } finally {
      if (previousBudget === undefined) {
        delete process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS;
      } else {
        process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS = previousBudget;
      }
      await harness.close();
    }
  });

  it('resolves a completed metadata continuation while a later snapshot yield remains active', async () => {
    const publicCg = 'selected-metadata-complete-snapshot-incomplete';
    const manifest = snapshotManifest(publicCg, 2);
    const firstPrefix = manifest.meta.slice(0, 3);
    const finalSuffix = manifest.meta.slice(3);
    let wallNow = 1_000;
    const previousMaxPasses = process.env.DKG_SWM_CATCHUP_MAX_PASSES;
    process.env.DKG_SWM_CATCHUP_MAX_PASSES = '2';
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => wallNow, deadline: () => wallNow + 1 },
      metaPages: [
        {
          quads: firstPrefix,
          resumedFromOffset: 0,
          nextOffset: firstPrefix.length,
          completed: false,
          timedOut: true,
        },
        {
          quads: finalSuffix,
          resumedFromOffset: firstPrefix.length,
          nextOffset: manifest.meta.length,
          completed: true,
          timedOut: false,
        },
      ],
      onSnapshotRead: ({ publicAdmission, snapshotRead }) => {
        if (publicAdmission === 2 && snapshotRead === 1) wallNow += 120_000;
      },
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

      expect(summary.continuationPasses).toBe(1);
      expect(summary.metadataContinuationYields).toBe(1);
      expect(summary.timedOutPhases).toBe(1);
      expect(summary.resolvedMetadataContinuationYields).toBe(1);
      expect(summary.snapshotPlaneIncomplete).toBe(1);
      expect(summary.failedPhases).toBe(1);
      expect(summary.resolvedSnapshotPlaneIncomplete).toBe(0);
      const freshness = classifySharedMemoryFreshness(summary);
      expect(freshness.timedOut).toBe(false);
      expect(freshness.backoffWorthyFailure).toBe(false);
      expect(freshness.phaseFailed).toBe(true);
    } finally {
      if (previousMaxPasses === undefined) {
        delete process.env.DKG_SWM_CATCHUP_MAX_PASSES;
      } else {
        process.env.DKG_SWM_CATCHUP_MAX_PASSES = previousMaxPasses;
      }
      await harness.close();
    }
  });

  it('grants the newly capable snapshot domain a pass after an empty metadata EOF page', async () => {
    const publicCg = 'selected-empty-meta-eof-before-snapshots';
    const manifest = snapshotManifest(publicCg, 3);
    let wallNow = 1_000;
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => wallNow, deadline: () => wallNow + 1 },
      metaPages: [
        {
          // The first pass retained the entire manifest, but did not receive
          // the responder EOF marker before its bounded deadline.
          quads: manifest.meta,
          resumedFromOffset: 0,
          nextOffset: manifest.meta.length,
          completed: false,
          timedOut: true,
        },
        {
          // Exact empty EOF tail. Metadata is now complete, but this pass has
          // no time left to begin the newly discovered snapshot domain.
          quads: [],
          resumedFromOffset: manifest.meta.length,
          nextOffset: manifest.meta.length,
          completed: true,
          timedOut: false,
        },
      ],
      onMetaFetch: ({ fetch }) => {
        if (fetch === 2) wallNow += 120_000;
      },
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

      expect(harness.probes.metaFetches()).toBe(2);
      expect(harness.probes.publicAdmissions()).toBe(3);
      expect(harness.probes.snapshotReads()).toBe(3);
      expect(summary.continuationPasses).toBe(2);
      expect(summary.metadataContinuationYields).toBe(1);
      expect(summary.resolvedMetadataContinuationYields).toBe(1);
      expect(summary.snapshotPlaneIncomplete).toBe(1);
      expect(summary.resolvedSnapshotPlaneIncomplete).toBe(1);
      expect(summary.swmCoverage).toMatchObject({
        snapshotsResolved: 3,
        snapshotsTotal: 3,
        missingCount: 0,
      });
      expect(classifySharedMemoryFreshness(summary)).toMatchObject({
        phaseFailed: false,
        timedOut: false,
        backoffWorthyFailure: false,
      });
    } finally {
      await harness.close();
    }
  });

  it('treats a responder restart as a new progress generation and completes its replacement prefix', async () => {
    const publicCg = 'selected-restarted-metadata-generation';
    const manifest = snapshotManifest(publicCg, 3);
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => 1_000, deadline: () => 1_001 },
      metaPages: [
        {
          quads: manifest.meta.slice(0, 2),
          resumedFromOffset: 0,
          nextOffset: 14_000,
          completed: false,
          timedOut: true,
        },
        {
          quads: manifest.meta.slice(0, 2),
          resumedFromOffset: 0,
          nextOffset: 5_000,
          completed: false,
          timedOut: true,
        },
        {
          quads: manifest.meta.slice(2),
          resumedFromOffset: 5_000,
          nextOffset: 19_000,
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
          recoveryTargets: [{ contextGraphId: publicCg, lane: 'selected-public' }],
        },
      );

      expect(harness.probes.metaFetches()).toBe(3);
      expect(harness.probes.publicAdmissions()).toBe(3);
      expect(harness.probes.processedMetaBatches).toEqual([manifest.meta]);
      expect(summary.continuationPasses).toBe(2);
      expect(summary.metadataContinuationYields).toBe(2);
      expect(summary.resolvedMetadataContinuationYields).toBe(2);
      expect(summary.swmCoverage).toMatchObject({
        snapshotsResolved: 3,
        snapshotsTotal: 3,
        missingCount: 0,
      });
      expect(harness.agent.syncCheckpoints.size).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('drops a full old prefix and retries once when a fresh responder generation replaces it', async () => {
    const publicCg = 'selected-full-prefix-fresh-generation';
    const manifest = snapshotManifest(publicCg, 1);
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => 1_000, deadline: () => 1_001 },
      metaContinuationLimits: { rows: manifest.meta.length, bytesEstimate: 1024 * 1024 },
      metaPages: [
        {
          quads: manifest.meta,
          resumedFromOffset: 0,
          nextOffset: 14_000,
          completed: false,
          timedOut: true,
        },
        {
          // The old prefix owns the entire row allowance, so this first fresh
          // replacement attempt proves the restart by hitting the zero append
          // cap. The requester must discard the old generation and retry.
          quads: manifest.meta,
          resumedFromOffset: 0,
          nextOffset: 2,
          completed: true,
          timedOut: false,
          responderSessionStartedFresh: true,
        },
        {
          quads: manifest.meta,
          resumedFromOffset: 0,
          nextOffset: 2,
          completed: true,
          timedOut: false,
          responderSessionStartedFresh: true,
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
          recoveryTargets: [{ contextGraphId: publicCg, lane: 'selected-public' }],
        },
      );

      expect(harness.probes.metaFetches()).toBe(3);
      expect(harness.probes.processedMetaBatches).toEqual([manifest.meta]);
      expect(summary.continuationPasses).toBe(1);
      expect(summary.metadataContinuationYields).toBe(1);
      expect(summary.resolvedMetadataContinuationYields).toBe(1);
      expect(summary.failedPhases).toBe(0);
      expect(harness.agent.syncCheckpoints.size).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('serializes overlapping selected invocations behind one retained-prefix owner', async () => {
    const publicCg = 'selected-overlap-isolation';
    const manifest = snapshotManifest(publicCg, 2);
    const firstPrefix = manifest.meta.slice(0, 2);
    const finalSuffix = manifest.meta.slice(2);
    const previousBudget = process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS;
    process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS = '0';
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => 1_000, deadline: () => 61_000 },
      metaPages: [
        {
          quads: firstPrefix,
          resumedFromOffset: 0,
          nextOffset: firstPrefix.length,
          completed: false,
          timedOut: true,
        },
        {
          quads: finalSuffix,
          resumedFromOffset: firstPrefix.length,
          nextOffset: manifest.meta.length,
          completed: true,
          timedOut: false,
        },
      ],
      onMetaFetch: async ({ fetch }) => {
        if (fetch === 1) {
          signalFirstStarted();
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
      await Promise.all([first, second]);

      expect(harness.probes.metaRequesterScopes).toHaveLength(2);
      expect(new Set(harness.probes.metaRequesterScopes).size).toBe(1);
      expect(harness.probes.metaSinceBatchIds).toEqual([undefined, undefined]);
      expect(harness.probes.maxActiveAdmissions()).toBe(1);
      expect(harness.probes.processedMetaBatches).toEqual([manifest.meta]);
      expect(harness.agent.syncCheckpoints.size).toBe(0);
    } finally {
      releaseFirst();
      if (previousBudget === undefined) {
        delete process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS;
      } else {
        process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS = previousBudget;
      }
      await harness.close();
    }
  });

  it('shares one row of retention across ordinary and selected owners until the ordinary prefix is released', async () => {
    const publicCg = 'ordinary-selected-global-retention';
    const manifest = snapshotManifest(publicCg, 1);
    const oneRow = manifest.meta.slice(0, 1);
    const allowances: Array<{ scope: string | undefined; rows: number | undefined }> = [];
    const previousBudget = process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS;
    process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS = '0';
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => 1_000, deadline: () => 1_001 },
      metaContinuationLimits: { rows: 1, globalRows: 1, bytesEstimate: 4096, globalBytesEstimate: 4096 },
      metaPages: [
        { quads: oneRow, resumedFromOffset: 0, nextOffset: 1, completed: false, timedOut: true },
        // The selected owner must reject this row because the ordinary owner
        // still retains the only process-wide row allowance.
        { quads: oneRow, resumedFromOffset: 0, nextOffset: 1, completed: false, timedOut: true },
        // The ordinary owner's empty EOF consumes no additional capacity and
        // retires its retained prefix through the real lifecycle path.
        { quads: [], resumedFromOffset: 1, nextOffset: 1, completed: true, timedOut: false },
        { quads: oneRow, resumedFromOffset: 0, nextOffset: 1, completed: false, timedOut: true },
      ],
      onMetaFetch: ({ requesterScope, maxAcceptedQuads }) => {
        allowances.push({ scope: requesterScope, rows: maxAcceptedQuads });
      },
    });
    const plan = { targets: [{ contextGraphId: publicCg, lane: 'selected-public' as const }] };
    const ordinary = () => callSyncSharedMemoryFromPeerDetailed(harness.agent, [publicCg], { sharedMemorySyncPlan: plan });
    const selected = () => callSelectedSharedMemorySummary(harness.agent, [publicCg], {
      selectedSwmPriority: true, recoveryTargets: plan.targets,
    });
    try {
      const first = await ordinary();
      expect(first.metadataContinuationYields).toBe(1);
      expect(harness.agent.syncCheckpoints.size).toBe(1);
      const blocked = await selected();
      expect(blocked.failedPhases).toBeGreaterThan(0);
      expect(allowances.map(item => item.rows)).toEqual([1, 0]);
      expect(harness.agent.syncCheckpoints.size).toBe(1);
      expect(allowances[0]!.scope).toMatch(/^ordinary-swm-meta:/);
      expect(allowances[1]!.scope).toMatch(/^selected-swm-meta:/);
      await ordinary();
      expect(harness.agent.syncCheckpoints.size).toBe(0);
      const admitted = await selected();
      expect(admitted.metadataContinuationYields).toBe(1);
      expect(allowances.map(item => item.rows)).toEqual([1, 0, 0, 1]);
      expect(allowances[2]!.scope).toBe(allowances[0]!.scope);
      expect(harness.agent.syncCheckpoints.size).toBe(1);
    } finally {
      if (previousBudget === undefined) delete process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS;
      else process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS = previousBudget;
      await harness.close();
    }
  });

  it('does not coalesce selected SWM into an ordinary same-priority flight', async () => {
    const publicCg = 'selected-ordinary-single-flight-isolation';
    const manifest = snapshotManifest(publicCg, 2);
    const firstPrefix = manifest.meta.slice(0, 3);
    const finalSuffix = manifest.meta.slice(3);
    let signalOrdinaryStarted!: () => void;
    const ordinaryStarted = new Promise<void>((resolve) => {
      signalOrdinaryStarted = resolve;
    });
    let releaseOrdinary!: () => void;
    const ordinaryRelease = new Promise<void>((resolve) => {
      releaseOrdinary = resolve;
    });
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => 1_000, deadline: () => 1_001 },
      metaPages: [
        {
          quads: manifest.meta,
          resumedFromOffset: 0,
          nextOffset: manifest.meta.length,
          completed: true,
          timedOut: false,
        },
        {
          quads: firstPrefix,
          resumedFromOffset: 0,
          nextOffset: firstPrefix.length,
          completed: false,
          timedOut: true,
        },
        {
          quads: finalSuffix,
          resumedFromOffset: firstPrefix.length,
          nextOffset: manifest.meta.length,
          completed: true,
          timedOut: false,
        },
      ],
      onMetaFetch: async ({ fetch }) => {
        if (fetch === 1) {
          signalOrdinaryStarted();
          await ordinaryRelease;
        }
      },
    });
    const plan = {
      targets: [{ contextGraphId: publicCg, lane: 'selected-public' as const }],
    };
    let ordinary: Promise<SharedMemorySyncResult> | undefined;
    let selected: ReturnType<typeof callSelectedSharedMemoryFromPeerDetailed> | undefined;

    try {
      ordinary = callSyncSharedMemoryFromPeerDetailed(harness.agent, [publicCg], {
        priority: 2_000,
        sharedMemorySyncPlan: plan,
      });
      await ordinaryStarted;

      selected = callSelectedSharedMemoryFromPeerDetailed(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        priority: 2_000,
        recoveryTargets: plan.targets,
      });
      await vi.waitFor(() => expect(harness.probes.metaFetches()).toBeGreaterThanOrEqual(2));
      releaseOrdinary();

      const [ordinarySummary, selectedResult] = await Promise.all([ordinary, selected]);
      const selectedSummary = selectedResult.shared;
      expect(ordinarySummary).not.toBe(selectedSummary);
      expect(harness.probes.metaFetches()).toBe(3);
      expect(harness.probes.metaRequesterScopes[0]).toMatch(/^ordinary-swm-meta:retained:\d+$/);
      expect(harness.probes.metaRequesterScopes[1]).toMatch(/^selected-swm-meta:retained:\d+$/);
      expect(harness.probes.metaRequesterScopes[2]).toBe(
        harness.probes.metaRequesterScopes[1],
      );
      expect(selectedSummary.continuationPasses).toBe(1);
      expect(selectedSummary.resolvedMetadataContinuationYields).toBe(1);
      expect(selectedSummary.swmCoverage).toMatchObject({
        contextGraphId: publicCg,
        snapshotsResolved: 2,
        snapshotsTotal: 2,
        missingCount: 0,
      });
      expect(harness.agent.syncCheckpoints.size).toBe(0);
    } finally {
      releaseOrdinary();
      const pending: Promise<unknown>[] = [];
      if (ordinary) pending.push(ordinary);
      if (selected) pending.push(selected);
      await Promise.allSettled(pending);
      await harness.close();
    }
  });

  it('does not coalesce different selected accounting scopes into one flight', async () => {
    const publicCg = 'selected-requested-scope-single-flight-isolation';
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest: snapshotManifest(publicCg, 0),
      clock: { now: () => 1_000, deadline: () => 61_000 },
      reportEmptyResponse: true,
      onMetaFetch: async ({ fetch }) => {
        if (fetch === 1) {
          signalFirstStarted();
          await firstGate;
        }
      },
    });
    const plan = {
      targets: [{ contextGraphId: publicCg, lane: 'selected-public' as const }],
    };

    try {
      const selectedPublic = callSelectedSharedMemoryFromPeerDetailed(
        harness.agent,
        [publicCg],
        {
          selectedSwmPriority: true,
          requestedScope: { kind: 'selected-public' },
          priority: 2_000,
          recoveryTargets: plan.targets,
        },
      );
      await firstStarted;
      const recoveryPlan = callSelectedSharedMemoryFromPeerDetailed(
        harness.agent,
        [publicCg],
        {
          selectedSwmPriority: true,
          requestedScope: { kind: 'rfc64-recovery-plan' },
          priority: 2_000,
          recoveryTargets: plan.targets,
        },
      );

      releaseFirst();
      const [selectedResult, recoveryResult] = await Promise.all([
        selectedPublic,
        recoveryPlan,
      ]);
      expect(selectedResult.requestedScope).toEqual({
        kind: 'selected-public',
        targets: [{ contextGraphId: publicCg, lane: 'selected-public' }],
      });
      expect(recoveryResult.requestedScope).toMatchObject({
        kind: 'rfc64-recovery-plan',
        plan: {
          providerPeerId: PEER,
          targets: [{ contextGraphId: publicCg, lane: 'selected-public' }],
        },
      });
      expect(selectedResult).not.toBe(recoveryResult);
    } finally {
      releaseFirst();
      await harness.close();
    }
  });
});
