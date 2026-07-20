/**
 * Runtime store monitor (store.monitor.*) — unit tests.
 *
 * Store-survivability build (2026-07-18 mainnet wedge incident). The
 * monitor's job: detect the alive-but-deaf Blazegraph failure mode
 * (JVM up, HTTP poller thread OOME-killed, ASK never answers) and issue
 * ONE bounded `docker restart` per cooldown window — never rm/recreate,
 * never anything for operator-managed stores.
 *
 * Driven via injected `now()` + manual `tick()` — no fake timers needed.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createStoreRuntimeMonitor,
  attemptManagedStoreBootRecovery,
  STORE_BOOT_RESTART_TS_FILENAME,
  STORE_HARDEN_LOCK_FILENAME,
  storeHardenLockPath,
  type StoreMonitorStats,
} from '../src/daemon/store-runtime-monitor.js';
import type { DockerRunner } from '../src/daemon/blazegraph-docker.js';

const CONTAINER = 'dkg-blazegraph-dkg';
const STORE_CONFIG = {
  backend: 'blazegraph',
  options: {
    managedByDkg: true,
    url: 'http://127.0.0.1:9999/bigdata/namespace/dkg/sparql',
  },
};

function mockDocker(exitCode = 0) {
  const calls: string[][] = [];
  const runner: DockerRunner = {
    async run(args) {
      calls.push([...args]);
      return { stdout: '', stderr: exitCode === 0 ? '' : 'engine sad', exitCode };
    },
  };
  return { runner, calls };
}

/** Fetch whose health answer is flipped per test via `state.ok`. */
function switchableFetch() {
  const state = { ok: false, pending: false };
  let release: (() => void) | null = null;
  const calls: string[] = [];
  const fn: typeof globalThis.fetch = (async (input: any) => {
    calls.push(String(input));
    if (state.pending) {
      await new Promise<void>((resolve) => { release = resolve; });
    }
    return state.ok
      ? new Response(JSON.stringify({ boolean: true }), { status: 200 })
      : new Response('dead', { status: 503 });
  }) as typeof globalThis.fetch;
  return { fn, state, calls, releasePending: () => release?.() };
}

function makeMonitor(overrides: Partial<Parameters<typeof createStoreRuntimeMonitor>[0]> = {}) {
  const { runner, calls: dockerCalls } = mockDocker();
  const fetch = switchableFetch();
  const logs: string[] = [];
  const clock = { t: 1_000_000 };
  const monitor = createStoreRuntimeMonitor({
    storeConfig: STORE_CONFIG,
    managedContainerName: CONTAINER,
    docker: runner,
    fetch: fetch.fn,
    log: (m) => logs.push(m),
    now: () => clock.t,
    ...overrides,
  });
  return { monitor, dockerCalls, fetch, logs, clock };
}

const restartCalls = (calls: string[][]) => calls.filter((c) => c[0] === 'restart');

