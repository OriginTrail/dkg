import { describe, expect, it } from 'vitest';
import {
  resolveDaemonShutdownWaitTimeoutMs,
  waitForDaemonExit,
} from '../src/daemon/shutdown-wait.js';

describe('daemon lifecycle shutdown wait', () => {
  it('includes the worker hard timeout and forced-cleanup allowance', () => {
    expect(resolveDaemonShutdownWaitTimeoutMs(undefined)).toBe(16_000);
    expect(resolveDaemonShutdownWaitTimeoutMs('60000')).toBe(61_000);
  });

  it('reports a shutdown longer than 10s as successful within its configured budget', async () => {
    let elapsedMs = 0;
    const stopped = await waitForDaemonExit(42, {
      timeoutMs: resolveDaemonShutdownWaitTimeoutMs('60000'),
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
