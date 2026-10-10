/**
 * GH#3081 — the catalog supervisor alone owns a confirmed private placement once the observer has
 * stored its marker and asked for it. Nothing waits for the placement, so these rows pin what the
 * owner still guarantees: a marker survives a refused request, a failed attempt, a shutdown and a
 * restart, and is retired only by the positive proof that the catalog covers its row.
 *
 * The first block drives the supervisor on its own; the second runs the real observer, supervisor
 * and catalog repair of one agent.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOperationContext,
  type ContextGraphIdV1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';

import { Rfc64SwmCatalogProjectionOwnerV1 } from '../src/dkg-agent-rfc64-swm-catalog-projection-supervisor.js';
import {
  CatalogPlacementTimingV1,
  type CatalogPlacementWaiterObserverV1,
} from '../src/internal/catalog-placement-timing.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from
  '../src/rfc64/finalized-private-placement-repair-store-v1.js';
import {
  CONTEXT_GRAPH_ID,
  agents,
  tempDirs,
} from './support/rfc64-local-catalog-repair-fixture.js';
import {
  gateV1,
  observeConfirmedV1,
  seedPlacementAssetV1,
  settlesWithinV1,
  startPlacementAgentV1,
  untilV1,
} from './support/rfc64-publication-placement-fixture.js';

const ctx = createOperationContext('system');

function fields(line: string): Record<string, string> {
  return Object.fromEntries(line.split(' ').slice(1).map((pair) => {
    const separator = pair.indexOf('=');
    return [pair.slice(0, separator), pair.slice(separator + 1)];
  }));
}

describe('the finalized-private supervisor as the owner of a placement', () => {
  const CG = 'placement-ownership' as ContextGraphIdV1;
  const AUTHOR = `0x${'11'.repeat(20)}` as EvmAddressV1;
  const owners: Rfc64SwmCatalogProjectionOwnerV1[] = [];

  afterEach(async () => {
    await Promise.all(owners.splice(0).map((owner) => owner.close()));
  });

  function marker(kaNumber: number): Rfc64FinalizedPrivatePlacementRepairV1 {
    return {
      version: 1, contextGraphId: CG, authorAddress: AUTHOR,
      inventoryScope: {
        networkId: 'otp:20430', contextGraphId: CG, governanceChainId: null,
        governanceContractAddress: null, ownershipTransitionDigest: null,
        authorAddress: AUTHOR, subGraphName: null, era: '1',
      },
      assertionCoordinate: `placement-${kaNumber}`, assertionVersion: '1',
      kaUal: `did:dkg:otp:20430/${AUTHOR}/${kaNumber}`, sealDigest: `0x${'22'.repeat(32)}`,
    } as Rfc64FinalizedPrivatePlacementRepairV1;
  }

  /**
   * A real owner over a marker list that stands in for the durable queue. Each repair parks until
   * the row releases it; a released repair deletes its marker, as a completed placement does.
   */
  function ownerFixture() {
    const clock = { now: 0 };
    const timing = new CatalogPlacementTimingV1({ clock: () => clock.now, logThresholdMs: 0 });
    const state = {
      markers: [] as Rfc64FinalizedPrivatePlacementRepairV1[],
      laneActive: true,
    };
    const parked = gateV1();
    const repaired: string[] = [];
    const owner = new Rfc64SwmCatalogProjectionOwnerV1({
      resolvePartition: () => ({ retryIntervalMs: 0, track2Policies: [], track2Targets: [], recoveryProviderPeerIds: [] }),
      listLocalAuthorAddresses: () => [AUTHOR],
      acceptsPublicRootLane: () => true,
      acceptsFinalizedPrivateLane: () => state.laneActive,
      readRepairRevision: () => ({ scopeIdentity: 'scope-1', headRevision: 'head-1' }),
      listFinalizedPrivateRepairs: () => state.markers,
      repairFinalizedPrivatePlacement: async (repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>) => {
        repaired.push(repair.assertionCoordinate);
        await parked.pass();
        state.markers = state.markers.filter((candidate) => candidate.kaUal !== repair.kaUal);
      },
      reconcile: async () => null,
      warn: () => {},
      placementTiming: () => timing,
    } as never);
    owners.push(owner);
    return {
      owner, clock, state, parked, repaired,
      queue: () => owner.status()?.finalizedPrivatePlacement,
      /** What the observer does: store the marker, then ask the supervisor for the placement. */
      owe: (repair: Rfc64FinalizedPrivatePlacementRepairV1, observer?: CatalogPlacementWaiterObserverV1) => {
        if (!state.markers.includes(repair)) state.markers = [...state.markers, repair];
        return owner.requestFinalizedPrivate({ repair, ctx, ...(observer === undefined ? {} : { observer }) });
      },
    };
  }

  /** An observer that records what the supervisor told it about its request. */
  function listening() {
    const heard: string[] = [];
    const observer: CatalogPlacementWaiterObserverV1 = {
      cooldownSkipped: () => { heard.push('cooldown-skipped'); },
      released: (admission) => { heard.push(admission === undefined ? 'released' : 'released-after-attempt'); },
    };
    return { heard, observer };
  }

  it('drains the placement in flight on close, settles every request, and leaves queued markers for the next start', async () => {
    const f = ownerFixture();
    const first = marker(1);
    const second = marker(2);
    const running = f.owe(first);
    await f.parked.entered();
    const queued = f.owe(second);
    expect(running.accepted && queued.accepted).toBe(true);
    expect(f.queue()).toMatchObject({ pending: 2, waiters: 2, passRunning: true });

    // Close fences admission, aborts the pass and waits for the attempt it already admitted.
    const closing = f.owner.close();
    expect(await settlesWithinV1(closing, 200)).toBe(false);
    expect(f.owe(marker(3)).accepted).toBe(false);
    f.parked.releaseNext();
    await closing;

    // The attempt in flight ran to its end. The queued marker was not started after the abort and
    // is still durable; the one stored while closing is too. No request is left unsettled.
    expect(f.repaired).toEqual(['placement-1']);
    expect(f.state.markers.map(({ assertionCoordinate }) => assertionCoordinate))
      .toEqual(['placement-2', 'placement-3']);
    expect(await settlesWithinV1(Promise.all([running.whenAttempted, queued.whenAttempted]), 200)).toBe(true);
    expect(f.owner.status()).toBeNull();
    // Nothing is left running that could start a placement later.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.repaired).toEqual(['placement-1']);

    // The next start lists the markers and places them. Nothing requested them again.
    f.parked.release();
    f.owner.start(ctx);
    await f.owner.whenIdle();
    expect(f.repaired).toEqual(['placement-1', 'placement-2', 'placement-3']);
    expect(f.state.markers).toEqual([]);
    expect(f.queue()).toMatchObject({ pending: 0, oldestPendingAgeMs: null, waiters: 0 });
  });

  it('counts a marker whose request it refused as owed, and places it on the next pass', async () => {
    const f = ownerFixture();
    f.parked.release();
    // A first placement gives the supervisor its state, so the queue is reported.
    await f.owe(marker(1)).whenAttempted;
    await f.owner.whenIdle();
    expect(f.queue()).toMatchObject({ pending: 0, waiters: 0 });

    f.clock.now = 1_000;
    f.state.laneActive = false;
    const refused = f.owe(marker(2));
    expect(refused.accepted).toBe(false);
    await refused.whenAttempted;
    f.clock.now = 9_000;
    // Refused, so no request is held; the marker is durable, so it is owed, for eight seconds now.
    expect(f.repaired).toEqual(['placement-1']);
    expect(f.queue()).toMatchObject({ pending: 1, oldestPendingAgeMs: 8_000, waiters: 0, oldestWaiterAgeMs: null });

    // The lane is back. Another marker's request starts a pass, and a pass lists every marker.
    f.state.laneActive = true;
    await f.owe(marker(3)).whenAttempted;
    await f.owner.whenIdle();
    expect(f.repaired).toEqual(['placement-1', 'placement-2', 'placement-3']);
    expect(f.state.markers).toEqual([]);
    expect(f.queue()).toMatchObject({ pending: 0, oldestPendingAgeMs: null });
  });

  it('tells the observer of a request exactly once what became of it, also when it refuses the request', async () => {
    const f = ownerFixture();
    const attempted = listening();
    const inactive = listening();
    const closed = listening();
    const throwing = { cooldownSkipped: () => {}, released: () => { throw new Error('observer failed'); } };

    const request = f.owe(marker(1), attempted.observer);
    await f.parked.entered();
    expect(attempted.heard).toEqual([]);
    f.parked.release();
    await request.whenAttempted;
    expect(attempted.heard).toEqual(['released-after-attempt']);

    // A refusal is a release with no attempt, told at once; an observer that fails changes nothing.
    f.state.laneActive = false;
    expect(f.owe(marker(2), inactive.observer).accepted).toBe(false);
    expect(f.owe(marker(3), throwing).accepted).toBe(false);
    expect(inactive.heard).toEqual(['released']);
    f.state.laneActive = true;
    await f.owner.close();
    expect(f.owe(marker(4), closed.observer).accepted).toBe(false);
    expect(closed.heard).toEqual(['released']);
    expect(attempted.heard).toEqual(['released-after-attempt']);
  });

  it('never settles a request before its attempt ends, however long the attempt takes', async () => {
    const f = ownerFixture();
    const request = f.owe(marker(1));
    await f.parked.entered();
    // The observer does not wait on this promise; the owner still keeps it honest.
    expect(await settlesWithinV1(request.whenAttempted, 200)).toBe(false);
    f.parked.releaseNext();
    await request.whenAttempted;
    expect(f.state.markers).toEqual([]);
  });
});

