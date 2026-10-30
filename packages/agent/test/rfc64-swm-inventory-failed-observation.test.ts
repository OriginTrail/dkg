import { describe, expect, it, vi } from 'vitest';
import { createOperationContext, type TimestampMsV1 } from '@origintrail-official/dkg-core';
import { activeDefaultStoreWorkPriority, GraphManager, isStoreOperationNotStarted, StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';

import { storeKnowledgeAssetOperationPublicQuads, storeKnowledgeAssetWorkspaceHead } from '@origintrail-official/dkg-publisher';
import { rfc64SwmInventoryShadowRuntimeV1, rfc64SwmInventoryAssetKeyV1 } from '../src/rfc64/swm-inventory-shadow-runtime-v1.js';

import {
  prepareRfc64LateLegacySwmBoundaryV1,
  readRfc64LegacySwmBoundaryCountV1,
} from '../src/rfc64/legacy-swm-boundary-v1.js';
import {
  AUTHOR,
  AUTHOR_WALLET,
  CONTEXT_GRAPH_ID,
  NETWORK_ID,
  PROJECTION_QUADS,
  seedDurableWorkspaceAssetV1,
  startRepairAgentV1,
} from './support/rfc64-local-catalog-repair-fixture.js';

describe('failed post-commit SWM inventory observation', () => {
  it('leaves a durable share missing until its observation is replayed, despite projection turns', async () => {
    const agent = await startRepairAgentV1({
      name: 'failed-inventory-observation',
      autoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    });
    vi.spyOn(agent, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    agent.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    await agent.whenRfc64CatalogResponsibilitiesIdleV1();
    await agent.whenRfc64CatalogSupervisorsIdleV1();
    // Seed canonical durable share state, not a mocked inventory result. This
    // fixture characterizes observation recovery, not promotion atomicity.
    const seeded = await seedDurableWorkspaceAssetV1(agent, 'lost-observation', 89n);
    const marker = prepareRfc64LateLegacySwmBoundaryV1(
      agent, CONTEXT_GRAPH_ID, seeded.seal.kaUal!, seeded.shareOperationId,
      seeded.seal.assertionVersion!,
    );
    let markerCommitted: boolean | undefined;
    try {
      await agent.store.insert([...marker.quads]);
      markerCommitted = true;
    } catch (error) {
      if (isStoreOperationNotStarted(error, 'insert')) markerCommitted = false;
      throw error;
    } finally {
      marker.settle(markerCommitted);
    }
    const readInventory = () => agent.readRfc64SwmAuthorInventorySnapshotV1({
      inventoryScopeDigest: seeded.scopeDigest,
      authorAddress: AUTHOR,
    });
    const params = {
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: seeded.assertionCoordinate,
      lifecycleAgentAddress: AUTHOR,
      shareOperationId: seeded.shareOperationId,
      ctx: createOperationContext('share'),
    };
    const record = vi.spyOn(agent, 'recordRfc64SwmAuthorInventoryShadowV1');
    const originalQuery = agent.store.query.bind(agent.store);
    const failure = new StoreSchedulerBusyError(
      'queue_wait_timeout', 'background', 'blazegraph.query',
      { storeOperation: 'query' },
    );
    expect(failure.outcome).toBe('not_started');
    let injectedFailures = 0;
    const query = vi.spyOn(agent.store, 'query').mockImplementation((sparql, options) => {
      if (options?.source === 'agent.rfc64.swmInventory.seal' && injectedFailures === 0) {
        injectedFailures += 1;
        return Promise.reject(failure);
      }
      return originalQuery(sparql, options);
    });

    try {
      await expect(agent.observeRfc64DurableSwmPromotionV1(params)).resolves.toBeUndefined();
      expect(injectedFailures).toBe(1);
      expect(record).toHaveBeenCalledOnce();
      await expect(record.mock.results[0]!.value).resolves.toMatchObject({
        status: 'failed', action: 'upsert',
      });
      expect(readInventory()).toBeNull();
      expect(readRfc64LegacySwmBoundaryCountV1(agent, CONTEXT_GRAPH_ID)).toBe(1);
      expect(agent.rfc64SwmAuthorInventoryShadowStatusV1()).toMatchObject({ failed: 1 });
      query.mockRestore();

      const projection = vi.spyOn(agent, 'reconcileRfc64PublicCatalogFromSwmInventoryV1');
      expect(agent.requestRfc64SwmCatalogProjectionV1({
        contextGraphId: CONTEXT_GRAPH_ID, authorAddress: AUTHOR,
      })).toBe(true);
      await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
      expect(projection).toHaveBeenCalled();
      expect(agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.repairs)
        .toEqual([expect.objectContaining({ outcome: 'no-inventory' })]);
      const retryInterval = agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.retryIntervalMs;
      expect(retryInterval).toBe(5_000);
      // Exercise the real recurring owner's deadline without replacing timers
      // that startup may already have armed.
      await new Promise((resolve) => setTimeout(resolve, retryInterval! + 25));
      await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
      expect(record).toHaveBeenCalledOnce();
      expect(readInventory()).toBeNull();
      expect(readRfc64LegacySwmBoundaryCountV1(agent, CONTEXT_GRAPH_ID)).toBe(1);

      // Re-observe the already committed share: no create/share/send replay.
      await agent.observeRfc64DurableSwmPromotionV1(params);
      await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
      expect(record).toHaveBeenCalledTimes(2);
      const recovered = readInventory();
      expect(recovered).toMatchObject({
        head: { payload: { totalRows: '1' } },
        rows: [expect.objectContaining({
          assertionCoordinate: seeded.assertionCoordinate,
          shareOperationId: seeded.shareOperationId,
          kaUal: seeded.seal.kaUal,
        })],
      });
      expect(readRfc64LegacySwmBoundaryCountV1(agent, CONTEXT_GRAPH_ID)).toBe(0);
      await agent.observeRfc64DurableSwmPromotionV1(params);
      await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
      expect(readInventory()).toEqual(recovered);
    } finally {
      query.mockRestore();
    }
  }, 30_000);
  it.each(['recover', 'vm-confirmed', 'new-head', 'shutdown', 'indeterminate', 'post-preparation', 'inventory-write', 'explicit-legacy'] as const)(
    'queued observation handles %s after a preparation read failure', async (outcome) => {
    const agent = await startRepairAgentV1({
      name: 'retry-inventory-observation',
      autoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    });
    vi.spyOn(agent, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    agent.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    await agent.whenRfc64CatalogResponsibilitiesIdleV1();
    const seeded = await seedDurableWorkspaceAssetV1(agent, 'automatic-retry', 90n);
    const originalQuery = agent.store.query.bind(agent.store);
    let failures = 0;
    const priorities: unknown[] = [];
    const record = vi.spyOn(agent, 'recordRfc64SwmAuthorInventoryShadowV1');
    if (outcome === 'post-preparation') {
      vi.spyOn(agent, 'createRfc64CatalogAuthorSignerV1').mockImplementation(() => {
        throw new StoreSchedulerBusyError('queue_wait_timeout', 'background', 'blazegraph.query', { storeOperation: 'query' });
      });
    }
    const persistenceOwner = agent as unknown as { rfc64PersistenceV1: {
      swmAuthorInventory: { compareAndSwapSwmAuthorInventoryV1: (...args: unknown[]) => unknown };
    } };
    const originalPersistence = persistenceOwner.rfc64PersistenceV1;
    const failInventoryWrite = vi.fn(() => {
      throw new StoreSchedulerBusyError('queue_wait_timeout', 'background', 'blazegraph.query', { storeOperation: 'query' });
    });
    if (outcome === 'inventory-write') {
      // The persistence facade is deliberately frozen; replace only its test-owned forwarding view.
      persistenceOwner.rfc64PersistenceV1 = { ...originalPersistence, swmAuthorInventory: {
        ...originalPersistence.swmAuthorInventory, compareAndSwapSwmAuthorInventoryV1: failInventoryWrite,
      } };
    }
    const query = vi.spyOn(agent.store, 'query').mockImplementation((sparql, options) => {
      if (options?.source === 'agent.rfc64.swmInventory.seal') {
        priorities.push(activeDefaultStoreWorkPriority());
        if (failures === 0 && outcome !== 'post-preparation' && outcome !== 'inventory-write') {
          failures += 1;
          return Promise.reject(outcome === 'indeterminate' ? new Error('query transport outcome unknown') : new StoreSchedulerBusyError(
            'queue_wait_timeout', 'background', 'blazegraph.query', { storeOperation: 'query' },
          ));
        }
      }
      return originalQuery(sparql, options);
    });
    const schedule = (agent as unknown as {
      scheduleRfc64SwmInventoryObserverV1(params: Readonly<{
        contextGraphId: string;
        assertionCoordinate: string;
        lifecycleAgentAddress: string;
        shareOperationId: string;
        ctx: ReturnType<typeof createOperationContext>;
      }>): void;
    }).scheduleRfc64SwmInventoryObserverV1.bind(agent);
    try {
      schedule({
        contextGraphId: CONTEXT_GRAPH_ID,
        assertionCoordinate: seeded.assertionCoordinate,
        lifecycleAgentAddress: AUTHOR,
        shareOperationId: seeded.shareOperationId,
        ctx: createOperationContext('share'),
      });
      const runtime = rfc64SwmInventoryShadowRuntimeV1(agent);
      const asset = { contextGraphId: CONTEXT_GRAPH_ID, authorAddress: AUTHOR, assertionCoordinate: seeded.assertionCoordinate };
      if (outcome === 'vm-confirmed' || outcome === 'new-head' || outcome === 'shutdown' || outcome === 'explicit-legacy') {
        await vi.waitFor(() => {
          expect(failures).toBe(1);
          expect(runtime.hasInventoryWrites(asset)).toBe(false);
          expect(runtime.inFlightCount).toBe(1);
        }, { timeout: 1_000, interval: 1 });
        if (outcome === 'vm-confirmed') {
          runtime.markVmConfirmed(rfc64SwmInventoryAssetKeyV1(asset), seeded.seal.assertionVersion!, seeded.shareOperationId);
        } else if (outcome === 'shutdown') {
          await runtime.closeAndDrain();
        } else if (outcome === 'explicit-legacy') {
          // Change the current authority-selection seam, not the captured observation result.
          vi.spyOn(agent as unknown as { resolveRfc64CatalogAuthoringLaneV1(): null }, 'resolveRfc64CatalogAuthoringLaneV1').mockReturnValue(null);
          vi.spyOn(agent, 'reconcileRfc64CatalogResponsibilityV1').mockResolvedValue({
            contextGraphId: CONTEXT_GRAPH_ID, responsible: true, responsibilityReason: 'edge-subscription',
            active: true, mode: 'legacy', selectionSource: 'operator-override',
          });
          vi.spyOn(agent, 'createRfc64CatalogAuthorSignerV1');
        } else {
          const common = { store: agent.store, graphManager: new GraphManager(agent.store), contextGraphId: CONTEXT_GRAPH_ID,
            kaUal: seeded.seal.kaUal!, assertionVersion: '2', shareOperationId: 'new-generation-share' };
          await storeKnowledgeAssetOperationPublicQuads({ ...common, quads: PROJECTION_QUADS, privateTripleCount: 0,
            publisherPeerId: agent.peerId, accessPolicy: 'public', agentAddress: AUTHOR, timestamp: new Date() });
          await storeKnowledgeAssetWorkspaceHead(common);
        }
      }
      await runtime.drain();
      const inventory = agent.readRfc64SwmAuthorInventorySnapshotV1({ inventoryScopeDigest: seeded.scopeDigest, authorAddress: AUTHOR });
      if (outcome === 'recover') {
        expect(inventory).toMatchObject({ head: { payload: { totalRows: '1' } },
          rows: [expect.objectContaining({ shareOperationId: seeded.shareOperationId })] });
        expect(record).toHaveBeenCalledTimes(2);
      } else {
        expect(inventory).toBeNull();
        expect(record).toHaveBeenCalledTimes(outcome === 'vm-confirmed' || outcome === 'new-head' || outcome === 'explicit-legacy' ? 2 : 1);
      }
      if (outcome === 'explicit-legacy') expect(agent.createRfc64CatalogAuthorSignerV1).not.toHaveBeenCalled();
      if (outcome === 'inventory-write') expect(failInventoryWrite).toHaveBeenCalledOnce();
      expect(priorities.length).toBeGreaterThan(0);
      expect(priorities.every((priority) => priority === 'background')).toBe(true);
      await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    } finally {
      query.mockRestore();
      persistenceOwner.rfc64PersistenceV1 = originalPersistence;
    }
  }, 30_000);
});