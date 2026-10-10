/**
 * GH#3081 — the catalog placement timing: how one observer wait is split, that a waiter is bound to
 * exactly the attempt that released it (through the real finalized-private supervisor too), the
 * aggregate queue view, the bounds, and that a failure to observe never surfaces.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOperationContext,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type OperationContext,
} from '@origintrail-official/dkg-core';

import { Rfc64SwmCatalogProjectionOwnerV1 } from '../src/dkg-agent-rfc64-swm-catalog-projection-supervisor.js';
import {
  CATALOG_PLACEMENT_WAIT_LOG_THRESHOLD_MS,
  CatalogPlacementTimingV1,
  INERT_CATALOG_PLACEMENT_ATTEMPT_V1,
  catalogPlacementTimingV1,
  installCatalogPlacementTimingV1,
  shareCatalogPlacementTimingV1,
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

/** What the supervisor registers for one accepted request: its settle callback and its promise. */
function supervisorWaiter(timing: CatalogPlacementTimingV1) {
  const settle = () => {};
  const whenAttempted = Promise.resolve();
  timing.waiterAdded(settle, whenAttempted);
  return { settle, whenAttempted };
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
  it('splits an observer wait into request, queue and the phases of the attempt that released it', () => {
    const { timing, clock, lines, log } = harness();
    const repair = {};
    const wait = timing.beginWait(ASSET, createOperationContext('publishFromSWM', 'job-7'));
    clock.now = 1_200;
    const waiter = supervisorWaiter(timing);
    wait.requested(waiter.whenAttempted);
    clock.now = 31_200;
    const admission = timing.admit(repair);
    const attempt = timing.attemptFor(repair);
    const coverage = attempt.now();
    clock.now = 33_000;
    attempt.covered(false, coverage);
    const asset = attempt.now();
    clock.now = 33_500;
    attempt.phase('asset', asset);
    const state = attempt.now();
    clock.now = 36_000;
    attempt.phase('state', state);
    const successor = attempt.now();
    clock.now = 44_000;
    attempt.phase('successor', successor);
    const cas = attempt.now();
    clock.now = 44_010;
    attempt.phase('cas', cas);
    const announce = attempt.now();
    clock.now = 154_010;
    attempt.announced({
      announcedPeers: ['peer-a'],
      failedPeers: [{ code: DENIED }, { code: DENIED }, {}],
    }, announce);
    clock.now = 154_100;
    admission.end('completed');
    timing.waitersSettled([waiter.settle], admission);
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
    const repair = {};
    const ctx = createOperationContext('publishFromSWM');
    const first = timing.beginWait(ASSET, ctx);
    const firstWaiter = supervisorWaiter(timing);
    first.requested(firstWaiter.whenAttempted);
    const firstAttempt = timing.admit(repair);
    clock.now = 10;
    firstAttempt.end('completed');
    timing.waitersSettled([firstWaiter.settle], firstAttempt);
    first.end(log);

    clock.now = 20;
    const second = timing.beginWait(ASSET, ctx);
    const secondWaiter = supervisorWaiter(timing);
    second.requested(secondWaiter.whenAttempted);
    clock.now = 25;
    const secondAttempt = timing.admit(repair);
    clock.now = 28;
    secondAttempt.end('failed');
    timing.waitersSettled([secondWaiter.settle], secondAttempt);
    clock.now = 30;
    second.end(log);

    // A key that leaves the queue releases its waiter with no attempt to bind.
    const third = timing.beginWait(ASSET, ctx);
    const thirdWaiter = supervisorWaiter(timing);
    third.requested(thirdWaiter.whenAttempted);
    timing.waitersSettled([thirdWaiter.settle]);
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
    const admission = timing.admit({});
    clock.now = 100;
    const wait = timing.beginWait(ASSET, createOperationContext('publishFromSWM'));
    const waiter = supervisorWaiter(timing);
    wait.requested(waiter.whenAttempted);
    clock.now = 400;
    admission.end('failed');
    timing.waitersSettled([waiter.settle], admission);
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
    wait.requested(Promise.resolve());
    clock.now = 9;
    wait.end(log);
    expect(fields(lines[0]!.message)).toMatchObject({
      lane: 'finalized-private', outcome: 'no-attempt', totalMs: '9', requestMs: '3', cooldownSkips: '0',
    });
  });

  it('counts the cooldown skips a waiter waited through and writes nothing below the threshold', () => {
    const { timing, clock, lines, log } = harness(CATALOG_PLACEMENT_WAIT_LOG_THRESHOLD_MS);
    const earlier = supervisorWaiter(timing);
    timing.cooldownSkipped([earlier.settle]);
    const wait = timing.beginWait(ASSET, createOperationContext('publish'));
    const waiter = supervisorWaiter(timing);
    wait.requested(waiter.whenAttempted);
    timing.cooldownSkipped([earlier.settle, waiter.settle]);
    timing.cooldownSkipped(undefined);
    timing.cooldownSkipped([waiter.settle]);
    clock.now = CATALOG_PLACEMENT_WAIT_LOG_THRESHOLD_MS - 1;
    wait.end(log);
    expect(lines).toEqual([]);

    const slow = timing.beginWait(ASSET, createOperationContext('publish'));
    const slowWaiter = supervisorWaiter(timing);
    slow.requested(slowWaiter.whenAttempted);
    timing.cooldownSkipped([slowWaiter.settle]);
    clock.now += CATALOG_PLACEMENT_WAIT_LOG_THRESHOLD_MS;
    slow.end(log);
    expect(fields(lines[0]!.message)).toMatchObject({ cooldownSkips: '1', observerCall: '2' });
    // Every skipped marker counts once in the aggregate, waiters or not.
    expect(timing.queueStatus(new Map(), false).cooldownSkips).toBe(5);
  });

  it('counts policy denials from the transport\'s typed code, never from the failure text', () => {
    const { timing, lines, log } = harness();
    const repair = {};
    const wait = timing.beginWait(ASSET, createOperationContext('publish'));
    const waiter = supervisorWaiter(timing);
    wait.requested(waiter.whenAttempted);
    const admission = timing.admit(repair);
    const attempt = timing.attemptFor(repair);
    const failures = [
      { error: 'the peer refused this announcement', code: DENIED },
      { error: '[catalog-transport-policy-denied] text alone is display, not evidence' },
      { error: 'catalog-head announcement returned an invalid acknowledgement', code: 'catalog-transport-wire' as const },
    ];
    attempt.announced({ announcedPeers: [], failedPeers: failures }, attempt.now());
    admission.end('completed');
    timing.waitersSettled([waiter.settle], admission);
    wait.end(log);
    expect(fields(lines[0]!.message)).toMatchObject({ peers: '3', failedPeers: '3', deniedPeers: '1' });
  });

  it('charges the repair body only to the attempt in flight for the exact listed marker', () => {
    const { timing, clock, lines, log } = harness();
    const repair = { kaUal: ASSET.kaUal, assertionVersion: ASSET.assertionVersion };
    expect(timing.attemptFor(repair)).toBe(INERT_CATALOG_PLACEMENT_ATTEMPT_V1);
    const wait = timing.beginWait(ASSET, createOperationContext('publish'));
    const waiter = supervisorWaiter(timing);
    wait.requested(waiter.whenAttempted);
    const admission = timing.admit(repair);
    // A direct call with an equal but different marker is not the supervisor's attempt.
    expect(timing.attemptFor({ ...repair })).toBe(INERT_CATALOG_PLACEMENT_ATTEMPT_V1);
    const attempt = timing.attemptFor(repair);
    const startedAt = attempt.now();
    clock.now = 50;
    admission.end('completed');
    expect(timing.attemptFor(repair)).toBe(INERT_CATALOG_PLACEMENT_ATTEMPT_V1);
    attempt.covered(true, startedAt);
    timing.waitersSettled([waiter.settle], admission);
    wait.end(log);
    expect(fields(lines[0]!.message)).toMatchObject({ covered: 'true', coverageMs: '50', otherMs: '0' });
  });

  it('reports the finalized-private queue as aggregates of the waiters the supervisor holds', () => {
    const { timing, clock } = harness();
    expect(timing.queueStatus(new Map(), false)).toEqual({
      depth: 0, waiters: 0, oldestWaiterAgeMs: null, passRunning: false, lastPassDurationMs: null, cooldownSkips: 0,
    });
    timing.passStarted(3);
    const first = supervisorWaiter(timing);
    clock.now = 400;
    const second = supervisorWaiter(timing);
    const third = supervisorWaiter(timing);
    timing.cooldownSkipped([third.settle]);
    clock.now = 1_000;
    const waiters = new Map<string, ReadonlySet<object>>([
      ['key-a', new Set([first.settle, second.settle])],
      ['key-b', new Set([third.settle])],
    ]);
    expect(timing.queueStatus(waiters, true)).toEqual({
      depth: 3, waiters: 3, oldestWaiterAgeMs: 1_000, passRunning: true, lastPassDurationMs: null, cooldownSkips: 1,
    });
    clock.now = 1_250;
    timing.passEnded();
    timing.passEnded();
    expect(timing.queueStatus(new Map([['key-b', new Set([third.settle])]]), false)).toEqual({
      depth: 3, waiters: 1, oldestWaiterAgeMs: 850, passRunning: false, lastPassDurationMs: 1_250, cooldownSkips: 1,
    });
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

  it('never throws, whatever fails underneath it', () => {
    const timing = new CatalogPlacementTimingV1({
      clock: () => { throw new Error('clock failed'); },
      logThresholdMs: 0,
    });
    const throwingLog = { info: () => { throw new Error('log failed'); } };
    expect(() => {
      const wait = timing.beginWait(ASSET, createOperationContext('publish'));
      const settle = () => {};
      timing.waiterAdded(settle, Promise.resolve());
      wait.requested(null);
      const admission = timing.admit({});
      const attempt = timing.attemptFor({});
      attempt.phase('state', attempt.now());
      attempt.covered(false, attempt.now());
      attempt.announced({ announcedPeers: [], failedPeers: [] }, attempt.now());
      admission.end('failed');
      timing.cooldownSkipped([settle]);
      timing.waitersSettled([settle], admission);
      timing.waitersSettled(undefined);
      timing.passStarted(1);
      timing.passEnded();
      wait.end(throwingLog);
      expect(timing.queueStatus(new Map([['key', new Set([settle])]]), true)).toMatchObject({
        waiters: 0, oldestWaiterAgeMs: null, passRunning: true,
      });
    }).not.toThrow();

    const { timing: working, clock } = harness();
    const wait = working.beginWait(ASSET, createOperationContext('publish'));
    clock.now = 5;
    expect(() => wait.end(throwingLog)).not.toThrow();
  });

  it('resolves one timing per agent, shared with the aliases bound to it and replaceable', () => {
    const agent = {};
    const owner = {};
    const timing = catalogPlacementTimingV1(agent);
    expect(catalogPlacementTimingV1(agent)).toBe(timing);
    expect(catalogPlacementTimingV1(owner)).not.toBe(timing);
    shareCatalogPlacementTimingV1(owner, agent);
    expect(catalogPlacementTimingV1(owner)).toBe(timing);
    const injected = new CatalogPlacementTimingV1({ logThresholdMs: 0 });
    installCatalogPlacementTimingV1(agent, injected);
    expect(catalogPlacementTimingV1(agent)).toBe(injected);
    expect(catalogPlacementTimingV1(owner)).toBe(injected);
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
   * marker list stands in for the durable queue: an observation puts its marker, a successful
   * repair deletes it, a failed one leaves it for the retry.
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
    const repair = vi.fn(async (marker: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>) => {
      const attempt = timing.attemptFor(marker);
      const startedAt = attempt.now();
      const failure = await new Promise<Error | undefined>((resolve) => {
        releases.push(resolve);
        enter();
      });
      attempt.phase('successor', startedAt);
      armEntry();
      if (failure !== undefined) throw failure;
      markers = markers.filter((candidate) => candidate !== marker);
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
    } as never);
    owners.push(owner);
    installCatalogPlacementTimingV1(owner, timing);
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
        const request = owner.requestFinalizedPrivate({ repair: marker, ctx });
        wait.requested(request.whenAttempted);
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
