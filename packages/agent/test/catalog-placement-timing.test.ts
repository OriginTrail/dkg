/**
 * GH#3081 — the catalog placement timing in isolation: how one observer wait is split, which
 * attempt it is charged to, the aggregate queue view, the bounds, and that a failure to observe
 * never surfaces.
 */
import { describe, expect, it } from 'vitest';
import { createOperationContext, type OperationContext } from '@origintrail-official/dkg-core';

import {
  CATALOG_PLACEMENT_WAIT_LOG_THRESHOLD_MS,
  CatalogPlacementTimingV1,
  INERT_CATALOG_PLACEMENT_ATTEMPT_V1,
  catalogPlacementTimingV1,
  installCatalogPlacementTimingV1,
  shareCatalogPlacementTimingV1,
} from '../src/internal/catalog-placement-timing.js';

const ASSET = Object.freeze({ kaUal: 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/7', assertionVersion: '3' });
const OTHER = Object.freeze({ kaUal: `${ASSET.kaUal}0`, assertionVersion: '1' });
const DENIED = '[catalog-transport-policy-denied] catalog operation is not access-policy authorized';

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
  it('splits an observer wait into request, queue and the phases of the attempt that settled it', () => {
    const { timing, clock, lines, log } = harness();
    const wait = timing.beginWait(ASSET, createOperationContext('publishFromSWM', 'job-7'));
    clock.now = 1_200;
    wait.requested();
    clock.now = 31_200;
    const admission = timing.admit(ASSET);
    const attempt = timing.attemptFor(ASSET);
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
      failedPeers: [{ error: DENIED }, { error: DENIED }, { error: 'timeout' }],
    }, announce);
    clock.now = 154_100;
    admission.end('completed');
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

  it('counts observer calls per asset and does not charge an earlier call\'s attempt to a later wait', () => {
    const { timing, clock, lines, log } = harness();
    const ctx = createOperationContext('publishFromSWM');
    const first = timing.beginWait(ASSET, ctx);
    first.requested();
    const admission = timing.admit(ASSET);
    clock.now = 10;
    admission.end('completed');
    first.end(log);

    clock.now = 20;
    const second = timing.beginWait(ASSET, ctx);
    second.requested();
    clock.now = 30;
    second.end(log);

    expect(fields(lines[0]!.message)).toMatchObject({ observerCall: '1', outcome: 'completed', source: '-' });
    expect(fields(lines[1]!.message)).toMatchObject({
      observerCall: '2', outcome: 'no-attempt', queueMs: '-', attemptMs: '-', coverageMs: '-', covered: '-',
    });
  });

  it('charges a waiter that joined an attempt already in flight from its own request onward', () => {
    const { timing, clock, lines, log } = harness();
    const admission = timing.admit(ASSET);
    clock.now = 100;
    const wait = timing.beginWait(ASSET, createOperationContext('publishFromSWM'));
    wait.requested();
    clock.now = 400;
    admission.end('failed');
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

  it('counts cooldown skips during the wait and writes nothing below the threshold', () => {
    const { timing, clock, lines, log } = harness(CATALOG_PLACEMENT_WAIT_LOG_THRESHOLD_MS);
    timing.cooldownSkipped(ASSET);
    const wait = timing.beginWait(ASSET, createOperationContext('publish'));
    wait.requested();
    timing.cooldownSkipped(ASSET);
    timing.cooldownSkipped(OTHER);
    timing.cooldownSkipped(ASSET);
    clock.now = CATALOG_PLACEMENT_WAIT_LOG_THRESHOLD_MS - 1;
    wait.end(log);
    expect(lines).toEqual([]);

    const slow = timing.beginWait(ASSET, createOperationContext('publish'));
    slow.requested();
    timing.cooldownSkipped(ASSET);
    clock.now += CATALOG_PLACEMENT_WAIT_LOG_THRESHOLD_MS;
    slow.end(log);
    expect(fields(lines[0]!.message)).toMatchObject({ cooldownSkips: '1', observerCall: '2' });
  });

  it('charges the repair body only to the attempt in flight for its own asset', () => {
    const { timing, clock, lines, log } = harness();
    expect(timing.attemptFor(ASSET)).toBe(INERT_CATALOG_PLACEMENT_ATTEMPT_V1);
    const wait = timing.beginWait(ASSET, createOperationContext('publish'));
    wait.requested();
    const admission = timing.admit(ASSET);
    expect(timing.attemptFor(OTHER)).toBe(INERT_CATALOG_PLACEMENT_ATTEMPT_V1);
    const attempt = timing.attemptFor(ASSET);
    const startedAt = attempt.now();
    clock.now = 50;
    admission.end('completed');
    expect(timing.attemptFor(ASSET)).toBe(INERT_CATALOG_PLACEMENT_ATTEMPT_V1);
    attempt.covered(true, startedAt);
    wait.end(log);
    expect(fields(lines[0]!.message)).toMatchObject({ covered: 'true', coverageMs: '50', otherMs: '0' });
  });

  it('reports the finalized-private queue as aggregates of the waiters the supervisor holds', () => {
    const { timing, clock } = harness();
    expect(timing.queueStatus(new Map(), false)).toEqual({
      depth: 0, waiters: 0, oldestWaiterAgeMs: null, passRunning: false, lastPassDurationMs: null, cooldownSkips: 0,
    });
    timing.passStarted(3);
    timing.waiterAdded('key-a', true);
    clock.now = 400;
    timing.waiterAdded('key-a', false);
    timing.waiterAdded('key-b', true);
    timing.cooldownSkipped(ASSET);
    clock.now = 1_000;
    const waiters = new Map<string, ReadonlySet<unknown>>([
      ['key-a', new Set([1, 2])],
      ['key-b', new Set([3])],
    ]);
    expect(timing.queueStatus(waiters, true)).toEqual({
      depth: 3, waiters: 3, oldestWaiterAgeMs: 1_000, passRunning: true, lastPassDurationMs: null, cooldownSkips: 1,
    });
    clock.now = 1_250;
    timing.passEnded();
    timing.passEnded();
    timing.waitersSettled('key-a');
    expect(timing.queueStatus(new Map([['key-b', new Set([3])]]), false)).toEqual({
      depth: 3, waiters: 1, oldestWaiterAgeMs: 850, passRunning: false, lastPassDurationMs: 1_250, cooldownSkips: 1,
    });
    // A key whose waiters reopened after a restart starts a new wait.
    timing.waiterAdded('key-b', true);
    expect(timing.queueStatus(new Map([['key-b', new Set([4])]]), false).oldestWaiterAgeMs).toBe(0);
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
      wait.requested();
      const admission = timing.admit(ASSET);
      const attempt = timing.attemptFor(ASSET);
      attempt.phase('state', attempt.now());
      attempt.covered(false, attempt.now());
      attempt.announced({ announcedPeers: [], failedPeers: [] }, attempt.now());
      admission.end('failed');
      timing.cooldownSkipped(ASSET);
      timing.waiterAdded('key', true);
      timing.waitersSettled('key');
      timing.passStarted(1);
      timing.passEnded();
      wait.end(throwingLog);
      expect(timing.queueStatus(new Map([['key', new Set([1])]]), true)).toMatchObject({
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
