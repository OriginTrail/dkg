import { afterEach, describe, expect, it, vi } from 'vitest';

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

afterEach(() => {
  vi.useRealTimers();
});

describe('RFC-64 local SWM catalog projection repair', () => {
  it('periodically repairs a default-mode projection without a bootstrap manifest', async () => {
    const agent = await startRepairAgentV1({
      name: 'default-mode-periodic-retry',
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
    const repair = vi.spyOn(agent, 'reconcileRfc64PublicCatalogFromSwmInventoryV1')
      .mockRejectedValueOnce(new Error('simulated detached projection failure'))
      .mockResolvedValue(null);
    vi.useFakeTimers();

    expect(agent.requestRfc64SwmCatalogProjectionV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).toBe(true);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(repair).toHaveBeenCalledTimes(1);
    expect(agent.readRfc64SwmCatalogProjectionSupervisorStatusV1())
      .toMatchObject({ retryIntervalMs: 5_000 });

    await vi.advanceTimersByTimeAsync(5_000);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(repair).toHaveBeenCalledTimes(2);
    expect(agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.repairs)
      .toEqual([expect.objectContaining({ outcome: 'no-inventory', attempts: 2 })]);
    vi.useRealTimers();
  });

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
    agent.subscribeToContextGraph(CONTEXT_GRAPH_ID);

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
    vi.spyOn(agent as any, 'resolveRfc64CatalogAuthoringLaneV1').mockReturnValue({
      projectionTargetPolicy: 'exact-replacement',
      acceptsFinalizedVmRepair: false,
    } as never);
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

  it('settles a finalized-private repair without waiting for an unrelated projection', async () => {
    const agent = await startRepairAgentV1({
      name: 'repair-scoped-completion',
      autoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    });
    const privateContextGraphId =
      '0x1111111111111111111111111111111111111111/private-repair' as ContextGraphIdV1;
    const ordinaryContextGraphId =
      '0x1111111111111111111111111111111111111111/blocked-repair' as ContextGraphIdV1;
    vi.spyOn(agent as any, 'resolveRfc64CatalogAuthoringLaneV1')
      .mockImplementation((contextGraphId: string) => ({
        projectionTargetPolicy: contextGraphId === privateContextGraphId
          ? 'monotonic-union'
          : 'exact-replacement',
        acceptsFinalizedVmRepair: contextGraphId === privateContextGraphId,
      } as never));
    let markOrdinaryEntered!: () => void;
    let releaseOrdinary!: () => void;
    const ordinaryEntered = new Promise<void>((resolve) => { markOrdinaryEntered = resolve; });
    const ordinaryGate = new Promise<void>((resolve) => { releaseOrdinary = resolve; });
    vi.spyOn(agent, 'reconcileRfc64PublicCatalogFromSwmInventoryV1')
      .mockImplementation(async () => {
        markOrdinaryEntered();
        await ordinaryGate;
        return null;
      });
    const repair = Object.freeze({
      version: 1 as const,
      contextGraphId: privateContextGraphId,
      authorAddress: AUTHOR,
      inventoryScope: Object.freeze({
        networkId: NETWORK_ID,
        contextGraphId: privateContextGraphId,
        governanceChainId: null,
        governanceContractAddress: null,
        ownershipTransitionDigest: null,
        authorAddress: AUTHOR,
        subGraphName: null,
        era: '1' as const,
      }),
      assertionCoordinate: 'private-repair' as never,
      assertionVersion: '1' as const,
      kaUal: `did:dkg:otp:20430/${AUTHOR}/1` as never,
      sealDigest: `0x${'aa'.repeat(32)}` as Digest32V1,
    });
    await (agent as any).rfc64PersistenceV1.finalizedPrivatePlacementRepairs.put(repair);
    const repairAttempt = vi.spyOn(agent, 'repairRfc64FinalizedPrivateCatalogPlacementV1')
      .mockResolvedValue('repaired');

    expect(agent.requestRfc64SwmCatalogProjectionV1({
      contextGraphId: ordinaryContextGraphId,
      authorAddress: AUTHOR,
    })).toBe(true);
    await ordinaryEntered;
    const request = agent.requestRfc64FinalizedPrivateCatalogPlacementRepairV1({ repair });
    expect(request.accepted).toBe(true);
    await request.whenAttempted;
    expect(repairAttempt).toHaveBeenCalledWith(repair);
    releaseOrdinary();
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
  }, 30_000);

  it('retains confirmation-time repair work when the accepted policy era changes', async () => {
    const agent = await startRepairAgentV1({
      name: 'repair-policy-transition',
      autoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    });
    const privateContextGraphId =
      '0x1111111111111111111111111111111111111111/policy-transition' as ContextGraphIdV1;
    const repair = Object.freeze({
      version: 1 as const,
      contextGraphId: privateContextGraphId,
      authorAddress: AUTHOR,
      inventoryScope: Object.freeze({
        networkId: NETWORK_ID,
        contextGraphId: privateContextGraphId,
        governanceChainId: null,
        governanceContractAddress: null,
        ownershipTransitionDigest: null,
        authorAddress: AUTHOR,
        subGraphName: null,
        era: '1' as const,
      }),
      assertionCoordinate: 'policy-transition' as never,
      assertionVersion: '1' as const,
      kaUal: `did:dkg:otp:20430/${AUTHOR}/2` as never,
      sealDigest: `0x${'bb'.repeat(32)}` as Digest32V1,
    });
    const repairStore = (agent as any).rfc64PersistenceV1
      .finalizedPrivatePlacementRepairs;
    await repairStore.put(repair);
    vi.spyOn(agent as any, 'resolveRfc64CatalogAuthoringLaneV1').mockReturnValue({
      projectionTargetPolicy: 'monotonic-union',
      acceptsFinalizedVmRepair: true,
      scopeBase: Object.freeze({
        networkId: NETWORK_ID,
        contextGraphId: privateContextGraphId,
        governanceChainId: null,
        governanceContractAddress: null,
        ownershipTransitionDigest: null,
        subGraphName: null,
        era: '2',
      }),
    } as never);

    await expect(agent.repairRfc64FinalizedPrivateCatalogPlacementV1(repair))
      .rejects.toThrow('conflicts with a policy transition');
    expect(repairStore.list()).toEqual([repair]);
  }, 30_000);
});
