import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WAL_RESTART_THRESHOLD_BYTES,
  createOxigraphWalMaintenanceCoordinator,
  resolveWalRestartThresholdBytes,
} from '../src/daemon/oxigraph-wal-maintenance.js';

function controlledCoordinator(overrides: {
  measureRetainedWalBytes?: () => number;
  requestRestart?: (reason: string) => boolean;
  log?: (message: string) => void;
} = {}) {
  let now = 0;
  let tick = () => {};
  let serverAvailable = false;
  const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
  const cancel = vi.fn();
  const coordinator = createOxigraphWalMaintenanceCoordinator({
    location: '/tmp/oxigraph-test',
    thresholdBytes: 100,
    checkIntervalMs: 20,
    idleMs: 80,
    cooldownMs: 100,
    measureRetainedWalBytes: overrides.measureRetainedWalBytes ?? (() => 101),
    requestRestart: overrides.requestRestart ?? (() => true),
    serverAvailable: () => serverAvailable,
    log: overrides.log ?? (() => {}),
    now: () => now,
    schedule: (callback, intervalMs) => {
      expect(intervalMs).toBe(20);
      tick = callback;
      return timer;
    },
    cancel,
  });
  return {
    coordinator,
    setServerAvailable: (value: boolean) => {
      serverAvailable = value;
      coordinator.serverLifecycleChanged();
    },
    setNow: (value: number) => { now = value; },
    tick: () => tick(),
    timer,
    cancel,
  };
}

describe('Oxigraph WAL maintenance coordinator', () => {
  it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100'])(
    'resolves invalid threshold %s to the canonical 4 GiB default',
    (value) => {
      expect(resolveWalRestartThresholdBytes(value)).toBe(DEFAULT_WAL_RESTART_THRESHOLD_BYTES);
    },
  );

  it('preserves a safe positive integer threshold', () => {
    expect(resolveWalRestartThresholdBytes(1234)).toBe(1234);
  });

  it('starts a fresh continuous-idle window after activity reaches zero', () => {
    const measureRetainedWalBytes = vi.fn(() => 101);
    const requestRestart = vi.fn(() => true);
    const controlled = controlledCoordinator({ measureRetainedWalBytes, requestRestart });
    controlled.setServerAvailable(true);
    expect(controlled.timer.unref).toHaveBeenCalledOnce();

    controlled.setNow(70);
    controlled.coordinator.reportActivity(1);
    controlled.setNow(100);
    controlled.tick();
    expect(measureRetainedWalBytes).not.toHaveBeenCalled();

    controlled.coordinator.reportActivity(0);
    controlled.setNow(179);
    controlled.tick();
    expect(measureRetainedWalBytes).not.toHaveBeenCalled();

    controlled.setNow(180);
    controlled.tick();
    expect(measureRetainedWalBytes).toHaveBeenCalledOnce();
    expect(requestRestart).toHaveBeenCalledWith(
      expect.stringContaining('101 B retained WAL reached the 100 B maintenance threshold'),
    );
  });

  it.each([
    [99, 0],
    [100, 1],
  ])('restarts only at or above the threshold: %i bytes', (walBytes, expectedRestarts) => {
    const requestRestart = vi.fn(() => true);
    const controlled = controlledCoordinator({
      measureRetainedWalBytes: () => walBytes,
      requestRestart,
    });
    controlled.setServerAvailable(true);
    controlled.setNow(80);
    controlled.tick();

    expect(requestRestart).toHaveBeenCalledTimes(expectedRestarts);
  });

  it('prevents another restart until both a new idle window and cooldown elapse', () => {
    const measureRetainedWalBytes = vi.fn(() => 101);
    const requestRestart = vi.fn(() => true);
    const controlled = controlledCoordinator({ measureRetainedWalBytes, requestRestart });
    controlled.setServerAvailable(true);
    controlled.setNow(80);
    controlled.tick();
    expect(requestRestart).toHaveBeenCalledOnce();

    controlled.setNow(90);
    controlled.setServerAvailable(true);
    controlled.setNow(170);
    controlled.tick();
    expect(requestRestart).toHaveBeenCalledOnce();
    expect(measureRetainedWalBytes).toHaveBeenCalledOnce();

    controlled.setNow(180);
    controlled.tick();
    expect(requestRestart).toHaveBeenCalledTimes(2);
    expect(measureRetainedWalBytes).toHaveBeenCalledTimes(2);
  });

  it('aggregates activity from independent store leases', () => {
    const requestRestart = vi.fn(() => true);
    const controlled = controlledCoordinator({ requestRestart });
    controlled.setServerAvailable(true);
    const first = controlled.coordinator.registerActivity();
    const second = controlled.coordinator.registerActivity();

    first.report(1);
    second.report(0);
    controlled.setNow(80);
    controlled.tick();
    expect(requestRestart).not.toHaveBeenCalled();

    // Releasing one adapter while the other remains busy must not open the
    // maintenance window.
    first.report(0);
    second.report(1);
    controlled.setNow(160);
    controlled.tick();
    expect(requestRestart).not.toHaveBeenCalled();

    second.report(0);
    controlled.setNow(239);
    controlled.tick();
    expect(requestRestart).not.toHaveBeenCalled();
    controlled.setNow(240);
    controlled.tick();
    expect(requestRestart).toHaveBeenCalledOnce();

    first.dispose();
    second.dispose();
  });

  it('contains measurement failures and stops its timer', () => {
    const log = vi.fn();
    const controlled = controlledCoordinator({
      measureRetainedWalBytes: () => { throw new Error('measurement failed'); },
      log,
    });
    controlled.setServerAvailable(true);
    controlled.setNow(80);
    controlled.tick();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('measurement failed'));

    controlled.coordinator.stop();
    expect(controlled.cancel).toHaveBeenCalledWith(controlled.timer);
  });
});
