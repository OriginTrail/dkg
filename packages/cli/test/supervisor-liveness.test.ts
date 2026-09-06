/**
 * Unit tests for the supervisor-liveness watchdog — NO service mocks.
 *
 * `startLivenessWatcher`'s `probe` / `onUnresponsive` / `onFailure` /
 * `isShuttingDown` parameters are the module's OWN documented
 * dependency-injection seams (the source: "Injectable probe — tests pass a
 * stub"; "Exported so tests can verify the truth table"), not service
 * collaborators whose shapes can drift from a live daemon. So the retired
 * vitest-fn stubs are replaced with plain hand-rolled recorders — controllable
 * functions that capture their calls — which is exactly what the seams are
 * designed to receive. `probeWorkerAlive` (the real TCP primitive the default
 * probe uses) is already exercised mock-free against real `node:net` sockets
 * in the bottom block.
 *
 * `vi.useFakeTimers` is RETAINED on purpose: the watcher is a multi-tick
 * consecutive-failure state machine whose contract is inherently about
 * wall-clock ticks (30s in production), and deterministic virtual time is the
 * only non-flaky way to assert tick-by-tick invariants like "after exactly N
 * failed ticks the counter is N, after the grace window it re-arms". It
 * controls the CLOCK — it does not fake a daemon, a node, or any data — so it
 * is not a behaviour mock; forcing real timers here would only trade exact,
 * deterministic coverage for scheduling-jitter flakiness.
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
  DEFAULT_LIVENESS_SHUTDOWN_GRACE_MS,
  resolveLivenessShutdownGraceMs,
} from '../src/daemon/supervisor-liveness.js';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';

// Plain DI recorder (no vitest mock API): captures every call's args and
// delegates to a real implementation. Used for the watcher's injected
// probe/callback seams.
function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}
const noop = (): void => undefined;

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
    expect(DEFAULT_LIVENESS_SHUTDOWN_GRACE_MS).toBe(30_000);
  });

  it('never lets supervisor shutdown grace preempt the worker hard timeout', () => {
    expect(resolveLivenessShutdownGraceMs(resolveShutdownPolicy(undefined).hardTimeoutMs)).toBe(30_000);
    expect(resolveLivenessShutdownGraceMs(resolveShutdownPolicy('60000').hardTimeoutMs)).toBe(66_000);
    expect(resolveLivenessShutdownGraceMs(resolveShutdownPolicy('300000').hardTimeoutMs)).toBe(306_000);
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
    const probe = recorder(async () => false);
    const onUnresponsive = recorder(noop);
    const onFailure = recorder((_c: number) => undefined);
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
    expect(onUnresponsive.calls).toEqual([]);
    expect(onFailure.calls).toHaveLength(2);
    expect(onFailure.calls[0]).toEqual([1]);
    expect(onFailure.calls[1]).toEqual([2]);

    await advanceTicks(1, 1000);
    expect(onUnresponsive.calls).toHaveLength(1);
    watcher.stop();
  });

  it('resets the failure counter on a successful probe', async () => {
    let alive = false;
    const probe = recorder(async () => alive);
    const onUnresponsive = recorder(noop);
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
    expect(onUnresponsive.calls).toEqual([]);

    await advanceTicks(1, 1000);
    expect(onUnresponsive.calls).toHaveLength(1);
    watcher.stop();
  });

  it('resets failure counter AFTER firing onUnresponsive (so respawn boot has full quorum)', async () => {
    // If the counter weren't reset post-fire, a slow-respawning worker would
    // trip the threshold again before its listener bound, causing a
    // pathological kill-respawn loop. Lock that invariant.
    const probe = recorder(async () => false);
    const onUnresponsive = recorder(noop);
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive,
      intervalMs: 1000,
      consecutiveFailuresToKill: 2,
    });

    await advanceTicks(2, 1000);
    expect(onUnresponsive.calls).toHaveLength(1);

    // Three MORE failed ticks should yield only ONE more onUnresponsive
    // (after threshold of 2), not three or four.
    await advanceTicks(2, 1000);
    expect(onUnresponsive.calls).toHaveLength(2);
    watcher.stop();
  });

  it('stop() halts further probing', async () => {
    const probe = recorder(async () => false);
    const onUnresponsive = recorder(noop);
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive,
      intervalMs: 1000,
      consecutiveFailuresToKill: 100,
    });

    await advanceTicks(2, 1000);
    const callsBeforeStop = probe.calls.length;
    watcher.stop();

    await advanceTicks(10, 1000);
    expect(probe.calls.length).toBe(callsBeforeStop);
  });

  it('does not pile up concurrent probes when a probe is slow', async () => {
    // If two ticks land on top of a single in-flight probe, we should
    // drop the second tick rather than queue another probe — otherwise a
    // slow worker (e.g. CPU-bound) generates a probe storm.
    let resolveSlowProbe: (alive: boolean) => void;
    const probe = recorder(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSlowProbe = resolve;
        }),
    );
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive: recorder(noop),
      intervalMs: 1000,
    });

    await advanceTicks(1, 1000);
    expect(probe.calls).toHaveLength(1);
    await advanceTicks(3, 1000);
    expect(probe.calls).toHaveLength(1);

    resolveSlowProbe!(true);
    await advanceTicks(1, 1000);
    expect(probe.calls).toHaveLength(2);
    watcher.stop();
  });

  it('passes the configured host through to the probe', async () => {
    const probe = recorder(async () => true);
    const watcher = startLivenessWatcher({
      port: 1234,
      host: '::1',
      probe,
      onUnresponsive: recorder(noop),
      intervalMs: 1000,
      timeoutMs: 250,
    });

    await advanceTicks(1, 1000);
    expect(probe.calls[0]).toEqual([1234, '::1', 250]);
    watcher.stop();
  });

  it('ignores a probe result that resolves after stop()', async () => {
    let resolveProbe: (alive: boolean) => void;
    const probe = recorder(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const onUnresponsive = recorder(noop);
    const onFailure = recorder((_c: number) => undefined);
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

    expect(onFailure.calls).toEqual([]);
    expect(onUnresponsive.calls).toEqual([]);
  });

  it('healthy probes never trigger onFailure / onUnresponsive', async () => {
    const probe = recorder(async () => true);
    const onUnresponsive = recorder(noop);
    const onFailure = recorder((_c: number) => undefined);
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive,
      onFailure,
      intervalMs: 1000,
      consecutiveFailuresToKill: 2,
    });

    await advanceTicks(10, 1000);
    expect(onUnresponsive.calls).toEqual([]);
    expect(onFailure.calls).toEqual([]);
    watcher.stop();
  });

  it('suppresses SIGKILL during the shutdown grace window when isShuttingDown returns true', async () => {
    // Regression: PR #664 originally counted every failed probe toward the
    // SIGKILL threshold, so a slow shutdown tail (server.close() runs early
    // → probe fails → 5 × 30s later we SIGKILL) bypassed agent.stop() / DB
    // close. The supervisor wires `isShuttingDown` to "api.port file gone"
    // because the worker's shutdown() removes it before the slow awaits.
    //
    // Codex #664 follow-up: the watcher no longer disarms PERMANENTLY —
    // it enters a bounded grace window during which failures are
    // suppressed. The "still armed after the window" case is covered in
    // the dedicated `re-arms SIGKILL after shutdownGraceMs elapses` test.
    const probe = recorder(async () => false);
    const onUnresponsive = recorder(noop);
    const onFailure = recorder((_c: number) => undefined);
    const isShuttingDown = recorder(() => true);
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive,
      onFailure,
      isShuttingDown,
      intervalMs: 1000,
      consecutiveFailuresToKill: 1,
      // Long enough that 5s of ticks stays inside the window.
      shutdownGraceMs: 60_000,
    });

    await advanceTicks(5, 1000);
    expect(onUnresponsive.calls).toEqual([]);
    expect(onFailure.calls).toEqual([]);
    expect(isShuttingDown.calls.length).toBeGreaterThan(0);
    watcher.stop();
  });

  it('still SIGKILLs zombies when isShuttingDown returns false', async () => {
    // Mirror image of the previous test: api.port present + probe failing
    // means the worker is genuinely a zombie (event loop wedged after a
    // partial shutdown attempt), and the watcher must still trip.
    const probe = recorder(async () => false);
    const onUnresponsive = recorder(noop);
    const isShuttingDown = recorder(() => false);
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive,
      isShuttingDown,
      intervalMs: 1000,
      consecutiveFailuresToKill: 3,
    });

    await advanceTicks(3, 1000);
    expect(onUnresponsive.calls).toHaveLength(1);
    watcher.stop();
  });

  it('treats isShuttingDown errors as "still alive" (fail-safe — keeps SIGKILL path armed)', async () => {
    // If the shutdown detector itself throws (e.g. transient FS error reading
    // api.port), we MUST NOT silently disarm — that would let a real zombie
    // hide behind a flaky FS. Treat detector errors as "not shutting down"
    // and keep counting failures.
    const probe = recorder(async () => false);
    const onUnresponsive = recorder(noop);
    const isShuttingDown = recorder(async () => { throw new Error('FS busy'); });
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive,
      isShuttingDown,
      intervalMs: 1000,
      consecutiveFailuresToKill: 2,
    });

    await advanceTicks(2, 1000);
    expect(onUnresponsive.calls).toHaveLength(1);
    watcher.stop();
  });

  it('checks isShuttingDown only on failed probes (no FS pressure when worker is healthy)', async () => {
    // Performance: the supervisor probes every 30s in production. We only
    // need to consult `isShuttingDown` when the probe FAILS — checking on
    // every healthy tick wastes a syscall in the steady state.
    const probe = recorder(async () => true);
    const isShuttingDown = recorder(() => false);
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive: recorder(noop),
      isShuttingDown,
      intervalMs: 1000,
    });

    await advanceTicks(5, 1000);
    expect(isShuttingDown.calls).toEqual([]);
    watcher.stop();
  });

  it('Codex #664 — re-arms SIGKILL after shutdownGraceMs elapses', async () => {
    // Codex (#664#discussion_r3302432762): the previous implementation
    // PERMANENTLY disarmed the watcher on the first shutdown observation.
    // If a later teardown step hung, the supervisor could never SIGKILL
    // or respawn the worker. The fix: keep probing during shutdown, but
    // resume counting failures after a bounded grace window so wedged
    // teardowns still get force-killed.
    const probe = recorder(async () => false);
    const onUnresponsive = recorder(noop);
    const isShuttingDown = recorder(() => true);
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive,
      isShuttingDown,
      intervalMs: 1000,
      consecutiveFailuresToKill: 2,
      shutdownGraceMs: 5000,
    });

    // Within grace window: no SIGKILL even though probes are failing.
    await advanceTicks(4, 1000);
    expect(onUnresponsive.calls).toEqual([]);

    // After grace window expires, consecutive failures start counting
    // again; with threshold=2 the watcher trips on the next 2 failed
    // probes.
    await advanceTicks(3, 1000);
    expect(onUnresponsive.calls).toHaveLength(1);
    watcher.stop();
  });

  it('resets stale failure count when entering shutdown grace', async () => {
    const probe = recorder(async () => false);
    const onUnresponsive = recorder(noop);
    const onFailure = recorder((_c: number) => undefined);
    let shuttingDown = false;
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive,
      onFailure,
      isShuttingDown: () => shuttingDown,
      intervalMs: 1000,
      consecutiveFailuresToKill: 3,
      shutdownGraceMs: 3000,
    });

    await advanceTicks(2, 1000);
    expect(onFailure.calls).toHaveLength(2);
    shuttingDown = true;
    await advanceTicks(3, 1000);
    expect(onUnresponsive.calls).toEqual([]);

    await advanceTicks(2, 1000);
    expect(onUnresponsive.calls).toEqual([]);
    await advanceTicks(1, 1000);
    expect(onUnresponsive.calls).toHaveLength(1);
    watcher.stop();
  });

  it('Codex #664 — shutdownGraceMs<0 preserves legacy disarm-forever behavior', async () => {
    // Operators who explicitly want the rc.11-and-earlier "never SIGKILL
    // during graceful shutdown" semantic can opt back in with a negative
    // grace value.
    const probe = recorder(async () => false);
    const onUnresponsive = recorder(noop);
    const isShuttingDown = recorder(() => true);
    const watcher = startLivenessWatcher({
      port: 1234,
      probe,
      onUnresponsive,
      isShuttingDown,
      intervalMs: 1000,
      consecutiveFailuresToKill: 1,
      shutdownGraceMs: -1,
    });

    await advanceTicks(20, 1000);
    expect(onUnresponsive.calls).toEqual([]);
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
