// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  RFC64_ANNOUNCED_HEAD_MAX_RETRY_DELAY_MS_V1,
  RFC64_ANNOUNCED_HEAD_QUIET_MS_V1,
  Rfc64AnnouncedHeadRetryScheduleV1,
  announcedCurrentHeadRetainCapacityErrorV1,
  compareCatalogVersionsV1,
  hintSettlesRetainedAnnouncedHeadV1,
  retainAnnouncedCurrentHeadTargetV1,
  type AnnouncedCurrentHeadTargetV1,
} from '../src/rfc64/announced-current-head-retry-v1.js';
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from '../src/rfc64/public-catalog-transport-v1.js';

function headAt(version: string, digestByte = 'aa'): Rfc64PublicCatalogHeadAnnouncementV1 {
  return {
    kind: 'rfc64-author-catalog-head-availability-v1',
    networkId: 'otp:20430',
    contextGraphId: '0x1111111111111111111111111111111111111111/retained',
    subGraphName: null,
    authorAddress: '0x2222222222222222222222222222222222222222',
    catalogEra: '0',
    catalogVersion: version,
    policyDigest: `0x${'71'.repeat(32)}`,
    catalogHeadObjectDigest: `0x${digestByte.repeat(32)}`,
    signatureVariantDigest: `0x${'bb'.repeat(32)}`,
  } as Rfc64PublicCatalogHeadAnnouncementV1;
}

function retainedTarget(
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  pullRequested = false,
): AnnouncedCurrentHeadTargetV1 {
  return {
    scope: {
      networkId: announcement.networkId,
      contextGraphId: announcement.contextGraphId,
      subGraphName: announcement.subGraphName,
      authorAddress: announcement.authorAddress,
      catalogEra: announcement.catalogEra,
    },
    remotePeerIds: new Set(['peer-a']),
    announcement,
    attempts: 1,
    retryAt: 0,
    pullRequested,
  };
}

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