describe('a confirmed private placement the observer handed to the supervisor', () => {
  it('keeps the marker of a placement refused while the supervisor is closing, and the next start places it', async () => {
    const fixture = await startPlacementAgentV1({ name: 'ownership-admission-closed' });
    const { agent } = fixture;
    const asset = await seedPlacementAssetV1(agent, 'closing', 81n);
    const observer = vi.spyOn(agent, 'observeRfc64ConfirmedVmV1');

    // The supervisor closes its admission first when the node shuts down.
    await agent.closeRfc64SwmCatalogProjectionSupervisorV1();
    await observeConfirmedV1(agent, asset);

    expect(fixture.events()).toEqual([
      'marker-stored:repair-closing',
      'placement-requested:repair-closing:refused',
    ]);
    expect(fixture.markers()).toHaveLength(1);
    expect(fixture.counts().repairs).toBe(0);
    expect(fixture.warnings()).toContain(
      'Confirmed queued publish for <urn:placement-fixture:repair-closing>: the RFC-64 catalog supervisor '
      + 'did not accept its placement now; the durable marker stays for its next pass or start',
    );
    // The refused request's line is written as the observer returns: nothing will release it later.
    expect(fixture.placementLines().map(fields)).toEqual([
      expect.objectContaining({ observerCall: '1', outcome: 'no-attempt', lane: 'finalized-private' }),
    ]);

    // The next start lists the marker and places it; the confirmation is not observed again.
    agent.startRfc64SwmCatalogProjectionSupervisorV1(ctx);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(fixture.markers()).toEqual([]);
    expect(fixture.catalogRows()).toBe('1');
    expect(fixture.counts()).toMatchObject({ repairs: 1, successors: 1, announcements: 1 });
    expect(observer).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('keeps the marker of a placement refused by a lane transition, and a later pass places it', async () => {
    const fixture = await startPlacementAgentV1({ name: 'ownership-lane-transition' });
    const { agent } = fixture;
    const refused = await seedPlacementAssetV1(agent, 'lane-a', 82n);
    const later = await seedPlacementAssetV1(agent, 'lane-b', 83n);

    // The lane stops taking finalized placements between the observer's own check and the
    // supervisor's admission.
    fixture.afterMarkerStored = () => { fixture.lane.acceptsFinalizedVmRepair = false; };
    await observeConfirmedV1(agent, refused);
    fixture.afterMarkerStored = undefined;
    expect(fixture.events()).toEqual([
      'marker-stored:repair-lane-a',
      'placement-requested:repair-lane-a:refused',
    ]);
    expect(fixture.markers()).toHaveLength(1);
    expect(fixture.counts().repairs).toBe(0);

    // The lane is back. The next confirmation's request starts a pass, which lists both markers.
    fixture.lane.acceptsFinalizedVmRepair = true;
    await observeConfirmedV1(agent, later);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(fixture.markers()).toEqual([]);
    expect(fixture.catalogRows()).toBe('2');
    expect(fixture.counts()).toMatchObject({ repairs: 2, successors: 2, announcements: 2 });
  }, 60_000);

  it('says the marker stays when the placement could not even be requested, and the next start places it', async () => {
    const fixture = await startPlacementAgentV1({ name: 'ownership-request-throws' });
    const { agent } = fixture;
    const asset = await seedPlacementAssetV1(agent, 'unrequested', 87n);

    // The lane cannot be resolved at all when the supervisor checks it: the request throws after
    // the marker was stored.
    fixture.afterMarkerStored = () => { fixture.lane.unavailable = new Error('the catalog policy is not accepted yet'); };
    await observeConfirmedV1(agent, asset);
    fixture.afterMarkerStored = undefined;
    fixture.lane.unavailable = undefined;

    expect(fixture.events()).toEqual(['marker-stored:repair-unrequested']);
    expect(fixture.markers()).toHaveLength(1);
    expect(fixture.warnings()).toContain(
      'Confirmed queued publish but RFC-64 finalized-private placement could not be requested; its durable '
      + 'marker stays for the next pass or start: the catalog policy is not accepted yet',
    );

    agent.startRfc64SwmCatalogProjectionSupervisorV1(ctx);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(fixture.markers()).toEqual([]);
    expect(fixture.catalogRows()).toBe('1');
  }, 60_000);

  it('keeps the marker when the attempt fails, reports it as owed, and retires it only on the coverage proof', async () => {
    const fixture = await startPlacementAgentV1({ name: 'ownership-failed-attempt' });
    const { agent, clock } = fixture;
    const asset = await seedPlacementAssetV1(agent, 'failing', 84n);
    const observer = vi.spyOn(agent, 'observeRfc64ConfirmedVmV1');
    fixture.failPlacements.push(new Error('the catalog could not be signed'));

    await observeConfirmedV1(agent, asset);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();

    // The attempt failed before anything proved that the catalog covers the row, so the marker
    // stays. No request is held any more, and the placement is still reported as owed.
    clock.now = 4_000;
    expect(fixture.markers()).toHaveLength(1);
    expect(fixture.catalogRows()).toBeNull();
    expect(fixture.events()).toEqual([
      'marker-stored:repair-failing',
      'placement-requested:repair-failing:accepted',
    ]);
    expect(fixture.queue()).toMatchObject({
      pending: 1, oldestPendingAgeMs: 4_000, waiters: 0, oldestWaiterAgeMs: null, passRunning: false,
    });
    expect(fixture.placementLines().map(fields)).toEqual([
      expect.objectContaining({ observerCall: '1', outcome: 'failed', covered: '-' }),
    ]);

    // The supervisor owns the retry. A lane that went away and came back makes the marker
    // eligible at once; the unchanged-failure backoff is covered by the supervisor's own suite.
    fixture.lane.acceptsFinalizedVmRepair = false;
    agent.observeRfc64SwmCatalogProjectionLaneAvailabilityV1(CONTEXT_GRAPH_ID);
    fixture.lane.acceptsFinalizedVmRepair = true;
    agent.startRfc64SwmCatalogProjectionSupervisorV1(ctx);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();

    expect(fixture.events()).toEqual([
      'marker-stored:repair-failing',
      'placement-requested:repair-failing:accepted',
      'coverage-proof:repair-failing:false',
      'marker-retired:repair-failing',
    ]);
    expect(fixture.markers()).toEqual([]);
    expect(fixture.catalogRows()).toBe('1');
    expect(fixture.queue()).toMatchObject({ pending: 0, oldestPendingAgeMs: null });
    expect(observer).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('drains the placement in flight at shutdown, and the next start places the queued one with no observer call', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-placement-ownership-'));
    tempDirs.push(dataDir);
    const storePath = join(dataDir, 'store.nq');
    const first = await startPlacementAgentV1({ name: 'ownership-shutdown', dataDir, storePath });
    const drained = await seedPlacementAssetV1(first.agent, 'drained', 85n);
    const queued = await seedPlacementAssetV1(first.agent, 'queued', 86n);
    const parked = first.holdPlacements();

    expect(await settlesWithinV1(observeConfirmedV1(first.agent, drained))).toBe(true);
    await parked.entered();
    expect(await settlesWithinV1(observeConfirmedV1(first.agent, queued))).toBe(true);
    // One placement is parked in flight; the other is owed and queued behind it.
    expect(first.markers()).toHaveLength(2);
    expect(first.queue()).toMatchObject({ pending: 2, passRunning: true });

    // Shutdown waits for the placement in flight: it is drained, not abandoned.
    const stopping = first.agent.stop();
    expect(await settlesWithinV1(stopping, 500)).toBe(false);
    parked.release();
    await stopping;
    agents.splice(agents.indexOf(first.agent), 1);

    // Every request the observer made is settled and nothing keeps running after the stop: the
    // queued placement never reached its catalog work.
    expect(await settlesWithinV1(Promise.all(first.requests().map(({ whenAttempted }) => whenAttempted)), 200))
      .toBe(true);
    const stopped = first.counts();
    expect(stopped).toMatchObject({ coverageChecks: 1, successors: 1, announcements: 1 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(first.counts()).toEqual(stopped);

    // A restart on the same data finds the marker that survived and places it. The confirmation
    // is not observed again: the marker alone carries the obligation.
    let observer!: ReturnType<typeof vi.spyOn>;
    const second = await startPlacementAgentV1({
      name: 'ownership-restart',
      dataDir,
      storePath,
      beforeStart: (agent) => { observer = vi.spyOn(agent, 'observeRfc64ConfirmedVmV1'); },
    });
    expect(second.catalogRows()).toBe('1');
    await untilV1(() => second.markers().length === 0, 'the surviving marker is placed', 30_000);
    await second.agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(second.catalogRows()).toBe('2');
    expect(second.counts()).toMatchObject({ successors: 1, announcements: 1 });
    expect(observer).not.toHaveBeenCalled();
  }, 120_000);
});
