import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeSync, openSync, readFileSync, truncateSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { findListenOwnerPid } from '../src/daemon/oxigraph-listen-port.js';
import { startOxigraphServer } from '../src/daemon/oxigraph-server.js';
import {
  createOxigraphStandinFixture,
  fetchPid,
  freePort,
  portAnswers,
  sleep,
  waitForCondition,
  type OxigraphStandinFixture,
} from './fixtures/oxigraph-server-real-fixture.js';

let fixture: OxigraphStandinFixture;

beforeAll(async () => {
  fixture = await createOxigraphStandinFixture();
});

afterAll(async () => {
  await fixture.cleanup();
});

async function seedWal(location: string, bytes: number): Promise<void> {
  closeSync(openSync(join(location, '000001.log'), 'w'));
  // Sparse: costs no disk, reports `bytes` to the production scanner.
  truncateSync(join(location, '000001.log'), bytes);
}

function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

describe('startOxigraphServer WAL-aware readiness (GH#1400)', () => {
  it.each(['timeout', 'crash'] as const)('clears a draining WAL pause after %s recovery without restarting its replacement', async cause => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-wal-independent-'));
    let walBytes = 101;
    const lines: string[] = [];
    const handle = await startOxigraphServer({ binaryPath: fixture.binaryPath, location, port,
      log: line => lines.push(line), readyIntervalMs: 20, readyTimeoutMs: 5_000,
      restartBackoffBaseMs: 20, walRestartThresholdBytes: 100,
      walMaintenanceCheckIntervalMs: 20, walRestartIdleMs: 80, walRestartCooldownMs: 500,
      io: { measureRetainedWalBytes: () => walBytes },
    });
    const activity = handle.registerStoreActivity();
    try {
      activity.report(true);
      expect(await waitForCondition(() => handle.getRecoveryState().admissionsPaused === true)).toBe(true);
      const originalPid = await fetchPid(port);
      walBytes = 0;
      if (cause === 'timeout') expect(handle.requestRestart('query exceeded its client deadline')).toBe(true);
      else process.kill(originalPid, 'SIGKILL');
      expect(await waitForCondition(() => handle.getRecoveryState().generation > 0 && !handle.getRecoveryState().recovering)).toBe(true);
      expect(handle.getRecoveryState().admissionsPaused).toBe(false);
      const replacementPid = await fetchPid(port);
      expect(replacementPid).not.toBe(originalPid);
      activity.report(false);
      await sleep(150);
      expect(await fetchPid(port)).toBe(replacementPid);
      expect(lines.filter(line => line.includes('restart #'))).toHaveLength(1);
    } finally {
      activity.dispose(); await handle.stop(); await rm(location, { recursive: true, force: true });
    }
  });

  it('extends boot past the base and reports periodic replay progress', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-wal-auto-'));
    await seedWal(location, 41_943_040);

    let ownershipFrom: number | null = null;
    const withholdUntil = Date.now() + 2_000;
    const lines: string[] = [];
    const handle = await startOxigraphServer({
      binaryPath: fixture.binaryPath,
      location,
      port,
      log: (line) => lines.push(line),
      // The 250ms base cannot cover the 2s delay. The WAL-derived extension can.
      autoReadyBaseTimeoutMs: 250,
      readyIntervalMs: 100,
      progressLogIntervalMs: 200,
      io: {
        findListenOwnerPid: async (child) => {
          if (Date.now() < withholdUntil) return null;
          ownershipFrom = child.pid ?? null;
          return child.pid ?? null;
        },
      },
    });
    try {
      expect(ownershipFrom).not.toBeNull();
      expect(lines.join('\n')).toMatch(/still opening: .*40\.0 MiB of write-ahead log/);
    } finally {
      await handle.stop();
      await rm(location, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps an explicit boot timeout authoritative and warns about the short override', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-wal-explicit-'));
    await seedWal(location, 41_943_040);

    const lines: string[] = [];
    const withholdUntil = Date.now() + 5_000;
    await expect(startOxigraphServer({
      binaryPath: fixture.binaryPath,
      location,
      port,
      log: (line) => lines.push(line),
      readyTimeoutMs: 600,
      readyIntervalMs: 100,
      io: {
        findListenOwnerPid: async (child) =>
          (Date.now() < withholdUntil ? null : child.pid ?? null),
      },
    })).rejects.toThrow(/did not become ready/);

    expect(lines.join('\n')).toMatch(/below the ~\d+ms estimated to replay/);
    await rm(location, { recursive: true, force: true });
  }, 30_000);

  it('re-measures the WAL for restart and reports restart progress', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-wal-revive-'));
    let withholdUntil = 0;
    let spawns = 0;
    const lines: string[] = [];
    const { spawn: realSpawn } = await import('node:child_process');
    const handle = await startOxigraphServer({
      binaryPath: fixture.binaryPath,
      location,
      port,
      log: (line) => lines.push(line),
      autoReadyBaseTimeoutMs: 3_000,
      readyIntervalMs: 50,
      progressLogIntervalMs: 250,
      restartBackoffBaseMs: 100,
      restartBackoffMaxMs: 100,
      io: {
        spawn: ((command: string, args: string[], options: object) => {
          spawns += 1;
          return realSpawn(command, args, options as never);
        }) as never,
        findListenOwnerPid: async (child) =>
          (Date.now() < withholdUntil ? null : child.pid ?? null),
      },
    });
    try {
      const pid1 = await fetchPid(port);
      expect(spawns).toBe(1);
      await seedWal(location, 41_943_040);
      withholdUntil = Date.now() + 8_000;
      process.kill(pid1, 'SIGKILL');

      const healthy = await waitForCondition(async () => {
        const state = handle.getRecoveryState();
        return !state.recovering
          && state.generation > 0
          && Date.now() >= withholdUntil
          && (await fetchPid(port).catch(() => pid1)) !== pid1;
      }, 20_000);
      expect(healthy, 'supervisor never brought a new child to healthy').toBe(true);
      expect(spawns, 'supervisor killed a healthy replay and spawned again').toBe(2);
      expect(lines.join('\n')).toMatch(
        /restart: 40\.0 MiB of retained write-ahead log to replay; allowing up to 1\ds\./,
      );
      expect(lines.join('\n')).toMatch(/restart still opening:/);
    } finally {
      await handle.stop();
      await rm(location, { recursive: true, force: true });
    }
  }, 40_000);

  it('uses explicit readyTimeoutMs on every supervised restart attempt', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-wal-revive-explicit-'));
    let withholdUntil = 0;
    let spawns = 0;
    const lines: string[] = [];
    const { spawn: realSpawn } = await import('node:child_process');
    const handle = await startOxigraphServer({
      binaryPath: fixture.binaryPath,
      location,
      port,
      log: (line) => lines.push(line),
      readyTimeoutMs: 600,
      readyIntervalMs: 50,
      restartBackoffBaseMs: 100,
      restartBackoffMaxMs: 100,
      io: {
        spawn: ((command: string, args: string[], options: object) => {
          spawns += 1;
          return realSpawn(command, args, options as never);
        }) as never,
        findListenOwnerPid: async (child) =>
          (Date.now() < withholdUntil ? null : child.pid ?? null),
      },
    });
    try {
      const pid1 = await fetchPid(port);
      await seedWal(location, 41_943_040);
      withholdUntil = Date.now() + 2_000;
      process.kill(pid1, 'SIGKILL');

      const retried = await waitForCondition(() => spawns >= 3, 5_000);
      expect(retried, 'restart inherited the longer automatic WAL allowance').toBe(true);
      expect(Date.now()).toBeLessThan(withholdUntil);
      expect(lines.join('\n')).toMatch(/configured readyTimeoutMs=600ms is below/);
    } finally {
      await handle.stop();
      await rm(location, { recursive: true, force: true });
    }
  }, 20_000);

  it('suppresses replay progress when no WAL exists and releases a failed-boot reaper', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-wal-none-'));
    const exitListenersBefore = process.listenerCount('exit');
    const lines: string[] = [];
    const started = Date.now();
    await expect(startOxigraphServer({
      binaryPath: fixture.binaryPath,
      location,
      port,
      log: (line) => lines.push(line),
      autoReadyBaseTimeoutMs: 500,
      readyIntervalMs: 100,
      progressLogIntervalMs: 100,
      io: { findListenOwnerPid: async () => null },
    })).rejects.toThrow(/did not become ready/);
    expect(process.listenerCount('exit')).toBe(exitListenersBefore);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(lines.join('\n')).not.toMatch(/still opening:/);
    expect(await portAnswers(port)).toBe(false);
    await rm(location, { recursive: true, force: true });
  }, 30_000);

  it('reaps the real server when its parent exits during readiness', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-wal-exit-reaper-'));
    const pidFile = join(location, 'server.pid');
    const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));
    const parentFixture = fileURLToPath(
      new URL('./fixtures/oxigraph-exit-reaper-parent.ts', import.meta.url),
    );
    const parent = spawn(tsx, [
      parentFixture,
      fixture.binaryPath,
      location,
      String(port),
      pidFile,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    parent.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    const parentExitPromise = new Promise<number | null>((resolve, reject) => {
      parent.once('error', reject);
      parent.once('exit', (code) => resolve(code));
    });

    try {
      const wrotePid = await waitForCondition(() => {
        try {
          const pid = Number(readFileSync(pidFile, 'utf8'));
          return Number.isInteger(pid) && pid > 0;
        } catch {
          return false;
        }
      }, 10_000);
      expect(wrotePid, `parent never observed the server: ${stderr}`).toBe(true);
      const serverPid = Number(readFileSync(pidFile, 'utf8'));

      const parentExit = await parentExitPromise;
      expect(parentExit, stderr).toBe(0);
      const reaped = await waitForCondition(
        async () => pidIsGone(serverPid) && !(await portAnswers(port)),
        5_000,
      );
      expect(reaped, `server pid ${serverPid} survived its parent`).toBe(true);
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
      await rm(location, { recursive: true, force: true });
    }
  }, 30_000);
});