describe('RFC-64 announced-head re-pull schedule', () => {
  it('doubles the delay after each unapplied pass, from the interval up to the cap', () => {
    const time = clock();
    const schedule = new Rfc64AnnouncedHeadRetryScheduleV1({ intervalMs: 5_000, now: time.now });

    const delays = [1, 2, 3, 4, 5, 6, 7, 40].map((attempts) => schedule.retryAt(attempts) - time.now());
    expect(delays).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000,
      RFC64_ANNOUNCED_HEAD_MAX_RETRY_DELAY_MS_V1,
      RFC64_ANNOUNCED_HEAD_MAX_RETRY_DELAY_MS_V1,
      RFC64_ANNOUNCED_HEAD_MAX_RETRY_DELAY_MS_V1,
    ]);
    // A target never pulled is due at once.
    expect(schedule.isDue(0)).toBe(true);
    const retryAt = schedule.retryAt(1);
    expect(schedule.isDue(retryAt)).toBe(false);
    time.advance(5_000);
    expect(schedule.isDue(retryAt)).toBe(true);
  });

  it('never caps the delay below the configured interval', () => {
    const time = clock();
    const schedule = new Rfc64AnnouncedHeadRetryScheduleV1({
      intervalMs: 300_000,
      now: time.now,
    });
    expect(schedule.retryAt(1) - time.now()).toBe(300_000);
    expect(schedule.retryAt(5) - time.now()).toBe(300_000);
  });

  it('keeps a head whose budget ran out quiet for the providers that were tried, and nothing else', () => {
    const time = clock();
    const schedule = new Rfc64AnnouncedHeadRetryScheduleV1({ intervalMs: 5_000, now: time.now });
    const spent = headAt('7');

    expect(schedule.isQuiet(spent, 'peer-a')).toBe(false);
    schedule.quiet(spent, new Set(['peer-a', 'peer-b']));
    expect(schedule.isQuiet(spent, 'peer-a')).toBe(true);
    expect(schedule.isQuiet(spent, 'peer-b')).toBe(true);
    // A provider the lane has not tried, an older or newer version, or another
    // head at the same version is not silenced: an announced version is not verified.
    expect(schedule.isQuiet(spent, 'peer-c')).toBe(false);
    expect(schedule.isQuiet(headAt('6'), 'peer-a')).toBe(false);
    expect(schedule.isQuiet(headAt('8'), 'peer-a')).toBe(false);
    expect(schedule.isQuiet(headAt('7', 'cc'), 'peer-a')).toBe(false);

    time.advance(RFC64_ANNOUNCED_HEAD_QUIET_MS_V1 - 1);
    expect(schedule.isQuiet(spent, 'peer-a')).toBe(true);
    time.advance(1);
    expect(schedule.isQuiet(spent, 'peer-a')).toBe(false);
    // The expired entry is gone.
    expect(schedule.quietHeads).toBe(0);
  });

  it('keeps the providers of an earlier spent budget quiet when another provider spends one', () => {
    const time = clock();
    const schedule = new Rfc64AnnouncedHeadRetryScheduleV1({ intervalMs: 5_000, now: time.now });
    const spent = headAt('7');

    schedule.quiet(spent, ['peer-a']);
    time.advance(60_000);
    schedule.quiet(spent, ['peer-b']);
    expect(schedule.isQuiet(spent, 'peer-a')).toBe(true);
    expect(schedule.isQuiet(spent, 'peer-b')).toBe(true);

    // Once the earlier quiet period has run out, it is not carried into a new one.
    time.advance(RFC64_ANNOUNCED_HEAD_QUIET_MS_V1);
    schedule.quiet(spent, ['peer-c']);
    expect(schedule.isQuiet(spent, 'peer-a')).toBe(false);
    expect(schedule.isQuiet(spent, 'peer-c')).toBe(true);
  });

  it('remembers a bounded number of quiet heads, forgetting the oldest first', () => {
    const time = clock();
    const schedule = new Rfc64AnnouncedHeadRetryScheduleV1({
      intervalMs: 5_000,
      quietMs: 60_000,
      now: time.now,
    });
    for (let index = 0; index < 1_024; index += 1) schedule.quiet(headAt(String(index + 1)), ['peer-a']);
    expect(schedule.quietHeads).toBe(1_024);

    // Quieting one again moves it to the newest place.
    schedule.quiet(headAt('1'), ['peer-a']);
    schedule.quiet(headAt('2000'), ['peer-a']);
    expect(schedule.quietHeads).toBe(1_024);
    expect(schedule.isQuiet(headAt('2'), 'peer-a')).toBe(false);
    expect(schedule.isQuiet(headAt('1'), 'peer-a')).toBe(true);
    expect(schedule.isQuiet(headAt('2000'), 'peer-a')).toBe(true);
  });

  it('defaults to the wall clock', () => {
    const schedule = new Rfc64AnnouncedHeadRetryScheduleV1({ intervalMs: 1_000 });
    const before = Date.now();
    const retryAt = schedule.retryAt(1);
    expect(retryAt).toBeGreaterThanOrEqual(before + 1_000);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 1_000);
  });
});

