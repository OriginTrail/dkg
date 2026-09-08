import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  conventionalSignalExitCode,
  parseOxigraphParentWatchdogArgs,
  startOxigraphParentWatchdog,
} from '../src/daemon/oxigraph-parent-watchdog.js';

describe('Oxigraph parent watchdog', () => {
  it.each(['parent-loss', 'shutdown'] as const)('kills a TERM-resistant child after %s grace expires', async (mode) => {
    let parentAlive = true;
    const handle = startOxigraphParentWatchdog({
      parentPid: 42,
      command: process.execPath,
      args: ['-e', 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000)'],
      pollIntervalMs: 5,
      stopGraceMs: 50,
      isProcessAlive: () => parentAlive,
      spawnChild: ((cmd, args, opts) => spawn(cmd, args, { ...opts, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })) as typeof spawn,
    });
    try {
      await once(handle.child, 'message');
      if (mode === 'parent-loss') parentAlive = false;
      else handle.stop();
      const result = await handle.result;
      expect(result.signal).toBe('SIGKILL');
      expect(result.parentLost).toBe(mode === 'parent-loss');
      expect(result.oomKilled).toBe(false);
    } finally {
      handle.child.kill('SIGKILL');
    }
  });

  it('cleans polling and escalation timers when spawning fails', async () => {
    vi.useFakeTimers();
    try {
      const handle = startOxigraphParentWatchdog({
        parentPid: process.pid,
        command: '/no-such-dkg-watchdog-test-command',
        args: [],
        platform: 'darwin',
      });
      await expect(handle.result).rejects.toThrow('Could not start protected Oxigraph child');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.skipIf(process.platform !== 'linux')('kills the database when its watchdog is SIGKILLed', async () => {
    const watchdog = spawn(process.execPath, [
      '--import', 'tsx',
      new URL('../src/daemon/oxigraph-parent-watchdog.ts', import.meta.url).pathname,
      String(process.pid), process.execPath, '-e',
      'console.log(process.pid); setInterval(() => {}, 1000)',
    ], { stdio: ['ignore', 'pipe', 'inherit'] });
    let databasePid: number | undefined;
    try {
      const [chunk] = await once(watchdog.stdout!, 'data');
      databasePid = Number(String(chunk).trim());
      expect(databasePid).toBeGreaterThan(1);
      const exited = once(watchdog, 'exit');
      watchdog.kill('SIGKILL');
      await exited;
      // PID 1 can take time to reap a zombie; it no longer holds a DB lock.
      const { readFile } = await import('node:fs/promises');
      await vi.waitFor(async () => {
        try {
          const stat = await readFile(`/proc/${databasePid}/stat`, 'utf8');
          expect(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]).toBe('Z');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      });
    } finally {
      watchdog.kill('SIGKILL');
      if (databasePid) { try { process.kill(databasePid, 'SIGKILL'); } catch {} }
    }
  });

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
