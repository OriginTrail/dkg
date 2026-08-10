import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { classifySharedMemoryFreshness } from '../src/sync/shared-memory-freshness.js';
import { runSyncOnConnect } from '../src/sync/on-connect/sync-on-connect.js';
import { DURABLE_DATA_SYNC_SESSION_TTL_MS } from '../src/sync/durable-session.js';
import {
  PEER,
  callSelectedSharedMemoryFromPeerDetailed,
  callSelectedSharedMemorySummary,
  callTrySyncFromPeer,
  cleanDurableResult,
  createSelectedSwmLifecycleHarness,
  graphBackedManifest,
  snapshotManifest,
  type SelectedProviderSelectionAgent,
  type SelectedSwmLifecycleAgentFixture,
} from './selected-swm-test-helpers.js';

describe('selected RFC-64 SWM lifecycle wiring', () => {
  it('treats a clean selected graph with zero snapshot refs as explicit complete 0/0 coverage', async () => {
    const publicCg = 'selected-empty-snapshot-plane';
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest: snapshotManifest(publicCg, 0),
      clock: { now: () => 1_000, deadline: () => 61_000 },
      reportEmptyResponse: true,
    });

    try {
      const selected = await callSelectedSharedMemoryFromPeerDetailed(
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
      const summary = selected.shared;

      expect(summary.swmCoverage).toEqual({
        contextGraphId: publicCg,
        peerIdSuffix: PEER.slice(-8),
        snapshotsResolved: 0,
        snapshotsTotal: 0,
        manifestComplete: true,
        descriptorsAuthoritative: true,
        missingCount: 0,
        missingSample: [],
        materializationFailures: 0,
      });
      expect(selected.selectedScopeComplete).toBe(true);
      expect(summary.continuationPasses).toBe(0);
      expect(harness.probes.publicAdmissions()).toBe(1);
      expect(harness.agent.selectedSwmRetryRequiredPeers.has(PEER)).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('keeps non-empty graph-backed zero-ref metadata incomplete until its content is proven', async () => {
    const publicCg = 'selected-graph-backed-zero-ref';
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest: graphBackedManifest(publicCg),
      clock: { now: () => 1_000, deadline: () => 61_000 },
    });

    try {
      const selected = await callSelectedSharedMemoryFromPeerDetailed(
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

      expect(selected.shared.fetchedMetaTriples).toBeGreaterThan(0);
      expect(selected.shared.insertedMetaTriples).toBe(0);
      expect(selected.shared.failedPhases).toBeGreaterThan(0);
      expect(selected.shared.swmCoverage).toBeUndefined();
      expect(selected.selectedScopeComplete).toBe(false);
      expect(harness.agent.selectedSwmRetryRequiredPeers.has(PEER)).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('keeps mixed store-backed and graph-backed metadata incomplete until every operation is proven', async () => {
    const publicCg = 'selected-mixed-snapshot-evidence';
    const storeBacked = snapshotManifest(publicCg, 1);
    const graphBacked = graphBackedManifest(publicCg);
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest: {
        meta: [...storeBacked.meta, ...graphBacked.meta],
        payloadByRef: storeBacked.payloadByRef,
      },
      clock: { now: () => 1_000, deadline: () => 61_000 },
    });

    try {
      const selected = await callSelectedSharedMemoryFromPeerDetailed(
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

      expect(selected.shared.swmCoverage).toMatchObject({
        contextGraphId: publicCg,
        snapshotsResolved: 1,
        snapshotsTotal: 1,
        missingCount: 0,
      });
      expect(selected.shared.insertedMetaTriples).toBe(0);
      expect(selected.shared.failedPhases).toBeGreaterThan(0);
      expect(selected.selectedScopeComplete).toBe(false);
      expect(harness.agent.selectedSwmRetryRequiredPeers.has(PEER)).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('keeps an empty selected graph incomplete when its data phase times out', async () => {
    const publicCg = 'selected-empty-data-timeout';
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest: snapshotManifest(publicCg, 0),
      clock: { now: () => 1_000, deadline: () => 61_000 },
      reportEmptyResponse: true,
      dataPage: {
        quads: [],
        completed: false,
        timedOut: true,
      },
    });

    try {
      const selected = await callSelectedSharedMemoryFromPeerDetailed(
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

      expect(selected.shared.swmCoverage).toBeUndefined();
      expect(selected.shared.timedOutPhases).toBeGreaterThan(0);
      expect(selected.selectedScopeComplete).toBe(false);
      expect(harness.agent.selectedSwmRetryRequiredPeers.has(PEER)).toBe(true);
    } finally {
      await harness.close();
    }
  });

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
    const agent: SelectedProviderSelectionAgent = {
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
      selectedSwmRetryRequiredPeers: new Set<string>(),
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
      ) => {
        syncCalls.push({
          contextGraphIds: [...contextGraphIds],
          selected: false,
        });
        return cleanDurableResult();
      },
      syncSelectedSharedMemoryFromPeerDetailed: async (
        _peerId: string,
        contextGraphIds: readonly string[],
      ) => {
        syncCalls.push({
          contextGraphIds: [...contextGraphIds],
          selected: true,
        });
        return {
          kind: 'selected-shared-memory',
          shared: cleanDurableResult(),
          selectedScopeComplete: true,
        };
      },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };

    await callTrySyncFromPeer.call(agent, PEER);

    expect(syncCalls).toEqual([
      { contextGraphIds: [publicCg], selected: true },
      { contextGraphIds: [privateCg], selected: false },
    ]);
  });

  it('does not stamp a max-pass incomplete selected provider fresh', async () => {
    const publicCg = 'selected-max-passes-incomplete';
    const accounting: Array<{ fresh: boolean; progress?: boolean }> = [];
    const agent: SelectedProviderSelectionAgent = {
      started: true,
      config: {
        syncOnConnect: true,
        syncSharedMemoryOnConnect: true,
        syncContextGraphs: [publicCg],
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
      selectedSwmRetryRequiredPeers: new Set<string>(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      planSharedMemorySyncContextGraphs: async () => ({
        publicContextGraphIds: [publicCg],
        privateRecoverFromCurator: [],
        eligibleContextGraphIds: [publicCg],
      }),
      resolveRfc64CompleteSwmProviderPeerIdsV1: () => [PEER],
      syncFromPeerDetailed: async () => 0,
      refreshMetaSyncedFlags: async () => undefined,
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeerDetailed: async () => cleanDurableResult(),
      syncSelectedSharedMemoryFromPeerDetailed: async (
        _peerId: string,
        _contextGraphIds: readonly string[],
      ) => ({
        kind: 'selected-shared-memory',
        shared: cleanDurableResult(),
        // The producer carries whole-selected-scope completeness explicitly;
        // freshness accounting must not depend on ambient peer state.
        selectedScopeComplete: false,
      }),
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };

    await callTrySyncFromPeer.call(agent, PEER, (outcome) => accounting.push(outcome));

    expect(agent.selectedSwmRetryRequiredPeers.has(PEER)).toBe(false);
    expect(agent.lastSuccessfulSyncAt.has(PEER)).toBe(false);
    // No freshness/progress callback means the reconciler wrapper classifies
    // this explicit incomplete result as a failed attempt and grows backoff.
    expect(accounting).toEqual([]);
  });

  it('continues a voluntary 672/905 public snapshot yield to 905/905 with fresh admission', async () => {
    const publicCg = 'selected-production-shape';
    const privateCg = 'selected-private-unaffected';
    let initialSnapshotReads = 0;
    let wallNow = 1_000;
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg, private: privateCg },
      manifest: snapshotManifest(publicCg, 905),
      clock: { now: () => wallNow, deadline: () => wallNow + 1 },
      priorities: { [publicCg]: 100, [privateCg]: 0 },
      onSnapshotRead: ({ publicAdmission }) => {
        if (publicAdmission === 1) {
          initialSnapshotReads += 1;
          if (initialSnapshotReads === 672) wallNow += 120_000;
        }
      },
    });

    try {
      const selected = await callSelectedSharedMemoryFromPeerDetailed(
        harness.agent,
        [publicCg, privateCg],
        {
        selectedSwmPriority: true,
        priority: 2_000,
        sharedMemorySyncPlan: {
          publicContextGraphIds: [publicCg],
          privateRecoverFromCurator: [privateCg],
          eligibleContextGraphIds: [publicCg, privateCg],
        },
        },
      );
      const summary = selected.shared;

      expect(summary.swmCoverage).toMatchObject({
        contextGraphId: publicCg,
        snapshotsResolved: 905,
        snapshotsTotal: 905,
        missingCount: 0,
      });
      expect(selected.selectedScopeComplete).toBe(true);
      expect(summary.continuationPasses).toBe(1);
      expect(summary.snapshotPlaneIncomplete).toBe(1);
      expect(summary.failedPhases).toBe(1);
      expect(summary.resolvedSnapshotPlaneIncomplete).toBe(1);
      expect(summary.timedOutPhases).toBe(0);
      expect(summary.backoffWorthyFailures).toBe(0);
      expect(harness.agent.selectedSwmRetryRequiredPeers.has(PEER)).toBe(false);
      expect(initialSnapshotReads).toBe(672);
      expect(harness.probes.snapshotFetches).toEqual([]);
      expect(harness.probes.maxActiveAdmissions()).toBe(1);
      expect(harness.probes.admissions).toEqual([
        { contextGraphId: publicCg, selected: true, priority: 2_000, event: 'start' },
        { contextGraphId: publicCg, selected: true, priority: 2_000, event: 'end' },
        { contextGraphId: privateCg, selected: false, priority: undefined, event: 'start' },
        { contextGraphId: privateCg, selected: false, priority: undefined, event: 'end' },
        { contextGraphId: publicCg, selected: true, priority: 2_000, event: 'start' },
        { contextGraphId: publicCg, selected: true, priority: 2_000, event: 'end' },
      ]);

      const onPeerSynced = vi.fn();
      const outcome = await runSyncOnConnect({
        remotePeer: PEER,
        syncingPeers: new Set(),
        getPeerProtocols: async () => [PROTOCOL_SYNC],
        knownCorePeerIds: new Set(),
        knownCorePeerIdsV2: new Set(),
        getSyncContextGraphs: () => [],
        getDurableSyncContextGraphs: () => [],
        getSharedMemorySyncContextGraphs: () => [publicCg],
        selectedSharedMemoryLane: {
          getContextGraphIds: () => [publicCg],
          syncFromPeer: async () => selected,
        },
        syncFromPeer: async () => 0,
        refreshMetaSyncedFlags: async () => undefined,
        discoverContextGraphsFromStore: async () => 0,
        syncSharedMemoryFromPeer: async () => summary,
        onPeerSynced,
        logInfo: () => {},
      });
      expect(outcome).toBe('synced');
      expect(onPeerSynced).toHaveBeenCalledWith(PEER, {
        fresh: true,
        progress: false,
      });
    } finally {
      await harness.close();
    }
  });

  it('keeps retry state when one selected CG completes and another remains incomplete', async () => {
    const completeCg = 'selected-multi-complete';
    const incompleteCg = 'selected-multi-incomplete';
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: completeCg },
      manifest: snapshotManifest(completeCg, 2),
      clock: { now: () => 1_000, deadline: () => 61_000 },
    });

    try {
      const selected = await callSelectedSharedMemoryFromPeerDetailed(
        harness.agent,
        [completeCg, incompleteCg],
        {
          selectedSwmPriority: true,
          priority: 2_000,
          sharedMemorySyncPlan: {
            publicContextGraphIds: [completeCg, incompleteCg],
            privateRecoverFromCurator: [],
            eligibleContextGraphIds: [completeCg, incompleteCg],
          },
        },
      );
      expect(selected.selectedScopeComplete).toBe(false);
      expect(harness.agent.selectedSwmRetryRequiredPeers.has(PEER)).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('retains an exact metadata prefix across bounded passes and verifies the combined manifest once', async () => {
    const publicCg = 'selected-multi-pass-metadata';
    const manifest = snapshotManifest(publicCg, 3);
    const firstPrefix = manifest.meta.slice(0, 4);
    const finalSuffix = manifest.meta.slice(4);
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
          quads: finalSuffix,
          resumedFromOffset: firstPrefix.length,
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
      expect(harness.probes.metaRequesterScopes).toHaveLength(2);
      expect(harness.probes.metaRequesterScopes[0]).toMatch(/^selected-swm-meta:retained:\d+$/);
      expect(harness.probes.metaRequesterScopes[1]).toBe(
        harness.probes.metaRequesterScopes[0],
      );
      expect(harness.probes.metaSinceBatchIds).toEqual([undefined, undefined]);
      expect(harness.probes.processedMetaBatches).toEqual([manifest.meta]);
      expect(harness.probes.publicAdmissions()).toBe(2);
      expect(summary.continuationPasses).toBe(1);
      expect(summary.metadataContinuationYields).toBe(1);
      expect(summary.timedOutPhases).toBe(1);
      expect(summary.resolvedMetadataContinuationYields).toBe(1);
      expect(classifySharedMemoryFreshness(summary).timedOut).toBe(false);
      expect(summary.swmCoverage).toMatchObject({
        contextGraphId: publicCg,
        snapshotsResolved: 3,
        snapshotsTotal: 3,
        missingCount: 0,
      });
      expect(harness.agent.syncCheckpoints.size).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('resumes one exact metadata prefix across outer reconciler invocations without partial activation', async () => {
    const publicCg = 'selected-cross-outer-metadata';
    const manifest = snapshotManifest(publicCg, 3);
    const firstPrefix = manifest.meta.slice(0, 4);
    const finalSuffix = manifest.meta.slice(4);
    const previousBudget = process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS;
    process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS = '0';
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
          quads: finalSuffix,
          resumedFromOffset: firstPrefix.length,
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
      const firstSelected = await callSelectedSharedMemoryFromPeerDetailed(
        harness.agent,
        [publicCg],
        { selectedSwmPriority: true, priority: 2_000, sharedMemorySyncPlan: plan },
      );
      const first = firstSelected.shared;

      expect(first.metadataContinuationYields).toBe(1);
      expect(firstSelected.selectedScopeComplete).toBe(false);
      expect(harness.probes.processedMetaBatches).toEqual([]);
      expect(harness.agent.selectedSwmRetryRequiredPeers.has(PEER)).toBe(true);

      const queuedPeers: string[] = [];
      const queueAgent = harness.agent as SelectedSwmLifecycleAgentFixture & Record<string, any>;
      queueAgent.networkAdmissionCoordinator = { isAcceptedPeer: () => true };
      queueAgent.lastSuccessfulSyncAt = new Map([[PEER, Date.now()]]);
      queueAgent.lastSyncDisconnectedAt = new Map<string, number>();
      queueAgent.catchupOnConnectAt = new Map<string, number>();
      queueAgent.syncReconcilerBackoff = new Map<string, unknown>();
      queueAgent.syncOnConnectDisconnectBoundary =
        LifecycleSyncMethods.prototype.syncOnConnectDisconnectBoundary;
      queueAgent.runSyncFromPeerOnConnect = async (peerId: string) => {
        queuedPeers.push(peerId);
      };
      expect(LifecycleSyncMethods.prototype.queueSyncFromPeerOnConnect.call(
        queueAgent as never,
        PEER,
        () => undefined,
        0,
        { selectedSwmRetry: true },
      )).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(queuedPeers).toEqual([PEER]);

      const secondSelected = await callSelectedSharedMemoryFromPeerDetailed(
        harness.agent,
        [publicCg],
        { selectedSwmPriority: true, priority: 2_000, sharedMemorySyncPlan: plan },
      );
      const second = secondSelected.shared;

      expect(second.failedPhases).toBe(0);
      expect(secondSelected.selectedScopeComplete).toBe(true);
      expect(harness.probes.metaRequesterScopes).toHaveLength(2);
      expect(harness.probes.metaRequesterScopes[1]).toBe(
        harness.probes.metaRequesterScopes[0],
      );
      expect(
        harness.probes.metaReturnAcceptedPrefixOnRetryableTransportFailure,
      ).toEqual([true, true]);
      expect(harness.probes.processedMetaBatches).toEqual([manifest.meta]);
      expect(harness.agent.selectedSwmRetryRequiredPeers.has(PEER)).toBe(false);
    } finally {
      if (previousBudget === undefined) {
        delete process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS;
      } else {
        process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS = previousBudget;
      }
      await harness.close();
    }
  });

  it('expires a cross-invocation prefix and starts a fresh responder scope', async () => {
    const publicCg = 'selected-cross-outer-expiry';
    const manifest = snapshotManifest(publicCg, 2);
    let wallNow = 1_000;
    const previousBudget = process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS;
    process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS = '0';
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => wallNow, deadline: () => wallNow + 1 },
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
      await callSelectedSharedMemorySummary(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        sharedMemorySyncPlan: plan,
      });
      wallNow += DURABLE_DATA_SYNC_SESSION_TTL_MS + 1;
      await callSelectedSharedMemorySummary(harness.agent, [publicCg], {
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

  it('drops an old cross-invocation prefix when the responder replaces its session', async () => {
    const publicCg = 'selected-cross-outer-session-replacement';
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
          nextOffset: 14_000,
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
      await callSelectedSharedMemorySummary(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        sharedMemorySyncPlan: plan,
      });
      await callSelectedSharedMemorySummary(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        sharedMemorySyncPlan: plan,
      });

      expect(harness.probes.metaRequesterScopes[1]).toBe(
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

  it.each([
    ['caller abort', Object.assign(new Error('caller cancelled'), { name: 'AbortError' })],
    ['integrity rejection', new Error('metadata integrity rejected')],
    ['local request build failure', new Error('wallet signing failed')],
  ])('discards retained state after a cross-invocation %s', async (_label, failure) => {
    const publicCg = `selected-cross-outer-failure-${_label.replaceAll(' ', '-')}`;
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
        // Fetch two throws from onMetaFetch. Fetch three must therefore begin
        // a new owner at offset zero and may accept this full replacement.
        {
          quads: [],
          resumedFromOffset: 0,
          nextOffset: 0,
          completed: false,
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
      onMetaFetch: ({ fetch }) => {
        if (fetch === 2) throw failure;
      },
    });
    const plan = {
      publicContextGraphIds: [publicCg],
      privateRecoverFromCurator: [],
      eligibleContextGraphIds: [publicCg],
    };

    try {
      await callSelectedSharedMemorySummary(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        sharedMemorySyncPlan: plan,
      });
      const failed = await callSelectedSharedMemorySummary(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        sharedMemorySyncPlan: plan,
      });
      expect(failed.failedPhases + failed.failedPeers).toBeGreaterThan(0);
      await callSelectedSharedMemorySummary(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        sharedMemorySyncPlan: plan,
      });

      expect(harness.probes.metaRequesterScopes).toHaveLength(3);
      expect(harness.probes.metaRequesterScopes[1]).toBe(
        harness.probes.metaRequesterScopes[0],
      );
      expect(harness.probes.metaRequesterScopes[2]).not.toBe(
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
});
