import { describe, expect, it, vi } from 'vitest';

import {
  type ContextGraphIdV1,
  type Digest32V1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import {
  buildOpenOwnerContextGraphPolicyV1,
  unsignedOpenContextGraphPolicyEnvelopeV1,
} from '../src/rfc64/open-catalog-policy-v1.js';
import {
  AUTHOR,
  CONTEXT_GRAPH_ID,
  LEGACY_CONTEXT_GRAPH_ID,
  NATIVE_DEPLOYMENT,
  NETWORK_ID,
  REMOTE_AUTHOR,
  catalogScopeDigestV1,
  startRepairAgentV1,
} from './support/rfc64-local-catalog-repair-fixture.js';

describe('RFC-64 local SWM catalog projection repair', () => {
  it('retries without widening graph or author scope', async () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const legacyPolicy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: LEGACY_CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const inventoryHeadObjectDigest = `0x${'91'.repeat(32)}` as Digest32V1;
    let repairSpy!: ReturnType<typeof vi.spyOn>;
    const agent = await startRepairAgentV1({
      name: 'bounded-retry',
      activation: {
        deploymentProfile: NATIVE_DEPLOYMENT,
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
        rollout: {
          contextGraphModes: {
            [CONTEXT_GRAPH_ID]: 'catalog',
            [LEGACY_CONTEXT_GRAPH_ID]: 'legacy',
          },
        },
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
            targets: [{ authorAddress: AUTHOR, providers: ['local-provider'] }, {
              authorAddress: REMOTE_AUTHOR,
              providers: ['remote-provider'],
            }],
          }, {
            policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(legacyPolicy),
            targets: [{ authorAddress: AUTHOR, providers: ['legacy-provider'] }],
          }],
          retryIntervalMs: 1_000,
        },
      },
      beforeStart: (startingAgent) => {
        vi.spyOn(startingAgent, 'listLocalAgents').mockReturnValue([
          { agentAddress: AUTHOR } as never,
        ]);
        vi.spyOn(startingAgent, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
          .mockResolvedValue(null);
        repairSpy = vi.spyOn(
          startingAgent,
          'reconcileRfc64PublicCatalogFromSwmInventoryV1',
        )
          .mockRejectedValueOnce(new Error('simulated projection failure'))
          .mockResolvedValue({
            status: 'existing',
            appliedHead: {
              catalogScopeDigest: catalogScopeDigestV1(),
              authorAddress: AUTHOR,
              currentCatalogHeadDigest: `0x${'92'.repeat(32)}` as Digest32V1,
              appliedInventoryDigest: `0x${'93'.repeat(32)}` as Digest32V1,
              catalogVersion: '1',
              inventoryRowCount: '1',
            },
            successorsApplied: 0,
            targetAssetCount: 1,
            inventoryHeadObjectDigest,
          });
      },
    });

    await vi.waitFor(() => {
      expect(agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.repairs)
        .toEqual([expect.objectContaining({
          contextGraphId: CONTEXT_GRAPH_ID,
          authorAddress: AUTHOR,
          outcome: 'reconciled',
          attempts: 2,
          inventoryHeadObjectDigest,
        })]);
    }, { timeout: 10_000, interval: 20 });
    expect(repairSpy.mock.calls.map(([input]) => ({
      contextGraphId: input.contextGraphId,
      authorAddress: input.authorAddress,
    }))).toEqual([
      { contextGraphId: CONTEXT_GRAPH_ID, authorAddress: AUTHOR },
      { contextGraphId: CONTEXT_GRAPH_ID, authorAddress: AUTHOR },
    ]);
    expect(agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.repairs).toHaveLength(1);
  }, 30_000);

  it('coalesces a live mutation burst into one latest-state follow-up pass', async () => {
    const firstInventoryHeadObjectDigest = `0x${'94'.repeat(32)}` as Digest32V1;
    const latestInventoryHeadObjectDigest = `0x${'97'.repeat(32)}` as Digest32V1;
    let markFirstRepairEntered!: () => void;
    let releaseFirstRepair!: () => void;
    const firstRepairEntered = new Promise<void>((resolve) => {
      markFirstRepairEntered = resolve;
    });
    const firstRepairGate = new Promise<void>((resolve) => {
      releaseFirstRepair = resolve;
    });
    let repairSpy!: ReturnType<typeof vi.spyOn>;
    const agent = await startRepairAgentV1({
      name: 'coalesced-live-burst',
      autoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
      beforeStart: (startingAgent) => {
        let call = 0;
        repairSpy = vi.spyOn(startingAgent, 'reconcileRfc64PublicCatalogFromSwmInventoryV1')
          .mockImplementation(async () => {
            call += 1;
            if (call === 1) {
              markFirstRepairEntered();
              await firstRepairGate;
            }
            return {
              status: 'existing' as const,
              appliedHead: {
                catalogScopeDigest: catalogScopeDigestV1(),
                authorAddress: AUTHOR,
                currentCatalogHeadDigest: `0x${'95'.repeat(32)}` as Digest32V1,
                appliedInventoryDigest: `0x${'96'.repeat(32)}` as Digest32V1,
                catalogVersion: String(call),
                inventoryRowCount: String(call),
              },
              successorsApplied: 0,
              targetAssetCount: call,
              inventoryHeadObjectDigest: call === 1
                ? firstInventoryHeadObjectDigest
                : latestInventoryHeadObjectDigest,
            };
          });
      },
    });

    agent.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    expect(agent.requestRfc64SwmCatalogProjectionV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).toBe(true);
    await firstRepairEntered;
    for (let index = 0; index < 16; index += 1) {
      expect(agent.requestRfc64SwmCatalogProjectionV1({
        contextGraphId: CONTEXT_GRAPH_ID,
        authorAddress: AUTHOR,
      })).toBe(true);
    }
    releaseFirstRepair();
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(repairSpy).toHaveBeenCalledTimes(2);
    expect(agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()).toEqual(
      expect.objectContaining({
        pass: 2,
        repairs: [expect.objectContaining({
          attempts: 2,
          outcome: 'reconciled',
          inventoryHeadObjectDigest: latestInventoryHeadObjectDigest,
          catalogVersion: '2',
          inventoryRowCount: '2',
        })],
      }),
    );
    await agent.closeRfc64SwmCatalogProjectionSupervisorV1();
    expect(agent.requestRfc64SwmCatalogProjectionV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).toBe(false);
  }, 30_000);

  it('bounds distinct repair scopes to four concurrent reconciliations', async () => {
    const agent = await startRepairAgentV1({
      name: 'bounded-distinct-repairs',
      autoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    });
    vi.spyOn(agent as any, 'resolveRfc64CatalogAuthoringLaneV1').mockReturnValue({} as never);
    let active = 0;
    let maxActive = 0;
    let call = 0;
    let markFirstEntered!: () => void;
    let releaseFirst!: () => void;
    let markFourEntered!: () => void;
    let releaseRepairs!: () => void;
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const fourEntered = new Promise<void>((resolve) => { markFourEntered = resolve; });
    const repairGate = new Promise<void>((resolve) => { releaseRepairs = resolve; });
    const reconcile = vi.spyOn(agent, 'reconcileRfc64PublicCatalogFromSwmInventoryV1')
      .mockImplementation(async () => {
        call += 1;
        if (call === 1) {
          markFirstEntered();
          await firstGate;
          return null;
        }
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (active === 4) markFourEntered();
        await repairGate;
        active -= 1;
        return null;
      });
    const contextGraphIds = Array.from({ length: 6 }, (_, index) => (
      `0x1111111111111111111111111111111111111111/bounded-${index}` as ContextGraphIdV1
    ));
    for (const contextGraphId of contextGraphIds) {
      expect(agent.requestRfc64SwmCatalogProjectionV1({
        contextGraphId,
        authorAddress: AUTHOR,
      })).toBe(true);
    }
    await firstEntered;
    releaseFirst();
    await fourEntered;
    expect(reconcile).toHaveBeenCalledTimes(5);
    expect(maxActive).toBe(4);
    releaseRepairs();
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(reconcile).toHaveBeenCalledTimes(6);
    expect(maxActive).toBe(4);
  }, 30_000);
});
