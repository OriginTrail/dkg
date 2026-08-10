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

describe('selected RFC-64 SWM continuation', () => {
  it('re-enters admission promptly until incomplete coverage becomes complete', async () => {
    const contextGraphId = 'selected-public';
    const admissions: string[] = [];
    const execution = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units: [selectedUnit(
        contextGraphId,
        result(contextGraphId, 1, 3),
        async () => result(contextGraphId, 3, 3, { insertedDataTriples: 2 }),
      )],
      passConfig: { maxPasses: 4, budgetMs: 600_000 },
      nowMs: () => 1,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (item, run) => {
        admissions.push(item.contextGraphId);
        return run();
      },
      merge,
      markDeferred: (summary) => ({
        ...summary,
        deferredBackpressure: (summary.deferredBackpressure ?? 0) + 1,
      }),
    });

    const { summary } = execution;
    expect(admissions).toEqual([contextGraphId]);
    expect(summary.continuationPasses).toBe(1);
    expect(summary.swmCoverage).toMatchObject({ snapshotsResolved: 3, snapshotsTotal: 3 });
    expect(execution.incompleteContextGraphIds).toEqual([]);
  });

  it('reports useful selected progress as retry-required when the next pass stalls', async () => {
    const contextGraphId = 'selected-progress-then-stalled';
    const initial = result(contextGraphId, 2, 3, { insertedDataTriples: 2 });
    const stalled = result(contextGraphId, 2, 3, { insertedDataTriples: 0 });
    const stop = vi.fn();

    const execution = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units: [selectedUnit(contextGraphId, initial, async () => stalled)],
      passConfig: { maxPasses: 4, budgetMs: 600_000 },
      nowMs: () => 1,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (_item, run) => run(),
      merge,
      markDeferred: (summary) => summary,
      onStop: stop,
    });

    expect(execution.incompleteContextGraphIds).toEqual([contextGraphId]);
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId,
      reason: 'coverage-stalled',
    }));
  });

  it('allows one capable zero-progress retry, then stops when coverage stalls', async () => {
    const contextGraphId = 'selected-stalled';
    const stalled = result(contextGraphId, 0, 3);
    const stop = vi.fn();
    let admissions = 0;

    const { summary } = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units: [selectedUnit(contextGraphId, stalled, async () => stalled)],
      passConfig: { maxPasses: 4, budgetMs: 600_000 },
      nowMs: () => 1,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (_item, run) => {
        admissions += 1;
        return run();
      },
      merge,
      markDeferred: (summary) => ({
        ...summary,
        deferredBackpressure: (summary.deferredBackpressure ?? 0) + 1,
      }),
      onStop: stop,
    });

    expect(admissions).toBe(1);
    expect(summary.continuationPasses).toBe(1);
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId,
      reason: 'coverage-stalled',
    }));
  });

  it('does not treat an allocated zero-offset metadata accumulator as retry capability', async () => {
    const contextGraphId = 'selected-zero-meta-progress';
    const run = vi.fn(async () => cleanDurableResult());
    const stop = vi.fn();
    const unit = selectedUnit(contextGraphId, cleanDurableResult(), run, {
      initial: { progress: 0, generation: 0, completed: false },
    });

    const { summary } = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units: [unit],
      passConfig: { maxPasses: 4, budgetMs: 600_000 },
      nowMs: () => 1,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (_item, work) => work(),
      merge,
      markDeferred: (current) => current,
      onStop: stop,
    });

    expect(run).not.toHaveBeenCalled();
    expect(summary.continuationPasses).toBe(0);
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId,
      reason: 'coverage-stalled',
    }));
  });

  it('keeps independent per-CG coverage and continues only the incomplete graph', async () => {
    const runs: string[] = [];
    const stop = vi.fn();
    const units = ['complete-cg', 'incomplete-cg'].map((contextGraphId) => selectedUnit(
      contextGraphId,
      result(contextGraphId, contextGraphId === 'complete-cg' ? 2 : 1, contextGraphId === 'complete-cg' ? 2 : 5),
      async () => {
        runs.push(contextGraphId);
        return result(contextGraphId, 5, 5);
      },
    ));

    await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units,
      passConfig: { maxPasses: 4, budgetMs: 600_000 },
      nowMs: () => 1,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (_item, run) => run(),
      merge,
      markDeferred: (current) => current,
      onStop: stop,
    });

    expect(runs).toEqual(['incomplete-cg']);
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId: 'complete-cg',
      reason: 'plane-proven',
    }));
  });

  it('continues two selected public CGs independently in priority order', async () => {
    const publicA = 'selected-public-a';
    const publicB = 'selected-public-b';
    const runs: string[] = [];
    const admissions: string[] = [];
    const progress: Array<{
      contextGraphId: string;
      progressBefore: number;
      progressAfter: number;
    }> = [];

    const execution = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units: [publicA, publicB].map((contextGraphId) => selectedUnit(
        contextGraphId,
        result(contextGraphId, 1, 3),
        async () => {
          runs.push(contextGraphId);
          return result(contextGraphId, 3, 3, { insertedDataTriples: 2 });
        },
      )),
      priorities: { [publicA]: 100, [publicB]: 200 },
      passConfig: { maxPasses: 4, budgetMs: 600_000 },
      nowMs: () => 1,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (item, run) => {
        admissions.push(item.contextGraphId);
        return run();
      },
      merge,
      markDeferred: (current) => current,
      onContinuation: (event) => progress.push(event),
    });

    expect(admissions).toEqual([publicB, publicA]);
    expect(runs).toEqual([publicB, publicA]);
    expect(progress).toEqual([
      { contextGraphId: publicB, progressBefore: 1, progressAfter: 3 },
      { contextGraphId: publicA, progressBefore: 1, progressAfter: 3 },
    ]);
    expect(execution.summary.continuationPasses).toBe(2);
    expect(execution.freshnessResolution).toEqual({
      recoverableSnapshotYieldFailures: 2,
      recoverableMetadataContinuationYields: 0,
    });
  });

  it('stops at four total passes even while coverage keeps advancing', async () => {
    const contextGraphId = 'selected-bounded';
    const rounds = [2, 3, 4];
    const stop = vi.fn();
    const { summary } = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units: [selectedUnit(
        contextGraphId,
        result(contextGraphId, 1, 5),
        async () => result(contextGraphId, rounds.shift()!, 5),
      )],
      passConfig: { maxPasses: 4, budgetMs: 600_000 },
      nowMs: () => 1,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (_item, run) => run(),
      merge,
      markDeferred: (current) => current,
      onStop: stop,
    });

    expect(summary.continuationPasses).toBe(3);
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId,
      continuationPasses: 3,
      reason: 'max-passes-reached',
    }));
  });

  it('keeps the total pass cap global across metadata-to-snapshot transition', async () => {
    const contextGraphId = 'selected-domain-transition-bounded';
    let metadataCompleted = false;
    const run = vi.fn(async () => {
      metadataCompleted = true;
      return result(contextGraphId, 0, 3);
    });
    const stop = vi.fn();
    const initialResult = {
      ...cleanDurableResult(),
      timedOutPhases: 1,
      metadataContinuationYields: 1,
    };
    const unit = selectedUnit(contextGraphId, initialResult, run, {
      initial: { progress: 1_000, generation: 0, completed: false },
      afterRun: () => ({ progress: 1_000, generation: 0, completed: metadataCompleted }),
    });

    const { summary } = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units: [unit],
      passConfig: { maxPasses: 2, budgetMs: 600_000 },
      nowMs: () => 1,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (_item, work) => work(),
      merge,
      markDeferred: (current) => current,
      onStop: stop,
    });

    expect(run).toHaveBeenCalledOnce();
    expect(summary.continuationPasses).toBe(1);
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId,
      continuationPasses: 1,
      reason: 'max-passes-reached',
    }));
  });

  it('does not start a continuation after the absolute budget expires', async () => {
    const contextGraphId = 'selected-expired';
    const run = vi.fn(async () => result(contextGraphId, 2, 2));
    const stop = vi.fn();
    const { summary } = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units: [selectedUnit(contextGraphId, result(contextGraphId, 1, 2), run)],
      passConfig: { maxPasses: 4, budgetMs: 0 },
      nowMs: () => 100,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (_item, work) => work(),
      merge,
      markDeferred: (current) => current,
      onStop: stop,
    });

    expect(run).not.toHaveBeenCalled();
    expect(summary.continuationPasses).toBe(0);
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId,
      reason: 'budget-exhausted',
    }));
  });

  it('stops immediately on continuation backpressure', async () => {
    const contextGraphId = 'selected-pressure';
    const incomplete = result(contextGraphId, 1, 3);
    const continuationStop = vi.fn();
    const continuationRun = vi.fn(async () => (
      result(contextGraphId, 1, 3, { deferredBackpressure: 1 })
    ));

    await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units: [selectedUnit(contextGraphId, incomplete, continuationRun)],
      passConfig: { maxPasses: 4, budgetMs: 600_000 },
      nowMs: () => 1,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (_item, run) => run(),
      merge,
      markDeferred: (summary) => ({
        ...summary,
        deferredBackpressure: (summary.deferredBackpressure ?? 0) + 1,
      }),
      onBackpressure: continuationStop,
    });
    expect(continuationRun).toHaveBeenCalledOnce();
    expect(continuationStop).toHaveBeenCalledOnce();
  });

  it('preserves the three-failure peer-dead cutoff across outer continuation batches', async () => {
    const calls: string[] = [];
    const onBackpressure = vi.fn();
    const contextGraphIds = Array.from({ length: 8 }, (_, index) => `selected-dead-${index}`);
    const failed = {
      ...cleanDurableResult(),
      failedPeers: 1,
      backoffWorthyFailures: 1,
    };

    const execution = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units: contextGraphIds.map((contextGraphId) => selectedUnit(
        contextGraphId,
        result(contextGraphId, 1, 2),
        async () => {
          calls.push(contextGraphId);
          return failed;
        },
      )),
      passConfig: { maxPasses: 4, budgetMs: 600_000 },
      nowMs: () => 1,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (_item, run) => run(),
      merge,
      markDeferred: (current) => current,
      isPeerTransportFailure: (part) => part.failedPeers > 0,
      onBackpressure,
    });

    expect(calls).toEqual(contextGraphIds.slice(0, 3));
    expect(execution.summary.continuationPasses).toBe(3);
    expect(onBackpressure).not.toHaveBeenCalled();
  });

  it('owns continuationPasses even when a part result carries a nonzero counter', async () => {
    const contextGraphId = 'selected-counter-owner';
    const continuation = {
      ...result(contextGraphId, 2, 2, { insertedDataTriples: 1 }),
      continuationPasses: 23,
    };

    const { summary } = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units: [selectedUnit(
        contextGraphId,
        result(contextGraphId, 1, 2),
        async () => continuation,
      )],
      passConfig: { maxPasses: 4, budgetMs: 600_000 },
      nowMs: () => 1,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (_item, run) => run(),
      merge: (left, right) => ({
        ...merge(left, right),
        continuationPasses:
          (left.continuationPasses ?? 0) + (right.continuationPasses ?? 0),
      }),
      markDeferred: (current) => current,
    });

    expect(summary.continuationPasses).toBe(1);
  });
});
