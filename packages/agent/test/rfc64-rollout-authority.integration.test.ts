// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';
import {
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  computeAuthorCatalogScopeDigestV1,
  deriveCanonicalGraphScopedAuthorSealPlacementV1,
  projectCanonicalGraphScopedAuthorSealRowsV1,
  type AssertionSeal,
  type CanonicalGraphScopedAuthorSealV1,
  type Digest32V1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DKGAgent } from '../src/index.js';
import { Rfc64PublicCatalogSuccessorProducerV1 } from
  '../src/rfc64/public-catalog-successor-producer-v1.js';
import { deriveRfc64PublicSwmGraphV1 } from
  '../src/rfc64/catalog-semantic-authority-transition-v1.js';
import {
  commitPreparedRfc64AppliedCatalogAuthorityDeactivationsV1,
  prepareRfc64AppliedCatalogAuthorityDeactivationV1,
} from '../src/rfc64/applied-catalog-authority-transition-v1.js';
import {
  createRfc64RolloutAgentHarness,
  RFC64_ROLLOUT_AUTHOR as AUTHOR,
  RFC64_ROLLOUT_AUTHOR_WALLET as AUTHOR_WALLET,
  RFC64_ROLLOUT_CONTEXT_GRAPH_ID as CONTEXT_GRAPH_ID,
  RFC64_ROLLOUT_DEPLOYMENT as DEPLOYMENT,
  RFC64_ROLLOUT_KAV10 as KAV10,
  RFC64_ROLLOUT_NETWORK_ID as NETWORK_ID,
  rfc64RolloutActivation as activation,
  rfc64RolloutPolicyEnvelope as policyEnvelope,
} from './_helpers/rfc64-rollout-agent-harness.js';

