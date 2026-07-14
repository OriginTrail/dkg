import { describe, expect, it, vi } from 'vitest';
import {
  cleanupDaemonWorker,
  type WorkerCleanupPolicyIo,
} from '../src/daemon/worker-cleanup-policy.js';

const emptyGroup = {
  applicable: true,
  termSent: false,
  killSent: false,
  empty: true,
};

function policyIo(
  overrides: Partial<WorkerCleanupPolicyIo> = {},
): WorkerCleanupPolicyIo {
  return {
    loadConfig: async () => ({ store: { backend: 'oxigraph' } }),
    reapWorkerProcessGroup: async () => emptyGroup,
    waitForTcpPortRelease: async () => true,
    warn: () => {},
    now: Date.now,
    ...overrides,
  };
}

describe('daemon worker cleanup policy', () => {
  it('permits replacement after an unmanaged worker group is empty', async () => {
    const waitForTcpPortRelease = vi.fn(async () => true);
    await expect(cleanupDaemonWorker(
      42,
      { code: 1, signal: null },
      policyIo({ waitForTcpPortRelease }),
    )).resolves.toBe(true);
    expect(waitForTcpPortRelease).not.toHaveBeenCalled();
  });

  it('waits for the configured managed Oxigraph port before replacement', async () => {
    const waitForTcpPortRelease = vi.fn(async () => true);
    await expect(cleanupDaemonWorker(
      42,
      { code: null, signal: 'SIGKILL' },
      policyIo({
        loadConfig: async () => ({
          store: { backend: 'oxigraph-server', options: { port: 8787 } },
        }),
        waitForTcpPortRelease,
      }),
    )).resolves.toBe(true);
    expect(waitForTcpPortRelease).toHaveBeenCalledWith('127.0.0.1', 8787);
  });

  it('logs generation, exit diagnostics, duration, and escalation', async () => {
    const warn = vi.fn();
    let clock = 100;
    await expect(cleanupDaemonWorker(
      42,
      { code: null, signal: 'SIGKILL' },
      policyIo({
        reapWorkerProcessGroup: async () => {
          clock = 112;
          return {
            ...emptyGroup,
            termSent: true,
            killSent: true,
          };
        },
        warn,
        now: () => clock,
      }),
      { label: 'foreground worker', generation: 3 },
    )).resolves.toBe(true);
    expect(warn).toHaveBeenLastCalledWith(
      '[supervisor] foreground worker cleanup completed ' +
        '(generation=3, pid=42, code=null, signal=SIGKILL, durationMs=12, ' +
        'sigterm=true, sigkill=true, groupEmpty=true).',
    );
  });

  it('fails closed while worker process-group survivors remain', async () => {
    const warn = vi.fn();
    const loadConfig = vi.fn(async () => ({ store: { backend: 'oxigraph-server' } }));
    await expect(cleanupDaemonWorker(
      42,
      { code: null, signal: 'SIGKILL' },
      policyIo({
        loadConfig,
        reapWorkerProcessGroup: async () => ({
          ...emptyGroup,
          termSent: true,
          killSent: true,
          empty: false,
        }),
        warn,
      }),
    )).resolves.toBe(false);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/still has survivors/));
  });

  it('fails closed while the managed listener still owns its port', async () => {
    const warn = vi.fn();
    await expect(cleanupDaemonWorker(
      42,
      { code: 1, signal: null },
      policyIo({
        loadConfig: async () => ({ store: { backend: 'oxigraph-server' } }),
        waitForTcpPortRelease: async () => false,
        warn,
      }),
    )).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/7878.*still listening/));
  });
});
