import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDaemonShutdownCoordinator,
  daemonRuntimeState,
  reportDaemonShutdownResult,
  waitForDaemonExit,
} from '../src/daemon/shutdown-wait.js';
import { _autoUpdateIo } from '../src/daemon/manifest.js';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';
import { stopDaemonIfRunning } from '../src/update/stop-daemon.js';

const originalDkgHome = process.env.DKG_HOME;
const originalShutdownTimeout = process.env.DKG_SHUTDOWN_HARD_TIMEOUT_MS;
const temporaryHomes: string[] = [];
const originalAtomicWriteIo = { ..._autoUpdateIo };

afterEach(async () => {
  Object.assign(_autoUpdateIo, originalAtomicWriteIo);
  if (originalDkgHome === undefined) delete process.env.DKG_HOME;
  else process.env.DKG_HOME = originalDkgHome;
  if (originalShutdownTimeout === undefined) delete process.env.DKG_SHUTDOWN_HARD_TIMEOUT_MS;
  else process.env.DKG_SHUTDOWN_HARD_TIMEOUT_MS = originalShutdownTimeout;
  await Promise.all(temporaryHomes.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe('daemon lifecycle shutdown wait', () => {
  it('rejects malformed and structurally invalid persisted policy state', async () => {
    const dkgHome = await mkdtemp(join(tmpdir(), 'dkg-shutdown-policy-invalid-'));
    temporaryHomes.push(dkgHome);
    process.env.DKG_HOME = dkgHome;

    await writeFile(join(dkgHome, 'shutdown-policy.json'), '{not-json', 'utf8');
    await expect(daemonRuntimeState.readPolicy(process.pid)).resolves.toBeNull();

    await writeFile(join(dkgHome, 'shutdown-policy.json'), JSON.stringify({
      version: 2,
      pid: process.pid,
      hardTimeoutMs: 60_000,
    }), 'utf8');
    await expect(daemonRuntimeState.readPolicy(process.pid)).resolves.toBeNull();
  });

  it('rolls back policy state when the PID claim cannot be written', async () => {
    const dkgHome = await mkdtemp(join(tmpdir(), 'dkg-shutdown-pid-claim-failure-'));
    temporaryHomes.push(dkgHome);
    process.env.DKG_HOME = dkgHome;
    await mkdir(join(dkgHome, 'daemon.pid'));

    await expect(
      daemonRuntimeState.claim(process.pid, resolveShutdownPolicy('60000')),
    ).rejects.toThrow();
    await expect(daemonRuntimeState.readPolicy(process.pid)).resolves.toBeNull();
  });

  it('surfaces non-ENOENT policy cleanup failures', async () => {
    const dkgHome = await mkdtemp(join(tmpdir(), 'dkg-shutdown-policy-cleanup-failure-'));
    temporaryHomes.push(dkgHome);
    process.env.DKG_HOME = dkgHome;
    await daemonRuntimeState.claim(process.pid, resolveShutdownPolicy('60000'));

    await chmod(dkgHome, 0o500);
    try {
      await expect(daemonRuntimeState.release(process.pid)).rejects.toThrow();
    } finally {
      await chmod(dkgHome, 0o700);
      await daemonRuntimeState.release(process.pid);
    }
  });

  it('uses the default timeout, clock, and process probe for an exited PID', async () => {
    const dkgHome = await mkdtemp(join(tmpdir(), 'dkg-shutdown-default-wait-'));
    temporaryHomes.push(dkgHome);
    process.env.DKG_HOME = dkgHome;
    await expect(waitForDaemonExit(9_999_999)).resolves.toBe(true);
  });

  it('signals and waits for a real owned child through the default coordinator I/O', async () => {
    const dkgHome = await mkdtemp(join(tmpdir(), 'dkg-shutdown-default-coordinator-'));
    temporaryHomes.push(dkgHome);
    process.env.DKG_HOME = dkgHome;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    try {
      await daemonRuntimeState.claim(child.pid!, resolveShutdownPolicy('5000'));
      await expect(stopDaemonIfRunning()).resolves.toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('reports a real default-coordinator timeout when a worker ignores SIGTERM', async () => {
    const dkgHome = await mkdtemp(join(tmpdir(), 'dkg-shutdown-default-timeout-'));
    temporaryHomes.push(dkgHome);
    process.env.DKG_HOME = dkgHome;
    const child = spawn(process.execPath, [
      '-e',
      "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once('data', () => resolve());
      child.once('error', reject);
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await daemonRuntimeState.claim(child.pid!, resolveShutdownPolicy('5000'));
      await expect(stopDaemonIfRunning()).resolves.toBe(false);
      expect(error).toHaveBeenCalledWith(
        'Daemon is still running after the configured shutdown deadline (6000ms).',
      );
    } finally {
      error.mockRestore();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await daemonRuntimeState.release(child.pid!).catch(() => undefined);
    }
  }, 10_000);

  it('classifies signal races, cleanup errors, and reporter cleanup diagnostics', async () => {
    const cleanupError = new Error('state cleanup failed');
    const cleanupFailure = createDaemonShutdownCoordinator({
      runtimeState: {
        readPid: async () => 42,
        resolveWaitTimeoutMs: async () => 1_000,
        release: async () => { throw cleanupError; },
      },
      isRunning: () => true,
      kill: () => {},
      waitForExit: async () => true,
    });
    const result = await cleanupFailure.stopViaSignal();
    expect(result).toEqual({
      status: 'stopped',
      pid: 42,
      timeoutMs: 1_000,
      cleanupError,
    });
    const errors: string[] = [];
    expect(reportDaemonShutdownResult(result, {
      log: () => {},
      error: (message) => errors.push(message),
    })).toBe(true);
    expect(errors).toEqual(['Daemon runtime-state cleanup error: state cleanup failed']);

    const signalRace = (code: string) => createDaemonShutdownCoordinator({
      runtimeState: {
        readPid: async () => 42,
        resolveWaitTimeoutMs: async () => 1_000,
        release: async () => {},
      },
      isRunning: () => true,
      kill: () => { throw Object.assign(new Error(code), { code }); },
      waitForExit: async () => true,
    });
    await expect(signalRace('ESRCH').stopViaSignal()).resolves.toMatchObject({ status: 'stopped' });
    await expect(signalRace('EACCES').stopViaSignal()).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('uses the worker-captured policy when the later command environment differs', async () => {
    const dkgHome = await mkdtemp(join(tmpdir(), 'dkg-shutdown-policy-state-'));
    temporaryHomes.push(dkgHome);
    process.env.DKG_HOME = dkgHome;
    process.env.DKG_SHUTDOWN_HARD_TIMEOUT_MS = '60000';
    await daemonRuntimeState.claim(process.pid, resolveShutdownPolicy(
      process.env.DKG_SHUTDOWN_HARD_TIMEOUT_MS,
    ));

    process.env.DKG_SHUTDOWN_HARD_TIMEOUT_MS = '5000';
    await expect(daemonRuntimeState.resolveWaitTimeoutMs(process.pid)).resolves.toBe(61_000);
    await expect(daemonRuntimeState.resolveWaitTimeoutMs(process.pid + 1)).resolves.toBe(301_000);
  });

  it('falls back to the maximum valid bounded policy when captured state is absent', async () => {
    const dkgHome = await mkdtemp(join(tmpdir(), 'dkg-shutdown-policy-missing-'));
    temporaryHomes.push(dkgHome);
    process.env.DKG_HOME = dkgHome;
    await expect(daemonRuntimeState.resolveWaitTimeoutMs(process.pid)).resolves.toBe(301_000);
  });

  it('lets only the owning PID consume and remove persisted policy', async () => {
    const dkgHome = await mkdtemp(join(tmpdir(), 'dkg-shutdown-policy-owner-'));
    temporaryHomes.push(dkgHome);
    process.env.DKG_HOME = dkgHome;
    await daemonRuntimeState.claim(process.pid, resolveShutdownPolicy('60000'));

    await expect(daemonRuntimeState.readPolicy(process.pid + 1)).resolves.toBeNull();
    await daemonRuntimeState.release(process.pid + 1);
    await expect(daemonRuntimeState.readPolicy(process.pid)).resolves.toEqual({
      hardTimeoutMs: 60_000,
    });

    await daemonRuntimeState.release(process.pid);
    await expect(daemonRuntimeState.readPolicy(process.pid)).resolves.toBeNull();
  });

  it('keeps the previous complete policy visible when an atomic replacement is interrupted', async () => {
    const dkgHome = await mkdtemp(join(tmpdir(), 'dkg-shutdown-policy-atomic-'));
    temporaryHomes.push(dkgHome);
    process.env.DKG_HOME = dkgHome;
    await daemonRuntimeState.claim(process.pid, resolveShutdownPolicy('60000'));

    const writes: string[] = [];
    const renames: Array<[string, string]> = [];
    _autoUpdateIo.writeFile = (async (path: unknown) => {
      writes.push(String(path));
    }) as typeof _autoUpdateIo.writeFile;
    _autoUpdateIo.rename = (async (from: unknown, to: unknown) => {
      renames.push([String(from), String(to)]);
      throw new Error('interrupted before replace');
    }) as typeof _autoUpdateIo.rename;
    _autoUpdateIo.unlink = (async () => {}) as typeof _autoUpdateIo.unlink;

    await expect(
      daemonRuntimeState.claim(process.pid, resolveShutdownPolicy('5000')),
    ).rejects.toThrow('interrupted before replace');
    expect(writes[0]).toMatch(/shutdown-policy\.json\.tmp\./u);
    expect(renames[0]?.[1]).toMatch(/shutdown-policy\.json$/u);
    await expect(daemonRuntimeState.readPolicy(process.pid)).resolves.toEqual({
      hardTimeoutMs: 60_000,
    });
  });

  it('reports a shutdown longer than 10s as successful within its configured budget', async () => {
    let elapsedMs = 0;
    const stopped = await waitForDaemonExit(42, {
      timeoutMs: 61_000,
      now: () => elapsedMs,
      sleep: async (ms) => { elapsedMs += ms; },
      isRunning: () => elapsedMs < 30_000,
    });

    expect(stopped).toBe(true);
    expect(elapsedMs).toBe(30_000);
  });

  it('remains bounded when the worker does not exit', async () => {
    let elapsedMs = 0;
    const stopped = await waitForDaemonExit(42, {
      timeoutMs: 1_250,
      pollIntervalMs: 500,
      now: () => elapsedMs,
      sleep: async (ms) => { elapsedMs += ms; },
      isRunning: () => true,
    });

    expect(stopped).toBe(false);
    expect(elapsedMs).toBe(1_250);
  });
});
