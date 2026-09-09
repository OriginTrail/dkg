import { describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildOxigraphWatchdogLaunchPlan,
  conventionalSignalExitCode,
  parseOxigraphParentWatchdogArgs,
  startOxigraphParentWatchdog,
} from '../src/daemon/oxigraph-parent-watchdog.js';

describe('Oxigraph parent watchdog', () => {
  it('derives protected Linux and direct non-Linux launch plans internally', () => {
    expect(buildOxigraphWatchdogLaunchPlan(
      'linux',
      42,
      '/opt/oxigraph',
      ['serve', '--location', '/data'],
    )).toEqual({
      command: 'setpriv',
      args: [
        '--pdeathsig', 'SIGKILL', '--', '/bin/sh', '-c',
        '[ "$PPID" = "$1" ] || exit 125; shift; exec "$@"',
        'dkg-oxigraph-child', '42', '/opt/oxigraph', 'serve', '--location', '/data',
      ],
      protectedByParentDeathSignal: true,
    });
    expect(buildOxigraphWatchdogLaunchPlan(
      'darwin',
      42,
      '/opt/oxigraph',
      ['serve'],
    )).toEqual({
      command: '/opt/oxigraph',
      args: ['serve'],
      protectedByParentDeathSignal: false,
    });
  });

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
        spawnChild: ((_command, _args, options) => spawn(
          '/no-such-dkg-watchdog-test-command',
          [],
          options,
        )) as typeof spawn,
      });
      await expect(handle.result).rejects.toThrow('Could not start protected Oxigraph child');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the child listener when its watchdog terminates', async () => {
    const watchdog = spawn(process.execPath, [
      '--import', 'tsx',
      new URL('../src/daemon/oxigraph-parent-watchdog.ts', import.meta.url).pathname,
      String(process.pid), process.execPath, '-e',
      'const s = require("node:net").createServer(); s.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ pid: process.pid, port: s.address().port })))',
    ], { stdio: ['ignore', 'pipe', 'inherit'] });
    let databasePid: number | undefined;
    try {
      const [chunk] = await once(watchdog.stdout!, 'data');
      const listening = JSON.parse(String(chunk).trim());
      databasePid = listening.pid;
      expect(databasePid).toBeGreaterThan(1);
      const exited = once(watchdog, 'exit');
      // Linux must survive uncatchable watchdog death through pdeathsig.
      // Other platforms exercise the signal-forwarding fallback instead.
      watchdog.kill(process.platform === 'linux' ? 'SIGKILL' : 'SIGTERM');
      await exited;
      // A released listener proves the child no longer owns resources even
      // when PID 1 has not yet reaped it. This works without Linux /proc.
      await vi.waitFor(async () => {
        const alive = await new Promise<boolean>((resolve) => {
          const socket = connect({ host: '127.0.0.1', port: listening.port });
          socket.once('connect', () => { socket.destroy(); resolve(true); });
          socket.once('error', () => { socket.destroy(); resolve(false); });
        });
        expect(alive).toBe(false);
      });
    } finally {
      watchdog.kill('SIGKILL');
      if (databasePid) { try { process.kill(databasePid, 'SIGKILL'); } catch {} }
    }
  });

  it('refuses to launch the database when the watchdog dies before pdeathsig setup on Linux', async () => {
    // This assertion runs the real process chain on Linux CI. Other hosts
    // exercise the pure launch policy above because setpriv/pdeathsig do not
    // exist there.
    if (process.platform !== 'linux') return;
    const setpriv = spawnSync('which', ['setpriv'], { encoding: 'utf8' }).stdout.trim();
    expect(setpriv).not.toBe('');
    const root = await mkdtemp(join(tmpdir(), 'dkg-watchdog-launch-race-'));
    const bin = join(root, 'bin');
    const entered = join(root, 'setpriv-entered');
    const marker = join(root, 'database-started');
    await mkdir(bin);
    await writeFile(join(bin, 'setpriv'), [
      '#!/bin/sh',
      `: > '${entered}'`,
      'sleep 0.25',
      `exec '${setpriv}' "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });

    const watchdog = spawn(process.execPath, [
      '--import', 'tsx',
      new URL('../src/daemon/oxigraph-parent-watchdog.ts', import.meta.url).pathname,
      String(process.pid), process.execPath, '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
    ], {
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
    });
    try {
      await vi.waitFor(async () => {
        await expect(access(entered)).resolves.toBeUndefined();
      });
      const exited = once(watchdog, 'exit');
      watchdog.kill('SIGKILL');
      await exited;
      await new Promise((resolve) => setTimeout(resolve, 500));
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(entered, 'utf8')).resolves.toBe('');
    } finally {
      watchdog.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
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
