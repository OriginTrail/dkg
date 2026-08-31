import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ContextGraphIdV1,
  type Digest32V1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { describe, expect, it, vi } from 'vitest';

import {
  AUTHOR,
  AUTHOR_WALLET,
  CONTEXT_GRAPH_ID,
  NATIVE_DEPLOYMENT,
  NETWORK_ID,
  agents,
  bootstrapConfigV1,
  seedInventoryAssetV1,
  startRepairAgentV1,
  tempDirs,
} from './support/rfc64-local-catalog-repair-fixture.js';

describe('RFC-64 durable local SWM catalog projection repair', () => {
  it('admits dormant durable inventory on subscribe and retries it on resubscribe', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-subscription-repair-'));
    tempDirs.push(dataDir);
    const storePath = join(dataDir, 'oxigraph');
    const autoPublish = {
      peers: [],
      catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
    };
    const author = await startRepairAgentV1({
      name: 'subscription-repair-author',
      dataDir,
      storePath,
      autoPublish,
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(
      AUTHOR_WALLET.privateKey,
    );
    author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    await seedInventoryAssetV1(author, 'post-start-subscription', 30n);
    await author.stop();
    agents.splice(agents.indexOf(author), 1);

    let repair!: ReturnType<typeof vi.spyOn>;
    const edge = await startRepairAgentV1({
      name: 'subscription-repair-edge',
      dataDir,
      storePath,
      syncContextGraphs: [],
      activation: {
        deploymentProfile: NATIVE_DEPLOYMENT,
        autoPublish,
        rollout: { contextGraphModes: { [CONTEXT_GRAPH_ID]: 'catalog' } },
        bootstrap: bootstrapConfigV1(0, false),
      },
      beforeStart: (startingAgent) => {
        vi.spyOn(startingAgent, 'listLocalAgents').mockReturnValue([
          { agentAddress: AUTHOR } as never,
        ]);
        vi.spyOn(startingAgent, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
          .mockResolvedValue(null);
        repair = vi.spyOn(startingAgent, 'reconcileRfc64PublicCatalogFromSwmInventoryV1')
          .mockRejectedValue(new Error('simulated durable projection failure'));
      },
    });
    await edge.whenRfc64PublicCatalogBootstrapIdleV1();
    await edge.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(repair).not.toHaveBeenCalled();
    expect(edge.readRfc64SwmCatalogProjectionSupervisorStatusV1()).toBeNull();

    edge.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    await edge.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(repair).toHaveBeenCalledTimes(1);
    expect(edge.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.repairs)
      .toEqual([expect.objectContaining({
        contextGraphId: CONTEXT_GRAPH_ID,
        authorAddress: AUTHOR,
        outcome: 'failed',
        attempts: 1,
      })]);

    edge.unsubscribeFromContextGraph(CONTEXT_GRAPH_ID);
    edge.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    await edge.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(repair).toHaveBeenCalledTimes(2);
    expect(edge.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.repairs)
      .toEqual([expect.objectContaining({ outcome: 'failed', attempts: 2 })]);
  }, 30_000);

  it('repairs durable additions and removals without remote author targets', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-restart-repair-'));
    tempDirs.push(dataDir);
    const storePath = join(dataDir, 'oxigraph');
    const autoPublish = {
      peers: [],
      catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
    };
    const author = await startRepairAgentV1({
      name: 'restart-author',
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
    const seeded = await seedInventoryAssetV1(author, 'restart', 31n);
    await author.stop();
    agents.splice(agents.indexOf(author), 1);

    const additionRepair = await startRepairAgentV1({
      name: 'addition-repair',
      dataDir,
      storePath,
      autoPublish,
      bootstrap: bootstrapConfigV1(undefined, false),
      beforeStart: (agent) => {
        vi.spyOn(agent, 'listLocalAgents').mockReturnValue([
          { agentAddress: AUTHOR } as never,
        ]);
        vi.spyOn(agent, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
          .mockResolvedValue(null);
        vi.spyOn(agent, 'getCustodialAgentPrivateKey').mockReturnValue(
          AUTHOR_WALLET.privateKey,
        );
      },
    });
    await vi.waitFor(() => {
      expect(additionRepair.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.repairs)
        .toEqual([expect.objectContaining({
          outcome: 'reconciled',
          catalogVersion: '1',
          inventoryRowCount: '1',
        })]);
    }, { timeout: 10_000, interval: 50 });
    await expect(additionRepair.removeRfc64SwmAuthorInventoryShadowV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      seal: seeded.seal,
    })).resolves.toMatchObject({ status: 'applied' });
    await additionRepair.stop();
    agents.splice(agents.indexOf(additionRepair), 1);

    const removalRepair = await startRepairAgentV1({
      name: 'removal-repair',
      dataDir,
      storePath,
      autoPublish,
      bootstrap: bootstrapConfigV1(undefined, false),
      beforeStart: (agent) => {
        vi.spyOn(agent, 'listLocalAgents').mockReturnValue([
          { agentAddress: AUTHOR } as never,
        ]);
        vi.spyOn(agent, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
          .mockResolvedValue(null);
        vi.spyOn(agent, 'getCustodialAgentPrivateKey').mockReturnValue(
          AUTHOR_WALLET.privateKey,
        );
      },
    });
    await vi.waitFor(() => {
      expect(removalRepair.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.repairs)
        .toEqual([expect.objectContaining({
          outcome: 'reconciled',
          catalogVersion: '2',
          inventoryRowCount: '0',
        })]);
    }, { timeout: 10_000, interval: 50 });
    expect(removalRepair.readRfc64SwmAuthorInventorySnapshotV1({
      inventoryScopeDigest: seeded.scopeDigest,
      authorAddress: AUTHOR,
    })?.rows).toEqual([]);
  }, 30_000);

  it('linearizes an inventory mutation that races an already-staged successor', async () => {
    const author = await startRepairAgentV1({
      name: 'staged-successor-race',
      autoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(
      AUTHOR_WALLET.privateKey,
    );
    author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    // Keep the test deterministic: ordinary live admission is fenced, while
    // the explicit reconciliation entry point remains available.
    await author.closeRfc64SwmCatalogProjectionSupervisorV1();
    await seedInventoryAssetV1(author, 'race-first', 41n);
    await expect(author.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).resolves.toMatchObject({
      appliedHead: { catalogVersion: '1', inventoryRowCount: '1' },
    });
    await seedInventoryAssetV1(author, 'race-second', 42n);

    const originalPublish = author.publishAuthorCatalogExactSetSuccessorV1.bind(author);
    const authored: Array<Readonly<{
      previousHeadDigest: Digest32V1;
      headObjectDigest: Digest32V1;
      catalogVersion: string;
    }>> = [];
    let injectedLatestInventory = false;
    vi.spyOn(author, 'publishAuthorCatalogExactSetSuccessorV1')
      .mockImplementation(async (params) => {
        const successor = await originalPublish(params);
        authored.push(Object.freeze({
          previousHeadDigest: params.previousHead.objectDigest,
          headObjectDigest: successor.headObjectDigest,
          catalogVersion: successor.announcement.catalogVersion,
        }));
        if (!injectedLatestInventory) {
          injectedLatestInventory = true;
          // This lands after v2 is signed and durably staged, but before its
          // applied-head callback validates the source inventory generation.
          await seedInventoryAssetV1(author, 'race-third', 43n);
        }
        return successor;
      });

    await expect(author.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).resolves.toMatchObject({
      targetAssetCount: 3,
      appliedHead: { catalogVersion: '3', inventoryRowCount: '3' },
    });
    expect(authored).toHaveLength(2);
    expect(authored.map(({ catalogVersion }) => catalogVersion)).toEqual(['2', '3']);
    // The retry resumes from the committed, already-signed v2. It never signs
    // a competing v2 from the original v1 predecessor.
    expect(authored[1]!.previousHeadDigest).toBe(authored[0]!.headObjectDigest);
    expect(new Set(authored.map(({ previousHeadDigest, catalogVersion }) => (
      `${previousHeadDigest}\n${catalogVersion}`
    ))).size).toBe(2);

    const persistence = (author as unknown as {
      rfc64PersistenceV1?: {
        controlObjects: {
          getVerifiedObjectByDigest(input: {
            objectDigest: Digest32V1;
            verifyIssuerSignature: typeof import('@origintrail-official/dkg-chain')
              .verifyControlEnvelopeIssuerSignatureV1;
          }): Promise<unknown>;
        };
      };
    }).rfc64PersistenceV1;
    expect(persistence).toBeDefined();
    const { verifyControlEnvelopeIssuerSignatureV1 } = await import(
      '@origintrail-official/dkg-chain'
    );
    for (const { headObjectDigest } of authored) {
      await expect(persistence!.controlObjects.getVerifiedObjectByDigest({
        objectDigest: headObjectDigest,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      })).resolves.not.toBeNull();
    }
  }, 30_000);
});