function startOpts(port: number, extra: Record<string, unknown> = {}) {
  return {
    binaryPath: fixture.binaryPath, location: fixture.directory, port,
    readyTimeoutMs: 5_000, readyIntervalMs: 50, stopGraceMs: 1_000,
    restartBackoffBaseMs: 100, restartBackoffMaxMs: 200, log: () => {}, ...extra,
  } as { binaryPath: string; location: string; port: number } & Record<string, unknown>;
}

describe('managed WAL maintenance supervision (GH#2395)', () => {
  it('leaves a server without a configured threshold alone and only reports its retained WAL', async () => {
    const port = await freePort();
    const logs: string[] = [];
    let measurements = 0;
    const handle = await startOxigraphServer(startOpts(port, {
      log: (line: string) => logs.push(line),
      // No walRestartThresholdBytes: the maintenance reopen is opt-in.
      walMaintenanceCheckIntervalMs: 20,
      walRestartIdleMs: 40,
      walRestartCooldownMs: 60,
      io: {
        measureRetainedWalBytes: () => {
          measurements += 1;
          return 64 * 1024 ** 3;
        },
      },
    }));
    try {
      const firstPid = await fetchPid(port);
      const activity = handle.registerStoreActivity();
      // Idle, then busy, then idle again: with a threshold of 100 bytes the test
      // below reopens the server inside this window.
      await sleep(120);
      activity.report(true);
      await sleep(60);
      activity.report(false);
      await sleep(240);
      activity.dispose();
      expect(measurements).toBeGreaterThanOrEqual(5);
      expect(handle.getRecoveryState()).toEqual({
        recovering: false,
        admissionsPaused: false,
        generation: 0,
      });
      expect(await fetchPid(port)).toBe(firstPid);
      expect(logs.filter(line => line.includes('restart #'))).toEqual([]);
      expect(logs.filter(line => line.includes('maintenance threshold'))).toEqual([]);
      // The size is said once; it has not doubled since.
      expect(logs.filter(line => line.includes('of write-ahead log is retained'))).toEqual([
        '[oxigraph] 64.00 GiB of write-ahead log is retained and it grows until the store is reopened; '
        + 'the maintenance reopen is off. A restart of the node reclaims it. '
        + 'Set store.options.walRestartThresholdBytes to have the node reopen the store at a size you choose.',
      ]);
    } finally {
      await handle.stop();
    }
    const measurementsAfterStop = measurements;
    await sleep(100);
    expect(measurements).toBe(measurementsAfterStop);
  });

  it('measures retained WAL under load and reopens only after store work stays idle', async () => {
    const port = await freePort();
    const logs: string[] = [];
    let measurements = 0;
    const handle = await startOxigraphServer(startOpts(port, {
      log: (line: string) => logs.push(line),
      walRestartThresholdBytes: 100,
      walMaintenanceCheckIntervalMs: 20,
      walRestartIdleMs: 80,
      walRestartCooldownMs: 60_000,
      io: {
        measureRetainedWalBytes: () => {
          measurements += 1;
          return measurements === 1 ? 0 : 101;
        },
      },
    }));
    try {
      const firstPid = await fetchPid(port);
      const activity = handle.registerStoreActivity();
      activity.report(true);
      await sleep(180);
      expect(await fetchPid(port)).toBe(firstPid);
      expect(measurements).toBeGreaterThanOrEqual(2);
      // The child is alive and still answering admitted work; only new work is
      // refused, so this is an admission pause and not a recovery.
      expect(handle.getRecoveryState()).toEqual({
        recovering: false,
        admissionsPaused: true,
        generation: 0,
      });

      activity.report(false);
      await sleep(40);
      expect(await fetchPid(port)).toBe(firstPid);
      let replacementPid = firstPid;
      for (let i = 0; i < 100; i++) {
        await sleep(30);
        try {
          replacementPid = await fetchPid(port);
          if (replacementPid !== firstPid) break;
        } catch {
          /* supervised reopen is between processes */
        }
      }
      expect(replacementPid).not.toBe(firstPid);
      expect(logs.join('\n')).toContain(
        '101 B retained WAL reached the 100 B maintenance threshold',
      );
    } finally {
      await handle.stop();
    }
    const measurementsAfterStop = measurements;
    await sleep(100);
    expect(measurements).toBe(measurementsAfterStop);
  });

  it.each(['ownership', 'signal'] as const)(
    'resumes WAL maintenance after a %s verification cancellation',
    async (failureMode) => {
      const port = await freePort();
      const logs: string[] = [];
      let rejectOwnership = false;
      let rejectSignal = false;
      let signalAttempts = 0;
      const handle = await startOxigraphServer(startOpts(port, {
        log: (line: string) => logs.push(line),
        walRestartThresholdBytes: 100,
        walMaintenanceCheckIntervalMs: 20,
        walRestartIdleMs: 40,
        walRestartCooldownMs: 80,
        io: {
          measureRetainedWalBytes: () => 101,
          findListenOwnerPid: async (child, listenerPort, host, ownership) => {
            const actual = await findListenOwnerPid(child, listenerPort, host, ownership);
            return failureMode === 'ownership' && rejectOwnership && actual !== null
              ? actual + 100_000
              : actual;
          },
          killProcess: vi.fn((pid: number, signal: NodeJS.Signals) => {
            signalAttempts += 1;
            if (failureMode === 'signal' && rejectSignal) return false;
            return process.kill(pid, signal);
          }) as unknown as typeof process.kill,
        },
      }));
      try {
        rejectOwnership = true;
        rejectSignal = true;
        const initialPid = await fetchPid(port);
        for (let i = 0; i < 100; i += 1) {
          const cancellations = logs.filter((line) => line.includes(
            failureMode === 'ownership'
              ? 'ownership changed'
              : 'could not signal the verified listener',
          )).length;
          if (cancellations >= 2) break;
          await sleep(20);
        }
        const cancellations = logs.filter((line) => line.includes(
          failureMode === 'ownership'
            ? 'ownership changed'
            : 'could not signal the verified listener',
        )).length;
        expect(cancellations).toBeGreaterThanOrEqual(2);
        expect(await fetchPid(port)).toBe(initialPid);
        // The threshold remains armed: new store work stays fail-closed while
        // the coordinator retries the verified restart. The child is still
        // alive, so this is an admission pause and not a recovery.
        expect(handle.getRecoveryState()).toEqual({
          recovering: false,
          admissionsPaused: true,
          generation: 0,
        });
        if (failureMode === 'signal') expect(signalAttempts).toBeGreaterThanOrEqual(2);

        rejectOwnership = false;
        rejectSignal = false;
        let replacementPid = initialPid;
        for (let i = 0; i < 100; i += 1) {
          await sleep(30);
          try {
            replacementPid = await fetchPid(port);
            if (replacementPid !== initialPid) break;
          } catch {
            /* supervised reopen is between processes */
          }
        }
        expect(replacementPid).not.toBe(initialPid);
        for (let i = 0; i < 50 && handle.getRecoveryState().recovering; i += 1) {
          await sleep(20);
        }
        expect(handle.getRecoveryState())
        .toEqual({ recovering: false, admissionsPaused: false, generation: 1 });
      } finally {
        await handle.stop();
      }
    },
  );
});
