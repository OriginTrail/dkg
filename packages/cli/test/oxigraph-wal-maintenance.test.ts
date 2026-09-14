import { describe, expect, it, vi } from 'vitest';
import { createOxigraphWalMaintenanceCoordinator } from '../src/daemon/oxigraph-wal-maintenance.js';

function controlledCoordinator(overrides: {
  measureRetainedWalBytes?: () => number;
  requestRestart?: (reason: string) => boolean;
  log?: (message: string) => void;
} = {}) {
  let now = 0;
  let tick = () => {};
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
    setNow: (value: number) => { now = value; },
    tick: () => tick(),
    timer,
    cancel,
  };
}

describe('Oxigraph WAL maintenance coordinator', () => {
  it('starts a fresh continuous-idle window after activity reaches zero', () => {
    const measureRetainedWalBytes = vi.fn(() => 101);
    const requestRestart = vi.fn(() => true);
    const controlled = controlledCoordinator({ measureRetainedWalBytes, requestRestart });
    controlled.coordinator.serverReady();
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

  it('prevents another restart until both a new idle window and cooldown elapse', () => {
    const measureRetainedWalBytes = vi.fn(() => 101);
    const requestRestart = vi.fn(() => true);
    const controlled = controlledCoordinator({ measureRetainedWalBytes, requestRestart });
    controlled.coordinator.serverReady();
    controlled.setNow(80);
    controlled.tick();
    expect(requestRestart).toHaveBeenCalledOnce();

    controlled.setNow(90);
    controlled.coordinator.serverReady();
    controlled.setNow(170);
    controlled.tick();
    expect(requestRestart).toHaveBeenCalledOnce();
    expect(measureRetainedWalBytes).toHaveBeenCalledOnce();

    controlled.setNow(180);
    controlled.tick();
    expect(requestRestart).toHaveBeenCalledTimes(2);
    expect(measureRetainedWalBytes).toHaveBeenCalledTimes(2);
  });

  it('contains measurement failures and stops its timer', () => {
    const log = vi.fn();
    const controlled = controlledCoordinator({
      measureRetainedWalBytes: () => { throw new Error('measurement failed'); },
      log,
    });
    controlled.coordinator.serverReady();
    controlled.setNow(80);
    controlled.tick();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('measurement failed'));

    controlled.coordinator.stop();
    expect(controlled.cancel).toHaveBeenCalledWith(controlled.timer);
  });
});