describe('createStoreRuntimeMonitor', () => {
  afterEach(() => {
    delete process.env.DKG_STORE_MONITOR_FAILURE_THRESHOLD;
    delete process.env.DKG_STORE_MONITOR_INTERVAL_MS;
    delete process.env.DKG_STORE_MONITOR_RESTART_COOLDOWN_MS;
  });

  it('issues exactly one bounded docker restart after 6 consecutive failures', async () => {
    const { monitor, dockerCalls } = makeMonitor();
    for (let i = 0; i < 6; i++) await monitor.tick();
    expect(restartCalls(dockerCalls)).toEqual([['restart', '-t', '30', CONTAINER]]);
    expect(monitor.stats.restartsTotal).toBe(1);
    expect(monitor.stats.consecutiveFailures).toBe(0);
    // Restart-ONLY: the monitor must never rm/recreate/touch volumes.
    expect(dockerCalls.every((c) => c[0] === 'restart')).toBe(true);
  });

  it('a success at failure #5 resets the counter — no restart', async () => {
    const { monitor, dockerCalls, fetch, logs } = makeMonitor();
    for (let i = 0; i < 5; i++) await monitor.tick();
    expect(monitor.stats.consecutiveFailures).toBe(5);
    fetch.state.ok = true;
    await monitor.tick();
    expect(monitor.stats.consecutiveFailures).toBe(0);
    expect(logs.some((l) => l.includes('store recovered after 5 failed probe(s)'))).toBe(true);
    fetch.state.ok = false;
    for (let i = 0; i < 5; i++) await monitor.tick();
    expect(restartCalls(dockerCalls)).toHaveLength(0);
    // The 6th consecutive failure after the reset does restart.
    await monitor.tick();
    expect(restartCalls(dockerCalls)).toHaveLength(1);
  });

  it('never restarts twice inside the cooldown, then restarts on the first tick after expiry', async () => {
    const { monitor, dockerCalls, logs, clock } = makeMonitor();
    for (let i = 0; i < 6; i++) await monitor.tick();
    expect(restartCalls(dockerCalls)).toHaveLength(1);
    expect(monitor.stats.cooldownUntilMs).toBe(clock.t + 600_000);

    // Store stays dead through the whole 10-min cooldown: counter re-fills
    // and caps at the threshold, but no second restart fires.
    for (let i = 0; i < 12; i++) {
      clock.t += 30_000;
      await monitor.tick();
    }
    expect(restartCalls(dockerCalls)).toHaveLength(1);
    expect(monitor.stats.consecutiveFailures).toBe(6);
    expect(logs.some((l) => l.includes('store.monitor.cooldown-wait'))).toBe(true);

    // First tick past cooldown expiry restarts immediately (capped counter).
    clock.t += 600_000;
    await monitor.tick();
    expect(restartCalls(dockerCalls)).toHaveLength(2);
  });

  it('recovery after failures resets state and logs store.monitor recovered', async () => {
    const { monitor, fetch, logs } = makeMonitor();
    for (let i = 0; i < 3; i++) await monitor.tick();
    fetch.state.ok = true;
    await monitor.tick();
    expect(monitor.stats.consecutiveFailures).toBe(0);
    expect(monitor.stats.lastProbeOkAt).not.toBeNull();
    expect(logs.some((l) => l.includes('[store.monitor] store recovered'))).toBe(true);
  });

  it('never touches docker for a non-managed store and logs unhealthy loudly', async () => {
    const { monitor, dockerCalls, logs } = makeMonitor({ managedContainerName: null });
    for (let i = 0; i < 12; i++) await monitor.tick();
    expect(dockerCalls).toHaveLength(0);
    const unhealthy = logs.filter((l) => l.includes('store.monitor.unhealthy'));
    // Re-alerted at each threshold multiple (6th and 12th failure), not every tick.
    expect(unhealthy).toHaveLength(2);
    expect(unhealthy[0]).toContain('manual intervention required');
    expect(unhealthy[0]).toContain('http://127.0.0.1:9999/bigdata/namespace/dkg/sparql');
  });

  it('skips overlapping ticks while a probe is in flight', async () => {
    const { monitor, fetch } = makeMonitor();
    fetch.state.pending = true;
    const first = monitor.tick();
    await new Promise((r) => setTimeout(r, 10)); // let the probe reach fetch
    await monitor.tick(); // must be a no-op
    expect(fetch.calls).toHaveLength(1);
    fetch.releasePending();
    await first;
    expect(monitor.stats.probesTotal).toBe(1);
  });

  it('stats object matches the StoreMonitorStats shape across transitions', async () => {
    const { monitor, fetch, clock } = makeMonitor();
    const expectShape = (s: StoreMonitorStats) => {
      expect(Object.keys(s).sort()).toEqual([
        'consecutiveFailures', 'cooldownUntilMs', 'failuresTotal', 'lastProbeOkAt',
        'lastRestartAt', 'managedContainer', 'probesTotal', 'restartFailuresTotal',
        'restartsTotal',
      ]);
    };
    expectShape(monitor.stats);
    expect(monitor.stats.managedContainer).toBe(CONTAINER);
    await monitor.tick();
    expectShape(monitor.stats);
    expect(monitor.stats).toMatchObject({ probesTotal: 1, failuresTotal: 1, consecutiveFailures: 1 });
    fetch.state.ok = true;
    await monitor.tick();
    expectShape(monitor.stats);
    expect(monitor.stats).toMatchObject({
      probesTotal: 2, failuresTotal: 1, consecutiveFailures: 0, lastProbeOkAt: clock.t,
    });
  });

  it('honours DKG_STORE_MONITOR_FAILURE_THRESHOLD and _RESTART_COOLDOWN_MS env overrides', async () => {
    process.env.DKG_STORE_MONITOR_FAILURE_THRESHOLD = '2';
    process.env.DKG_STORE_MONITOR_RESTART_COOLDOWN_MS = '1234';
    const { monitor, dockerCalls, clock } = makeMonitor();
    await monitor.tick();
    expect(restartCalls(dockerCalls)).toHaveLength(0);
    await monitor.tick();
    expect(restartCalls(dockerCalls)).toHaveLength(1);
    expect(monitor.stats.cooldownUntilMs).toBe(clock.t + 1234);
  });

  it('honours DKG_STORE_MONITOR_INTERVAL_MS for the timer cadence', () => {
    process.env.DKG_STORE_MONITOR_INTERVAL_MS = '12345';
    const spy = vi.spyOn(globalThis, 'setInterval');
    const { monitor } = makeMonitor();
    try {
      monitor.start();
      expect(spy).toHaveBeenCalledWith(expect.any(Function), 12345);
      // start() is idempotent — a second call must not stack timers.
      monitor.start();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      monitor.stop();
      spy.mockRestore();
    }
  });

  it('keeps counting cooldown from a failed restart attempt too', async () => {
    const { runner, calls } = mockDocker(1); // docker restart fails
    const { monitor, clock } = makeMonitor({ docker: runner });
    for (let i = 0; i < 6; i++) await monitor.tick();
    expect(restartCalls(calls)).toHaveLength(1);
    expect(monitor.stats.restartsTotal).toBe(0); // failed restart is not a restart
    expect(monitor.stats.restartFailuresTotal).toBe(1);
    expect(monitor.stats.cooldownUntilMs).toBe(clock.t + 600_000);
  });

  it('catches a REJECTING docker runner (spawn error) — logs + counts, never escapes the tick', async () => {
    // defaultDockerRunner.run rejects on spawn errors (ENOENT / EMFILE);
    // the tick runs from `void tick()` on a timer, so an escaped rejection
    // would hit the daemon's unhandledRejection handler. The awaits below
    // would reject if the tick let it escape.
    const rejectingRunner: DockerRunner = {
      async run() { throw new Error('spawn docker EMFILE'); },
    };
    const { monitor, logs, clock } = makeMonitor({ docker: rejectingRunner });
    for (let i = 0; i < 6; i++) await monitor.tick();
    expect(monitor.stats.restartsTotal).toBe(0);
    expect(monitor.stats.restartFailuresTotal).toBe(1);
    expect(logs.some((l) => l.includes('store.monitor.restart-failed'))).toBe(true);
    expect(logs.some((l) => l.includes('spawn docker EMFILE'))).toBe(true);
    // Cooldown still starts so a broken engine is not hammered.
    expect(monitor.stats.cooldownUntilMs).toBe(clock.t + 600_000);
  });

  describe('harden-lock suspension (BLOCKER-1a)', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dkg-monitor-lock-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('suspends ALL docker restarts while the harden lock exists, resumes once it clears', async () => {
      const lockPath = storeHardenLockPath(dir);
      expect(lockPath.endsWith(STORE_HARDEN_LOCK_FILENAME)).toBe(true);
      writeFileSync(lockPath, '{"pid":123}\n');
      const { monitor, dockerCalls, logs } = makeMonitor({ hardenLockPath: lockPath });
      // Well past the threshold: without the lock this would have restarted.
      for (let i = 0; i < 12; i++) await monitor.tick();
      expect(restartCalls(dockerCalls)).toHaveLength(0);
      expect(logs.some((l) => l.includes('store.monitor.suspended-by-harden'))).toBe(true);
      // Lock cleared (harden's finally) → the very next failing tick restarts.
      rmSync(lockPath);
      await monitor.tick();
      expect(restartCalls(dockerCalls)).toHaveLength(1);
    });

    it('ignores a stale lock left by a crashed harden (> 6h old) and restarts', async () => {
      const lockPath = storeHardenLockPath(dir);
      writeFileSync(lockPath, '{"pid":123}\n');
      const old = (Date.now() - 7 * 60 * 60 * 1000) / 1000;
      utimesSync(lockPath, old, old);
      const { monitor, dockerCalls, logs } = makeMonitor({ hardenLockPath: lockPath });
      for (let i = 0; i < 6; i++) await monitor.tick();
      expect(restartCalls(dockerCalls)).toHaveLength(1);
      expect(logs.some((l) => l.includes('store.monitor.harden-lock-stale'))).toBe(true);
    });
  });
});

