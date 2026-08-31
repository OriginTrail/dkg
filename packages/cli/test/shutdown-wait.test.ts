import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  daemonRuntimeState,
  waitForDaemonExit,
} from '../src/daemon/shutdown-wait.js';
import { _autoUpdateIo } from '../src/daemon/manifest.js';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';

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