const PROJECTION_QUADS: readonly Quad[] = Object.freeze([
  Object.freeze({
    subject: 'https://example.org/alice',
    predicate: 'https://schema.org/age',
    object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
    graph: '',
  }),
  Object.freeze({
    subject: 'https://example.org/alice',
    predicate: 'https://schema.org/name',
    object: '"Alice"',
    graph: '',
  }),
]);
const {
  createDataDir,
  startAgent,
  restartAgent,
  cleanup,
} = createRfc64RolloutAgentHarness();

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe('RFC-64 rollout authority integration', () => {
  it('keeps an eligible edge CG dormant until subscribe and deactivates it on unsubscribe', async () => {
    const providerPeerId = '12D3KooWSubscriptionOwnedCatalogProvider';
    let synchronize!: ReturnType<typeof vi.spyOn>;
    const edge = await startAgent({
      name: 'subscription-owned-selection',
      activation: {
        ...activation('catalog'),
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: policyEnvelope(),
            targets: [{ authorAddress: AUTHOR, providers: [providerPeerId] }],
          }],
        },
      },
      beforeStart: (agent) => {
        synchronize = vi.spyOn(agent, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
          .mockResolvedValue(null);
      },
      config: { syncContextGraphs: [] },
    });
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    const initialPass = edge.readRfc64PublicCatalogBootstrapStatusV1()?.pass ?? 0;

    expect(edge.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(false);
    expect(edge.readRfc64CatalogRuntimeSelectionV1()).toEqual({
      subscriptionDriven: true,
      eligibleContextGraphs: [CONTEXT_GRAPH_ID],
      selectedContextGraphs: [],
    });
    expect(edge.rfc64PublicCatalogStatsV1()).toMatchObject({
      started: true,
      acceptedPolicies: 1,
    });
    expect(edge.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
      outcome: 'inactive',
      attempts: 0,
    });
    expect(synchronize).not.toHaveBeenCalled();

    // Sync-scope bookkeeping is not a subscription and cannot independently
    // activate RFC-64 receiver work.
    expect(edge.trackSyncContextGraph(CONTEXT_GRAPH_ID)).toBe(false);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(synchronize).not.toHaveBeenCalled();

    edge.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(edge.readRfc64CatalogRuntimeSelectionV1().selectedContextGraphs)
      .toEqual([CONTEXT_GRAPH_ID]);
    expect(edge.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(true);
    expect((edge as any).gossipRegistered.has(CONTEXT_GRAPH_ID)).toBe(false);
    expect(edge.readRfc64PublicCatalogBootstrapStatusV1()?.pass).toBeGreaterThan(initialPass);
    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(edge.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
      outcome: 'not-found',
      attempts: 1,
    });

    // An idempotent subscription cannot enqueue a duplicate invalidation.
    edge.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(synchronize).toHaveBeenCalledTimes(1);

    edge.unsubscribeFromContextGraph(CONTEXT_GRAPH_ID);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(edge.readRfc64CatalogRuntimeSelectionV1().selectedContextGraphs).toEqual([]);
    expect(edge.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
      outcome: 'inactive',
      attempts: 0,
    });
    expect(synchronize).toHaveBeenCalledTimes(1);

    edge.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(edge.deleteContextGraphSubscription(CONTEXT_GRAPH_ID)).toBe(true);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(edge.readRfc64CatalogRuntimeSelectionV1().selectedContextGraphs).toEqual([]);
    expect(edge.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
      outcome: 'inactive',
      attempts: 0,
    });
    expect(synchronize).toHaveBeenCalledTimes(2);
  });

  it('aborts a stale in-flight bootstrap pass and waits through the inactive rerun', async () => {
    const providerPeerId = '12D3KooWBlockedSubscriptionCatalogProvider';
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    let firstSignal: AbortSignal | undefined;
    let synchronize!: ReturnType<typeof vi.spyOn>;
    const edge = await startAgent({
      name: 'subscription-transition-during-bootstrap',
      activation: {
        ...activation('catalog'),
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: policyEnvelope(),
            targets: [{ authorAddress: AUTHOR, providers: [providerPeerId] }],
          }],
        },
      },
      beforeStart: (agent) => {
        synchronize = vi.spyOn(agent, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
          .mockImplementationOnce(async ({ signal }) => {
            firstSignal = signal;
            markEntered();
            await new Promise<void>((resolve) => {
              signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            return null;
          })
          .mockResolvedValue(null);
      },
      config: { syncContextGraphs: [] },
    });
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    const initialPass = edge.readRfc64PublicCatalogBootstrapStatusV1()?.pass ?? 0;

    edge.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    await entered;
    edge.unsubscribeFromContextGraph(CONTEXT_GRAPH_ID);
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();

    expect(firstSignal?.aborted).toBe(true);
    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(edge.readRfc64PublicCatalogBootstrapStatusV1()).toMatchObject({
      running: false,
      pass: initialPass + 2,
      targets: [expect.objectContaining({
        outcome: 'inactive',
        attempts: 0,
      })],
    });
  });

  it('retains manifest-wide RFC-64 selection on core nodes', async () => {
    const providerPeerId = '12D3KooWCoreManifestWideCatalogProvider';
    let synchronize!: ReturnType<typeof vi.spyOn>;
    const core = await startAgent({
      name: 'core-manifest-selection',
      activation: {
        ...activation('catalog'),
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: policyEnvelope(),
            targets: [{ authorAddress: AUTHOR, providers: [providerPeerId] }],
          }],
        },
      },
      beforeStart: (agent) => {
        synchronize = vi.spyOn(agent, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
          .mockResolvedValue(null);
      },
      config: { nodeRole: 'core', syncContextGraphs: [] },
    });
    await core.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(core.readRfc64CatalogRuntimeSelectionV1()).toEqual({
      subscriptionDriven: false,
      eligibleContextGraphs: [CONTEXT_GRAPH_ID],
      selectedContextGraphs: [CONTEXT_GRAPH_ID],
    });
    expect(synchronize).toHaveBeenCalledWith(expect.objectContaining({
      remotePeerIds: [providerPeerId],
      scope: expect.objectContaining({
        authorAddress: AUTHOR,
        contextGraphId: CONTEXT_GRAPH_ID,
      }),
    }));

    // An ordinary host-only transition cannot abort manifest-wide core work.
    const deactivate = vi.spyOn(
      (core as any).rfc64PublicCatalogServiceV1,
      'deactivateReceiverContextGraph',
    );
    core.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    core.unsubscribeFromContextGraph(CONTEXT_GRAPH_ID);
    await core.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(deactivate).not.toHaveBeenCalled();
    expect(synchronize).toHaveBeenCalledTimes(1);
  });

  it('enforces legacy, shadow, catalog, and kill-switch authority at startup', async () => {
    const legacy = await startAgent({ name: 'legacy', activation: activation('legacy') });
    expect(legacy.getSyncContextGraphIds()).toContain(CONTEXT_GRAPH_ID);
    expect(legacy.rfc64PublicCatalogStatsV1()).toBeNull();

    const shadow = await startAgent({ name: 'shadow', activation: activation('shadow') });
    expect(shadow.getSyncContextGraphIds()).toContain(CONTEXT_GRAPH_ID);
    expect(shadow.rfc64PublicCatalogStatsV1()).toMatchObject({ started: true });

    const catalog = await startAgent({ name: 'catalog', activation: activation('catalog') });
    expect(catalog.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    expect(catalog.rfc64PublicCatalogStatsV1()).toMatchObject({ started: true });
    catalog.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    expect(catalog.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    expect((catalog as any).gossipRegistered.has(CONTEXT_GRAPH_ID)).toBe(false);

    const stopped = await startAgent({
      name: 'kill-switch',
      activation: {
        ...activation('catalog', true),
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: policyEnvelope(),
            targets: [],
            completeSwmProviders: ['12D3KooWKilledCompleteProvider'],
          }],
        },
      },
    });
    expect(stopped.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    expect(stopped.rfc64PublicCatalogStatsV1()).toBeNull();
    expect(stopped.readRfc64PublicCatalogBootstrapStatusV1()).toBeNull();
  });

  it('keeps authorized catalog-mode metadata refresh off member and host SWM gossip', async () => {
    const catalog = await startAgent({
      name: 'catalog-metadata-refresh-fence',
      activation: activation('catalog'),
    });
    catalog.subscribeToContextGraph(CONTEXT_GRAPH_ID);

    const internals = catalog as any;
    expect(catalog.getSubscribedContextGraphs().get(CONTEXT_GRAPH_ID)).toMatchObject({
      subscribed: true,
    });
    expect(internals.sharedMemoryGossipRegistered.has(CONTEXT_GRAPH_ID)).toBe(false);

    // Exercise the exact post-catch-up transition from the review: metadata is
    // confirmed and local SWM membership would otherwise authorize the member
    // gossip consumer. queueSharedMemoryGossipSubscription remains
    // fire-and-forget, so capture the concrete reconciliation promise.
    vi.spyOn(catalog, 'hasConfirmedMetaState').mockResolvedValue(true);
    const memberAuthority = vi.spyOn(catalog, 'canUseSharedMemoryForContextGraph')
      .mockResolvedValue(true);
    const reconciliations: Promise<void>[] = [];
    const reconcile = catalog.reconcileSharedMemoryGossipSubscription.bind(catalog);
    vi.spyOn(catalog, 'reconcileSharedMemoryGossipSubscription').mockImplementation((cg) => {
      const pending = reconcile(cg);
      reconciliations.push(pending);
      return pending;
    });

    await internals.refreshMetaSyncedFlags([CONTEXT_GRAPH_ID]);
    await vi.waitFor(() => expect(reconciliations).toHaveLength(1));
    await Promise.all(reconciliations);

    expect(catalog.getSubscribedContextGraphs().get(CONTEXT_GRAPH_ID)).toMatchObject({
      subscribed: true,
      metaSynced: true,
    });
    expect(memberAuthority).not.toHaveBeenCalled();
    expect(internals.sharedMemoryGossipRegistered.has(CONTEXT_GRAPH_ID)).toBe(false);

    // A core's ordinary host reconciliation is another legacy entry point.
    // Make every non-RFC prerequisite available so catalog authority is the
    // reason it stays unwired.
    internals.swmHostModeStore = {};
    const curated = vi.spyOn(catalog, 'isCuratedForHostMode').mockResolvedValue(true);
    await catalog.reconcileSwmHostModeSubscription(CONTEXT_GRAPH_ID);
    const hostKey = catalog.canonicalSwmHostModeKey(CONTEXT_GRAPH_ID);
    expect(curated).not.toHaveBeenCalled();
    expect(internals.swmHostModeSubscribed.has(hostKey)).toBe(false);
    expect(internals.swmHostModeHandlers.has(hostKey)).toBe(false);
  });

  it('rehydrates persisted edge intent through exclusive catalog authority', async () => {
    const persisted = new Map<string, any>([[CONTEXT_GRAPH_ID, {
      id: CONTEXT_GRAPH_ID,
      name: 'persisted-before-rfc64',
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      syncScoped: true,
      coreHosted: false,
    }]]);
    const catalog = await startAgent({
      name: 'catalog-rehydration-fence',
      activation: activation('catalog'),
      config: {
        contextGraphSubscriptionStore: {
          loadAll: async () => [...persisted.values()],
          save: async (record) => { persisted.set(record.id, { ...record }); },
          delete: async (contextGraphId) => { persisted.delete(contextGraphId); },
        },
      },
    });
    expect(catalog.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(true);
    expect(catalog.readRfc64CatalogRuntimeSelectionV1().selectedContextGraphs)
      .toEqual([CONTEXT_GRAPH_ID]);
    expect(catalog.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    expect((catalog as any).gossipRegistered.has(CONTEXT_GRAPH_ID)).toBe(false);
    expect(catalog.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 1,
      dormant: 0,
      dormantIds: [],
    });
    expect(persisted.get(CONTEXT_GRAPH_ID)).toMatchObject({ subscribed: true });
  });

  it('keeps complete-provider recovery live when every selected CG is legacy-mode', async () => {
    const providerPeerId = '12D3KooWAllLegacyCompleteProvider';
    let connect!: ReturnType<typeof vi.spyOn>;
    let queue!: ReturnType<typeof vi.spyOn>;
    const legacy = await startAgent({
      name: 'all-legacy-provider',
      activation: {
        ...activation('legacy'),
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: policyEnvelope(),
            targets: [],
            completeSwmProviders: [providerPeerId],
          }],
        },
      },
      beforeStart: (agent) => {
        connect = vi.spyOn(agent, 'connectToPeerId').mockResolvedValue();
        queue = vi.spyOn(agent, 'queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect')
          .mockReturnValue(true);
      },
    });
    await legacy.whenRfc64PublicCatalogBootstrapIdleV1();

    expect(legacy.readRfc64PublicCatalogBootstrapStatusV1()).toMatchObject({
      // Startup observes the inactive edge first; the explicit subscription
      // then invalidates that pass and runs the active recovery pass.
      pass: 2,
      targets: [],
    });
    expect(connect).toHaveBeenCalledWith(providerPeerId, { timeoutMs: 10_000 });
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({ providerPeerId }),
      expect.any(Function),
      0,
    );
  });

  it.each(['legacy', 'shadow'] as const)(
    'semantically deactivates durable catalog authority before a %s restart',
    async (nextMode) => {
    const dataDir = await createDataDir('rollout-transition');
    const persistentStorePath = join(dataDir, 'oxigraph');
    const author = await startAgent({
      name: 'catalog-author',
      activation: {
        ...activation('catalog'),
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
      dataDir,
      persistentStorePath,
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const seal = await authorSeal(81n);
    const applied = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'rollout-restart-guard' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(seal),
    });
    expect(applied).toMatchObject({ catalogVersion: '1', inventoryRowCount: '1' });
    await seedCatalogSemanticClosure(author, seal, 'rollout-restart-guard');
    await expectCatalogSemanticClosure(
      author,
      seal,
      'rollout-restart-guard',
      true,
    );
    const producer = vi.spyOn(
      Rfc64PublicCatalogSuccessorProducerV1.prototype,
      'produceAndStageExactSet',
    );
    const restarted = await restartAgent(author, {
      name: `${nextMode}-after-catalog`,
      activation: activation(nextMode),
      dataDir,
      persistentStorePath,
    });
    expect(restarted.getSyncContextGraphIds()).toContain(CONTEXT_GRAPH_ID);
    expect(restarted.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toBeNull();
    await expectCatalogSemanticClosure(
      restarted,
      seal,
      'rollout-restart-guard',
      false,
    );
    expect(restarted.rfc64PublicCatalogStatsV1()).toEqual(
      nextMode === 'shadow' ? expect.objectContaining({ started: true }) : null,
    );
    expect(producer).not.toHaveBeenCalled();
    },
    30_000,
  );

  it('preserves locally authored shadow discovery state and legacy material on restart', async () => {
    const dataDir = await createDataDir('rollout-shadow-author');
    const persistentStorePath = join(dataDir, 'oxigraph');
    const author = await startAgent({
      name: 'shadow-author-restart',
      activation: {
        ...activation('shadow'),
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
      dataDir,
      persistentStorePath,
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const seal = await authorSeal(810n);
    const applied = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'shadow-author-restart-guard' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(seal),
    });
    expect(applied).not.toBeNull();
    // Shadow catalog publication accompanies existing legacy material; it does
    // not grant catalog semantic authority over that material.
    await seedCatalogSemanticClosure(author, seal, 'shadow-author-restart-guard');
    const restarted = await restartAgent(author, {
      name: 'shadow-author-restarted',
      activation: activation('shadow'),
      dataDir,
      persistentStorePath,
    });
    expect(restarted.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toMatchObject({ currentCatalogHeadDigest: applied?.currentCatalogHeadDigest });
    await expectCatalogSemanticClosure(
      restarted,
      seal,
      'shadow-author-restart-guard',
      true,
    );
  }, 30_000);

  it('preserves later legacy semantic content while relinquishing stale catalog authority', async () => {
    const dataDir = await createDataDir('rollout-divergent');
    const persistentStorePath = join(dataDir, 'oxigraph');
    const author = await startAgent({
      name: 'catalog-divergent-author',
      activation: {
        ...activation('catalog'),
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
      dataDir,
      persistentStorePath,
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const seal = await authorSeal(85n);
    const applied = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'rollout-divergent-preservation' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(seal),
    });
    await seedCatalogSemanticClosure(author, seal, 'rollout-divergent-preservation');
    const store = (author as unknown as { store: OxigraphStore }).store;
    const swmGraph = deriveRfc64PublicSwmGraphV1(CONTEXT_GRAPH_ID, seal.reservedKaId as never);
    await store.insert([{
      subject: 'https://example.org/later-legacy-write',
      predicate: 'https://schema.org/name',
      object: '"must survive"',
      graph: swmGraph,
    }]);
    const restarted = await restartAgent(author, {
      name: 'legacy-after-divergent-catalog',
      activation: activation('legacy'),
      dataDir,
      persistentStorePath,
    });
    expect(restarted.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toBeNull();
    expect(applied).not.toBeNull();
    await expectCatalogSemanticClosure(
      restarted,
      seal,
      'rollout-divergent-preservation',
      true,
    );
    const preserved = await (restarted as unknown as { store: OxigraphStore }).store.query(
      `ASK { GRAPH <${swmGraph}> { <https://example.org/later-legacy-write> ?p ?o } }`,
    );
    expect(preserved).toEqual({ type: 'boolean', value: true });
  }, 30_000);

  it.each(['later semantic removal', 'inventory deletion'] as const)(
    'rolls back the whole CG after injected %s failure and retries cleanly',
    async (failureStage) => {
      const author = await startAgent({
        name: 'catalog-atomic-transition',
        activation: {
          ...activation('catalog'),
          autoPublish: {
            peers: [],
            catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
          },
        },
      });
      vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
      const seals = [await authorSeal(86n), await authorSeal(87n)] as const;
      for (const [index, seal] of seals.entries()) {
        await author.recordRfc64PublicCatalogAssetV1({
          contextGraphId: CONTEXT_GRAPH_ID,
          assertionCoordinate: `rollout-atomic-${index}` as never,
          publicQuads: PROJECTION_QUADS,
          seal: assertionSealFromCanonical(seal),
        });
        await seedCatalogSemanticClosure(author, seal, `rollout-atomic-${index}`);
      }
      const internals = author as unknown as {
        store: TripleStore;
        rfc64PersistenceV1: {
          controlObjects: Parameters<
            typeof prepareRfc64AppliedCatalogAuthorityDeactivationV1
          >[0]['controlObjects'];
          inventory: Parameters<
            typeof commitPreparedRfc64AppliedCatalogAuthorityDeactivationsV1
          >[0]['inventory'] & {
            listAppliedCatalogHeadsV1(): readonly any[];
          };
        };
      };
      const [appliedHead] = internals.rfc64PersistenceV1.inventory.listAppliedCatalogHeadsV1();
      expect(appliedHead).toBeDefined();
      const prepared = await prepareRfc64AppliedCatalogAuthorityDeactivationV1({
        store: internals.store,
        controlObjects: internals.rfc64PersistenceV1.controlObjects,
        appliedHead,
      });
      let semanticMutations = 0;
      const injectedStore = new Proxy(internals.store, {
        get(target, property, receiver) {
          if (property === 'replaceGraphAndSubject') {
            return async (...args: unknown[]) => {
              semanticMutations += 1;
              if (failureStage === 'later semantic removal' && semanticMutations === 2) {
                throw new Error('injected later semantic removal failure');
              }
              return (target.replaceGraphAndSubject as (...values: unknown[]) => unknown)
                .apply(target, args);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const injectedInventory = failureStage === 'inventory deletion'
        ? { deleteAppliedCatalogHeadsV1: () => { throw new Error('injected inventory failure'); } }
        : internals.rfc64PersistenceV1.inventory;

      await expect(commitPreparedRfc64AppliedCatalogAuthorityDeactivationsV1({
        store: injectedStore,
        inventory: injectedInventory,
        prepared: [prepared],
      })).rejects.toThrow('catalog semantic authority deactivation failed');
      for (const [index, seal] of seals.entries()) {
        await expectCatalogSemanticClosure(author, seal, `rollout-atomic-${index}`, true);
      }
      expect(author.readRfc64AppliedCatalogHeadV1({
        catalogScopeDigest: catalogScopeDigest(),
        authorAddress: AUTHOR,
      })).not.toBeNull();

      await commitPreparedRfc64AppliedCatalogAuthorityDeactivationsV1({
        store: internals.store,
        inventory: internals.rfc64PersistenceV1.inventory,
        prepared: [prepared],
      });
      for (const [index, seal] of seals.entries()) {
        await expectCatalogSemanticClosure(author, seal, `rollout-atomic-${index}`, false);
      }
      expect(author.readRfc64AppliedCatalogHeadV1({
        catalogScopeDigest: catalogScopeDigest(),
        authorAddress: AUTHOR,
      })).toBeNull();
    },
    30_000,
  );

  it('pauses and resumes existing catalog authority without deleting it', async () => {
    const dataDir = await createDataDir('rollout-kill-switch');
    const persistentStorePath = join(dataDir, 'oxigraph');
    const author = await startAgent({
      name: 'kill-switch-author',
      activation: {
        ...activation('catalog'),
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
      dataDir,
      persistentStorePath,
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const seal = await authorSeal(84n);
    const applied = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'kill-switch-preservation' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(seal),
    });
    expect(applied).not.toBeNull();
    await seedCatalogSemanticClosure(author, seal, 'kill-switch-preservation');
    await expectCatalogSemanticClosure(author, seal, 'kill-switch-preservation', true);
    const stopped = await restartAgent(author, {
      name: 'kill-switch-active',
      activation: activation('catalog', true),
      dataDir,
      persistentStorePath,
    });
    expect(stopped.rfc64PublicCatalogStatsV1()).toBeNull();
    expect(stopped.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    expect(stopped.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toMatchObject({ currentCatalogHeadDigest: applied?.currentCatalogHeadDigest });
    await expectCatalogSemanticClosure(stopped, seal, 'kill-switch-preservation', true);
    const resumed = await restartAgent(stopped, {
      name: 'kill-switch-cleared',
      activation: activation('catalog'),
      dataDir,
      persistentStorePath,
    });
    expect(resumed.rfc64PublicCatalogStatsV1()).toMatchObject({ started: true });
    expect(resumed.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    expect(resumed.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toMatchObject({ currentCatalogHeadDigest: applied?.currentCatalogHeadDigest });
    await expectCatalogSemanticClosure(resumed, seal, 'kill-switch-preservation', true);
  }, 30_000);

  it('retains durable catalog authority for pre-activation standalone controls', async () => {
    const dataDir = await createDataDir('rollout-standalone');
    const persistentStorePath = join(dataDir, 'oxigraph');
    const author = await startAgent({
      name: 'standalone-author',
      activation: {
        ...activation('catalog'),
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
      dataDir,
      persistentStorePath,
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const applied = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'rollout-standalone-compatibility' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(await authorSeal(83n)),
    });
    expect(applied).not.toBeNull();
    const restarted = await restartAgent(author, {
      name: 'standalone-compatibility',
      dataDir,
      persistentStorePath,
      config: {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        rfc64PublicCatalogBootstrap: {
          acceptedPublicPolicies: [{ policyEnvelope: policyEnvelope(), targets: [] }],
        },
      },
    });
    expect(restarted.rfc64PublicCatalogStatsV1()).toMatchObject({ started: true });
    expect(restarted.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toMatchObject({
      currentCatalogHeadDigest: applied?.currentCatalogHeadDigest,
      catalogVersion: '1',
      inventoryRowCount: '1',
    });
  }, 30_000);

  it('cold-bootstraps a valid shadow head as staged-only with no applied head', async () => {
    const author = await startAgent({
      name: 'shadow-author',
      activation: {
        ...activation('catalog'),
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
      },
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    const published = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'rollout-shadow-bootstrap' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(await authorSeal(82n)),
    });
    const shadow = await startAgent({
      name: 'shadow-receiver',
      activation: {
        ...activation('shadow'),
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: policyEnvelope(),
            targets: [{ authorAddress: AUTHOR, providers: [author.peerId] }],
          }],
        },
      },
    });
    await connectBothWays(author, shadow);
    await vi.waitFor(() => {
      expect(shadow.readRfc64PublicCatalogBootstrapStatusV1()?.targets[0]).toMatchObject({
        mode: 'shadow',
        outcome: 'shadow-staged',
        stagedHeadDigest: published?.currentCatalogHeadDigest,
        appliedHeadDigest: null,
      });
    }, { timeout: 20_000, interval: 100 });
    expect(shadow.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR,
    })).toBeNull();
  }, 30_000);
});

async function connectBothWays(a: DKGAgent, b: DKGAgent): Promise<void> {
  const address = (agent: DKGAgent) => {
    const tcp = agent.multiaddrs.find((candidate) => candidate.includes('/tcp/'));
    if (tcp === undefined) throw new Error('agent has no TCP multiaddr');
    return tcp;
  };
  await a.node.libp2p.dial(multiaddr(address(b)));
  await b.node.libp2p.dial(multiaddr(address(a)));
}

async function expectCatalogSemanticClosure(
  agent: DKGAgent,
  seal: CanonicalGraphScopedAuthorSealV1,
  assertionCoordinate: string,
  present: boolean,
): Promise<void> {
  const swmGraph = deriveRfc64PublicSwmGraphV1(
    CONTEXT_GRAPH_ID,
    seal.reservedKaId as never,
  );
  const placement = deriveCanonicalGraphScopedAuthorSealPlacementV1({
    contextGraphId: CONTEXT_GRAPH_ID,
    subGraphName: null,
    authorAddress: AUTHOR,
    assertionCoordinate: assertionCoordinate as never,
  });
  const store = (agent as unknown as { store: OxigraphStore }).store;
  await expect(store.hasGraph(swmGraph)).resolves.toBe(present);
  const sealRows = await store.query(
    `SELECT ?p ?o WHERE { GRAPH <${placement.metaGraph}> { `
      + `<${placement.subject}> ?p ?o } } LIMIT 1`,
  );
  expect(sealRows.type).toBe('bindings');
  if (sealRows.type !== 'bindings') throw new Error('expected seal bindings');
  expect(sealRows.bindings.length > 0).toBe(present);
}

async function seedCatalogSemanticClosure(
  agent: DKGAgent,
  seal: CanonicalGraphScopedAuthorSealV1,
  assertionCoordinate: string,
): Promise<void> {
  const swmGraph = deriveRfc64PublicSwmGraphV1(
    CONTEXT_GRAPH_ID,
    seal.reservedKaId as never,
  );
  const store = (agent as unknown as { store: OxigraphStore }).store;
  await store.insert([
    ...PROJECTION_QUADS.map((quad) => ({ ...quad, graph: swmGraph })),
    ...projectCanonicalGraphScopedAuthorSealRowsV1(seal, {
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null,
      authorAddress: AUTHOR,
      assertionCoordinate: assertionCoordinate as never,
    }),
  ]);
}

function catalogScopeDigest() {
  return computeAuthorCatalogScopeDigestV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    era: '0' as never,
    bucketCount: '1' as never,
  });
}

async function authorSeal(kaNumber: bigint): Promise<CanonicalGraphScopedAuthorSealV1> {
  const kaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
  const assertionMerkleRoot = ethers.hexlify(
    computeFlatKCRootV10([...PROJECTION_QUADS], []),
  ) as Digest32V1;
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(DEPLOYMENT.assertedAtChainId),
    kav10Address: DEPLOYMENT.assertedAtKav10Address,
    merkleRoot: ethers.getBytes(assertionMerkleRoot),
    authorAddress: AUTHOR,
    reservedKaId: BigInt(kaId),
  });
  const signature = ethers.Signature.from(await AUTHOR_WALLET.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot,
    authorAddress: AUTHOR,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address: KAV10,
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal: `did:dkg:${NETWORK_ID}/${AUTHOR}/${kaNumber}`,
    assertionVersion: '1',
    publicTripleCount: String(PROJECTION_QUADS.length),
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}

function assertionSealFromCanonical(seal: CanonicalGraphScopedAuthorSealV1): AssertionSeal {
  return {
    merkleRoot: ethers.getBytes(seal.assertionMerkleRoot),
    authorAddress: seal.authorAddress,
    authorAttestationR: ethers.getBytes(seal.authorAttestationR),
    authorAttestationVS: ethers.getBytes(seal.authorAttestationVS),
    authorSchemeVersion: 1,
    chainId: BigInt(seal.assertedAtChainId),
    kav10Address: seal.assertedAtKav10Address,
    reservedKaId: BigInt(seal.reservedKaId),
    finalizedAtIso: seal.assertionFinalizedAt,
    contentScopeVersion: 2,
    kaUal: seal.kaUal,
    assertionVersion: seal.assertionVersion,
    publicTripleCount: Number(seal.publicTripleCount),
    privateTripleCount: Number(seal.privateTripleCount),
    rootEntities: [],
  };
}
