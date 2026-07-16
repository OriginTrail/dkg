import { describe, expect, it } from 'vitest';
import {
  conventionalSignalExitCode,
  parseOxigraphParentWatchdogArgs,
  startOxigraphParentWatchdog,
} from '../src/daemon/oxigraph-parent-watchdog.js';

describe('Oxigraph parent watchdog', () => {
  it('parses a typed parent/command boundary', () => {
    expect(parseOxigraphParentWatchdogArgs(['42', '/opt/oxigraph', 'serve']))
      .toEqual({ parentPid: 42, command: '/opt/oxigraph', args: ['serve'] });
    expect(() => parseOxigraphParentWatchdogArgs(['nope', '/opt/oxigraph']))
      .toThrow(/Usage/);
  });

  it('maps an unforwarded catchable child signal to a non-zero wrapper exit', () => {
    expect(conventionalSignalExitCode('SIGTERM')).toBe(143);
    expect(conventionalSignalExitCode('SIGINT')).toBe(130);
  });

  it('terminates the child when the daemon parent disappears', async () => {
    const handle = startOxigraphParentWatchdog({
      parentPid: 42,
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      pollIntervalMs: 5,
      isProcessAlive: () => false,
    });

    const result = await handle.result;
    expect(result.parentLost).toBe(true);
    expect(result.signal).toBe('SIGTERM');
    expect(result.oomKilled).toBe(false);
  });

  it('forwards an explicit shutdown signal to the child', async () => {
    const handle = startOxigraphParentWatchdog({
      parentPid: process.pid,
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

  it('reports an externally SIGTERM-killed child as a non-zero wrapper exit', async () => {
    const handle = startOxigraphParentWatchdog({
      parentPid: process.pid,
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
      parentPid: process.pid,
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
