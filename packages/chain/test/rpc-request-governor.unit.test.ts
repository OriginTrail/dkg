// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RpcRequestGovernor,
  RpcRequestGovernorQueueFullError,
  resolveRpcRequestGovernorPolicy,
  withRpcRequestClass,
} from '../src/rpc-request-governor.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('RpcRequestGovernor', () => {
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

  it('bounds the queue and removes a cancelled waiter', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 1,
      foregroundReservePercent: 50,
      burstRequests: 1,
      maxQueueSize: 1,
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

  it('carries explicit background classification across async context', async () => {
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 100,
      foregroundReservePercent: 50,
      burstRequests: 100,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });
    await withRpcRequestClass('background', async () => {
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
