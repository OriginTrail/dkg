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
import { NamedKaRecoveryPendingLog } from '../src/named-ka-recovery-pending-log.js';
import {
  CatalogPlacementTimingV1,
  INERT_CATALOG_PLACEMENT_ATTEMPT_V1,
  installCatalogPlacementTimingV1,
} from '../src/internal/catalog-placement-timing.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from
  '../src/rfc64/finalized-private-placement-repair-store-v1.js';
import { RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1 } from
  '../src/rfc64/public-catalog-transport-v1.js';
import {
  AUTHOR,
  AUTHOR_WALLET,
  CONTEXT_GRAPH_ID,
  NETWORK_ID,
  catalogScopeDigestV1,
  seedInventoryAssetV1,
  startRepairAgentV1,
} from './support/rfc64-local-catalog-repair-fixture.js';


/** A configured announcement peer; the tests that name it never let it answer. */
const PARKED_PEER = '12D3KooWAUCFb3hwTLUu3bhMqAsqtF1YH1sTUaMuTXiyvC1z7k65';

/** An author whose confirmed private placements go through the real repair path. */
async function startPlacementAgent(name: string, peers: readonly string[] = []) {
  const agent = await startRepairAgentV1({
    name,
    autoPublish: {
      peers,
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
  it('finishes a placement while its announcement is parked, and charges a second observation to the coverage check', async () => {
    // GH#3081 — the committed head is handed off for delivery. A peer that never answers holds
    // neither the placement that produced the head nor the next change of the same scope.
    const { agent, clock, placementLines, repairs } = await startPlacementAgent(
      'placement-wait-announce',
      [PARKED_PEER],
    );
    const { seal } = await seedInventoryAssetV1(agent, 'announce', 81n);
    const next = await seedInventoryAssetV1(agent, 'next', 84n);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    const appliedHead = () => agent.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigestV1(),
      authorAddress: AUTHOR,
    });
    expect(appliedHead()).toBeNull();

    // The announcement stream to the configured peer stays open until its signal aborts.
    const parked: string[] = [];
    const router = (agent as any).router;
    const send = router.send.bind(router);
    vi.spyOn(router, 'send').mockImplementation((...args: any[]) => {
      const [peerId, protocolId, , options] = args;
      if (protocolId !== RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1) return send(...args);
      parked.push(peerId);
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    });
    const handoff = vi.spyOn(agent, 'deliverRfc64CatalogHeadV1');
    const warn = vi.spyOn((agent as any).log, 'warn');
    const debug = vi.spyOn((agent as any).log, 'debug');

    await observe(agent, 'announce', seal, 'job-announce');
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();

    expect(handoff).toHaveBeenCalledTimes(1);
    expect(handoff.mock.calls[0]?.[0].peers).toEqual([PARKED_PEER]);
    expect(handoff.mock.results[0]?.value).toEqual({ status: 'queued' });
    expect(appliedHead()).toMatchObject({ catalogVersion: '1', inventoryRowCount: '1' });
    expect(repairs().list()).toEqual([]);
    // The attempt's announce phase is the hand-off: no time, and no peer delivered inside it.
    expect(placementLines()).toEqual([
      `rfc64_catalog_placement_wait ual=${seal.kaUal} version=1 lane=finalized-private source=job-announce `
      + 'observerCall=1 outcome=completed totalMs=0 requestMs=0 queueMs=0 attemptMs=0 coverageMs=0 '
      + 'assetMs=0 stateMs=0 successorMs=0 casMs=0 announceMs=0 otherMs=0 peers=0 failedPeers=0 '
      + 'deniedPeers=0 covered=false cooldownSkips=0',
    ]);

    // The next change of the same catalog scope is placed while the first head is still being sent.
    await vi.waitFor(() => expect(parked).toEqual([PARKED_PEER]), { timeout: 10_000, interval: 10 });
    await observe(agent, 'next', next.seal, 'job-next');
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(appliedHead()).toMatchObject({ catalogVersion: '2', inventoryRowCount: '2' });
    expect(handoff).toHaveBeenCalledTimes(2);
    // One owner per scope: the second head waits for the first fan-out instead of joining it.
    expect(parked).toEqual([PARKED_PEER]);
    let deliveryIdle = false;
    const whenDeliveryIdle = agent.whenRfc64CatalogHeadDeliveryIdleV1().then(() => { deliveryIdle = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(deliveryIdle).toBe(false);

    // The detached path observes the same confirmation again from recovery: the marker returns,
    // the supervisor runs the repair once more, and only the coverage check stands between them.
    const coverage = (agent as any).rfc64CatalogCoversConfirmedSwmRowV1.bind(agent);
    vi.spyOn(agent as any, 'rfc64CatalogCoversConfirmedSwmRowV1').mockImplementation(async (params: unknown) => {
      clock.now += 1_500;
      return coverage(params);
    });
    await observe(agent, 'announce', seal, 'job-announce');
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(handoff).toHaveBeenCalledTimes(2);
    expect(repairs().list()).toEqual([]);
    expect(fields(placementLines()[2]!)).toMatchObject({
      observerCall: '2',
      outcome: 'completed',
      covered: 'true',
      totalMs: '1500',
      coverageMs: '1500',
      announceMs: '0',
      peers: '0',
      source: 'job-announce',
    });

    // Stopping the node ends the parked send; a send cut short by shutdown is not a failed delivery.
    await agent.stop();
    await whenDeliveryIdle;
    expect(parked).toEqual([PARKED_PEER]);
    expect(warn.mock.calls.map(([, message]) => String(message))
      .filter((message) => message.includes('catalog head announce failed'))).toEqual([]);
    // The one fan-out that ran reports through the agent; the waiting head was dropped unsent.
    const deliveryLines = debug.mock.calls.map(([, message]) => String(message))
      .filter((message) => message.startsWith('rfc64_catalog_head_delivery '));
    expect(deliveryLines).toHaveLength(1);
    expect(deliveryLines[0])
      .toContain(' version=1 delivered=0 failed=0 refused=0 unchecked=0 unconfirmed=0 superseded=0 ');
    expect(deliveryLines[0]).toContain('notDeliverable="RFC-64 catalog head delivery closed"');
  }, 60_000);

  it('charges a coverage check that fails after six seconds to coverage, not to other time', async () => {
    const { agent, clock, placementLines, repairs } = await startPlacementAgent('placement-wait-failure');
    const { seal } = await seedInventoryAssetV1(agent, 'failure', 84n);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    vi.spyOn(agent as any, 'rfc64CatalogCoversConfirmedSwmRowV1').mockImplementation(async () => {
      clock.now += 6_000;
      throw new Error('storage timeout');
    });

    await observe(agent, 'failure', seal, 'job-failure');

    // The failed repair keeps its durable marker for the retry.
    expect(repairs().list()).toHaveLength(1);
    expect(fields(placementLines()[0]!)).toMatchObject({
      outcome: 'failed', totalMs: '6000', attemptMs: '6000', coverageMs: '6000', covered: '-', otherMs: '0',
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
    (agent as any).namedKaRecoveryPendingLog = new NamedKaRecoveryPendingLog();
    await agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish({
      job: { jobId: 'job-recovered' },
      request: { contextGraphId: 'recovered-cg', name: 'recovered' },
    } as never);
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
