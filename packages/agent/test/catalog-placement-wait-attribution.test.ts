/**
 * GH#3081 — attribution of a confirmed publication's catalog-placement wait through the real
 * observer, finalized-private supervisor and catalog upsert. The finalized-private lane is forced
 * on the agent's real open-policy lane, so the projection, successor and CAS run for real; the
 * timing clock moves only where a row parks the work, which makes every segment exact.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  contextGraphAssertionUri,
  createOperationContext,
  type AssertionSeal,
  type Digest32V1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';

import { DKGAgent } from '../src/index.js';
import {
  CatalogPlacementTimingV1,
  INERT_CATALOG_PLACEMENT_ATTEMPT_V1,
  installCatalogPlacementTimingV1,
} from '../src/internal/catalog-placement-timing.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from
  '../src/rfc64/finalized-private-placement-repair-store-v1.js';
import {
  AUTHOR,
  AUTHOR_WALLET,
  CONTEXT_GRAPH_ID,
  NETWORK_ID,
  catalogScopeDigestV1,
  seedInventoryAssetV1,
  startRepairAgentV1,
} from './support/rfc64-local-catalog-repair-fixture.js';


/** An author whose confirmed private placements go through the real repair path. */
async function startPlacementAgent(name: string) {
  const agent = await startRepairAgentV1({
    name,
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
  // Keep the ordinary projection from placing the row first: only the confirmed repair may.
  vi.spyOn(agent, 'reconcileRfc64PublicCatalogFromSwmInventoryV1').mockResolvedValue(null);
  const realLane = (agent as any).resolveRfc64CatalogAuthoringLaneV1.bind(agent);
  vi.spyOn(agent as any, 'resolveRfc64CatalogAuthoringLaneV1').mockImplementation(
    (contextGraphId: unknown, subGraphName: unknown) => {
      const lane = realLane(contextGraphId, subGraphName);
      return lane === null ? null : { ...lane, acceptsFinalizedVmRepair: true };
    },
  );
  const clock = { now: 0 };
  installCatalogPlacementTimingV1(agent, new CatalogPlacementTimingV1({
    clock: () => clock.now,
    logThresholdMs: 0,
  }));
  const info = vi.spyOn((agent as any).log, 'info');
  const placementLines = (): string[] => info.mock.calls
    .map(([, message]) => String(message))
    .filter((message) => message.startsWith('rfc64_catalog_placement_wait '));
  const repairs = () => (agent as any).rfc64PersistenceV1.finalizedPrivatePlacementRepairs as {
    put(repair: Rfc64FinalizedPrivatePlacementRepairV1): Promise<void>;
    delete(repair: Rfc64FinalizedPrivatePlacementRepairV1): Promise<void>;
    list(): readonly Rfc64FinalizedPrivatePlacementRepairV1[];
  };
  return { agent, clock, placementLines, repairs };
}

function observe(agent: DKGAgent, suffix: string, seal: AssertionSeal, jobId: string) {
  return agent.observeRfc64ConfirmedVmV1({
    contextGraphId: CONTEXT_GRAPH_ID,
    assertionCoordinate: `repair-${suffix}`,
    shareOperationId: `repair-operation-${suffix}`,
    seal,
    assertionUri: contextGraphAssertionUri(CONTEXT_GRAPH_ID, AUTHOR, `repair-${suffix}`),
    ctx: createOperationContext('publishFromSWM', jobId),
    publicationLabel: 'queued publish',
  });
}

function fields(line: string): Record<string, string> {
  return Object.fromEntries(line.split(' ').slice(1).map((pair) => {
    const separator = pair.indexOf('=');
    return [pair.slice(0, separator), pair.slice(separator + 1)];
  }));
}

describe('catalog placement wait attribution', () => {
  it('attributes a parked announcement to announce, and a second observation to the coverage check', async () => {
    const { agent, clock, placementLines, repairs } = await startPlacementAgent('placement-wait-announce');
    const { seal } = await seedInventoryAssetV1(agent, 'announce', 81n);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(agent.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigestV1(),
      authorAddress: AUTHOR,
    })).toBeNull();

    let enterAnnounce!: () => void;
    const announceEntered = new Promise<void>((resolve) => { enterAnnounce = resolve; });
    let releaseAnnounce!: () => void;
    const announceGate = new Promise<void>((resolve) => { releaseAnnounce = resolve; });
    const announce = vi.spyOn(agent, 'announceRfc64PublicCatalogHeadV1').mockImplementation(async (input) => {
      enterAnnounce();
      await announceGate;
      return Object.freeze({
        announcement: input.announcement,
        announcedPeers: Object.freeze(['peer-a', 'peer-b']),
        // Classified by the transport's typed code; the wording is display text only.
        failedPeers: Object.freeze([Object.freeze({
          peerId: 'peer-c',
          error: 'the peer refused this announcement',
          code: 'catalog-transport-policy-denied' as const,
        })]),
      });
    });

    const first = observe(agent, 'announce', seal, 'job-announce');
    await announceEntered;
    clock.now = 45_000;
    releaseAnnounce();
    await first;

    expect(announce).toHaveBeenCalledTimes(1);
    expect(agent.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigestV1(),
      authorAddress: AUTHOR,
    })).toMatchObject({ inventoryRowCount: '1' });
    expect(repairs().list()).toEqual([]);
    expect(placementLines()).toEqual([
      `rfc64_catalog_placement_wait ual=${seal.kaUal} version=1 lane=finalized-private source=job-announce `
      + 'observerCall=1 outcome=completed totalMs=45000 requestMs=0 queueMs=0 attemptMs=45000 coverageMs=0 '
      + 'assetMs=0 stateMs=0 successorMs=0 casMs=0 announceMs=45000 otherMs=0 peers=3 failedPeers=1 '
      + 'deniedPeers=1 covered=false cooldownSkips=0',
    ]);

    // The detached path observes the same confirmation again from recovery: the marker returns,
    // the supervisor runs the repair once more, and only the coverage check stands between them.
    const coverage = (agent as any).rfc64CatalogCoversConfirmedSwmRowV1.bind(agent);
    vi.spyOn(agent as any, 'rfc64CatalogCoversConfirmedSwmRowV1').mockImplementation(async (params: unknown) => {
      clock.now += 1_500;
      return coverage(params);
    });
    await observe(agent, 'announce', seal, 'job-announce');
    expect(announce).toHaveBeenCalledTimes(1);
    expect(repairs().list()).toEqual([]);
    expect(fields(placementLines()[1]!)).toMatchObject({
      observerCall: '2',
      outcome: 'completed',
      covered: 'true',
      totalMs: '1500',
      coverageMs: '1500',
      announceMs: '0',
      peers: '0',
      source: 'job-announce',
    });
  }, 60_000);

  it('shows a confirmation queued behind an earlier marker as queue time, and the queue in status', async () => {
    const { agent, clock, placementLines, repairs } = await startPlacementAgent('placement-wait-queue');
    const { seal } = await seedInventoryAssetV1(agent, 'queued', 82n);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    const blocker = Object.freeze({
      version: 1 as const,
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
      inventoryScope: Object.freeze({
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        governanceChainId: null,
        governanceContractAddress: null,
        ownershipTransitionDigest: null,
        authorAddress: AUTHOR,
        subGraphName: null,
        era: '0' as const,
      }),
      assertionCoordinate: 'repair-blocker' as never,
      assertionVersion: '1' as const,
      kaUal: `did:dkg:${NETWORK_ID}/${AUTHOR}/83` as never,
      sealDigest: `0x${'83'.repeat(32)}` as Digest32V1,
    }) as unknown as Rfc64FinalizedPrivatePlacementRepairV1;
    let enterBlocker!: () => void;
    const blockerEntered = new Promise<void>((resolve) => { enterBlocker = resolve; });
    let releaseBlocker!: () => void;
    const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    // The supervisor runs the observed repair, passing its admitted attempt's recorder.
    const repair = (agent as any).repairObservedRfc64FinalizedPrivateCatalogPlacementV1.bind(agent);
    vi.spyOn(agent as any, 'repairObservedRfc64FinalizedPrivateCatalogPlacementV1').mockImplementation(
      async (candidate: any, placement: unknown) => {
        if (candidate.kaUal !== blocker.kaUal) return repair(candidate, placement);
        enterBlocker();
        await blockerGate;
        await repairs().delete(candidate);
        return 'repaired';
      },
    );

    await repairs().put(blocker);
    const blocked = agent.requestRfc64FinalizedPrivateCatalogPlacementRepairV1({ repair: blocker });
    expect(blocked.accepted).toBe(true);
    await blockerEntered;
    const queued = observe(agent, 'queued', seal, 'job-queued');
    await vi.waitFor(() => {
      expect(agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.finalizedPrivatePlacement)
        .toMatchObject({ waiters: 2 });
    }, { timeout: 10_000, interval: 10 });
    clock.now = 30_000;
    expect(agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.finalizedPrivatePlacement).toEqual({
      depth: 1,
      waiters: 2,
      oldestWaiterAgeMs: 30_000,
      passRunning: true,
      lastPassDurationMs: null,
      cooldownSkips: 0,
    });
    releaseBlocker();
    await blocked.whenAttempted;
    await queued;
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();

    expect(repairs().list()).toEqual([]);
    expect(placementLines()).toEqual([
      `rfc64_catalog_placement_wait ual=${seal.kaUal} version=1 lane=finalized-private source=job-queued `
      + 'observerCall=1 outcome=completed totalMs=30000 requestMs=0 queueMs=30000 attemptMs=0 coverageMs=0 '
      + 'assetMs=0 stateMs=0 successorMs=0 casMs=0 announceMs=0 otherMs=0 peers=0 failedPeers=0 '
      + 'deniedPeers=0 covered=false cooldownSkips=0',
    ]);
    // A waiter wake armed by the first pass may re-list the queue after it drained, so the final
    // depth is whichever pass ran last; the waiters are gone either way.
    expect(agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.finalizedPrivatePlacement).toMatchObject({
      waiters: 0,
      oldestWaiterAgeMs: null,
      passRunning: false,
      lastPassDurationMs: 0,
      cooldownSkips: 0,
    });
  }, 60_000);

  it('names the queue job as the source of the recovery that finalizes it', async () => {
    // Correlation only: the recovery's own lines and its observer line carry [from:<jobId>].
    const agent = Object.create(DKGAgent.prototype) as DKGAgent;
    const finalize = vi.fn(async (_input: unknown, _ctx: unknown) => {});
    (agent as any)._finalizeRecoveredQueuedKnowledgeAssetVmPublish = finalize;
    await agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish({ job: { jobId: 'job-recovered' } } as never);
    expect(finalize.mock.calls[0]?.[1]).toMatchObject({
      operationName: 'publishFromSWM',
      sourceOperationId: 'job-recovered',
    });
  });

  it('runs a repair called outside the supervisor against the inert recorder', async () => {
    const agentLike = Object.create(DKGAgent.prototype) as DKGAgent;
    const observed = vi.fn(async () => 'already-complete' as const);
    Reflect.set(agentLike, 'repairObservedRfc64FinalizedPrivateCatalogPlacementV1', observed);
    const marker = Object.freeze({ kaUal: 'did:dkg:otp:20430/0x1/1' }) as unknown as
      Rfc64FinalizedPrivatePlacementRepairV1;
    await expect(agentLike.repairRfc64FinalizedPrivateCatalogPlacementV1(marker)).resolves.toBe('already-complete');
    expect(observed).toHaveBeenCalledWith(marker, INERT_CATALOG_PLACEMENT_ATTEMPT_V1);
  });
});
