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
