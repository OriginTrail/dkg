// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RpcRequestGovernor,
  RpcRequestGovernorQueueFullError,
  resolveRpcRequestGovernorPolicy,
} from '../src/rpc-request-governor.js';
import { withRpcRequestContext } from '../src/rpc-request-transport.js';

afterEach(() => {
  vi.useRealTimers();
});

/** An authority read issued by background work, as the transport presents it. */
function acquireBackgroundAuthority(
  governor: RpcRequestGovernor,
  signal?: AbortSignal,
): Promise<void> {
  return withRpcRequestContext(
    { requestClass: 'background', admissionPriority: 'authority', ...(signal ? { signal } : {}) },
    () => governor.acquireActiveRequest(),
  );
}

describe('RpcRequestGovernor', () => {
  it('resolves the default 20-request burst to exactly four background admissions', async () => {
    const governor = new RpcRequestGovernor({ startupJitterMs: 0 });
    for (let index = 0; index < 4; index += 1) {
      await expect(governor.acquireImmediately('background')).resolves.toBeUndefined();
    }
    await expect(governor.acquireImmediately('background')).rejects.toBeInstanceOf(
      RpcRequestGovernorQueueFullError,
    );
    expect(governor.snapshot()).toMatchObject({
      backgroundAdmitted: 4,
    });
    expect(governor.snapshot().backgroundAvailableTokens).toBeLessThan(1);
  });

  it('paces background requests with the reserved-capacity bucket', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 2,
      foregroundReservePercent: 50,
      burstRequests: 2,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });

    await governor.acquire('background');
    let admitted = false;
    const pending = governor.acquire('background').then(() => { admitted = true; });
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(governor.snapshot().backgroundQueued).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(admitted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(admitted).toBe(true);
    expect(governor.snapshot()).toMatchObject({
      backgroundAdmitted: 2,
      backgroundDeferred: 1,
      backgroundQueued: 0,
    });
  });

  it('lets newly queued foreground work jump background work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 1,
      foregroundReservePercent: 50,
      burstRequests: 1,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });

    await governor.acquire('background');
    const order: string[] = [];
    const background = governor.acquire('background').then(() => { order.push('background'); });
    const foreground = governor.acquire('foreground').then(() => { order.push('foreground'); });

    await vi.advanceTimersByTimeAsync(1_000);
    await foreground;
    expect(order).toEqual(['foreground']);
    expect(governor.snapshot().backgroundQueued).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await background;
    expect(order).toEqual(['foreground', 'background']);
  });

  it('admits an authority gate at the head of a saturated ordinary foreground queue', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 1,
      foregroundReservePercent: 80,
      burstRequests: 1,
      maxQueueSize: 2,
      startupJitterMs: 0,
    });

    await governor.acquire('foreground');
    const order: string[] = [];
    const ordinaryA = governor.acquire('foreground').then(() => { order.push('ordinary-a'); });
    const ordinaryB = governor.acquire('foreground').then(() => { order.push('ordinary-b'); });
    const authorities = Array.from({ length: 4 }, (_, index) => (
      withRpcRequestContext(
        { admissionPriority: 'authority' },
        () => governor.acquireActiveRequest(),
      ).then(() => { order.push(`authority-${index}`); })
    ));
    await expect(withRpcRequestContext(
      { admissionPriority: 'authority' },
      () => governor.acquireActiveRequest(),
    )).rejects.toBeInstanceOf(RpcRequestGovernorQueueFullError);

    expect(governor.snapshot()).toMatchObject({ foregroundQueued: 6 });
    await vi.advanceTimersByTimeAsync(4_000);
    await Promise.all(authorities);
    expect(order).toEqual([
      'authority-0',
      'authority-1',
      'authority-2',
      'authority-3',
    ]);

    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all([ordinaryA, ordinaryB]);
    expect(order).toEqual([
      'authority-0',
      'authority-1',
      'authority-2',
      'authority-3',
      'ordinary-a',
      'ordinary-b',
    ]);
  });

  it('does not hold a background authority read for the start-up delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 2,
      foregroundReservePercent: 50,
      burstRequests: 2,
      maxQueueSize: 8,
      startupJitterMs: 30_000,
    }, {
      clock: {
        now: () => Date.now(),
        random: () => 0.5,
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: (timer) => clearTimeout(timer),
      },
    });

    let ordinaryAdmitted = false;
    const ordinary = governor.acquire('background').then(() => { ordinaryAdmitted = true; });
    // Ordinary work waits out the delay; the authority read passes it at once.
    await expect(acquireBackgroundAuthority(governor)).resolves.toBeUndefined();
    expect(ordinaryAdmitted).toBe(false);
    expect(governor.snapshot()).toMatchObject({
      backgroundAdmitted: 1,
      backgroundQueued: 1,
      startupDelayRemainingMs: 15_000,
    });

    // The background bucket is now empty, so the next authority read queues.
    // It is paced by that bucket (one permit a second here), not by the
    // wake-up already set for the ordinary waiter at the end of the delay.
    let secondAdmitted = false;
    const second = acquireBackgroundAuthority(governor).then(() => { secondAdmitted = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(secondAdmitted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(ordinaryAdmitted).toBe(false);
    expect(governor.snapshot()).toMatchObject({
      backgroundAdmitted: 2,
      backgroundQueued: 1,
      startupDelayRemainingMs: 14_000,
    });

    await vi.advanceTimersByTimeAsync(13_999);
    expect(ordinaryAdmitted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await ordinary;
    expect(governor.snapshot()).toMatchObject({
      backgroundAdmitted: 3,
      backgroundQueued: 0,
      startupDelayRemainingMs: 0,
    });
  });

  it('admits a background authority read ahead of ordinary background work that queued first', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 2,
      foregroundReservePercent: 50,
      burstRequests: 2,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });

    await governor.acquire('background');
    const order: string[] = [];
    const ordinaryA = governor.acquire('background').then(() => { order.push('ordinary-a'); });
    const ordinaryB = governor.acquire('background').then(() => { order.push('ordinary-b'); });
    const authority = acquireBackgroundAuthority(governor).then(() => { order.push('authority'); });
    expect(governor.snapshot()).toMatchObject({ backgroundQueued: 3, backgroundDeferred: 3 });

    await vi.advanceTimersByTimeAsync(1_000);
    await authority;
    expect(order).toEqual(['authority']);

    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all([ordinaryA, ordinaryB]);
    expect(order).toEqual(['authority', 'ordinary-a', 'ordinary-b']);
  });

  it('keeps a background authority read inside the background budget and behind foreground work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 1,
      foregroundReservePercent: 50,
      burstRequests: 1,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });

    await governor.acquire('background');
    const order: string[] = [];
    const authority = acquireBackgroundAuthority(governor).then(() => { order.push('authority'); });
    const foreground = governor.acquire('foreground').then(() => { order.push('foreground'); });

    await vi.advanceTimersByTimeAsync(1_000);
    await foreground;
    expect(order).toEqual(['foreground']);
    expect(governor.snapshot()).toMatchObject({ backgroundQueued: 1, foregroundAdmitted: 1 });

    await vi.advanceTimersByTimeAsync(1_000);
    await authority;
    expect(order).toEqual(['foreground', 'authority']);
    expect(governor.snapshot()).toMatchObject({ backgroundAdmitted: 2, backgroundQueued: 0 });
  });

  it('does not hand a background authority read the permit a queued foreground request is waiting for', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 1,
      foregroundReservePercent: 50,
      burstRequests: 1,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });

    await governor.acquire('foreground');
    const order: string[] = [];
    const foreground = governor.acquire('foreground').then(() => { order.push('foreground'); });
    // The permit is back, but the foreground waiter's wake-up has not run yet.
    vi.setSystemTime(1_000);
    const authority = acquireBackgroundAuthority(governor).then(() => { order.push('authority'); });

    await vi.advanceTimersByTimeAsync(1);
    await foreground;
    expect(order).toEqual(['foreground']);
    expect(governor.snapshot()).toMatchObject({ foregroundQueued: 0, backgroundQueued: 1 });

    await vi.advanceTimersByTimeAsync(1_000);
    await authority;
    expect(order).toEqual(['foreground', 'authority']);
  });

  it('lets at most four authority reads in a row pass ordinary background work that has waited', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 2,
      foregroundReservePercent: 50,
      burstRequests: 2,
      maxQueueSize: 16,
      startupJitterMs: 0,
    });

    await governor.acquire('background');
    const order: string[] = [];
    const ordinary = [1, 2].map((index) => (
      governor.acquire('background').then(() => { order.push(`ordinary-${index}`); })
    ));
    const authorities = [1, 2, 3, 4, 5, 6].map((index) => (
      acquireBackgroundAuthority(governor).then(() => { order.push(`authority-${index}`); })
    ));

    // One background permit a second. From the first one on, the ordinary
    // waiters have waited the fairness grace period.
    await vi.advanceTimersByTimeAsync(8_000);
    await Promise.all([...ordinary, ...authorities]);
    expect(order).toEqual([
      'authority-1',
      'authority-2',
      'authority-3',
      'authority-4',
      'ordinary-1',
      'authority-5',
      'authority-6',
      'ordinary-2',
    ]);
  });

  it('gives a background authority read that has waited its turn past foreground demand', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 10,
      foregroundReservePercent: 80,
      burstRequests: 1,
      maxQueueSize: 1_000,
      startupJitterMs: 0,
    });

    // Foreground demand that outlasts the test: every permit has a taker.
    const foreground = Array.from({ length: 60 }, () => governor.acquire('foreground'));
    let admittedAt: number | undefined;
    const authority = acquireBackgroundAuthority(governor).then(() => { admittedAt = Date.now(); });

    // It yields to foreground work like any background request ...
    await vi.advanceTimersByTimeAsync(999);
    expect(admittedAt).toBeUndefined();
    // ... and like any background request it is not postponed past the
    // fairness grace period.
    await vi.advanceTimersByTimeAsync(1);
    expect(admittedAt).toBe(1_000);

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([...foreground, authority]);
  });

  it('gives waited ordinary background work its turn past foreground demand, however young the authority reads ahead of it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 10,
      foregroundReservePercent: 80,
      burstRequests: 1,
      maxQueueSize: 1_000,
      startupJitterMs: 0,
    });

    // Foreground demand that outlasts the test: every permit has a taker.
    const foreground = Array.from({ length: 150 }, () => governor.acquire('foreground'));
    const order: string[] = [];
    const ordinary = governor.acquire('background').then(() => { order.push('ordinary'); });

    // An authority read every 250 ms, each given up after 500 ms. The one at
    // the front of the background queue is never as old as the grace period.
    const authorities: Promise<unknown>[] = [];
    for (let elapsed = 0; elapsed < 5_000; elapsed += 250) {
      const controller = new AbortController();
      authorities.push(
        acquireBackgroundAuthority(governor, controller.signal)
          .then(() => { order.push('authority'); }, () => undefined),
      );
      setTimeout(() => controller.abort(new Error('authority read gave up')), 500);
      await vi.advanceTimersByTimeAsync(250);
    }

    // The ordinary waiter has waited the grace period since the first second.
    // From then on the class takes its turn past the foreground queue: four
    // authority reads, then the ordinary request.
    expect(order.slice(0, 5)).toEqual([
      'authority', 'authority', 'authority', 'authority', 'ordinary',
    ]);

    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all([...foreground, ordinary, ...authorities]);
  });

  it('does not count authority reads that pass ordinary background work which has only just queued', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 10,
      foregroundReservePercent: 50,
      burstRequests: 2,
      maxQueueSize: 16,
      startupJitterMs: 0,
    });

    // Five background permits a second, one in the bucket.
    await acquireBackgroundAuthority(governor);
    const order: string[] = [];
    const ordinary = governor.acquire('background').then(() => { order.push('ordinary'); });
    const authorities = [1, 2, 3, 4, 5, 6].map((index) => (
      acquireBackgroundAuthority(governor).then(() => { order.push(`authority-${index}`); })
    ));
    await vi.advanceTimersByTimeAsync(1_400);
    await Promise.all([ordinary, ...authorities]);
    // More than four in a row: the ordinary waiter reached the grace period
    // only at the fifth permit, so nothing before that counted against it.
    expect(order).toEqual([
      'authority-1',
      'authority-2',
      'authority-3',
      'authority-4',
      'authority-5',
      'authority-6',
      'ordinary',
    ]);
  });

  it('lets a bounded number of background authority reads into a full background queue', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 1,
      foregroundReservePercent: 50,
      burstRequests: 1,
      maxQueueSize: 2,
      startupJitterMs: 0,
    });
    await governor.acquire('background');

    const controller = new AbortController();
    const ordinary = governor.acquire('background', controller.signal);
    await expect(governor.acquire('background')).rejects.toBeInstanceOf(
      RpcRequestGovernorQueueFullError,
    );
    const authorities = Array.from(
      { length: 4 },
      () => acquireBackgroundAuthority(governor, controller.signal),
    );
    await expect(acquireBackgroundAuthority(governor)).rejects.toBeInstanceOf(
      RpcRequestGovernorQueueFullError,
    );
    expect(governor.snapshot()).toMatchObject({
      backgroundQueued: 5,
      rejected: 2,
    });

    controller.abort(new Error('test cleanup'));
    await Promise.all([ordinary, ...authorities].map(
      (pending) => expect(pending).rejects.toThrow('test cleanup'),
    ));
  });

  it('keeps the queue slots reserved for foreground work when background authority reads wait in the reserve', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 1,
      foregroundReservePercent: 50,
      burstRequests: 1,
      maxQueueSize: 2,
      startupJitterMs: 0,
    });
    await governor.acquire('foreground');

    // The background share of the queue is one slot. The ordinary request
    // takes it, so the authority read waits in the reserve.
    const controller = new AbortController();
    const ordinaryBackground = governor.acquire('background', controller.signal);
    const authority = acquireBackgroundAuthority(governor, controller.signal);

    // The slot kept for foreground work is still there for it ...
    const foreground = governor.acquire('foreground', controller.signal);
    expect(governor.snapshot()).toMatchObject({
      foregroundQueued: 1,
      backgroundQueued: 2,
      rejected: 0,
    });
    // ... and the queue's ordinary slots are bounded as before.
    await expect(governor.acquire('foreground')).rejects.toBeInstanceOf(
      RpcRequestGovernorQueueFullError,
    );

    controller.abort(new Error('test cleanup'));
    await Promise.all([ordinaryBackground, authority, foreground].map(
      (pending) => expect(pending).rejects.toThrow('test cleanup'),
    ));
  });

  it('gives a reserve slot back when the authority read that held it leaves the queue, and nothing else', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 1,
      foregroundReservePercent: 50,
      burstRequests: 1,
      maxQueueSize: 2,
      startupJitterMs: 0,
    });
    const queueFull = (pending: Promise<void>) => (
      expect(pending).rejects.toBeInstanceOf(RpcRequestGovernorQueueFullError)
    );
    await governor.acquire('background');
    // The background share of the queue is one slot, and this request has it.
    const ordinary = governor.acquire('background');

    // Four reads fill the reserve.
    const leaving = new AbortController();
    const admitted = [acquireBackgroundAuthority(governor), acquireBackgroundAuthority(governor)];
    const givenUp = [
      acquireBackgroundAuthority(governor, leaving.signal),
      acquireBackgroundAuthority(governor, leaving.signal),
    ];
    await queueFull(acquireBackgroundAuthority(governor));

    // Two give up and two are admitted (one background permit in two seconds).
    leaving.abort(new Error('authority read gave up'));
    await Promise.all(givenUp.map(
      (pending) => expect(pending).rejects.toThrow('authority read gave up'),
    ));
    await vi.advanceTimersByTimeAsync(4_000);
    await Promise.all(admitted);

    // The reserve is empty. That frees no ordinary slot: the background
    // share is still taken ...
    await queueFull(governor.acquire('background'));
    // ... and the reserve holds four reads again, no more.
    const again = Array.from({ length: 4 }, () => acquireBackgroundAuthority(governor));
    await queueFull(acquireBackgroundAuthority(governor));

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all([ordinary, ...again]);

    // An ordinary request that leaves gives back its own slot and no other:
    // the share is one slot, as at the start.
    await governor.acquire('background');
    const next = governor.acquire('background');
    await queueFull(governor.acquire('background'));
    await vi.advanceTimersByTimeAsync(5_000);
    await next;
  });

  it('eventually admits aged background work during sustained foreground demand', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 2,
      foregroundReservePercent: 50,
      burstRequests: 2,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });

    await governor.acquire('background');
    await governor.acquire('foreground');
    const order: string[] = [];
    const background = governor.acquire('background').then(() => { order.push('background'); });
    const foregroundA = governor.acquire('foreground').then(() => { order.push('foreground-a'); });
    const foregroundB = governor.acquire('foreground').then(() => { order.push('foreground-b'); });

    await vi.advanceTimersByTimeAsync(500);
    await foregroundA;
    expect(order).toEqual(['foreground-a']);
    expect(governor.snapshot()).toMatchObject({
      foregroundQueued: 1,
      backgroundQueued: 1,
    });

    await vi.advanceTimersByTimeAsync(500);
    await background;
    expect(order).toEqual(['foreground-a', 'background']);
    expect(governor.snapshot()).toMatchObject({
      foregroundQueued: 1,
      backgroundQueued: 0,
    });

    await vi.advanceTimersByTimeAsync(500);
    await foregroundB;
    expect(order).toEqual(['foreground-a', 'background', 'foreground-b']);
  });

  it('rejects optional immediate background work without consuming the foreground reserve', async () => {
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 100,
      foregroundReservePercent: 80,
      burstRequests: 5,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });

    await governor.acquireImmediately('background');
    await expect(governor.acquireImmediately('background')).rejects.toBeInstanceOf(
      RpcRequestGovernorQueueFullError,
    );
    await expect(governor.acquireImmediately('foreground')).resolves.toBeUndefined();
    expect(governor.snapshot()).toMatchObject({
      foregroundAdmitted: 1,
      backgroundAdmitted: 1,
      foregroundQueued: 0,
      backgroundQueued: 0,
      rejected: 1,
    });
  });

  it('lets diagnostics bypass startup jitter but never jump queued background work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 100,
      foregroundReservePercent: 80,
      burstRequests: 5,
      maxQueueSize: 8,
      startupJitterMs: 30_000,
    }, {
      clock: {
        now: () => Date.now(),
        random: () => 1,
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: (timer) => clearTimeout(timer),
      },
    });

    const controller = new AbortController();
    const queued = governor.acquire('background', controller.signal);
    await expect(governor.acquireImmediately('background')).rejects.toBeInstanceOf(
      RpcRequestGovernorQueueFullError,
    );
    // Health traffic is optional: even though it may skip startup jitter, it
    // cannot consume the token ahead of an already-queued workload.
    await expect(governor.acquireDiagnosticRequestImmediately()).rejects.toBeInstanceOf(
      RpcRequestGovernorQueueFullError,
    );
    await expect(governor.acquireImmediately('foreground')).resolves.toBeUndefined();
    controller.abort(new Error('test cleanup'));
    await expect(queued).rejects.toThrow('test cleanup');
    await expect(governor.acquireDiagnosticRequestImmediately()).resolves.toBeUndefined();
    expect(governor.snapshot()).toMatchObject({
      backgroundAdmitted: 1,
      foregroundAdmitted: 1,
      backgroundQueued: 0,
      startupDelayRemainingMs: 30_000,
      cancelled: 1,
      rejected: 2,
    });
  });

  it('bounds the queue and removes a cancelled waiter', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 1,
      foregroundReservePercent: 50,
      burstRequests: 1,
      maxQueueSize: 2,
      startupJitterMs: 0,
    });
    await governor.acquire('background');
    const controller = new AbortController();
    const queued = governor.acquire('background', controller.signal);

    await expect(governor.acquire('background')).rejects.toBeInstanceOf(
      RpcRequestGovernorQueueFullError,
    );
    controller.abort(new Error('shutdown'));
    await expect(queued).rejects.toThrow('shutdown');
    expect(governor.snapshot()).toMatchObject({
      backgroundQueued: 0,
      rejected: 1,
      cancelled: 1,
    });
  });

  it('reserves queue admission so background saturation cannot reject foreground work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 1,
      foregroundReservePercent: 50,
      burstRequests: 1,
      maxQueueSize: 2,
      startupJitterMs: 0,
    });
    await governor.acquire('background');
    const order: string[] = [];
    const background = governor.acquire('background').then(() => { order.push('background'); });
    await expect(governor.acquire('background')).rejects.toBeInstanceOf(
      RpcRequestGovernorQueueFullError,
    );

    const foreground = governor.acquire('foreground').then(() => { order.push('foreground'); });
    await Promise.resolve();
    expect(order).toEqual([]);
    expect(governor.snapshot()).toMatchObject({
      foregroundQueued: 1,
      backgroundQueued: 1,
      rejected: 1,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await foreground;
    expect(order).toEqual(['foreground']);
    expect(governor.snapshot().backgroundQueued).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await background;
    expect(order).toEqual(['foreground', 'background']);
  });

  it('rounds a fractional foreground queue reserve up to one protected slot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 1,
      foregroundReservePercent: 1,
      burstRequests: 1,
      maxQueueSize: 2,
      startupJitterMs: 0,
    });
    await governor.acquire('background');

    const controller = new AbortController();
    const background = governor.acquire('background', controller.signal);
    await expect(governor.acquire('background')).rejects.toBeInstanceOf(
      RpcRequestGovernorQueueFullError,
    );
    const foreground = governor.acquire('foreground', controller.signal);

    expect(governor.snapshot()).toMatchObject({
      foregroundQueued: 1,
      backgroundQueued: 1,
      rejected: 1,
    });

    controller.abort(new Error('test cleanup'));
    await expect(background).rejects.toThrow('test cleanup');
    await expect(foreground).rejects.toThrow('test cleanup');
  });

  it('keeps the foreground queue slot reserved when another foreground request is already queued', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 1,
      foregroundReservePercent: 50,
      burstRequests: 1,
      maxQueueSize: 2,
      startupJitterMs: 0,
    });
    await governor.acquire('background');
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstForeground = governor.acquire('foreground', firstController.signal);

    await expect(governor.acquire('background')).rejects.toBeInstanceOf(
      RpcRequestGovernorQueueFullError,
    );
    const secondForeground = governor.acquire('foreground', secondController.signal);
    expect(governor.snapshot()).toMatchObject({
      foregroundQueued: 2,
      backgroundQueued: 0,
      rejected: 1,
    });

    firstController.abort(new Error('test cleanup'));
    secondController.abort(new Error('test cleanup'));
    await expect(firstForeground).rejects.toThrow('test cleanup');
    await expect(secondForeground).rejects.toThrow('test cleanup');
  });

  it('reserves the configured foreground percentage of queue admission', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 1,
      foregroundReservePercent: 70,
      burstRequests: 1,
      maxQueueSize: 10,
      startupJitterMs: 0,
    });
    await governor.acquire('background');

    const controller = new AbortController();
    const background = Array.from(
      { length: 3 },
      () => governor.acquire('background', controller.signal),
    );
    await expect(governor.acquire('background')).rejects.toBeInstanceOf(
      RpcRequestGovernorQueueFullError,
    );

    const foreground = Array.from(
      { length: 7 },
      () => governor.acquire('foreground', controller.signal),
    );
    await expect(governor.acquire('foreground')).rejects.toBeInstanceOf(
      RpcRequestGovernorQueueFullError,
    );
    expect(governor.snapshot()).toMatchObject({
      foregroundQueued: 7,
      backgroundQueued: 3,
      rejected: 2,
    });

    controller.abort(new Error('test cleanup'));
    await Promise.all([
      ...background.map((pending) => expect(pending).rejects.toThrow('test cleanup')),
      ...foreground.map((pending) => expect(pending).rejects.toThrow('test cleanup')),
    ]);
  });

  it('does not reserve queue slots when foreground reserve is zero', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 1,
      foregroundReservePercent: 0,
      burstRequests: 1,
      maxQueueSize: 2,
      startupJitterMs: 0,
    });
    await governor.acquire('background');

    const controller = new AbortController();
    const first = governor.acquire('background', controller.signal);
    const second = governor.acquire('background', controller.signal);
    await expect(governor.acquire('background')).rejects.toBeInstanceOf(
      RpcRequestGovernorQueueFullError,
    );
    expect(governor.snapshot()).toMatchObject({
      foregroundQueued: 0,
      backgroundQueued: 2,
      rejected: 1,
    });

    controller.abort(new Error('test cleanup'));
    await expect(first).rejects.toThrow('test cleanup');
    await expect(second).rejects.toThrow('test cleanup');
  });

  it('carries explicit background classification across async context', async () => {
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 100,
      foregroundReservePercent: 50,
      burstRequests: 100,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });
    await withRpcRequestContext({ requestClass: 'background' }, async () => {
      await Promise.resolve();
      await governor.acquireActiveRequest();
    });
    await governor.acquireActiveRequest();
    expect(governor.snapshot()).toMatchObject({
      backgroundAdmitted: 1,
      foregroundAdmitted: 1,
    });
  });

  it('defers only background work for the deterministic startup-jitter window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 2,
      foregroundReservePercent: 50,
      burstRequests: 2,
      maxQueueSize: 8,
      startupJitterMs: 30_000,
    }, {
      clock: {
        now: () => Date.now(),
        random: () => 0.5,
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: (timer) => clearTimeout(timer),
      },
    });

    let backgroundAdmitted = false;
    const background = governor.acquire('background').then(() => {
      backgroundAdmitted = true;
    });
    await governor.acquire('foreground');
    expect(backgroundAdmitted).toBe(false);
    expect(governor.snapshot()).toMatchObject({
      foregroundAdmitted: 1,
      backgroundQueued: 1,
      startupDelayRemainingMs: 15_000,
    });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(backgroundAdmitted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await background;
    expect(governor.snapshot()).toMatchObject({
      backgroundAdmitted: 1,
      backgroundQueued: 0,
      startupDelayRemainingMs: 0,
    });
  });

  it('drains delta counters once while retaining live policy and queue state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 1,
      foregroundReservePercent: 50,
      burstRequests: 1,
      maxQueueSize: 2,
      startupJitterMs: 0,
    });
    await governor.acquire('foreground');
    const controller = new AbortController();
    const deferred = governor.acquire('background', controller.signal);
    await expect(governor.acquire('background')).rejects.toBeInstanceOf(
      RpcRequestGovernorQueueFullError,
    );
    controller.abort(new Error('window cleanup'));
    await expect(deferred).rejects.toThrow('window cleanup');

    const first = governor.drainWindow();
    expect(first).toMatchObject({
      maxRequestsPerSecond: 1,
      foregroundQueued: 0,
      backgroundQueued: 0,
      foregroundAdmitted: 1,
      backgroundDeferred: 1,
      rejected: 1,
      cancelled: 1,
    });
    const second = governor.drainWindow();
    expect(second).toMatchObject({
      maxRequestsPerSecond: first.maxRequestsPerSecond,
      availableTokens: first.availableTokens,
      foregroundQueued: 0,
      backgroundQueued: 0,
      foregroundAdmitted: 0,
      backgroundAdmitted: 0,
      foregroundDeferred: 0,
      backgroundDeferred: 0,
      rejected: 0,
      cancelled: 0,
    });
  });

  it('validates every operator-facing limit', () => {
    expect(() => resolveRpcRequestGovernorPolicy(null as unknown as undefined))
      .toThrow(/plain object/);
    expect(() => resolveRpcRequestGovernorPolicy([] as unknown as undefined))
      .toThrow(/plain object/);
    expect(() => resolveRpcRequestGovernorPolicy({
      maxRequestsPerSecond: null,
    } as unknown as Parameters<typeof resolveRpcRequestGovernorPolicy>[0]))
      .toThrow(/maxRequestsPerSecond/);
    expect(() => resolveRpcRequestGovernorPolicy({
      maxRequestsPerSecond: 1,
      typo: 2,
    } as unknown as Parameters<typeof resolveRpcRequestGovernorPolicy>[0]))
      .toThrow(/unknown field typo/);
    expect(() => resolveRpcRequestGovernorPolicy({ maxRequestsPerSecond: 0 }))
      .toThrow(/maxRequestsPerSecond/);
    expect(() => resolveRpcRequestGovernorPolicy({ foregroundReservePercent: 100 }))
      .toThrow(/foregroundReservePercent/);
    expect(() => resolveRpcRequestGovernorPolicy({ burstRequests: 1.5 }))
      .toThrow(/burstRequests must be an integer/);
    expect(() => resolveRpcRequestGovernorPolicy({ maxQueueSize: 0 }))
      .toThrow(/maxQueueSize/);
    expect(() => resolveRpcRequestGovernorPolicy({ startupJitterMs: -1 }))
      .toThrow(/startupJitterMs/);
  });
});
