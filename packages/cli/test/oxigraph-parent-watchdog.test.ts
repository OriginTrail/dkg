import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  conventionalSignalExitCode,
  parseOxigraphParentWatchdogArgs,
  readLinuxProcessIdentity,
  startOxigraphParentWatchdog,
} from '../src/daemon/oxigraph-parent-watchdog.js';

describe('Oxigraph parent watchdog', () => {
  it('parses a typed parent/command boundary', () => {
    expect(parseOxigraphParentWatchdogArgs([
      'process-identity', '42', '42:1234', '/opt/oxigraph', 'serve',
    ]))
      .toEqual({
        parent: { kind: 'process-identity', pid: 42, identity: '42:1234' },
        command: '/opt/oxigraph',
        args: ['serve'],
      });
    expect(parseOxigraphParentWatchdogArgs([
      'pipe', '42', '3', '/opt/oxigraph', 'serve',
    ])).toEqual({
      parent: { kind: 'pipe', pid: 42, fd: 3 },
      command: '/opt/oxigraph',
      args: ['serve'],
    });
    expect(() => parseOxigraphParentWatchdogArgs([
      'process-identity', 'nope', 'identity', '/opt/oxigraph',
    ]))
      .toThrow(/Usage/);
  });

  it.runIf(process.platform === 'linux')('reads a PID-reuse-safe parent identity', () => {
    expect(readLinuxProcessIdentity(process.pid)).toMatch(new RegExp(`^${process.pid}:\\d+$`));
  });

  it('maps an unforwarded catchable child signal to a non-zero wrapper exit', () => {
    expect(conventionalSignalExitCode('SIGTERM')).toBe(143);
    expect(conventionalSignalExitCode('SIGINT')).toBe(130);
  });

  it('terminates the child when the daemon parent disappears', async () => {
    let checks = 0;
    const handle = startOxigraphParentWatchdog({
      parent: { kind: 'process-identity', pid: 42 },
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      pollIntervalMs: 5,
      // Pre-spawn + immediate post-spawn checks pass; the first periodic
      // identity/liveness check observes the parent loss.
      isProcessAlive: () => ++checks <= 2,
    });

    const result = await handle.result;
    expect(result.parentLost).toBe(true);
    expect(result.signal).toBe('SIGTERM');
    expect(result.oomKilled).toBe(false);
  });

  it('refuses to spawn when the expected parent identity was reused', () => {
    expect(() => startOxigraphParentWatchdog({
      parent: { kind: 'process-identity', pid: 42, identity: '42:original' },
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      readProcessIdentity: () => '42:replacement',
    })).toThrow(/disappeared or changed identity/);
  });

  it('forwards an explicit shutdown signal to the child', async () => {
    const handle = startOxigraphParentWatchdog({
      parent: { kind: 'process-identity', pid: process.pid },
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      pollIntervalMs: 5,
    });
    handle.stop('SIGTERM');

    const result = await handle.result;
    expect(result.parentLost).toBe(false);
    expect(result.signal).toBe('SIGTERM');
    expect(result.oomKilled).toBe(false);
  });

  it('treats inherited parent-pipe EOF as authoritative worker death', async () => {
    const parentPipe = new PassThrough();
    const handle = startOxigraphParentWatchdog({
      parent: { kind: 'pipe', pid: 42, stream: parentPipe },
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      stopGraceMs: 100,
    });
    parentPipe.end();

    const result = await handle.result;
    expect(result.parentLost).toBe(true);
    expect(result.signal).toBe('SIGTERM');
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const handle = startOxigraphParentWatchdog({
      parent: { kind: 'process-identity', pid: process.pid },
      command: process.execPath,
      args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      pollIntervalMs: 5,
      stopGraceMs: 25,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    handle.stop('SIGTERM');

    const result = await handle.result;
    expect(result.parentLost).toBe(false);
    expect(result.signal).toBe('SIGKILL');
  });

  it('reports an externally SIGTERM-killed child as a non-zero wrapper exit', async () => {
    const handle = startOxigraphParentWatchdog({
      parent: { kind: 'process-identity', pid: process.pid },
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      pollIntervalMs: 5,
    });
    handle.child.kill('SIGTERM');

    const result = await handle.result;
    expect(result.parentLost).toBe(false);
    expect(result.signal).toBe('SIGTERM');
    expect(conventionalSignalExitCode(result.signal!)).toBe(143);
  });

  it('captures scoped OOM evidence before the watchdog cgroup can disappear', async () => {
    const handle = startOxigraphParentWatchdog({
      parent: { kind: 'process-identity', pid: process.pid },
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      pollIntervalMs: 5,
      readOomSnapshot: () => ({ dir: '/sys/fs/cgroup/dkg-oxi', oomKill: 4 }),
      readOomKill: () => 5,
    });
    handle.child.kill('SIGKILL');

    const result = await handle.result;
    expect(result.signal).toBe('SIGKILL');
    expect(result.oomKilled).toBe(true);
  });
});
