import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stopDaemonIfRunning } from '../src/cli-helpers.js';
import { executeStopCommand } from '../src/commands/lifecycle.js';
import {
  createDaemonShutdownCoordinator,
  daemonRuntimeState,
  waitForDaemonExit,
} from '../src/daemon/shutdown-wait.js';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';

function simulatedExitWait(exitAfterMs: number | null): {
  elapsed: () => number;
  wait(pid: number, timeoutMs: number): Promise<boolean>;
} {
  let elapsedMs = 0;
  return {
    elapsed: () => elapsedMs,
    wait: (pid, timeoutMs) => waitForDaemonExit(pid, {
      timeoutMs,
      now: () => elapsedMs,
      sleep: async (ms) => { elapsedMs += ms; },
      isRunning: () => exitAfterMs === null || elapsedMs < exitAfterMs,
    }),
  };
}

describe('lifecycle command shutdown waits', () => {
  it('lets dkg stop complete after a simulated 30s drain under the captured 60s policy', async () => {
    const savedDkgHome = process.env.DKG_HOME;
    const savedTimeout = process.env.DKG_SHUTDOWN_HARD_TIMEOUT_MS;
    const dkgHome = await mkdtemp(join(tmpdir(), 'dkg-stop-captured-policy-'));
    const simulation = simulatedExitWait(30_000);
    const logs: string[] = [];
    let shutdownRequests = 0;
    try {
      process.env.DKG_HOME = dkgHome;
      process.env.DKG_SHUTDOWN_HARD_TIMEOUT_MS = '60000';
      await daemonRuntimeState.claim(process.pid, resolveShutdownPolicy(
        process.env.DKG_SHUTDOWN_HARD_TIMEOUT_MS,
      ));
      process.env.DKG_SHUTDOWN_HARD_TIMEOUT_MS = '5000';
      const coordinator = createDaemonShutdownCoordinator({
        runtimeState: daemonRuntimeState,
        isRunning: () => true,
        kill: () => {},
        waitForExit: simulation.wait,
      });

      await expect(executeStopCommand({
        connectApi: async () => ({
          shutdown: async () => { shutdownRequests += 1; },
        }),
        coordinator,
        log: (message) => logs.push(message),
        error: (message) => logs.push(message),
      })).resolves.toBe(true);
      await expect(daemonRuntimeState.readPolicy(process.pid)).resolves.toBeNull();
    } finally {
      if (savedDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = savedDkgHome;
      if (savedTimeout === undefined) delete process.env.DKG_SHUTDOWN_HARD_TIMEOUT_MS;
      else process.env.DKG_SHUTDOWN_HARD_TIMEOUT_MS = savedTimeout;
      await rm(dkgHome, { recursive: true, force: true });
    }

    expect(shutdownRequests).toBe(1);
    expect(simulation.elapsed()).toBe(30_000);
    expect(logs).toContain('Stopped.');
  });

  it('lets the update/rollback stop helper complete after the same 30s drain', async () => {
    const simulation = simulatedExitWait(30_000);
    const signals: NodeJS.Signals[] = [];
    const coordinator = createDaemonShutdownCoordinator({
      runtimeState: {
        readPid: async () => 42,
        resolveWaitTimeoutMs: async () => 61_000,
        release: async () => {},
      },
      isRunning: () => true,
      kill: (_pid, signal) => { signals.push(signal); },
      waitForExit: simulation.wait,
    });
    await expect(stopDaemonIfRunning({
      coordinator,
      log: () => {},
      error: () => {},
    })).resolves.toBe(true);

    expect(signals).toEqual(['SIGTERM']);
    expect(simulation.elapsed()).toBe(30_000);
  });

  it('reports the configured deadline when the shared stop helper never observes exit', async () => {
    const simulation = simulatedExitWait(null);
    const errors: string[] = [];
    const coordinator = createDaemonShutdownCoordinator({
      runtimeState: {
        readPid: async () => 42,
        resolveWaitTimeoutMs: async () => 1_250,
        release: async () => {},
      },
      isRunning: () => true,
      kill: () => {},
      waitForExit: simulation.wait,
    });
    await expect(stopDaemonIfRunning({
      coordinator,
      log: () => {},
      error: (message) => errors.push(message),
    })).resolves.toBe(false);

    expect(simulation.elapsed()).toBe(1_250);
    expect(errors).toEqual([
      'Daemon is still running after the configured shutdown deadline (1250ms).',
    ]);
  });

  it('fails dkg stop promptly on an auth rejection without entering completion wait', async () => {
    let waitCalls = 0;
    const coordinator = createDaemonShutdownCoordinator({
      runtimeState: {
        readPid: async () => 42,
        resolveWaitTimeoutMs: async () => 61_000,
        release: async () => {},
      },
      isRunning: () => true,
      kill: () => {},
      waitForExit: async () => { waitCalls += 1; return true; },
    });
    const unauthorized = Object.assign(new Error('Unauthorized'), { httpStatus: 401 });

    await expect(executeStopCommand({
      connectApi: async () => ({ shutdown: async () => { throw unauthorized; } }),
      coordinator,
      log: () => {},
      error: () => {},
    })).rejects.toBe(unauthorized);
    expect(waitCalls).toBe(0);
  });
});
