import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeSync, openSync, readFileSync, truncateSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startOxigraphServer } from '../src/daemon/oxigraph-server.js';
import {
  createOxigraphStandinFixture,
  fetchPid,
  freePort,
  portAnswers,
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