describe('RFC-64 announced-head target retention', () => {
  const limits = { maxScopes: 2, maxProviders: 3 };

  it('merges a pulled target into an older hint that came during the pass', () => {
    const fresh = retainedTarget(headAt('3'), true);
    fresh.attempts = 0;
    fresh.remotePeerIds.clear();
    fresh.remotePeerIds.add('peer-b');
    const targets = new Map([['scope', fresh]]);
    const pulled = { ...retainedTarget(headAt('4')), attempts: 2, retryAt: 9_000 };

    expect(retainAnnouncedCurrentHeadTargetV1(targets, 'scope', pulled, limits, () => {})).toBe(true);
    // The hint brought another provider, so it still asks for a pull now.
    expect(fresh).toMatchObject({ announcement: headAt('4'), attempts: 2, pullRequested: true, retryAt: 0 });
    expect([...fresh.remotePeerIds]).toEqual(['peer-b', 'peer-a']);
  });

  it('keeps the re-pull delay when the hint during the pass repeated what was pulled', () => {
    const repeat = retainedTarget(headAt('4'), true);
    repeat.attempts = 0;
    const targets = new Map([['scope', repeat]]);
    const pulled = { ...retainedTarget(headAt('4')), attempts: 1, retryAt: 9_000 };

    retainAnnouncedCurrentHeadTargetV1(targets, 'scope', pulled, limits, () => {});
    expect(repeat).toMatchObject({ attempts: 1, pullRequested: false, retryAt: 9_000 });
  });

  it('keeps a newer hint that came during the pass, with its own budget', () => {
    const newer = retainedTarget(headAt('5'), true);
    newer.attempts = 0;
    const targets = new Map([['scope', newer]]);
    retainAnnouncedCurrentHeadTargetV1(targets, 'scope', retainedTarget(headAt('4')), limits, () => {});
    expect(newer).toMatchObject({ announcement: headAt('5'), attempts: 0, pullRequested: true });
  });

  it('evicts the most-attempted retained target at the cap, never a fresh hint', () => {
    const fresh = { ...retainedTarget(headAt('1'), true), attempts: 0 };
    const old = { ...retainedTarget(headAt('1')), attempts: 3 };
    const targets = new Map([['fresh', fresh], ['old', old]]);
    const evicted: AnnouncedCurrentHeadTargetV1[] = [];

    expect(retainAnnouncedCurrentHeadTargetV1(
      targets, 'pulled', { ...retainedTarget(headAt('1')), attempts: 1 }, limits, (victim) => evicted.push(victim),
    )).toBe(true);
    expect(evicted).toEqual([old]);
    expect([...targets.keys()]).toEqual(['fresh', 'pulled']);

    // Nothing retained has more attempts than this one: it is the one that yields.
    expect(retainAnnouncedCurrentHeadTargetV1(
      targets, 'another', { ...retainedTarget(headAt('1')), attempts: 1 }, limits, (victim) => evicted.push(victim),
    )).toBe(false);
    expect(evicted).toEqual([old]);
  });
});

describe('RFC-64 announced-head helpers', () => {
  it('lets a satisfied hint settle a retained target it supersedes or names exactly', () => {
    const target = retainedTarget(headAt('4'));
    expect(hintSettlesRetainedAnnouncedHeadV1(target, headAt('5', 'cc'))).toBe(true);
    expect(hintSettlesRetainedAnnouncedHeadV1(target, headAt('4'))).toBe(true);
    // An equal version with another digest is a conflict, and an older one proves nothing.
    expect(hintSettlesRetainedAnnouncedHeadV1(target, headAt('4', 'cc'))).toBe(false);
    expect(hintSettlesRetainedAnnouncedHeadV1(target, headAt('3'))).toBe(false);
    // A target a hint asked a pull for keeps the full path.
    expect(hintSettlesRetainedAnnouncedHeadV1(retainedTarget(headAt('4'), true), headAt('5'))).toBe(false);
  });

  it('orders decimal catalog versions numerically', () => {
    expect(compareCatalogVersionsV1('9', '10')).toBe(-1);
    expect(compareCatalogVersionsV1('10', '10')).toBe(0);
    expect(compareCatalogVersionsV1('11', '10')).toBe(1);
  });

  it('names the capacity drop and keeps its cause', () => {
    const cause = new Error('provider unreachable');
    expect(announcedCurrentHeadRetainCapacityErrorV1(cause).cause).toBe(cause);
    expect(announcedCurrentHeadRetainCapacityErrorV1(null)).not.toHaveProperty('cause');
  });
});