describe('attemptManagedStoreBootRecovery', () => {
  it('returns true when the store answers after one restart', async () => {
    const { runner, calls } = mockDocker();
    const fetch = switchableFetch();
    fetch.state.ok = true;
    const logs: string[] = [];
    await expect(attemptManagedStoreBootRecovery({
      storeConfig: STORE_CONFIG,
      managedContainerName: CONTAINER,
      docker: runner,
      fetch: fetch.fn,
      log: (m) => logs.push(m),
      readyTimeoutMs: 100,
      pollIntervalMs: 1,
    })).resolves.toBe(true);
    expect(restartCalls(calls)).toEqual([['restart', '-t', '30', CONTAINER]]);
    expect(logs.some((l) => l.includes('boot-recovery succeeded'))).toBe(true);
  });

  it('returns false after the ready timeout with exactly one restart issued', async () => {
    const { runner, calls } = mockDocker();
    const fetch = switchableFetch(); // stays unhealthy
    const logs: string[] = [];
    await expect(attemptManagedStoreBootRecovery({
      storeConfig: STORE_CONFIG,
      managedContainerName: CONTAINER,
      docker: runner,
      fetch: fetch.fn,
      log: (m) => logs.push(m),
      readyTimeoutMs: 30,
      pollIntervalMs: 1,
    })).resolves.toBe(false);
    expect(restartCalls(calls)).toHaveLength(1);
    expect(logs.some((l) => l.includes('boot-recovery failed'))).toBe(true);
  });

  it('returns false immediately when the docker restart itself fails', async () => {
    const { runner, calls } = mockDocker(1);
    const fetch = switchableFetch();
    fetch.state.ok = true;
    await expect(attemptManagedStoreBootRecovery({
      storeConfig: STORE_CONFIG,
      managedContainerName: CONTAINER,
      docker: runner,
      fetch: fetch.fn,
      log: () => {},
    })).resolves.toBe(false);
    expect(restartCalls(calls)).toHaveLength(1);
    expect(fetch.calls).toHaveLength(0); // no probe after a failed restart
  });

  it('returns false (no probe) when the docker restart REJECTS (spawn error)', async () => {
    const rejectingRunner: DockerRunner = {
      async run() { throw new Error('spawn docker ENOENT'); },
    };
    const fetch = switchableFetch();
    fetch.state.ok = true;
    const logs: string[] = [];
    await expect(attemptManagedStoreBootRecovery({
      storeConfig: STORE_CONFIG,
      managedContainerName: CONTAINER,
      docker: rejectingRunner,
      fetch: fetch.fn,
      log: (m) => logs.push(m),
    })).resolves.toBe(false);
    expect(logs.some((l) => l.includes('boot-recovery restart failed'))).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });

  describe('cross-process boot-restart cooldown (MAJOR-2)', () => {
    let dir: string;
    let tsPath: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'dkg-boot-cooldown-'));
      tsPath = join(dir, STORE_BOOT_RESTART_TS_FILENAME);
    });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    const recoveryOpts = (runner: DockerRunner, fetchFn: typeof globalThis.fetch, logs: string[]) => ({
      storeConfig: STORE_CONFIG,
      managedContainerName: CONTAINER,
      docker: runner,
      fetch: fetchFn,
      log: (m: string) => logs.push(m),
      restartCooldownFilePath: tsPath,
      readyTimeoutMs: 40,
      pollIntervalMs: 1,
    });

    it('skips the container restart while the last attempt is fresh, but still waits for the store', async () => {
      writeFileSync(tsPath, `${Date.now()}\n`);
      const { runner, calls } = mockDocker();
      const fetch = switchableFetch();
      fetch.state.ok = true; // container finishes its own cold start
      const logs: string[] = [];
      await expect(attemptManagedStoreBootRecovery(recoveryOpts(runner, fetch.fn, logs)))
        .resolves.toBe(true);
      expect(restartCalls(calls)).toHaveLength(0);
      expect(logs.some((l) => l.includes('boot-recovery restart skipped'))).toBe(true);
      expect(logs.some((l) => l.includes('came up on its own'))).toBe(true);
    });

    it('during the cooldown a still-dead store reports failure WITHOUT kicking the container', async () => {
      writeFileSync(tsPath, `${Date.now()}\n`);
      const { runner, calls } = mockDocker();
      const fetch = switchableFetch(); // stays unhealthy
      const logs: string[] = [];
      await expect(attemptManagedStoreBootRecovery(recoveryOpts(runner, fetch.fn, logs)))
        .resolves.toBe(false);
      expect(restartCalls(calls)).toHaveLength(0); // never restarted mid-cold-start
      expect(logs.some((l) => l.includes('boot-recovery failed'))).toBe(true);
    });

    it('restarts again once the last attempt is older than the cooldown, refreshing the timestamp', async () => {
      const before = Date.now() - 31 * 60_000;
      writeFileSync(tsPath, `${before}\n`);
      const { runner, calls } = mockDocker();
      const fetch = switchableFetch();
      fetch.state.ok = true;
      const logs: string[] = [];
      await expect(attemptManagedStoreBootRecovery(recoveryOpts(runner, fetch.fn, logs)))
        .resolves.toBe(true);
      expect(restartCalls(calls)).toHaveLength(1);
      const persisted = Number.parseInt(readFileSync(tsPath, 'utf-8').trim(), 10);
      expect(persisted).toBeGreaterThan(before);
    });

    it('an unparseable or missing timestamp file does not block the restart', async () => {
      writeFileSync(tsPath, 'not-a-number\n');
      const { runner, calls } = mockDocker();
      const fetch = switchableFetch();
      fetch.state.ok = true;
      await expect(attemptManagedStoreBootRecovery(recoveryOpts(runner, fetch.fn, [])))
        .resolves.toBe(true);
      expect(restartCalls(calls)).toHaveLength(1);
    });

    it('never restarts at boot while the harden lock exists (polls only)', async () => {
      const lockPath = storeHardenLockPath(dir);
      writeFileSync(lockPath, '{"pid":123}\n');
      const { runner, calls } = mockDocker();
      const fetch = switchableFetch(); // dead — harden holds the store stopped
      const logs: string[] = [];
      await expect(attemptManagedStoreBootRecovery({
        ...recoveryOpts(runner, fetch.fn, logs),
        hardenLockPath: lockPath,
      })).resolves.toBe(false);
      expect(restartCalls(calls)).toHaveLength(0);
      expect(logs.some((l) => l.includes('store.monitor.suspended-by-harden'))).toBe(true);
    });
  });
});
