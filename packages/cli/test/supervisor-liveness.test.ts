/**
 * Unit tests for the supervisor-liveness watchdog.
 *
 * Pure-logic surface — `startLivenessWatcher` is exercised with an injected
 * stub probe so tests stay deterministic and don't need to bind real TCP
 * sockets. `probeWorkerAlive` itself is covered by a small "real socket
 * round-trip" block at the end using a node:net server.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:net';
import {
  isLivenessProbeEnabled,
  startLivenessWatcher,
  probeWorkerAlive,
  LIVENESS_CONSECUTIVE_FAILURES_TO_KILL,
  LIVENESS_PROBE_INTERVAL_MS,
  LIVENESS_PROBE_TIMEOUT_MS,
} from '../src/daemon/supervisor-liveness.js';

describe('isLivenessProbeEnabled', () => {
  it.each([
    [undefined, true],
    ['', true],
    ['on', true],
    ['ON', true],
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['off', false],
    ['OFF', false],
    ['0', false],
    ['false', false],
    ['False', false],
    // Unknown value → fail-safe enable.
    ['maybe', true],
    ['yes', true],
  ])('parses env %j → %s', (input, expected) => {
    expect(isLivenessProbeEnabled(input)).toBe(expected);
  });
});

describe('module constants', () => {
  it('exposes the documented defaults', () => {
    expect(LIVENESS_CONSECUTIVE_FAILURES_TO_KILL).toBe(5);
    expect(LIVENESS_PROBE_INTERVAL_MS).toBe(30_000);
    expect(LIVENESS_PROBE_TIMEOUT_MS).toBe(5_000);
  });
});

describe('startLivenessWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Advance fake timers to fire `ticks` intervals and let every probe
   * promise settle. Why: `setInterval` callbacks are sync (they kick off
   * the async probe) but the watcher's state transitions only happen
   * after the probe promise resolves. `runAllTicks` + microtask flush
   * makes the test deterministic.
   */
  async function advanceTicks(ticks: number, intervalMs: number): Promise<void> {
    for (let i = 0; i < ticks; i++) {
      await vi.advanceTimersByTimeAsync(intervalMs);
    }
  }

  it('fires onUnresponsive after N consecutive failures', async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const onUnresponsive = vi.fn();
    const onFailure = vi.fn();
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive,
      onFailure,
      intervalMs: 1000,
      timeoutMs: 100,
      consecutiveFailuresToKill: 3,
    });

    await advanceTicks(2, 1000);
    expect(onUnresponsive).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenNthCalledWith(1, 1);
    expect(onFailure).toHaveBeenNthCalledWith(2, 2);

    await advanceTicks(1, 1000);
    expect(onUnresponsive).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it('resets the failure counter on a successful probe', async () => {
    let alive = false;
    const probe = vi.fn().mockImplementation(() => Promise.resolve(alive));
    const onUnresponsive = vi.fn();
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive,
      intervalMs: 1000,
      consecutiveFailuresToKill: 3,
    });

    await advanceTicks(2, 1000);
    alive = true;
    await advanceTicks(1, 1000);
    alive = false;
    await advanceTicks(2, 1000);
    expect(onUnresponsive).not.toHaveBeenCalled();

    await advanceTicks(1, 1000);
    expect(onUnresponsive).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it('resets failure counter AFTER firing onUnresponsive (so respawn boot has full quorum)', async () => {
    // If the counter weren't reset post-fire, a slow-respawning worker would
    // trip the threshold again before its listener bound, causing a
    // pathological kill-respawn loop. Lock that invariant.
    const probe = vi.fn().mockResolvedValue(false);
    const onUnresponsive = vi.fn();
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive,
      intervalMs: 1000,
      consecutiveFailuresToKill: 2,
    });

    await advanceTicks(2, 1000);
    expect(onUnresponsive).toHaveBeenCalledTimes(1);

    // Three MORE failed ticks should yield only ONE more onUnresponsive
    // (after threshold of 2), not three or four.
    await advanceTicks(2, 1000);
    expect(onUnresponsive).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it('stop() halts further probing', async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const onUnresponsive = vi.fn();
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive,
      intervalMs: 1000,
      consecutiveFailuresToKill: 100,
    });

    await advanceTicks(2, 1000);
    const callsBeforeStop = probe.mock.calls.length;
    watcher.stop();

    await advanceTicks(10, 1000);
    expect(probe.mock.calls.length).toBe(callsBeforeStop);
  });

  it('does not pile up concurrent probes when a probe is slow', async () => {
    // If two ticks land on top of a single in-flight probe, we should
    // drop the second tick rather than queue another probe — otherwise a
    // slow worker (e.g. CPU-bound) generates a probe storm.
    let resolveSlowProbe: (alive: boolean) => void;
    const probe = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSlowProbe = resolve;
        }),
    );
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive: vi.fn(),
      intervalMs: 1000,
    });

    await advanceTicks(1, 1000);
    expect(probe).toHaveBeenCalledTimes(1);
    await advanceTicks(3, 1000);
    expect(probe).toHaveBeenCalledTimes(1);

    resolveSlowProbe!(true);
    await advanceTicks(1, 1000);
    expect(probe).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it('passes the configured host through to the probe', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const watcher = startLivenessWatcher({
      port: 1234,
      host: '::1',
      probe,
      onUnresponsive: vi.fn(),
      intervalMs: 1000,
      timeoutMs: 250,
    });

    await advanceTicks(1, 1000);
    expect(probe).toHaveBeenCalledWith(1234, '::1', 250);
    watcher.stop();
  });

  it('ignores a probe result that resolves after stop()', async () => {
    let resolveProbe: (alive: boolean) => void;
    const probe = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const onUnresponsive = vi.fn();
    const onFailure = vi.fn();
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive,
      onFailure,
      intervalMs: 1000,
      consecutiveFailuresToKill: 1,
    });

    await advanceTicks(1, 1000);
    watcher.stop();
    resolveProbe!(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(onFailure).not.toHaveBeenCalled();
    expect(onUnresponsive).not.toHaveBeenCalled();
  });

  it('healthy probes never trigger onFailure / onUnresponsive', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const onUnresponsive = vi.fn();
    const onFailure = vi.fn();
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive,
      onFailure,
      intervalMs: 1000,
      consecutiveFailuresToKill: 2,
    });

    await advanceTicks(10, 1000);
    expect(onUnresponsive).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    watcher.stop();
  });

  it('disarms (no SIGKILL, no failure increment) when isShuttingDown returns true', async () => {
    // Regression: PR #664 originally counted every failed probe toward the
    // SIGKILL threshold, so a slow shutdown tail (server.close() runs early
    // → probe fails → 5 × 30s later we SIGKILL) bypassed agent.stop() / DB
    // close. The supervisor wires `isShuttingDown` to "api.port file gone"
    // because the worker's shutdown() removes it before the slow awaits.
    const probe = vi.fn().mockResolvedValue(false);
    const onUnresponsive = vi.fn();
    const onFailure = vi.fn();
    const isShuttingDown = vi.fn().mockReturnValue(true);
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive,
      onFailure,
      isShuttingDown,
      intervalMs: 1000,
      consecutiveFailuresToKill: 1,
    });

    await advanceTicks(5, 1000);
    expect(onUnresponsive).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    expect(isShuttingDown).toHaveBeenCalled();
    watcher.stop();
  });

  it('still SIGKILLs zombies when isShuttingDown returns false', async () => {
    // Mirror image of the previous test: api.port present + probe failing
    // means the worker is genuinely a zombie (event loop wedged after a
    // partial shutdown attempt), and the watcher must still trip.
    const probe = vi.fn().mockResolvedValue(false);
    const onUnresponsive = vi.fn();
    const isShuttingDown = vi.fn().mockReturnValue(false);
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive,
      isShuttingDown,
      intervalMs: 1000,
      consecutiveFailuresToKill: 3,
    });

    await advanceTicks(3, 1000);
    expect(onUnresponsive).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it('treats isShuttingDown errors as "still alive" (fail-safe — keeps SIGKILL path armed)', async () => {
    // If the shutdown detector itself throws (e.g. transient FS error reading
    // api.port), we MUST NOT silently disarm — that would let a real zombie
    // hide behind a flaky FS. Treat detector errors as "not shutting down"
    // and keep counting failures.
    const probe = vi.fn().mockResolvedValue(false);
    const onUnresponsive = vi.fn();
    const isShuttingDown = vi.fn().mockRejectedValue(new Error('FS busy'));
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive,
      isShuttingDown,
      intervalMs: 1000,
      consecutiveFailuresToKill: 2,
    });

    await advanceTicks(2, 1000);
    expect(onUnresponsive).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it('checks isShuttingDown only on failed probes (no FS pressure when worker is healthy)', async () => {
    // Performance: the supervisor probes every 30s in production. We only
    // need to consult `isShuttingDown` when the probe FAILS — checking on
    // every healthy tick wastes a syscall in the steady state.
    const probe = vi.fn().mockResolvedValue(true);
    const isShuttingDown = vi.fn().mockReturnValue(false);
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive: vi.fn(),
      isShuttingDown,
      intervalMs: 1000,
    });

    await advanceTicks(5, 1000);
    expect(isShuttingDown).not.toHaveBeenCalled();
    watcher.stop();
  });
});

describe('probeWorkerAlive (real TCP socket round-trip)', () => {
  it('returns true when a TCP listener accepts the connection', async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const alive = await probeWorkerAlive(port, '127.0.0.1', 2_000);
      expect(alive).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns false when nothing is listening (connection refused)', async () => {
    // Bind + immediately close to get a port that's *known* unused.
    const tmpServer = createServer();
    await new Promise<void>((resolve) => tmpServer.listen(0, '127.0.0.1', resolve));
    const port = (tmpServer.address() as { port: number }).port;
    await new Promise<void>((resolve) => tmpServer.close(() => resolve()));

    const alive = await probeWorkerAlive(port, '127.0.0.1', 1_000);
    expect(alive).toBe(false);
  });

  it('returns false when the connect attempt exceeds the timeout', async () => {
    // 192.0.2.0/24 (TEST-NET-1) is reserved for documentation and routes
    // nowhere — a connection attempt hangs until our timeout fires.
    const alive = await probeWorkerAlive(54321, '192.0.2.1', 150);
    expect(alive).toBe(false);
  });
});
