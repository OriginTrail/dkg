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
  reopenForEditingV1,
  reopenNextVersionForEditingV1,
  seedPlacementAssetV1,
  settledWithinV1,
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
  const gates: Array<ReturnType<typeof gateV1>> = [];

  afterEach(async () => {
    // A row that failed with a repair still parked must not leave its owner unable to close.
    for (const gate of gates.splice(0)) gate.release();
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
   * the row releases it; a released repair deletes its marker, as a completed placement does,
   * unless the row queued a failure for it. `retryIntervalMs` is 0 unless a row gives one: the
   * supervisor then runs a pass only when it is asked to. The shipped default is 5 s.
   */
  function ownerFixture(options: { retryIntervalMs?: number } = {}) {
    const clock = { now: 0 };
    const timing = new CatalogPlacementTimingV1({ clock: () => clock.now, logThresholdMs: 0 });
    const state = {
      markers: [] as Rfc64FinalizedPrivatePlacementRepairV1[],
      laneActive: true,
      /** When set, the lane cannot be resolved at all: the check throws it. */
      laneUnavailable: undefined as Error | undefined,
      /** How often a pass listed the durable markers. */
      listings: 0,
      /** The next repairs reject with these, one each. */
      failures: [] as Error[],
    };
    const parked = gateV1();
    gates.push(parked);
    const repaired: string[] = [];
    const owner = new Rfc64SwmCatalogProjectionOwnerV1({
      resolvePartition: () => ({
        retryIntervalMs: options.retryIntervalMs ?? 0, track2Policies: [], track2Targets: [], recoveryProviderPeerIds: [],
      }),
      listLocalAuthorAddresses: () => [AUTHOR],
      acceptsPublicRootLane: () => true,
      acceptsFinalizedPrivateLane: () => {
        if (state.laneUnavailable !== undefined) throw state.laneUnavailable;
        return state.laneActive;
      },
      readRepairRevision: () => ({ scopeIdentity: 'scope-1', headRevision: 'head-1' }),
      listFinalizedPrivateRepairs: () => {
        state.listings += 1;
        return state.markers;
      },
      repairFinalizedPrivatePlacement: async (repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>) => {
        repaired.push(repair.assertionCoordinate);
        await parked.pass();
        const failure = state.failures.shift();
        if (failure !== undefined) throw failure;
        state.markers = state.markers.filter((candidate) => candidate.kaUal !== repair.kaUal);
      },
      reconcile: async () => null,
      warn: () => {},
      placementTiming: () => timing,
    });
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
    expect(await settledWithinV1(closing, 200)).toEqual({ status: 'pending' });
    expect(f.owe(marker(3)).accepted).toBe(false);
    f.parked.releaseNext();
    await closing;

    // The attempt in flight ran to its end. The queued marker was not started after the abort and
    // is still durable; the one stored while closing is too. No request is left unsettled.
    expect(f.repaired).toEqual(['placement-1']);
    expect(f.state.markers.map(({ assertionCoordinate }) => assertionCoordinate))
      .toEqual(['placement-2', 'placement-3']);
    expect(await settledWithinV1(Promise.all([running.whenAttempted, queued.whenAttempted]), 200))
      .toEqual({ status: 'fulfilled', value: [undefined, undefined] });
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

  it('starts the pass one turn after the request, off the requester\'s stack', async () => {
    const f = ownerFixture();
    const request = f.owe(marker(1));
    expect(request.accepted).toBe(true);
    // The request is accepted and its marker counted, and nothing of the pass has run: neither
    // the listing of the durable markers nor the start of the repair.
    expect(f.state.listings).toBe(0);
    expect(f.repaired).toEqual([]);
    expect(f.queue()).toMatchObject({ pending: 1, waiters: 1, passRunning: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.state.listings).toBe(0);

    await f.parked.entered();
    expect(f.state.listings).toBe(1);
    expect(f.queue()).toMatchObject({ passRunning: true });
    f.parked.release();
    await request.whenAttempted;
    expect(f.state.markers).toEqual([]);
  });

  it('comes back on its own for a marker whose request the lane check refused', async () => {
    // The supervisor has no state yet: nothing has asked it for anything.
    const f = ownerFixture({ retryIntervalMs: 20 });
    f.parked.release();
    f.state.laneActive = false;
    expect(f.owe(marker(1)).accepted).toBe(false);

    // No other request and no start follow. While the lane stays away the marker stays.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(f.state.markers).toHaveLength(1);
    expect(f.repaired).toEqual([]);
    expect(f.state.listings).toBeGreaterThan(0);

    f.state.laneActive = true;
    await untilV1(() => f.state.markers.length === 0, 'the refused marker is placed', 5_000);
    expect(f.repaired).toEqual(['placement-1']);
    expect(f.queue()).toMatchObject({ pending: 0, oldestPendingAgeMs: null });
  });

  it('comes back on its own for a marker whose lane could not be resolved at the request', async () => {
    const f = ownerFixture({ retryIntervalMs: 20 });
    f.parked.release();
    f.state.laneUnavailable = new Error('the catalog policy is not accepted yet');
    expect(() => f.owe(marker(1))).toThrow('the catalog policy is not accepted yet');
    f.state.laneUnavailable = undefined;

    await untilV1(() => f.state.markers.length === 0, 'the unrequested marker is placed', 5_000);
    expect(f.repaired).toEqual(['placement-1']);
  });

  it('retries a failed first attempt on its own when a retry interval is configured', async () => {
    const f = ownerFixture({ retryIntervalMs: 20 });
    f.parked.release();
    f.state.failures.push(new Error('the catalog could not be signed'));
    const request = f.owe(marker(1));
    await request.whenAttempted;
    // The first attempt failed and released its request; the marker is still owed.
    expect(f.repaired).toEqual(['placement-1']);
    expect(f.state.markers).toHaveLength(1);

    await untilV1(() => f.state.markers.length === 0, 'the failed placement is retried', 5_000);
    expect(f.repaired).toEqual(['placement-1', 'placement-1']);
  });

  it('leaves a failed first attempt to the next request or start when no retry interval is configured', async () => {
    // Not the shipped default. With the interval at 0 nothing runs a pass unless it is asked to.
    const f = ownerFixture();
    f.parked.release();
    f.state.failures.push(new Error('the catalog could not be signed'));
    await f.owe(marker(1)).whenAttempted;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(f.repaired).toEqual(['placement-1']);
    expect(f.state.markers).toHaveLength(1);
    expect(f.queue()).toMatchObject({ pending: 1, waiters: 0, passRunning: false });
  });

  it('never settles a request before its attempt ends, however long the attempt takes', async () => {
    const f = ownerFixture();
    const request = f.owe(marker(1));
    await f.parked.entered();
    // The observer does not wait on this promise; the owner still keeps it honest.
    expect(await settledWithinV1(request.whenAttempted, 200)).toEqual({ status: 'pending' });
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
    // No waiter exists to release this call later, so its line is written as the observer returns.
    expect(fixture.placementLines().map(fields)).toEqual([
      expect.objectContaining({ observerCall: '1', outcome: 'no-attempt', lane: 'finalized-private' }),
    ]);

    agent.startRfc64SwmCatalogProjectionSupervisorV1(ctx);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(fixture.markers()).toEqual([]);
    expect(fixture.catalogRows()).toBe('1');
  }, 60_000);

  // Two exits of the observer end a confirmed publication with no marker. Both are older than the
  // terminal boundary and are exceptions to it; the rows record them and do not endorse them.
  it('owes nothing when the catalog lane cannot be resolved at the confirmation', async () => {
    const fixture = await startPlacementAgentV1({ name: 'ownership-lane-unresolvable' });
    const { agent } = fixture;
    const asset = await seedPlacementAssetV1(agent, 'unresolvable', 88n);

    fixture.lane.unavailable = new Error('the catalog policy is not accepted yet');
    await expect(observeConfirmedV1(agent, asset)).resolves.toBeUndefined();
    fixture.lane.unavailable = undefined;

    expect(fixture.events()).toEqual([]);
    expect(fixture.markers()).toEqual([]);
    expect(fixture.warnings()).toContain(
      'Confirmed queued publish but RFC-64 catalog authority was unavailable: the catalog policy is not accepted yet',
    );
    // Nothing was stored, so no pass and no start has anything to place.
    agent.startRfc64SwmCatalogProjectionSupervisorV1(ctx);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(fixture.counts().repairs).toBe(0);
    expect(fixture.catalogRows()).toBeNull();
  }, 60_000);

  it('owes nothing when the graph has no catalog lane at the confirmation', async () => {
    const fixture = await startPlacementAgentV1({ name: 'ownership-lane-inactive' });
    const { agent } = fixture;
    const asset = await seedPlacementAssetV1(agent, 'laneless', 89n);

    fixture.lane.inactive = true;
    await expect(observeConfirmedV1(agent, asset)).resolves.toBeUndefined();
    fixture.lane.inactive = false;

    // The observer took the path of a lane that places nothing at confirmation: no marker.
    expect(fixture.events()).toEqual([]);
    expect(fixture.markers()).toEqual([]);
    agent.startRfc64SwmCatalogProjectionSupervisorV1(ctx);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(fixture.counts().repairs).toBe(0);
    expect(fixture.catalogRows()).toBeNull();
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

    expect(await settledWithinV1(observeConfirmedV1(first.agent, drained)))
      .toEqual({ status: 'fulfilled', value: undefined });
    await parked.entered();
    expect(await settledWithinV1(observeConfirmedV1(first.agent, queued)))
      .toEqual({ status: 'fulfilled', value: undefined });
    // One placement is parked in flight; the other is owed and queued behind it.
    expect(first.markers()).toHaveLength(2);
    expect(first.queue()).toMatchObject({ pending: 2, passRunning: true });

    // Shutdown waits for the placement in flight: it is drained, not abandoned.
    const stopping = first.agent.stop();
    expect(await settledWithinV1(stopping, 500)).toEqual({ status: 'pending' });
    parked.release();
    await stopping;
    agents.splice(agents.indexOf(first.agent), 1);

    // Every request the observer made is settled and nothing keeps running after the stop: the
    // queued placement never reached its catalog work.
    expect(await settledWithinV1(Promise.all(first.requests().map(({ whenAttempted }) => whenAttempted)), 200))
      .toEqual({ status: 'fulfilled', value: [undefined, undefined] });
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

  it('keeps a marker whose seal is stored nowhere after a restart, attempts it at a bounded pace, and says why', async () => {
    // The seal of an owed placement is kept in memory, not on disk. Two edit cycles followed by
    // a restart leave a marker that cannot place its version. This row records what the node
    // then does; it does not endorse it.
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-placement-sealless-'));
    tempDirs.push(dataDir);
    const storePath = join(dataDir, 'store.nq');
    const first = await startPlacementAgentV1({ name: 'ownership-sealless', dataDir, storePath });
    const asset = await seedPlacementAssetV1(first.agent, 'sealless', 90n);
    // The marker is stored while the supervisor takes no requests, so nothing places it before
    // the stop. Then both stored seals move on.
    await first.agent.closeRfc64SwmCatalogProjectionSupervisorV1();
    await observeConfirmedV1(first.agent, asset);
    expect(first.markers()).toHaveLength(1);
    await reopenForEditingV1(first.agent, asset);
    await reopenNextVersionForEditingV1(first.agent, asset);
    await first.agent.stop();
    agents.splice(agents.indexOf(first.agent), 1);

    const second = await startPlacementAgentV1({ name: 'ownership-sealless-restart', dataDir, storePath });
    const sealFailures = (): Array<Record<string, any>> => second.warnings().flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed.event === 'catalog_private_repair_failed' && parsed.diagnostic?.stage === 'seal' ? [parsed] : [];
      } catch {
        return [];
      }
    });
    await untilV1(() => sealFailures().length > 0, 'the placement fails for want of its seal', 30_000);

    // Visible: the failure names the stage and its kind, and the placement stays in the backlog.
    expect(sealFailures()).toEqual([
      expect.objectContaining({
        event: 'catalog_private_repair_failed',
        diagnostic: expect.objectContaining({ kind: 'integrity', stage: 'seal' }),
        consecutiveFailures: 1,
      }),
    ]);
    expect(second.markers()).toHaveLength(1);
    expect(second.catalogRows()).toBeNull();
    expect(second.queue()).toMatchObject({ pending: 1, waiters: 0 });
    // Bounded: the supervisor's backoff holds the next attempt back, here by its first interval.
    expect(sealFailures()[0]!.nextAttemptAtMs - Date.now()).toBeGreaterThan(3_000);
  }, 120_000);
});
