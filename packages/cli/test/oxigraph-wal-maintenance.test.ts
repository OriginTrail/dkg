import { describe, expect, it, vi } from 'vitest';
import { ManagedWorkRecoveryCoordinatorV1 } from '../../storage/src/managed-work-recovery-coordinator.js';
import { normalizeManagedSparqlRecoveryV1 } from '../../storage/src/adapters/managed-sparql-recovery.js';
import { createOxigraphRecoveryProgress, OxigraphRecoveryProgressOwner } from '../src/daemon/oxigraph-recovery-progress.js';
import {
  WAL_GROWTH_NOTICE_BYTES,
  createOxigraphWalMaintenanceCoordinator,
  resolveWalRestartThresholdBytes,
} from '../src/daemon/oxigraph-wal-maintenance.js';

function controlledCoordinator(overrides: {
  measureRetainedWalBytes?: () => number;
  onRequest?: (reason: string) => void;
  log?: (message: string) => void;
} = {}) {
  let now = 0;
  let tick = () => {};
  let serverAvailable = false;
  const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
  const cancel = vi.fn();
  let progress: ReturnType<typeof createOxigraphRecoveryProgress> | undefined;
  const coordinator = createOxigraphWalMaintenanceCoordinator({
    location: '/tmp/oxigraph-test',
    thresholdBytes: 100,
    checkIntervalMs: 20,
    idleMs: 80,
    cooldownMs: 100,
    measureRetainedWalBytes: overrides.measureRetainedWalBytes ?? (() => 101),
    requestRecovery: reason => {
      overrides.onRequest?.(reason);
      progress = createOxigraphRecoveryProgress(0);
      return progress.handle;
    },
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
    notify: (phase: import('@origintrail-official/dkg-storage').ManagedOxigraphRecoveryPhaseV1) => progress?.publish(phase),
  };
}

describe('Oxigraph WAL maintenance coordinator', () => {
  it('accepts a confirmed independent reopen while maintenance is draining', () => {
    let walBytes = 101;
    const request = vi.fn();
    const fixture = controlledCoordinator({ measureRetainedWalBytes: () => walBytes, onRequest: request });
    const activity = fixture.coordinator.registerActivity();
    fixture.setServerAvailable(true);
    activity.report(true);
    fixture.tick();
    expect(fixture.coordinator.admissionsPaused()).toBe(true);
    // Another supervisor recovery reclaims the old store before maintenance
    // has requested a handle of its own. Only its confirmed reopen satisfies it.
    fixture.setServerAvailable(false);
    fixture.coordinator.serverLifecycleChanged();
    expect(fixture.coordinator.admissionsPaused()).toBe(true);
    walBytes = 0;
    activity.report(false);
    fixture.setNow(20);
    fixture.setServerAvailable(true);
    fixture.coordinator.serverLifecycleChanged('confirmed-reopen');
    expect(fixture.coordinator.admissionsPaused()).toBe(false);
    fixture.setNow(100); fixture.tick();
    expect(request).not.toHaveBeenCalled();
    // The confirmed reopen starts cooldown even if WAL rises again meanwhile.
    walBytes = 101;
    fixture.setNow(119); fixture.tick();
    expect(fixture.coordinator.admissionsPaused()).toBe(false);
    fixture.setNow(120); fixture.tick();
    expect(request).toHaveBeenCalledOnce();
    activity.dispose(); fixture.coordinator.stop();
  });

  it('drains abandoned work after two completed spontaneous recoveries before its original deadline', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const state = { recovering: false, generation: 0 };
    let tick = () => {};
    const start = vi.fn(() => { progress.begin(state.generation); return true; });
    const progress = new OxigraphRecoveryProgressOwner(() => state.generation, start);
    const wal = createOxigraphWalMaintenanceCoordinator({ location: '/tmp/wal-completed-generations', thresholdBytes: 100,
      idleMs: 10, cooldownMs: 100, measureRetainedWalBytes: () => 101,
      requestRecovery: reason => progress.request(state.generation, reason),
      serverAvailable: () => !state.recovering, log() {}, now: () => Date.now(),
      schedule(callback) { tick = callback; return { unref() {} } as ReturnType<typeof setInterval>; }, cancel() {},
    });
    const activity = wal.registerActivity();
    const pending = vi.fn((busy: boolean) => activity.report(busy));
    const recovery = new ManagedWorkRecoveryCoordinatorV1({ now: () => Date.now(), retainActivity: () => { pending(true); return { release() { pending(false); } }; },
      capability: normalizeManagedSparqlRecoveryV1({ readState: () => state,
        requestRecovery: (generation, operation) => progress.request(generation, operation) }) });
    try {
      recovery.retain('update', startedAt + 30_000, recovery.begin(state));
      tick(); expect(wal.admissionsPaused()).toBe(true);
      // The real owner is advanced only by canonical physical reclamation and
      // the serialized replacement reopen, independently of the retained timer.
      for (const generation of [0, 1]) {
        progress.begin(generation); progress.publish('signalled');
        expect(pending.mock.calls).toEqual([[true]]);
        progress.publish('terminated'); state.generation = generation + 1;
        progress.publish('reopened');
      }
      expect(start).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(pending.mock.calls).toEqual([[true]]);
      await vi.advanceTimersByTimeAsync(1);
      expect(pending.mock.calls).toEqual([[true], [false]]);
      expect(start).not.toHaveBeenCalled();
      tick(); await vi.advanceTimersByTimeAsync(10); tick();
      expect(start).toHaveBeenCalledOnce();
      progress.publish('signalled'); progress.publish('terminated');
      expect(wal.admissionsPaused()).toBe(true);
      state.generation += 1; progress.publish('reopened');
      expect(wal.admissionsPaused()).toBe(false);
      await vi.advanceTimersByTimeAsync(99); tick(); expect(start).toHaveBeenCalledOnce();
    } finally { recovery.close(); activity.dispose(); wal.stop(); vi.useRealTimers(); }
  });

  it('replays only accepted physical termination, without restarting completed or future generations', () => {
    let generation = 0;
    const start = vi.fn(() => false);
    const owner = new OxigraphRecoveryProgressOwner(() => generation, start);
    owner.begin(0);
    const original = owner.request(0, 'same generation');
    owner.publish('signalled'); owner.publish('terminated'); owner.publish('reopened');
    expect(owner.request(0, 'same completed handle')).toBe(original);
    generation = 1; owner.begin(1); owner.publish('signalled');
    const completed: string[] = [];
    const unsubscribe = owner.request(0, 'old completed generation')!.subscribe(phase => completed.push(phase));
    expect(completed).toEqual(['terminated']); unsubscribe();
    const current: string[] = [];
    const disposeCurrent = owner.request(1, 'not yet reclaimed')!.subscribe(phase => current.push(phase));
    expect(current).toEqual(['signalled']); disposeCurrent();
    expect(owner.request(2, 'future generation')).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'stopped'] as const)('does not certify a late termination ignored after %s', phase => {
    let generation = 0;
    const start = vi.fn(() => false);
    const owner = new OxigraphRecoveryProgressOwner(() => generation, start);
    owner.begin(0); owner.publish('signalled'); owner.publish(phase); owner.publish('terminated');
    generation = 1; owner.begin(1);
    expect(owner.request(0, 'still unconfirmed')).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });

  it('uses supervisor cancellation/reopen notifications for idle retry and cooldown', () => {
    let now = 0; let tick = () => {};
    let progress = createOxigraphRecoveryProgress(0);
    const requestRecovery = vi.fn(() => { progress = createOxigraphRecoveryProgress(0); return progress.handle; });
    const coordinator = createOxigraphWalMaintenanceCoordinator({ location: '/tmp/wal-progress', thresholdBytes: 100,
      idleMs: 10, cooldownMs: 100, measureRetainedWalBytes: () => 101,
      requestRecovery, serverAvailable: () => true, log() {}, now: () => now,
      schedule(callback) { tick = callback; return { unref() {} } as ReturnType<typeof setInterval>; }, cancel() {},
    });
    const notify = (phase: import('@origintrail-official/dkg-storage').ManagedOxigraphRecoveryPhaseV1) => progress.publish(phase);
    try {
      tick(); now = 10; tick();
      expect(requestRecovery).toHaveBeenCalledOnce();
      now = 1_000; tick(); notify('signalled'); tick();
      expect(requestRecovery).toHaveBeenCalledOnce();
      expect(coordinator.admissionsPaused()).toBe(true);
      notify('cancelled'); now = 1_009; tick();
      expect(requestRecovery).toHaveBeenCalledOnce();
      now = 1_010; tick(); expect(requestRecovery).toHaveBeenCalledTimes(2);
      notify('terminated'); expect(coordinator.admissionsPaused()).toBe(true);
      now = 1_020; notify('reopened'); expect(coordinator.admissionsPaused()).toBe(false);
      now = 1_119; tick(); expect(requestRecovery).toHaveBeenCalledTimes(2);
      now = 1_120; tick(); expect(coordinator.admissionsPaused()).toBe(true);
    } finally { coordinator.stop(); }
    const requests = requestRecovery.mock.calls.length;
    notify('reopened'); tick(); expect(requestRecovery).toHaveBeenCalledTimes(requests);
  });

  it.each([undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100', true])(
    'leaves the maintenance reopen off for the threshold %s',
    (value) => {
      expect(resolveWalRestartThresholdBytes(value)).toBeUndefined();
    },
  );

  it('preserves a safe positive integer threshold', () => {
    expect(resolveWalRestartThresholdBytes(1234)).toBe(1234);
  });

  it('applies the documented 60s check, 30s idle, and 1h cooldown defaults', () => {
    // Every other test overrides all three seams, so the values operators are
    // told about in docs/use-dkg/storage-sparql-http.md are otherwise untested.
    let now = 0;
    let tick = () => {};
    const measureRetainedWalBytes = vi.fn(() => 101);
    const progress = createOxigraphRecoveryProgress(0);
    const requestRecovery = vi.fn(() => progress.handle);
    const coordinator = createOxigraphWalMaintenanceCoordinator({
      location: '/tmp/oxigraph-test',
      thresholdBytes: 100,
      measureRetainedWalBytes,
      requestRecovery,
      serverAvailable: () => true,
      log: () => {},
      now: () => now,
      schedule: (callback, intervalMs) => {
        expect(intervalMs).toBe(60_000);
        tick = callback;
        return { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
      },
      cancel: vi.fn(),
    });

    tick();
    expect(coordinator.admissionsPaused()).toBe(true);
    now = 29_999;
    tick();
    expect(requestRecovery).not.toHaveBeenCalled();
    now = 30_000;
    tick();
    expect(requestRecovery).toHaveBeenCalledOnce();

    progress.publish('reopened');
    coordinator.serverLifecycleChanged();
    now = 30_000 + 3_599_999;
    tick();
    expect(measureRetainedWalBytes).toHaveBeenCalledOnce();
    now = 30_000 + 3_600_000;
    tick();
    expect(measureRetainedWalBytes).toHaveBeenCalledTimes(2);
    coordinator.stop();
  });

  it('measures under continuous traffic, pauses admission, and waits for active work to drain', () => {
    const measureRetainedWalBytes = vi.fn(() => 101);
    const requestRecovery = vi.fn();
    const controlled = controlledCoordinator({ measureRetainedWalBytes, onRequest: requestRecovery });
    controlled.setServerAvailable(true);
    expect(controlled.timer.unref).toHaveBeenCalledOnce();

    controlled.setNow(70);
    const activity = controlled.coordinator.registerActivity();
    activity.report(true);
    controlled.setNow(100);
    controlled.tick();
    expect(measureRetainedWalBytes).toHaveBeenCalledOnce();
    expect(controlled.coordinator.admissionsPaused()).toBe(true);
    expect(requestRecovery).not.toHaveBeenCalled();

    activity.report(false);
    controlled.setNow(179);
    controlled.tick();
    expect(requestRecovery).not.toHaveBeenCalled();

    controlled.setNow(180);
    controlled.tick();
    expect(requestRecovery).toHaveBeenCalledWith(
      expect.stringContaining('retained WAL reached the 100 B maintenance threshold'),
    );
  });

  it.each([
    [99, 0],
    [100, 1],
  ])('restarts only at or above the threshold: %i bytes', (walBytes, expectedRestarts) => {
    const requestRecovery = vi.fn();
    const controlled = controlledCoordinator({
      measureRetainedWalBytes: () => walBytes,
      onRequest: requestRecovery,
    });
    controlled.setServerAvailable(true);
    controlled.setNow(80);
    controlled.tick();

    expect(requestRecovery).toHaveBeenCalledTimes(expectedRestarts);
  });

  it('prevents another restart until both a new idle window and cooldown elapse', () => {
    const measureRetainedWalBytes = vi.fn(() => 101);
    const requestRecovery = vi.fn();
    const controlled = controlledCoordinator({ measureRetainedWalBytes, onRequest: requestRecovery });
    controlled.setServerAvailable(true);
    controlled.setNow(80);
    controlled.tick();
    expect(requestRecovery).toHaveBeenCalledOnce();

    controlled.setNow(90);
    controlled.notify('reopened');
    expect(controlled.coordinator.admissionsPaused()).toBe(false);
    controlled.setServerAvailable(true);
    controlled.setNow(170);
    controlled.tick();
    expect(requestRecovery).toHaveBeenCalledOnce();
    expect(measureRetainedWalBytes).toHaveBeenCalledOnce();

    controlled.setNow(190);
    controlled.tick();
    expect(requestRecovery).toHaveBeenCalledTimes(2);
    expect(measureRetainedWalBytes).toHaveBeenCalledTimes(2);
  });

  it('keeps admission paused and retries after a requested restart is cancelled', () => {
    const requestRecovery = vi.fn();
    const controlled = controlledCoordinator({ onRequest: requestRecovery });
    controlled.setServerAvailable(true);
    controlled.setNow(80);
    controlled.tick();
    expect(requestRecovery).toHaveBeenCalledOnce();
    expect(controlled.coordinator.admissionsPaused()).toBe(true);

    // Readiness alone cannot certify cancellation of the owned recovery.
    controlled.setServerAvailable(true);
    controlled.notify('cancelled');
    controlled.setNow(159);
    controlled.tick();
    expect(requestRecovery).toHaveBeenCalledOnce();
    controlled.setNow(160);
    controlled.tick();
    expect(requestRecovery).toHaveBeenCalledTimes(2);
    expect(controlled.coordinator.admissionsPaused()).toBe(true);
  });

  it('aggregates activity from independent store leases', () => {
    const requestRecovery = vi.fn();
    const controlled = controlledCoordinator({ onRequest: requestRecovery });
    controlled.setServerAvailable(true);
    const first = controlled.coordinator.registerActivity();
    const second = controlled.coordinator.registerActivity();

    first.report(true);
    second.report(false);
    controlled.setNow(80);
    controlled.tick();
    expect(requestRecovery).not.toHaveBeenCalled();

    // Releasing one adapter while the other remains busy must not open the
    // maintenance window.
    first.report(false);
    second.report(true);
    controlled.setNow(160);
    controlled.tick();
    expect(requestRecovery).not.toHaveBeenCalled();

    second.report(false);
    controlled.setNow(239);
    controlled.tick();
    expect(requestRecovery).not.toHaveBeenCalled();
    controlled.setNow(240);
    controlled.tick();
    expect(requestRecovery).toHaveBeenCalledOnce();

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

/** A coordinator with the maintenance reopen off, driven by hand. */
function controlledObserver(overrides: {
  measureRetainedWalBytes?: () => number;
  checkIntervalMs?: number;
} = {}) {
  let tick = () => {};
  let serverAvailable = true;
  const lines: string[] = [];
  const requestRecovery = vi.fn(() => undefined);
  const cancel = vi.fn();
  const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
  let scheduledEveryMs: number | undefined;
  const coordinator = createOxigraphWalMaintenanceCoordinator({
    location: '/tmp/oxigraph-test',
    thresholdBytes: undefined,
    checkIntervalMs: overrides.checkIntervalMs,
    measureRetainedWalBytes: overrides.measureRetainedWalBytes ?? (() => 0),
    requestRecovery,
    serverAvailable: () => serverAvailable,
    log: line => lines.push(line),
    schedule: (callback, intervalMs) => {
      scheduledEveryMs = intervalMs;
      tick = callback;
      return timer;
    },
    cancel,
  });
  return {
    coordinator, lines, requestRecovery, cancel, timer,
    tick: () => tick(),
    scheduledEveryMs: () => scheduledEveryMs,
    setServerAvailable: (value: boolean) => { serverAvailable = value; },
  };
}

describe('Oxigraph WAL maintenance with the reopen off', () => {
  const GIB = 1024 ** 3;

  it('never pauses admission and never asks for a reopen, however large the log is', () => {
    let walBytes = 100 * WAL_GROWTH_NOTICE_BYTES;
    const { coordinator, tick, requestRecovery, lines } = controlledObserver({
      measureRetainedWalBytes: () => walBytes,
    });
    try {
      const lease = coordinator.registerActivity();
      for (let sample = 0; sample < 5; sample += 1) {
        lease.report(sample % 2 === 0);
        tick();
        walBytes += GIB;
        expect(coordinator.admissionsPaused()).toBe(false);
      }
      coordinator.serverLifecycleChanged('confirmed-reopen');
      lease.dispose();
      expect(coordinator.admissionsPaused()).toBe(false);
      expect(requestRecovery).not.toHaveBeenCalled();
      // The size was reported once: it never doubled.
      expect(lines).toHaveLength(1);
    } finally { coordinator.stop(); }
  });

  it('reports the retained log at the notice size and again each time it has doubled', () => {
    let walBytes = WAL_GROWTH_NOTICE_BYTES - 1;
    const { coordinator, tick, lines } = controlledObserver({ measureRetainedWalBytes: () => walBytes });
    try {
      tick();
      expect(lines).toEqual([]);

      walBytes = WAL_GROWTH_NOTICE_BYTES;
      tick();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('4.00 GiB of write-ahead log is retained');
      expect(lines[0]).toContain('the maintenance reopen is off');
      expect(lines[0]).toContain('store.options.walRestartThresholdBytes');

      walBytes = 2 * WAL_GROWTH_NOTICE_BYTES - 1;
      tick();
      tick();
      expect(lines).toHaveLength(1);

      walBytes = 2 * WAL_GROWTH_NOTICE_BYTES;
      tick();
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('8.00 GiB of write-ahead log is retained');

      // The next notice is measured from the size last reported, not from a fixed ladder.
      walBytes = 3 * WAL_GROWTH_NOTICE_BYTES;
      tick();
      expect(lines).toHaveLength(2);
      walBytes = 4 * WAL_GROWTH_NOTICE_BYTES;
      tick();
      expect(lines).toHaveLength(3);
    } finally { coordinator.stop(); }
  });

  it('starts the notices over after a reopen has truncated the log', () => {
    let walBytes = 3 * WAL_GROWTH_NOTICE_BYTES;
    const { coordinator, tick, lines } = controlledObserver({ measureRetainedWalBytes: () => walBytes });
    try {
      tick();
      expect(lines).toHaveLength(1);
      walBytes = 1024;
      tick();
      expect(lines).toHaveLength(1);
      // Without the reset this size would stay silent: it is below twice the last report.
      walBytes = WAL_GROWTH_NOTICE_BYTES + 1;
      tick();
      expect(lines).toHaveLength(2);
    } finally { coordinator.stop(); }
  });

  it('starts the notices over on a confirmed reopen, without a sample of the truncated log', () => {
    let walBytes = 4 * WAL_GROWTH_NOTICE_BYTES;
    const { coordinator, tick, lines } = controlledObserver({ measureRetainedWalBytes: () => walBytes });
    try {
      tick();
      expect(lines).toHaveLength(1);
      // The log was truncated and has grown past the notice size again before the next sample.
      coordinator.serverLifecycleChanged('confirmed-reopen');
      walBytes = WAL_GROWTH_NOTICE_BYTES + GIB;
      tick();
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('5.00 GiB of write-ahead log is retained');
      // Any other lifecycle change leaves the last report standing.
      coordinator.serverLifecycleChanged();
      tick();
      expect(lines).toHaveLength(2);
    } finally { coordinator.stop(); }
  });

  it('does not measure while the server is not available', () => {
    const measureRetainedWalBytes = vi.fn(() => 10 * WAL_GROWTH_NOTICE_BYTES);
    const { coordinator, tick, lines, setServerAvailable } = controlledObserver({ measureRetainedWalBytes });
    try {
      setServerAvailable(false);
      tick();
      expect(measureRetainedWalBytes).not.toHaveBeenCalled();
      expect(lines).toEqual([]);
      setServerAvailable(true);
      tick();
      expect(measureRetainedWalBytes).toHaveBeenCalledOnce();
      expect(lines).toHaveLength(1);
    } finally { coordinator.stop(); }
  });

  it('logs a failing measurement once per run of failures', () => {
    let fail = true;
    const { coordinator, tick, lines } = controlledObserver({
      measureRetainedWalBytes: () => {
        if (fail) throw new Error('EACCES: permission denied, scandir');
        return 0;
      },
    });
    try {
      tick(); tick(); tick();
      expect(lines).toEqual(['[oxigraph] retained WAL measurement failed: EACCES: permission denied, scandir']);
      fail = false;
      tick();
      fail = true;
      tick(); tick();
      expect(lines).toHaveLength(2);
    } finally { coordinator.stop(); }
  });

  it('samples once a minute by default and stops its timer once', () => {
    const { coordinator, scheduledEveryMs, timer, cancel, tick, lines } = controlledObserver({
      measureRetainedWalBytes: () => 10 * WAL_GROWTH_NOTICE_BYTES,
    });
    expect(scheduledEveryMs()).toBe(60_000);
    expect(timer.unref).toHaveBeenCalledOnce();
    coordinator.stop();
    coordinator.stop();
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith(timer);
    // A sample that was already queued when the node stopped reports nothing.
    tick();
    expect(lines).toEqual([]);
  });
});
