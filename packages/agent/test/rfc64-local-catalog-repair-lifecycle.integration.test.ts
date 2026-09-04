import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  contextGraphAssertionUri,
  createOperationContext,
  type Digest32V1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { describe, expect, it, vi } from 'vitest';

import {
  AUTHOR,
  AUTHOR_WALLET,
  CONTEXT_GRAPH_ID,
  NETWORK_ID,
  agents,
  assertionSealV1,
  authorSealV1,
  bootstrapConfigV1,
  seedInventoryAssetV1,
  startRepairAgentV1,
  tempDirs,
} from './support/rfc64-local-catalog-repair-fixture.js';

describe('RFC-64 local SWM catalog projection lifecycle', () => {
  it('keeps retrying a dormant durable promotion while default responsibility settles', async () => {
    const agent = await startRepairAgentV1({
      name: 'dormant-default-responsibility',
      autoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    });
    const inventoryDigest = `0x${'a0'.repeat(32)}` as Digest32V1;
    const record = vi.spyOn(agent, 'recordRfc64SwmAuthorInventoryShadowV1')
      .mockResolvedValueOnce({
        status: 'dormant',
        action: 'upsert',
        attempts: 0,
        headObjectDigest: null,
        error: null,
        dormantReason: 'inactive-lane',
      })
      .mockResolvedValueOnce({
        status: 'dormant',
        action: 'upsert',
        attempts: 0,
        headObjectDigest: null,
        error: null,
        dormantReason: 'inactive-lane',
      })
      .mockResolvedValueOnce({
        status: 'applied',
        action: 'upsert',
        attempts: 1,
        headObjectDigest: inventoryDigest,
        error: null,
      });
    const reconcileResponsibility = vi.spyOn(
      agent,
      'reconcileRfc64CatalogResponsibilityV1',
    ).mockResolvedValue({
      contextGraphId: CONTEXT_GRAPH_ID,
      responsible: true,
      responsibilityReason: 'private-membership',
      active: true,
      mode: 'catalog',
      selectionSource: 'default',
    });
    const requestProjection = vi.spyOn(agent, 'requestRfc64SwmCatalogProjectionV1')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    await agent.observeRfc64DurableSwmPromotionV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'dormant-default-responsibility',
      lifecycleAgentAddress: AUTHOR,
      shareOperationId: 'dormant-default-responsibility-operation',
      ctx: createOperationContext('share'),
    });

    expect(reconcileResponsibility).toHaveBeenCalledTimes(3);
    expect(reconcileResponsibility).toHaveBeenCalledWith(CONTEXT_GRAPH_ID);
    expect(record).toHaveBeenCalledTimes(3);
    expect(requestProjection).toHaveBeenCalledTimes(2);
  });

  it('drains an admitted SWM observer before persistence closes and rejects late admission', async () => {
    const autoPublish = {
      peers: [],
      catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
    };
    const agent = await startRepairAgentV1({
      name: 'observer-lifecycle-drain',
      autoPublish,
    });
    vi.spyOn(agent, 'getCustodialAgentPrivateKey').mockReturnValue(
      AUTHOR_WALLET.privateKey,
    );
    agent.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    await seedInventoryAssetV1(agent, 'shutdown', 29n);

    const originalRecord = agent.recordRfc64SwmAuthorInventoryShadowV1.bind(agent);
    let markObserverEntered!: () => void;
    let releaseObserver!: () => void;
    const observerEntered = new Promise<void>((resolve) => {
      markObserverEntered = resolve;
    });
    const observerGate = new Promise<void>((resolve) => {
      releaseObserver = resolve;
    });
    const recordSpy = vi.spyOn(agent, 'recordRfc64SwmAuthorInventoryShadowV1')
      .mockImplementation(async (params) => {
        markObserverEntered();
        await observerGate;
        return originalRecord(params);
      });
    let markProjectionEntered!: () => void;
    let releaseProjection!: () => void;
    const projectionEntered = new Promise<void>((resolve) => {
      markProjectionEntered = resolve;
    });
    const projectionGate = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    vi.spyOn(agent, 'reconcileRfc64PublicCatalogFromSwmInventoryV1')
      .mockImplementation(async () => {
        markProjectionEntered();
        await projectionGate;
        return null;
      });
    const persistenceCloseSpy = vi.spyOn(agent, 'closeRfc64PersistenceV1');
    const schedule = (agent as unknown as {
      scheduleRfc64SwmInventoryObserverV1(params: Readonly<{
        contextGraphId: string;
        assertionCoordinate: string;
        lifecycleAgentAddress: string;
        shareOperationId: string;
        ctx: ReturnType<typeof createOperationContext>;
      }>): void;
    }).scheduleRfc64SwmInventoryObserverV1.bind(agent);
    const observerParams = Object.freeze({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'repair-shutdown',
      lifecycleAgentAddress: AUTHOR,
      shareOperationId: 'repair-operation-shutdown',
      ctx: createOperationContext('share'),
    });

    schedule(observerParams);
    await observerEntered;
    let stopSettled = false;
    const stopping = agent.stop().finally(() => { stopSettled = true; });
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    expect(persistenceCloseSpy).not.toHaveBeenCalled();

    releaseObserver();
    await projectionEntered;
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    expect(persistenceCloseSpy).not.toHaveBeenCalled();
    releaseProjection();
    await expect(stopping).resolves.toBeUndefined();
    agents.splice(agents.indexOf(agent), 1);
    expect(recordSpy).toHaveBeenCalledOnce();
    expect(persistenceCloseSpy).toHaveBeenCalledOnce();
    expect(agent.rfc64SwmAuthorInventoryShadowStatusV1()).toMatchObject({
      failed: 0,
      existingUpserts: 1,
    });

    schedule(observerParams);
    await Promise.resolve();
    expect(recordSpy).toHaveBeenCalledOnce();
    expect(agent.inFlightRfc64SwmInventoryObserverCountV1()).toBe(0);
  }, 30_000);

  it('reports missing inventory through the canonical supervisor path', async () => {
    const agent = await startRepairAgentV1({
      name: 'no-inventory',
      autoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
      bootstrap: bootstrapConfigV1(),
      beforeStart: (startingAgent) => {
        vi.spyOn(startingAgent, 'listLocalAgents').mockReturnValue([
          { agentAddress: AUTHOR } as never,
        ]);
        vi.spyOn(startingAgent, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
          .mockResolvedValue(null);
      },
    });
    await agent.whenRfc64CatalogSupervisorsIdleV1();
    expect(agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.repairs)
      .toEqual([expect.objectContaining({ outcome: 'no-inventory', attempts: 1 })]);
  });

  it('reports a rejected canonical reconciliation as a failed repair', async () => {
    const agent = await startRepairAgentV1({
      name: 'failed-reconciliation-status',
      autoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    });
    agent.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    vi.spyOn(agent, 'reconcileRfc64PublicCatalogFromSwmInventoryV1')
      .mockRejectedValue(new Error('projection unavailable'));

    expect(agent.requestRfc64SwmCatalogProjectionV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).toBe(true);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();

    expect(agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.repairs)
      .toEqual([expect.objectContaining({
        outcome: 'failed',
        attempts: 1,
        lastError: 'projection unavailable',
      })]);
  });

  it('reopens live-only inventory and projection admission on same-instance restart', async () => {
    const agent = await startRepairAgentV1({
      name: 'same-instance-restart',
      autoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    });
    const reconcile = vi.spyOn(agent, 'reconcileRfc64PublicCatalogFromSwmInventoryV1')
      .mockResolvedValue(null);
    const acceptPolicy = (): void => {
      agent.acceptOpenContextGraphPolicyV1({
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        ownerAddress: AUTHOR,
      });
    };
    acceptPolicy();
    expect(agent.requestRfc64SwmCatalogProjectionV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).toBe(true);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();

    await agent.stop();
    expect(agent.requestRfc64SwmCatalogProjectionV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).toBe(false);
    await agent.start();
    acceptPolicy();
    expect(agent.requestRfc64SwmCatalogProjectionV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).toBe(true);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();

    const inventoryDigest = `0x${'a1'.repeat(32)}` as Digest32V1;
    const record = vi.spyOn(agent, 'recordRfc64SwmAuthorInventoryShadowV1')
      .mockResolvedValue({
        status: 'existing',
        action: 'upsert',
        attempts: 1,
        headObjectDigest: inventoryDigest,
        error: null,
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
    schedule({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'same-instance-share',
      lifecycleAgentAddress: AUTHOR,
      shareOperationId: 'same-instance-operation',
      ctx: createOperationContext('share'),
    });
    await agent.awaitInFlightRfc64SwmInventoryObserversV1();
    expect(record).toHaveBeenCalledOnce();

    const remove = vi.spyOn(agent, 'removeRfc64SwmAuthorInventoryShadowV1')
      .mockResolvedValue({
        status: 'absent',
        action: 'remove',
        attempts: 1,
        headObjectDigest: inventoryDigest,
        error: null,
      });
    const canonicalSeal = await authorSealV1(35n);
    await agent.observeRfc64ConfirmedVmV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'same-instance-share',
      shareOperationId: 'same-instance-operation',
      seal: assertionSealV1(canonicalSeal),
      assertionUri: contextGraphAssertionUri(
        CONTEXT_GRAPH_ID,
        AUTHOR,
        'same-instance-share',
      ),
      ctx: createOperationContext('publish'),
      publicationLabel: 'publish',
    });
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(remove).toHaveBeenCalledOnce();
    expect(reconcile.mock.calls.length).toBeGreaterThanOrEqual(4);
  }, 30_000);

  it('does not tear down persistence under a non-cooperative catalog read', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-cancel-repair-'));
    tempDirs.push(dataDir);
    const storePath = join(dataDir, 'oxigraph');
    const autoPublish = {
      peers: [],
      catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
    };
    const author = await startRepairAgentV1({
      name: 'cancel-author',
      dataDir,
      storePath,
      autoPublish,
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    await seedInventoryAssetV1(author, 'cancellation', 30n);
    await author.stop();
    agents.splice(agents.indexOf(author), 1);

    let markCatalogReadEntered!: () => void;
    let releaseCatalogRead!: () => void;
    const catalogReadEntered = new Promise<void>((resolve) => {
      markCatalogReadEntered = resolve;
    });
    const catalogReadGate = new Promise<void>((resolve) => {
      releaseCatalogRead = resolve;
    });
    const restarted = await startRepairAgentV1({
      name: 'cancel-restarted',
      dataDir,
      storePath,
      autoPublish,
      bootstrap: bootstrapConfigV1(),
      beforeStart: (startingAgent) => {
        vi.spyOn(startingAgent, 'listLocalAgents').mockReturnValue([
          { agentAddress: AUTHOR } as never,
        ]);
        vi.spyOn(startingAgent, 'getCustodialAgentPrivateKey').mockReturnValue(
          AUTHOR_WALLET.privateKey,
        );
        const originalQuery = startingAgent.store.query.bind(startingAgent.store);
        let blockCatalogRead = true;
        vi.spyOn(startingAgent.store, 'query').mockImplementation(
          async (sparql: string, ...args: unknown[]) => {
            const options = args[0] as Readonly<{ source?: string }> | undefined;
            if (
              blockCatalogRead
              && options?.source === 'agent.rfc64.swmInventory.catalogReconcile.seal'
            ) {
              blockCatalogRead = false;
              markCatalogReadEntered();
              await catalogReadGate;
            }
            return originalQuery(sparql, ...args);
          },
        );
      },
    });
    await catalogReadEntered;
    const persistenceClose = vi.spyOn(restarted, 'closeRfc64PersistenceV1');
    let stopped = false;
    const stopping = restarted.stop().finally(() => { stopped = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    expect(persistenceClose).not.toHaveBeenCalled();

    releaseCatalogRead();
    await stopping;
    agents.splice(agents.indexOf(restarted), 1);
    expect(persistenceClose).toHaveBeenCalledOnce();
  }, 30_000);
});
