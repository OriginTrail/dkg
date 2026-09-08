import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { classifySharedMemoryFreshness } from '../src/sync/shared-memory-freshness.js';
import {
  runSelectedSharedMemoryRetry,
} from '../src/sync/on-connect/sync-on-connect.js';
import {
  captureSyncOnConnectAttempt,
  executeSyncOnConnectAttempt,
} from '../src/sync/on-connect/attempt-accounting.js';
import { SyncOnConnectPeerScheduler } from '../src/sync/on-connect/peer-scheduler.js';
import { DURABLE_DATA_SYNC_SESSION_TTL_MS } from '../src/sync/durable-session.js';
import { SelectedSwmBootstrapAdmission } from '../src/sync/selected-swm-bootstrap-admission.js';
import {
  DKG,
  PEER,
  callSyncSharedMemoryFromPeerDetailed,
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
  it('accounts a real complete private-only no-op without reconciler backoff', async () => {
    const publicCg = 'unselected-public-control';
    const privateCg = '0x1111111111111111111111111111111111111111/private-complete-noop';
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg, private: privateCg },
      manifest: snapshotManifest(publicCg, 0),
      clock: { now: () => 1_000, deadline: () => 61_000 },
      reportEmptyResponse: true,
    });

    try {
      const recovery = await callSelectedSharedMemoryFromPeerDetailed(
        harness.agent,
        [privateCg],
        {
          selectedSwmPriority: true,
          requestedScope: { kind: 'rfc64-recovery-plan' },
          priority: 2_000,
          recoveryTargets: [{ contextGraphId: privateCg, lane: 'ordinary-private' }],
        },
      );
      expect(recovery.shared.insertedTriples).toBe(0);
      expect(recovery.shared.completedPhases).toBe(1);
      expect(recovery.requestedScope).toMatchObject({
        kind: 'rfc64-recovery-plan',
        plan: {
          providerPeerId: PEER,
          targets: [{ contextGraphId: privateCg, lane: 'ordinary-private' }],
        },
      });
      expect(recovery.scopeComplete).toBe(true);
      expect(recovery.selectedScopeComplete).toBe(recovery.scopeComplete);
      expect(recovery.targetDiagnostics).toEqual({
        selectedPublic: { completed: 0, total: 0 },
        ordinaryPrivate: { completed: 1, total: 1 },
      });

      const backoff = new Map<string, unknown>();
      const accountingAgent = {
        lastSuccessfulSyncAt: new Map<string, number>(),
        lastSyncProgressAt: new Map<string, number>(),
        skippedNoSyncPeers: new Set<string>(),
        syncReconcilerBackoff: backoff,
        applySyncOnConnectAccounting:
          LifecycleSyncMethods.prototype.applySyncOnConnectAccounting,
        recordSyncReconcilerFailure: (peerId: string) => {
          backoff.set(peerId, { failures: 1 });
        },
        log: { info: () => {} },
      };
      await executeSyncOnConnectAttempt(
        () => captureSyncOnConnectAttempt((onSyncAccounting) => (
          runSelectedSharedMemoryRetry({
          remotePeer: PEER,
          syncingPeers: new Set(),
          getPeerProtocols: async () => [PROTOCOL_SYNC],
          selectedSharedMemoryLane: {
            admitWork: () => ({
              contextGraphIds: [privateCg],
              syncFromPeer: async () => recovery,
            }),
          },
          onSyncAccounting: (_peerId, outcome) => {
            if (outcome) onSyncAccounting(outcome);
          },
          logInfo: () => {},
          })
        )),
        {
          recordAccounting: (outcome) => {
            accountingAgent.applySyncOnConnectAccounting.call(
              accountingAgent as never,
              PEER,
              outcome,
              {} as never,
            );
          },
          onBackpressure: () => {},
        },
      );

      expect(backoff.has(PEER)).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('uses balanced recency only through the selected production lifecycle', async () => {
    const publicCg = 'selected-balanced-recency';
    const createManifest = () => {
      const manifest = snapshotManifest(publicCg, 8);
      const metaGraph = manifest.meta[0]!.graph;
      for (let index = 0; index < 8; index += 1) {
        const subject = `urn:selected-swm-manifest:${index}`;
        manifest.meta.push(
          {
            subject,
            predicate: `${DKG}publishedAt`,
            object: `"2026-08-10T22:00:${index.toString().padStart(2, '0')}.000Z"`,
            graph: metaGraph,
          },
          {
            subject,
            predicate: `${DKG}kaUal`,
            object: `"did:dkg:base:84532/0x0000000000000000000000000000000000000001/${100 + index}"`,
            graph: metaGraph,
          },
        );
      }
      return manifest;
    };
    const selectedManifest = createManifest();
    const selectedRefs = [...selectedManifest.payloadByRef.keys()];
    const selectedReads: string[] = [];
    const selectedHarness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest: selectedManifest,
      clock: { now: () => 1_000, deadline: () => 61_000 },
      onSnapshotRead: ({ ref }) => selectedReads.push(ref),
    });

    const ordinaryManifest = createManifest();
    const ordinaryRefs = [...ordinaryManifest.payloadByRef.keys()];
    const ordinaryReads: string[] = [];
    const ordinaryHarness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest: ordinaryManifest,
      clock: { now: () => 1_000, deadline: () => 61_000 },
      onSnapshotRead: ({ ref }) => ordinaryReads.push(ref),
    });

    const plan = {
      targets: [{ contextGraphId: publicCg, lane: 'selected-public' as const }],
    };
    try {
      await callSelectedSharedMemoryFromPeerDetailed(
        selectedHarness.agent,
        [publicCg],
        {
          selectedSwmPriority: true,
          priority: 2_000,
          recoveryTargets: plan.targets,
        },
      );
      await callSyncSharedMemoryFromPeerDetailed(
        ordinaryHarness.agent,
        [publicCg],
        { sharedMemorySyncPlan: plan },
      );

      expect(selectedReads).toEqual([
        selectedRefs[7], selectedRefs[6], selectedRefs[5], selectedRefs[0],
        selectedRefs[4], selectedRefs[3], selectedRefs[2], selectedRefs[1],
      ]);
      expect(ordinaryReads).toEqual(ordinaryRefs);
    } finally {
      await selectedHarness.close();
      await ordinaryHarness.close();
    }
  });

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
          recoveryTargets: [{ contextGraphId: publicCg, lane: 'selected-public' }],
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
      expect(selected.scopeComplete).toBe(true);
      expect(selected.targetDiagnostics.selectedPublic).toEqual({ completed: 1, total: 1 });
      expect(summary.continuationPasses).toBe(0);
      expect(harness.probes.publicAdmissions()).toBe(1);
      expect(harness.agent.selectedSwmBootstrapAdmission.isRetryRequired(PEER)).toBe(false);
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
          recoveryTargets: [{ contextGraphId: publicCg, lane: 'selected-public' }],
        },
      );

      expect(selected.shared.fetchedMetaTriples).toBeGreaterThan(0);
      expect(selected.shared.insertedMetaTriples).toBe(0);
      expect(selected.shared.failedPhases).toBeGreaterThan(0);
      expect(selected.shared.swmCoverage).toBeUndefined();
      expect(selected.scopeComplete).toBe(false);
      expect(selected.targetDiagnostics.selectedPublic).toEqual({ completed: 0, total: 1 });
      expect(harness.agent.selectedSwmBootstrapAdmission.isRetryRequired(PEER)).toBe(true);
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
          recoveryTargets: [{ contextGraphId: publicCg, lane: 'selected-public' }],
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
      expect(selected.scopeComplete).toBe(false);
      expect(selected.targetDiagnostics.selectedPublic).toEqual({ completed: 0, total: 1 });
      expect(harness.agent.selectedSwmBootstrapAdmission.isRetryRequired(PEER)).toBe(true);
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
          recoveryTargets: [{ contextGraphId: publicCg, lane: 'selected-public' }],
        },
      );

      expect(selected.shared.swmCoverage).toBeUndefined();
      expect(selected.shared.timedOutPhases).toBeGreaterThan(0);
      expect(selected.scopeComplete).toBe(false);
      expect(selected.targetDiagnostics.selectedPublic).toEqual({ completed: 0, total: 1 });
      expect(harness.agent.selectedSwmBootstrapAdmission.isRetryRequired(PEER)).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('keeps the reserved selected-provider lane public-only and leaves private recovery ordinary', async () => {
    const publicCg = 'selected-public-cg';
    const unselectedPublicCg = 'unselected-public-cg';
    const privateCg = 'did:dkg:agent:0x1111111111111111111111111111111111111111/private-cg';
    const syncCalls: Array<{
      contextGraphIds: readonly string[];
      selected: boolean;
    }> = [];
    const plannedScopes: Array<readonly string[]> = [];
    const agent: SelectedProviderSelectionAgent = {
      started: true,
      config: {
        syncOnConnect: true,
        syncSharedMemoryOnConnect: true,
        syncContextGraphs: [],
        rfc64CatalogBootstrap: {
          acceptedPolicies: [
            { contextGraphId: publicCg, accessPolicy: 0 as const },
            { contextGraphId: unselectedPublicCg, accessPolicy: 0 as const },
            { contextGraphId: privateCg, accessPolicy: 1 as const },
          ].map(({ contextGraphId, accessPolicy }) => ({
            policyEnvelope: { payload: { contextGraphId, accessPolicy } },
            completeSwmProviders: [PEER],
          })),
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
      applySyncOnConnectAccounting:
        LifecycleSyncMethods.prototype.applySyncOnConnectAccounting,
      selectedSwmBootstrapAdmission: new SelectedSwmBootstrapAdmission(),
      rfc64SwmRecoveryCoordinatorV1: {
        admitSelectedPublic: (peerId, contextGraphIds) => (
          agent.selectedSwmBootstrapAdmission.request(peerId, contextGraphIds)
        ),
      },
      readRfc64CatalogRuntimeSelectionV1: () => ({
        selectedContextGraphs: [publicCg, privateCg],
      }),
      resolveActiveRfc64SwmRecoveryPlanV1: (providerPeerId) => ({
        kind: 'rfc64-active-swm-recovery-plan-v1' as const,
        providerPeerId,
        targets: [
          { contextGraphId: publicCg, lane: 'selected-public' },
          { contextGraphId: privateCg, lane: 'ordinary-private' },
        ],
      }),
      selectedSwmBootstrapContextGraphIdsForPeer:
        LifecycleSyncMethods.prototype.selectedSwmBootstrapContextGraphIdsForPeer,
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      planSharedMemorySyncContextGraphs: async (_peerId, contextGraphIds = []) => {
        plannedScopes.push([...contextGraphIds]);
        return {
          targets: contextGraphIds.map((contextGraphId) => ({
            contextGraphId,
            lane: contextGraphId === privateCg
              ? 'ordinary-private' as const
              : 'selected-public' as const,
          })),
        };
      },
      resolveRfc64CompleteSwmProviderPeerIdsV1: (contextGraphId: string) => (
        [publicCg, unselectedPublicCg, privateCg].includes(contextGraphId) ? [PEER] : []
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
        options,
      ) => {
        syncCalls.push({
          contextGraphIds: [...contextGraphIds],
          selected: true,
        });
        return {
          kind: 'selected-shared-memory',
          requestedScope: options.requestedScope,
          shared: cleanDurableResult(),
          scopeComplete: true,
          targetDiagnostics: {
            selectedPublic: { completed: 1, total: 1 },
            ordinaryPrivate: { completed: 0, total: 0 },
          },
        };
      },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };

    await callTrySyncFromPeer.call(agent, PEER);

    expect(syncCalls).toEqual([
      { contextGraphIds: [publicCg], selected: true },
      { contextGraphIds: [privateCg], selected: false },
    ]);
    expect(plannedScopes).toEqual([
      [privateCg],
    ]);
    expect(plannedScopes.every((scope) => !scope.includes(unselectedPublicCg)))
      .toBe(true);
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
          acceptedPublicPolicies: [{
            policyEnvelope: { payload: { contextGraphId: publicCg } },
            completeSwmProviders: [PEER],
          }],
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
      applySyncOnConnectAccounting:
        LifecycleSyncMethods.prototype.applySyncOnConnectAccounting,
      selectedSwmBootstrapAdmission: new SelectedSwmBootstrapAdmission(),
      rfc64SwmRecoveryCoordinatorV1: {
        admitSelectedPublic: (peerId, contextGraphIds) => (
          agent.selectedSwmBootstrapAdmission.request(peerId, contextGraphIds)
        ),
      },
      readRfc64CatalogRuntimeSelectionV1: () => ({
        selectedContextGraphs: [publicCg],
      }),
      resolveActiveRfc64SwmRecoveryPlanV1: (providerPeerId) => ({
        kind: 'rfc64-active-swm-recovery-plan-v1' as const,
        providerPeerId,
        targets: [{ contextGraphId: publicCg, lane: 'selected-public' }],
      }),
      selectedSwmBootstrapContextGraphIdsForPeer:
        LifecycleSyncMethods.prototype.selectedSwmBootstrapContextGraphIdsForPeer,
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      planSharedMemorySyncContextGraphs: async () => ({
        targets: [{ contextGraphId: publicCg, lane: 'selected-public' }],
      }),
      resolveRfc64CompleteSwmProviderPeerIdsV1: () => [PEER],
      syncFromPeerDetailed: async () => 0,
      refreshMetaSyncedFlags: async () => undefined,
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeerDetailed: async () => cleanDurableResult(),
      syncSelectedSharedMemoryFromPeerDetailed: async (
        _peerId: string,
        _contextGraphIds: readonly string[],
        options,
      ) => ({
        kind: 'selected-shared-memory',
        requestedScope: options.requestedScope,
        shared: cleanDurableResult(),
        // The producer carries whole-selected-scope completeness explicitly;
        // freshness accounting must not depend on ambient peer state.
        scopeComplete: false,
        targetDiagnostics: {
          selectedPublic: { completed: 0, total: 1 },
          ordinaryPrivate: { completed: 0, total: 0 },
        },
      }),
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };

    await callTrySyncFromPeer.call(agent, PEER, (outcome) => accounting.push(outcome));

    expect(agent.selectedSwmBootstrapAdmission.isRetryRequired(PEER)).toBe(true);
    expect(agent.lastSuccessfulSyncAt.has(PEER)).toBe(false);
    expect(accounting).toEqual([{
      reconcilerDisposition: 'retry',
      fresh: false,
      progress: false,
    }]);
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
          requestedScope: { kind: 'rfc64-recovery-plan' },
          priority: 2_000,
          recoveryTargets: [
            { contextGraphId: publicCg, lane: 'selected-public' },
            { contextGraphId: privateCg, lane: 'ordinary-private' },
          ],
        },
      );
      const summary = selected.shared;

      expect(summary.swmCoverage).toMatchObject({
        contextGraphId: publicCg,
        snapshotsResolved: 905,
        snapshotsTotal: 905,
        missingCount: 0,
      });
      expect(selected.requestedScope).toMatchObject({
        kind: 'rfc64-recovery-plan',
        plan: {
          providerPeerId: PEER,
          targets: [
            { contextGraphId: publicCg, lane: 'selected-public' },
            { contextGraphId: privateCg, lane: 'ordinary-private' },
          ],
        },
      });
      expect(selected.scopeComplete).toBe(true);
      expect(selected.targetDiagnostics).toEqual({
        selectedPublic: { completed: 1, total: 1 },
        ordinaryPrivate: { completed: 1, total: 1 },
      });
      expect(summary.continuationPasses).toBe(1);
      expect(summary.snapshotPlaneIncomplete).toBe(1);
      expect(summary.failedPhases).toBe(1);
      expect(summary.resolvedSnapshotPlaneIncomplete).toBe(1);
      expect(summary.timedOutPhases).toBe(0);
      expect(summary.backoffWorthyFailures).toBe(0);
      expect(harness.agent.selectedSwmBootstrapAdmission.isRetryRequired(PEER)).toBe(false);
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

      const onSyncAccounting = vi.fn();
      const outcome = await runSelectedSharedMemoryRetry({
        remotePeer: PEER,
        syncingPeers: new Set(),
        getPeerProtocols: async () => [PROTOCOL_SYNC],
        selectedSharedMemoryLane: {
          admitWork: () => ({
            contextGraphIds: [publicCg],
            syncFromPeer: async () => selected,
          }),
        },
        onSyncAccounting,
        logInfo: () => {},
      });
      expect(outcome).toBe('synced');
      expect(onSyncAccounting).toHaveBeenCalledWith(PEER, {
        reconcilerDisposition: 'clear',
        fresh: false,
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
          recoveryTargets: [completeCg, incompleteCg].map((contextGraphId) => ({
            contextGraphId,
            lane: 'selected-public' as const,
          })),
        },
      );
      expect(selected.scopeComplete).toBe(false);
      expect(selected.targetDiagnostics.selectedPublic).toEqual({ completed: 1, total: 2 });
      expect(harness.agent.selectedSwmBootstrapAdmission.isRetryRequired(PEER)).toBe(true);
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
          recoveryTargets: [{ contextGraphId: publicCg, lane: 'selected-public' }],
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
      targets: [{ contextGraphId: publicCg, lane: 'selected-public' as const }],
    };

    try {
      const firstSelected = await callSelectedSharedMemoryFromPeerDetailed(
        harness.agent,
        [publicCg],
        { selectedSwmPriority: true, priority: 2_000, recoveryTargets: plan.targets },
      );
      const first = firstSelected.shared;

      expect(first.metadataContinuationYields).toBe(1);
      expect(firstSelected.scopeComplete).toBe(false);
      expect(firstSelected.targetDiagnostics.selectedPublic).toEqual({ completed: 0, total: 1 });
      expect(harness.probes.processedMetaBatches).toEqual([]);
      expect(harness.agent.selectedSwmBootstrapAdmission.isRetryRequired(PEER)).toBe(true);

      const queuedPeers: string[] = [];
      const queueAgent = harness.agent as SelectedSwmLifecycleAgentFixture & Record<string, any>;
      queueAgent.networkAdmissionCoordinator = { isAcceptedPeer: () => true };
      queueAgent.lastSuccessfulSyncAt = new Map([[PEER, Date.now()]]);
      queueAgent.lastSyncDisconnectedAt = new Map<string, number>();
      queueAgent.catchupOnConnectAt = new Map<string, number>();
      queueAgent.rfc64ExactCatchupOnConnectAt = new Map<string, number>();
      queueAgent.syncOnConnectPeerScheduler = new SyncOnConnectPeerScheduler({
        createJob: (peerId) => ({
          runAutomaticSelectedThenOrdinary: async () => 'not-started',
          runSelected: async () => {
            queuedPeers.push(peerId);
            return 'not-started';
          },
          cancel: () => undefined,
          finish: () => undefined,
        }),
        onInternalError: () => undefined,
      });
      queueAgent.getSyncOnConnectPeerScheduler =
        LifecycleSyncMethods.prototype.getSyncOnConnectPeerScheduler;
      queueAgent.syncReconcilerBackoff = new Map<string, unknown>();
      queueAgent.syncOnConnectDisconnectBoundary =
        LifecycleSyncMethods.prototype.syncOnConnectDisconnectBoundary;
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
        { selectedSwmPriority: true, priority: 2_000, recoveryTargets: plan.targets },
      );
      const second = secondSelected.shared;

      expect(second.failedPhases).toBe(0);
      expect(secondSelected.scopeComplete).toBe(true);
      expect(secondSelected.targetDiagnostics.selectedPublic).toEqual({ completed: 1, total: 1 });
      expect(harness.probes.metaRequesterScopes).toHaveLength(2);
      expect(harness.probes.metaRequesterScopes[1]).toBe(
        harness.probes.metaRequesterScopes[0],
      );
      expect(
        harness.probes.metaReturnAcceptedPrefixOnRetryableTransportFailure,
      ).toEqual([true, true]);
      expect(harness.probes.processedMetaBatches).toEqual([manifest.meta]);
      expect(harness.agent.selectedSwmBootstrapAdmission.isRetryRequired(PEER)).toBe(false);
    } finally {
      if (previousBudget === undefined) {
        delete process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS;
      } else {
        process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS = previousBudget;
      }
      await harness.close();
    }
  });

  it('resumes an exact snapshot walk across bounded outer reconciler invocations', async () => {
    const publicCg = 'selected-cross-outer-snapshots';
    const manifest = snapshotManifest(publicCg, 10);
    let wallNow = 1_000;
    const readsByAdmission = new Map<number, number>();
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => wallNow, deadline: () => wallNow + 1 },
      onSnapshotRead: ({ publicAdmission }) => {
        const reads = (readsByAdmission.get(publicAdmission) ?? 0) + 1;
        readsByAdmission.set(publicAdmission, reads);
        if (reads === 2) wallNow += 120_000;
      },
    });
    const plan = {
      targets: [{ contextGraphId: publicCg, lane: 'selected-public' as const }],
    };

    try {
      const first = await callSelectedSharedMemoryFromPeerDetailed(
        harness.agent,
        [publicCg],
        { selectedSwmPriority: true, priority: 2_000, recoveryTargets: plan.targets },
      );
      expect(first.scopeComplete).toBe(false);
      expect(first.targetDiagnostics.selectedPublic).toEqual({ completed: 0, total: 1 });
      expect(first.shared.swmCoverage).toMatchObject({
        contextGraphId: publicCg,
        snapshotsResolved: 8,
        snapshotsTotal: 10,
        missingCount: 2,
      });
      expect(first.shared.continuationPasses).toBe(3);
      expect(harness.probes.metaFetches()).toBe(1);
      expect(harness.probes.snapshotReads()).toBe(8);

      const second = await callSelectedSharedMemoryFromPeerDetailed(
        harness.agent,
        [publicCg],
        { selectedSwmPriority: true, priority: 2_000, recoveryTargets: plan.targets },
      );
      expect(second.scopeComplete).toBe(true);
      expect(second.targetDiagnostics.selectedPublic).toEqual({ completed: 1, total: 1 });
      expect(second.shared.swmCoverage).toMatchObject({
        contextGraphId: publicCg,
        snapshotsResolved: 10,
        snapshotsTotal: 10,
        missingCount: 0,
      });
      // The completed manifest and eight proven refs survived the outer
      // boundary. No metadata refetch and no re-read of the old prefix.
      expect(harness.probes.metaFetches()).toBe(1);
      expect(harness.probes.snapshotReads()).toBe(10);
      expect(harness.probes.publicAdmissions()).toBe(5);
    } finally {
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
      targets: [{ contextGraphId: publicCg, lane: 'selected-public' as const }],
    };

    try {
      await callSelectedSharedMemorySummary(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        recoveryTargets: plan.targets,
      });
      wallNow += DURABLE_DATA_SYNC_SESSION_TTL_MS + 1;
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
      targets: [{ contextGraphId: publicCg, lane: 'selected-public' as const }],
    };

    try {
      await callSelectedSharedMemorySummary(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        recoveryTargets: plan.targets,
      });
      await callSelectedSharedMemorySummary(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        recoveryTargets: plan.targets,
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
      targets: [{ contextGraphId: publicCg, lane: 'selected-public' as const }],
    };

    try {
      await callSelectedSharedMemorySummary(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        recoveryTargets: plan.targets,
      });
      const failed = await callSelectedSharedMemorySummary(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        recoveryTargets: plan.targets,
      });
      expect(failed.failedPhases + failed.failedPeers).toBeGreaterThan(0);
      await callSelectedSharedMemorySummary(harness.agent, [publicCg], {
        selectedSwmPriority: true,
        recoveryTargets: plan.targets,
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
