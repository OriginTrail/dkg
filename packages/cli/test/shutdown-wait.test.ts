import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  persistDaemonShutdownPolicy,
  resolveDaemonShutdownWaitTimeoutMs,
  waitForDaemonExit,
} from '../src/daemon/shutdown-wait.js';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';

const originalDkgHome = process.env.DKG_HOME;
const originalShutdownTimeout = process.env.DKG_SHUTDOWN_HARD_TIMEOUT_MS;
const temporaryHomes: string[] = [];

afterEach(async () => {
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
    await persistDaemonShutdownPolicy(resolveShutdownPolicy(
      process.env.DKG_SHUTDOWN_HARD_TIMEOUT_MS,
    ));

    process.env.DKG_SHUTDOWN_HARD_TIMEOUT_MS = '5000';
    await expect(resolveDaemonShutdownWaitTimeoutMs(process.pid)).resolves.toBe(61_000);
    await expect(resolveDaemonShutdownWaitTimeoutMs(process.pid + 1)).resolves.toBe(301_000);
  });

  it('falls back to the maximum valid bounded policy when captured state is absent', async () => {
    const dkgHome = await mkdtemp(join(tmpdir(), 'dkg-shutdown-policy-missing-'));
    temporaryHomes.push(dkgHome);
    process.env.DKG_HOME = dkgHome;
    await expect(resolveDaemonShutdownWaitTimeoutMs(process.pid)).resolves.toBe(301_000);
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
