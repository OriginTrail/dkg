import { describe, expect, it, vi } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  contextGraphWorkspaceMetaGraphUri,
  knowledgeAssetLayerGraphUri,
  PROTOCOL_SYNC,
} from '@origintrail-official/dkg-core';
import {
  generateKnowledgeAssetShareMetadata,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import type {
  SharedMemorySyncResult,
  SwmSnapshotCoverage,
} from '../src/dkg-agent-types.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import {
  runSelectedSwmContinuations,
} from '../src/sync/selected-swm-continuation.js';
import {
  type SelectedSwmMetaContinuation,
} from '../src/sync/selected-swm-meta-fetcher.js';
import { SelectedSwmMetaTransferCoordinator } from '../src/sync/selected-swm-meta-transfer-coordinator.js';
import {
  applySelectedSwmFreshnessResolution,
  classifySelectedSwmRoundFreshness,
  classifySharedMemoryFreshness,
} from '../src/sync/shared-memory-freshness.js';
import { runSyncOnConnect } from '../src/sync/on-connect/sync-on-connect.js';
import {
  SyncPageAccumulationLimitError,
  type SyncPageFetchOptions,
} from '../src/sync/requester/page-fetch.js';
import { estimateQuadHeapBytes } from '../src/sync/memory-telemetry.js';
import { DURABLE_DATA_SYNC_SESSION_TTL_MS } from '../src/sync/durable-session.js';
import {
  PEER,
  callSelectedSharedMemoryFromPeerDetailed,
  callSyncSharedMemoryFromPeerDetailed,
  callTrySyncFromPeer,
  cleanDurableResult,
  createSelectedSwmLifecycleHarness,
  graphBackedManifest,
  merge,
  result,
  selectedUnit,
  snapshotManifest,
  type AdmissionProbe,
  type SelectedProviderSelectionAgent,
  type SelectedSwmLifecycleAgentFixture,
  type SelectedSwmLifecycleHarness,
  type SelectedSwmLifecycleHarnessOptions,
  type SyncSharedMemoryOptions,
} from './selected-swm-test-helpers.js';

describe('selected RFC-64 SWM lifecycle retained sessions', () => {
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
      publicContextGraphIds: [publicCg],
      privateRecoverFromCurator: [],
      eligibleContextGraphIds: [publicCg],
    };

    try {
      await callSyncSharedMemoryFromPeerDetailed(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        sharedMemorySyncPlan: plan,
      });
      await harness.agent.closeSelectedSwmMetaTransfers();
      await callSyncSharedMemoryFromPeerDetailed(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        sharedMemorySyncPlan: plan,
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
      const summary = await callSyncSharedMemoryFromPeerDetailed(
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
      const summary = await callSyncSharedMemoryFromPeerDetailed(
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
      const summary = await callSyncSharedMemoryFromPeerDetailed(
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
      const summary = await callSyncSharedMemoryFromPeerDetailed(
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
      publicContextGraphIds: [publicCg],
      privateRecoverFromCurator: [],
      eligibleContextGraphIds: [publicCg],
    };

    try {
      const first = callSyncSharedMemoryFromPeerDetailed(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        priority: 2_000,
        sharedMemorySyncPlan: plan,
      });
      await firstStarted;
      const second = callSyncSharedMemoryFromPeerDetailed(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        priority: 2_001,
        sharedMemorySyncPlan: plan,
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
      publicContextGraphIds: [publicCg],
      privateRecoverFromCurator: [],
      eligibleContextGraphIds: [publicCg],
    };
    let ordinary: Promise<SharedMemorySyncResult> | undefined;
    let selected: Promise<SharedMemorySyncResult> | undefined;

    try {
      ordinary = callSyncSharedMemoryFromPeerDetailed(harness.agent, [publicCg], {
        priority: 2_000,
        sharedMemorySyncPlan: plan,
      });
      await ordinaryStarted;

      selected = callSyncSharedMemoryFromPeerDetailed(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        priority: 2_000,
        sharedMemorySyncPlan: plan,
      });
      await vi.waitFor(() => expect(harness.probes.metaFetches()).toBeGreaterThanOrEqual(2));
      releaseOrdinary();

      const [ordinarySummary, selectedSummary] = await Promise.all([ordinary, selected]);
      expect(ordinarySummary).not.toBe(selectedSummary);
      expect(harness.probes.metaFetches()).toBe(3);
      expect(harness.probes.metaRequesterScopes[0]).toBeUndefined();
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
      await Promise.allSettled([ordinary, selected].filter(
        (promise): promise is Promise<SharedMemorySyncResult> => promise !== undefined,
      ));
      await harness.close();
    }
  });
});
