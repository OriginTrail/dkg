/**
 * GH#3081 — the catalog placement timing: how the time from one observer call to the end of its
 * placement attempt is split, that a wait hears exactly the attempt that released its own waiter
 * (through the real finalized-private supervisor too), that its line is written at that release
 * because the observer does not wait for it, the supervisor's waiter registry, the aggregate queue
 * view with the placements still owed, the bounds, and that a failure to observe never surfaces.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOperationContext,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type OperationContext,
} from '@origintrail-official/dkg-core';

import { Rfc64SwmCatalogProjectionOwnerV1 } from '../src/dkg-agent-rfc64-swm-catalog-projection-supervisor.js';
import { FinalizedPrivatePlacementWaitersV1 } from '../src/internal/finalized-private-placement-waiters.js';
import {
  CATALOG_PLACEMENT_WAIT_LOG_THRESHOLD_MS,
  CatalogPlacementTimingV1,
  catalogPlacementTimingV1,
  installCatalogPlacementTimingV1,
  type CatalogPlacementAttemptV1,
  type CatalogPlacementPhase,
} from '../src/internal/catalog-placement-timing.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from
  '../src/rfc64/finalized-private-placement-repair-store-v1.js';

const ASSET = Object.freeze({ kaUal: 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/7', assertionVersion: '3' });
const DENIED = 'catalog-transport-policy-denied' as const;

function harness(logThresholdMs = 0) {
  const clock = { now: 0 };
  const timing = new CatalogPlacementTimingV1({ clock: () => clock.now, logThresholdMs });
  const lines: Array<{ ctx: OperationContext; message: string }> = [];
  const log = { info: (ctx: OperationContext, message: string) => { lines.push({ ctx, message }); } };
  return { timing, clock, lines, log };
}

function fields(message: string): Record<string, string> {
  const [event, ...pairs] = message.split(' ');
  expect(event).toBe('rfc64_catalog_placement_wait');
  return Object.fromEntries(pairs.map((pair) => {
    const separator = pair.indexOf('=');
    return [pair.slice(0, separator), pair.slice(separator + 1)];
  }));
}

describe('catalog placement timing', () => {
  it('splits an observer wait into request, queue and the phases of the attempt that released it', async () => {
    const { timing, clock, lines, log } = harness();
    const wait = timing.beginWait(ASSET, createOperationContext('publishFromSWM', 'job-7'));
    clock.now = 1_200;
    wait.requested();
    clock.now = 31_200;
    const admission = timing.admit();
    const { attempt } = admission;
    const until = (phase: CatalogPlacementPhase, at: number) => attempt.measure(phase, async () => { clock.now = at; });
    attempt.covered(await attempt.measure('coverage', async () => {
      clock.now = 33_000;
      return false;
    }));
    await until('asset', 33_500);
    await until('state', 36_000);
    await until('successor', 44_000);
    await until('cas', 44_010);
    attempt.announced(await attempt.measure('announce', async () => {
      clock.now = 154_010;
      return { announcedPeers: ['peer-a'], failedPeers: [{ code: DENIED }, { code: DENIED }, {}] };
    }));
    clock.now = 154_100;
    admission.end('completed');
    wait.observer.released(admission);
    clock.now = 154_101;
    wait.end(log);

    expect(lines).toHaveLength(1);
    expect(lines[0]!.ctx.sourceOperationId).toBe('job-7');
    expect(lines[0]!.message).toBe(
      `rfc64_catalog_placement_wait ual=${ASSET.kaUal} version=3 lane=finalized-private source=job-7 `
      + 'observerCall=1 outcome=completed totalMs=154101 requestMs=1200 queueMs=30000 attemptMs=122900 '
      + 'coverageMs=1800 assetMs=500 stateMs=2500 successorMs=8000 casMs=10 announceMs=110000 otherMs=90 '
      + 'peers=4 failedPeers=3 deniedPeers=2 covered=false cooldownSkips=0',
    );
  });

  it('describes each observer call by the attempt that released its own waiter', () => {
    const { timing, clock, lines, log } = harness();
    const ctx = createOperationContext('publishFromSWM');
    const first = timing.beginWait(ASSET, ctx);
    first.requested();
    const firstAttempt = timing.admit();
    clock.now = 10;
    firstAttempt.end('completed');
    first.observer.released(firstAttempt);
    first.end(log);

    clock.now = 20;
    const second = timing.beginWait(ASSET, ctx);
    second.requested();
    clock.now = 25;
    const secondAttempt = timing.admit();
    clock.now = 28;
    secondAttempt.end('failed');
    second.observer.released(secondAttempt);
    clock.now = 30;
    second.end(log);

    // A key that leaves the queue releases its waiter without an attempt.
    const third = timing.beginWait(ASSET, ctx);
    third.requested();
    third.observer.released();
    clock.now = 31;
    third.end(log);

    expect(fields(lines[0]!.message)).toMatchObject({ observerCall: '1', outcome: 'completed', source: '-' });
    expect(fields(lines[1]!.message)).toMatchObject({
      observerCall: '2', outcome: 'failed', totalMs: '10', queueMs: '5', attemptMs: '3', otherMs: '3',
    });
    expect(fields(lines[2]!.message)).toMatchObject({
      observerCall: '3', outcome: 'no-attempt', queueMs: '-', attemptMs: '-', coverageMs: '-', covered: '-',
    });
  });

  it('charges a waiter that joined an attempt already in flight from its own request onward', () => {
    const { timing, clock, lines, log } = harness();
    const admission = timing.admit();
    clock.now = 100;
    const wait = timing.beginWait(ASSET, createOperationContext('publishFromSWM'));
    wait.requested();
    clock.now = 400;
    admission.end('failed');
    wait.observer.released(admission);
    wait.end(log);
    expect(fields(lines[0]!.message)).toMatchObject({
      outcome: 'failed', totalMs: '300', queueMs: '0', attemptMs: '300', otherMs: '400',
    });
  });

  it('labels a wait that never asked for a placement as the public lane', () => {
    const { timing, clock, lines, log } = harness();
    const wait = timing.beginWait(ASSET, createOperationContext('publish'));
    clock.now = 7;
    wait.end(log);
    expect(fields(lines[0]!.message)).toMatchObject({
      lane: 'public', outcome: 'not-awaited', totalMs: '7', requestMs: '-', cooldownSkips: '-',
    });
  });

  it('reports a request the supervisor did not accept as an unattempted wait', () => {
    const { timing, clock, lines, log } = harness();
    const wait = timing.beginWait(ASSET, createOperationContext('publish'));
    clock.now = 3;
    wait.requested();
    // A refusal is a release with no attempt, told at once.
    wait.observer.released();
    clock.now = 9;
    wait.end(log);
    expect(fields(lines[0]!.message)).toMatchObject({
      lane: 'finalized-private', outcome: 'no-attempt', totalMs: '9', requestMs: '3', cooldownSkips: '0',
    });
  });

  it('counts the cooldown skips a waiter waited through and writes nothing below the threshold', () => {
    const { timing, clock, lines, log } = harness(CATALOG_PLACEMENT_WAIT_LOG_THRESHOLD_MS);
    const wait = timing.beginWait(ASSET, createOperationContext('publish'));
    wait.requested();
    wait.observer.cooldownSkipped();
    wait.observer.cooldownSkipped();
    clock.now = CATALOG_PLACEMENT_WAIT_LOG_THRESHOLD_MS - 1;
    wait.observer.released();
    wait.end(log);
    expect(lines).toEqual([]);

    const slow = timing.beginWait(ASSET, createOperationContext('publish'));
    slow.requested();
    slow.observer.cooldownSkipped();
    clock.now += CATALOG_PLACEMENT_WAIT_LOG_THRESHOLD_MS;
    slow.observer.released();
    slow.end(log);
    expect(fields(lines[0]!.message)).toMatchObject({ cooldownSkips: '1', observerCall: '2' });
    // Every skipped marker counts once in the aggregate, waiters or not.
    for (let skip = 0; skip < 3; skip += 1) timing.cooldownSkipped();
    expect(timing.queueStatus({ count: 0, oldestRequestedAt: undefined }, false).cooldownSkips).toBe(3);
  });

  it('counts policy denials from the transport\'s typed code, never from the failure text', () => {
    const { timing, lines, log } = harness();
    const wait = timing.beginWait(ASSET, createOperationContext('publish'));
    wait.requested();
    const admission = timing.admit();
    const { attempt } = admission;
    const failures = [
      { error: 'the peer refused this announcement', code: DENIED },
      { error: '[catalog-transport-policy-denied] text alone is display, not evidence' },
      { error: 'catalog-head announcement returned an invalid acknowledgement', code: 'catalog-transport-wire' as const },
    ];
    attempt.announced({ announcedPeers: [], failedPeers: failures });
    admission.end('completed');
    wait.observer.released(admission);
    wait.end(log);
    expect(fields(lines[0]!.message)).toMatchObject({ peers: '3', failedPeers: '3', deniedPeers: '1' });
  });

  it('charges a phase that rejects to that phase, and passes the rejection through', async () => {
    const { timing, clock, lines, log } = harness();
    const wait = timing.beginWait(ASSET, createOperationContext('publish'));
    wait.requested();
    const admission = timing.admit();
    const failure = new Error('storage timeout');
    await expect(admission.attempt.measure('asset', async () => {
      clock.now = 6_000;
      throw failure;
    })).rejects.toBe(failure);
    admission.end('failed');
    wait.observer.released(admission);
    wait.end(log);
    expect(fields(lines[0]!.message)).toMatchObject({
      outcome: 'failed', assetMs: '6000', otherMs: '0', covered: '-',
    });
  });

  it('keeps two attempts admitted at once apart, each charged only through its own recorder', async () => {
    const { timing, clock, lines, log } = harness();
    const ctx = createOperationContext('publish');
    const firstWait = timing.beginWait(ASSET, ctx);
    firstWait.requested();
    const secondWait = timing.beginWait(ASSET, ctx);
    secondWait.requested();
    const first = timing.admit();
    const second = timing.admit();
    let advance!: () => void;
    const gate = new Promise<void>((resolve) => { advance = resolve; });
    const both = Promise.all([
      first.attempt.measure('coverage', () => gate.then(() => true)),
      second.attempt.measure('successor', () => gate),
    ]);
    clock.now = 40;
    advance();
    const [covered] = await both;
    first.attempt.covered(covered);
    second.end('failed');
    first.end('completed');
    secondWait.observer.released(second);
    firstWait.observer.released(first);
    firstWait.end(log);
    secondWait.end(log);
    expect(fields(lines[0]!.message)).toMatchObject({
      observerCall: '1', outcome: 'completed', covered: 'true', coverageMs: '40', successorMs: '0',
    });
    expect(fields(lines[1]!.message)).toMatchObject({
      observerCall: '2', outcome: 'failed', covered: '-', coverageMs: '0', successorMs: '40',
    });
  });

  it('reports the finalized-private queue as aggregates of the waiters the supervisor holds', () => {
    const { timing, clock } = harness();
    const waiters = new FinalizedPrivatePlacementWaitersV1();
    expect(timing.queueStatus(waiters.summary(), false)).toEqual({
      depth: 0, pending: 0, oldestPendingAgeMs: null, waiters: 0, oldestWaiterAgeMs: null,
      passRunning: false, lastPassDurationMs: null, cooldownSkips: 0,
    });
    timing.passStarted(new Set(['key-a', 'key-b', 'key-c']));
    waiters.add('key-a', timing.now());
    clock.now = 400;
    waiters.add('key-a', timing.now());
    waiters.add('key-b', timing.now());
    timing.cooldownSkipped();
    clock.now = 1_000;
    expect(timing.queueStatus(waiters.summary(), true)).toEqual({
      depth: 3, pending: 3, oldestPendingAgeMs: 1_000, waiters: 3, oldestWaiterAgeMs: 1_000,
      passRunning: true, lastPassDurationMs: null, cooldownSkips: 1,
    });
    clock.now = 1_250;
    timing.passEnded();
    timing.passEnded();
    waiters.release('key-a');
    // No attempt completed, so every listed marker is still owed although one key lost its waiters.
    expect(timing.queueStatus(waiters.summary(), false)).toEqual({
      depth: 3, pending: 3, oldestPendingAgeMs: 1_250, waiters: 1, oldestWaiterAgeMs: 850,
      passRunning: false, lastPassDurationMs: 1_250, cooldownSkips: 1,
    });
  });

  it('writes the line when the supervisor releases a request whose observer already returned', async () => {
    const { timing, clock, lines, log } = harness();
    const wait = timing.beginWait(ASSET, createOperationContext('publishFromSWM', 'job-9'));
    clock.now = 20;
    wait.requested();
    // The observer returns here: the publication is terminal and the placement still queued.
    wait.end(log);
    expect(lines).toEqual([]);

    clock.now = 5_020;
    const admission = timing.admit('key-a');
    await expect(admission.attempt.measure('successor', async () => {
      clock.now = 9_020;
      throw new Error('the successor could not be signed');
    })).rejects.toThrow('the successor could not be signed');
    admission.end('failed');
    expect(lines).toEqual([]);
    wait.observer.released(admission);

    expect(lines).toHaveLength(1);
    expect(lines[0]!.ctx.sourceOperationId).toBe('job-9');
    expect(fields(lines[0]!.message)).toMatchObject({
      observerCall: '1', outcome: 'failed', totalMs: '9020', requestMs: '20', queueMs: '5000',
      attemptMs: '4000', successorMs: '4000', source: 'job-9',
    });
    // One line per request: a second release of the same waiter writes nothing more.
    wait.observer.released(admission);
    wait.observer.released();
    expect(lines).toHaveLength(1);
  });

  it('writes a returned observer\'s line as unattempted when its marker left the queue', () => {
    const { timing, clock, lines, log } = harness();
    const wait = timing.beginWait(ASSET, createOperationContext('publish'));
    wait.requested();
    wait.end(log);
    clock.now = 70;
    expect(lines).toEqual([]);
    wait.observer.released();
    expect(lines.map(({ message }) => fields(message))).toEqual([
      expect.objectContaining({ outcome: 'no-attempt', totalMs: '70', queueMs: '-', attemptMs: '-' }),
    ]);
  });

  it('writes at once for a request that was released before the observer reported it', () => {
    const { timing, clock, lines, log } = harness();
    const wait = timing.beginWait(ASSET, createOperationContext('publish'));
    const admission = timing.admit();
    admission.end('completed');
    wait.observer.released(admission);
    clock.now = 4;
    wait.requested();
    wait.end(log);
    expect(lines.map(({ message }) => fields(message))).toEqual([
      expect.objectContaining({ outcome: 'completed', totalMs: '4' }),
    ]);
  });

  it('counts a placement as owed from its request until an attempt completes it', () => {
    const { timing, clock } = harness();
    const pending = () => {
      const { pending: count, oldestPendingAgeMs } = timing.queueStatus({ count: 0, oldestRequestedAt: undefined }, false);
      return { pending: count, oldestPendingAgeMs };
    };
    clock.now = 100;
    timing.owed('key-a');
    clock.now = 300;
    timing.owed('key-b');
    // A repeated request for a marker already owed keeps its first time.
    clock.now = 900;
    timing.owed('key-a');
    expect(pending()).toEqual({ pending: 2, oldestPendingAgeMs: 800 });

    // A failed attempt leaves the marker owed; a completed one retires it.
    timing.admit('key-a').end('failed');
    expect(pending()).toEqual({ pending: 2, oldestPendingAgeMs: 800 });
    timing.admit('key-a').end('completed');
    expect(pending()).toEqual({ pending: 1, oldestPendingAgeMs: 600 });
    // An attempt admitted without a key retires nothing.
    timing.admit().end('completed');
    expect(pending()).toEqual({ pending: 1, oldestPendingAgeMs: 600 });

    // A pass lists what is durable: a marker it does not list is gone, and one it lists that
    // nothing requested here (it survived a restart) is owed from this pass on.
    clock.now = 1_000;
    timing.passStarted(new Set(['key-c']));
    clock.now = 1_400;
    expect(pending()).toEqual({ pending: 1, oldestPendingAgeMs: 400 });
    timing.passStarted(new Set());
    expect(pending()).toEqual({ pending: 0, oldestPendingAgeMs: null });
  });

  it('stops remembering new markers between passes at its bound, until a pass lists them', () => {
    const { timing } = harness();
    const idle = { count: 0, oldestRequestedAt: undefined };
    for (let index = 0; index < 4_100; index += 1) timing.owed(`key-${index}`);
    expect(timing.queueStatus(idle, false).pending).toBe(4_096);
    const listed = new Set(Array.from({ length: 4_100 }, (_unused, index) => `key-${index}`));
    timing.passStarted(listed);
    expect(timing.queueStatus(idle, false)).toMatchObject({ depth: 4_100, pending: 4_100 });
  });

  it('keeps a first-seen time for at most 4,096 owed placements and still counts every one a pass lists', () => {
    const { timing, clock } = harness();
    const status = () => {
      const { depth, pending, oldestPendingAgeMs } = timing.queueStatus({ count: 0, oldestRequestedAt: undefined }, false);
      return { depth, pending, oldestPendingAgeMs };
    };
    const keys = Array.from({ length: 5_000 }, (_unused, index) => `key-${index}`);
    clock.now = 1_000;
    timing.passStarted(new Set(keys));
    clock.now = 4_000;
    expect(status()).toEqual({ depth: 5_000, pending: 5_000, oldestPendingAgeMs: 3_000 });

    // A completed placement counts down whether its time was kept (the first 4,096) or not.
    timing.admit('key-0').end('completed');
    timing.admit('key-4999').end('completed');
    expect(status().pending).toBe(4_998);
    // While some markers are only counted, one stored now may be one of them: the next pass,
    // which lists every marker, counts it.
    timing.owed('key-new');
    timing.owed('key-4500');
    expect(status().pending).toBe(4_998);

    // The next pass is exact again. It keeps nothing it no longer lists, and one of the markers
    // that was only counted takes the room the completed one left, with this pass's time.
    clock.now = 9_000;
    timing.passStarted(new Set([...keys.slice(1, 4_999), 'key-new']));
    expect(status()).toEqual({ depth: 4_999, pending: 4_999, oldestPendingAgeMs: 8_000 });

    // With every marker of the first pass placed, the oldest one left is the one that took that
    // room: its age counts from the pass that found it, not from the pass that first listed it.
    clock.now = 10_000;
    timing.passStarted(new Set(keys.slice(4_096, 4_999)));
    clock.now = 12_000;
    expect(status()).toEqual({ depth: 903, pending: 903, oldestPendingAgeMs: 3_000 });

    // Back under the bound a stored marker counts at once again.
    timing.owed('key-late');
    expect(status().pending).toBe(904);
  });

  it('keeps at most 512 assets of observer counts', () => {
    const { timing, lines, log } = harness();
    const ctx = createOperationContext('publish');
    for (let index = 0; index <= 512; index += 1) {
      timing.beginWait({ kaUal: `did:dkg:test/${index}`, assertionVersion: '1' }, ctx);
    }
    timing.beginWait({ kaUal: 'did:dkg:test/0', assertionVersion: '1' }, ctx).end(log);
    timing.beginWait({ kaUal: 'did:dkg:test/512', assertionVersion: '1' }, ctx).end(log);
    expect(lines.map(({ message }) => fields(message).observerCall)).toEqual(['1', '2']);
  });

  it('never throws, whatever fails underneath it', async () => {
    const timing = new CatalogPlacementTimingV1({
      clock: () => { throw new Error('clock failed'); },
      logThresholdMs: 0,
    });
    const throwingLog = { info: () => { throw new Error('log failed'); } };
    expect(() => {
      const wait = timing.beginWait(ASSET, createOperationContext('publish'));
      wait.requested();
      const admission = timing.admit();
      const { attempt } = admission;
      attempt.covered(false);
      attempt.announced({ announcedPeers: [], failedPeers: [] });
      admission.end('failed');
      timing.cooldownSkipped();
      wait.observer.cooldownSkipped();
      wait.observer.released(admission);
      wait.observer.released();
      timing.owed('key');
      timing.admit('key').end('completed');
      timing.passStarted(new Set(['key']));
      timing.passEnded();
      wait.end(throwingLog);
      expect(timing.now()).toBeNaN();
      expect(timing.queueStatus({ count: 1, oldestRequestedAt: Number.NaN }, true)).toMatchObject({
        waiters: 1, oldestWaiterAgeMs: null, oldestPendingAgeMs: null, passRunning: true,
      });
    }).not.toThrow();

    const { timing: working, clock } = harness();
    const wait = working.beginWait(ASSET, createOperationContext('publish'));
    clock.now = 5;
    expect(() => wait.end(throwingLog)).not.toThrow();

    // Neither does a line that fails when the supervisor releases the request it was left for.
    const left = working.beginWait(ASSET, createOperationContext('publish'));
    left.requested();
    left.end(throwingLog);
    expect(() => left.observer.released()).not.toThrow();

    // A clock that fails after admission never changes what a measured phase returns or throws.
    let clockFails = false;
    const flaky = new CatalogPlacementTimingV1({
      clock: () => { if (clockFails) throw new Error('clock failed'); return 0; },
      logThresholdMs: 0,
    });
    const flakyAttempt = flaky.admit().attempt;
    clockFails = true;
    await expect(flakyAttempt.measure('state', async () => 'kept')).resolves.toBe('kept');
    const failure = new Error('work failed');
    await expect(flakyAttempt.measure('asset', async () => { throw failure; })).rejects.toBe(failure);
  });

  it('resolves one timing per agent and lets a test install its own', () => {
    const agent = {};
    const timing = catalogPlacementTimingV1(agent);
    expect(catalogPlacementTimingV1(agent)).toBe(timing);
    expect(catalogPlacementTimingV1({})).not.toBe(timing);
    const injected = new CatalogPlacementTimingV1({ logThresholdMs: 0 });
    installCatalogPlacementTimingV1(agent, injected);
    expect(catalogPlacementTimingV1(agent)).toBe(injected);
  });
});

describe('catalog placement timing through the finalized-private supervisor', () => {
  const CG = 'placement-timing' as ContextGraphIdV1;
  const AUTHOR = `0x${'11'.repeat(20)}` as EvmAddressV1;
  const ctx = createOperationContext('publishFromSWM', 'job-supervised');
  const owners: Rfc64SwmCatalogProjectionOwnerV1[] = [];

  afterEach(async () => {
    await Promise.all(owners.splice(0).map((owner) => owner.close()));
    vi.useRealTimers();
  });

  function repairMarker(): Rfc64FinalizedPrivatePlacementRepairV1 {
    return {
      version: 1, contextGraphId: CG, authorAddress: AUTHOR,
      inventoryScope: {
        networkId: 'otp:20430', contextGraphId: CG, governanceChainId: null,
        governanceContractAddress: null, ownershipTransitionDigest: null,
        authorAddress: AUTHOR, subGraphName: null, era: '1',
      },
      assertionCoordinate: 'placement', assertionVersion: '3',
      kaUal: ASSET.kaUal, sealDigest: `0x${'22'.repeat(32)}`,
    } as Rfc64FinalizedPrivatePlacementRepairV1;
  }

  /**
   * A real owner whose repair body the row drives: each run parks until the row releases it. The
   * body works on a snapshot of its marker, as a repair boundary may, so its phases can reach the
   * waiters only through the recorder the supervisor passes in. The marker list stands in for the
   * durable queue: an observation puts its marker, a successful repair deletes it, a failed one
   * leaves it for the retry.
   */
  function supervisedFixture() {
    const clock = { now: 0 };
    const timing = new CatalogPlacementTimingV1({ clock: () => clock.now, logThresholdMs: 0 });
    let markers: readonly Rfc64FinalizedPrivatePlacementRepairV1[] = [];
    const releases: Array<(failure?: Error) => void> = [];
    let enter!: () => void;
    let entered!: Promise<void>;
    const armEntry = () => { entered = new Promise((resolve) => { enter = resolve; }); };
    armEntry();
    const repair = vi.fn(async (
      marker: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
      placement: CatalogPlacementAttemptV1,
    ) => {
      const snapshot = { ...marker };
      const failure = await placement.measure('successor', () => new Promise<Error | undefined>((resolve) => {
        releases.push(resolve);
        enter();
      }));
      armEntry();
      if (failure !== undefined) throw failure;
      markers = markers.filter((candidate) => candidate.kaUal !== snapshot.kaUal);
    });
    const owner = new Rfc64SwmCatalogProjectionOwnerV1({
      resolvePartition: () => ({ retryIntervalMs: 0, track2Policies: [], track2Targets: [], recoveryProviderPeerIds: [] }),
      listLocalAuthorAddresses: () => [AUTHOR],
      acceptsPublicRootLane: () => true,
      acceptsFinalizedPrivateLane: () => true,
      readRepairRevision: () => ({ scopeIdentity: 'scope-1', headRevision: 'head-1' }),
      listFinalizedPrivateRepairs: () => markers,
      repairFinalizedPrivatePlacement: repair,
      reconcile: async () => null,
      warn: () => {},
      placementTiming: () => timing,
    } as never);
    owners.push(owner);
    const lines: string[] = [];
    const log = { info: (_ctx: OperationContext, message: string) => { lines.push(message); } };
    return {
      owner, clock, repair, lines, log,
      entered: () => entered,
      release: (failure?: Error) => releases.at(-1)!(failure),
      /** One observer call: put the marker (unless it already left the queue), then request it. */
      observe: (marker: Rfc64FinalizedPrivatePlacementRepairV1, options: { put?: boolean } = {}) => {
        if (options.put !== false && !markers.includes(marker)) markers = [...markers, marker];
        const wait = timing.beginWait(ASSET, ctx);
        const request = owner.requestFinalizedPrivate({ repair: marker, ctx, observer: wait.observer });
        wait.requested();
        return { wait, request };
      },
    };
  }

  it('binds repeated observations and a waiter joining an attempt in flight to the attempt that released each', async () => {
    const f = supervisedFixture();
    const marker = repairMarker();

    f.clock.now = 100;
    const first = f.observe(marker);
    await f.entered();
    f.clock.now = 400;
    const joined = f.observe(marker);
    f.clock.now = 1_000;
    f.release();
    await Promise.all([first.request.whenAttempted, joined.request.whenAttempted]);
    first.wait.end(f.log);
    joined.wait.end(f.log);
    await f.owner.whenIdle();

    // The same confirmation observed again, as recovery does after the executor tail.
    f.clock.now = 2_000;
    const repeated = f.observe(marker);
    await f.entered();
    f.clock.now = 2_600;
    f.release();
    await repeated.request.whenAttempted;
    repeated.wait.end(f.log);
    await f.owner.whenIdle();

    expect(f.repair).toHaveBeenCalledTimes(2);
    expect(f.lines.map(fields)).toEqual([
      expect.objectContaining({
        observerCall: '1', outcome: 'completed', totalMs: '900', queueMs: '0', attemptMs: '900',
        successorMs: '900', otherMs: '0', source: 'job-supervised',
      }),
      expect.objectContaining({
        observerCall: '2', outcome: 'completed', totalMs: '600', queueMs: '0', attemptMs: '600',
        successorMs: '900',
      }),
      expect.objectContaining({
        observerCall: '3', outcome: 'completed', totalMs: '600', queueMs: '0', attemptMs: '600',
        successorMs: '600',
      }),
    ]);
  });

  it('counts the cooldown skips a waiter sits through and reports a marker that left as unattempted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = supervisedFixture();
    const marker = repairMarker();
    const failed = f.observe(marker);
    await f.entered();
    f.release(new Error('unchanged private repair failure'));
    await failed.request.whenAttempted;
    failed.wait.end(f.log);
    await f.owner.whenIdle();

    // Inside the retry cooldown the next pass skips the marker; the waiter is released by the
    // attempt that follows the cooldown, not by the skip.
    const cooled = f.observe(marker);
    await f.owner.whenIdle();
    expect(f.repair).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await f.entered();
    f.release();
    await cooled.request.whenAttempted;
    cooled.wait.end(f.log);
    await f.owner.whenIdle();

    // A marker deleted from the durable queue before the next pass releases its waiter unattempted.
    const gone = f.observe(marker, { put: false });
    await gone.request.whenAttempted;
    gone.wait.end(f.log);

    expect(f.repair).toHaveBeenCalledTimes(2);
    expect(f.lines.map(fields)).toEqual([
      expect.objectContaining({ observerCall: '1', outcome: 'failed', cooldownSkips: '0' }),
      expect.objectContaining({ observerCall: '2', outcome: 'completed', cooldownSkips: '1' }),
      expect.objectContaining({ observerCall: '3', outcome: 'no-attempt', cooldownSkips: '0' }),
    ]);
  });
});

describe('finalized-private placement waiters', () => {
  function recordingObserver() {
    const heard: string[] = [];
    return {
      heard,
      observer: {
        cooldownSkipped: () => { heard.push('cooldown'); },
        released: (admission?: unknown) => { heard.push(admission === undefined ? 'released' : 'released-after-attempt'); },
      },
    };
  }

  it('tells each waiter\'s own observer about its cooldown skips and the attempt that released it', async () => {
    const waiters = new FinalizedPrivatePlacementWaitersV1();
    const first = recordingObserver();
    const other = recordingObserver();
    const firstWaiter = waiters.add('key-a', 1, first.observer);
    const unobserved = waiters.add('key-a', 2);
    const otherWaiter = waiters.add('key-b', 3, other.observer);
    waiters.cooldownSkipped('key-a');
    const admission = new CatalogPlacementTimingV1({ clock: () => 0 }).admit();
    waiters.release('key-a', admission);
    await Promise.all([firstWaiter.whenAttempted, unobserved.whenAttempted]);
    expect(first.heard).toEqual(['cooldown', 'released-after-attempt']);
    expect(other.heard).toEqual([]);
    expect([...waiters.keys()]).toEqual(['key-b']);
    // A key that left the queue, or a closing supervisor, releases without an attempt.
    waiters.releaseAll();
    await otherWaiter.whenAttempted;
    expect(other.heard).toEqual(['released']);
    expect(waiters.summary()).toEqual({ count: 0, oldestRequestedAt: undefined });
  });

  it('settles every waiter even when its observer throws', async () => {
    const waiters = new FinalizedPrivatePlacementWaitersV1();
    const throwing = {
      cooldownSkipped: () => { throw new Error('observer failed'); },
      released: () => { throw new Error('observer failed'); },
    };
    const waiter = waiters.add('key', 0, throwing);
    expect(() => waiters.cooldownSkipped('key')).not.toThrow();
    expect(() => waiters.release('key')).not.toThrow();
    await expect(waiter.whenAttempted).resolves.toBeUndefined();
  });

  it('counts unobserved waiters in the summary and forgets a withdrawn one', async () => {
    const waiters = new FinalizedPrivatePlacementWaitersV1();
    waiters.add('key', 50);
    const refused = waiters.add('key', 10);
    waiters.add('key', Number.NaN);
    expect(waiters.summary()).toEqual({ count: 3, oldestRequestedAt: 10 });
    refused.withdraw();
    await refused.whenAttempted;
    expect(waiters.summary()).toEqual({ count: 2, oldestRequestedAt: 50 });
  });
});
