/**
 * The Oxigraph launch strategies and the handle each launch returns: the
 * command a direct, Windows or systemd-scope launch builds, the process group
 * its termination signals, listener ownership, and OOM attribution. Spawns
 * are recorded or stood in for; `oxigraph-server.test.ts` covers the server
 * that drives these launches.
 */
import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createOxigraphLaunchStrategy } from '../src/daemon/oxigraph-launch-strategy.js';
import { OXIGRAPH_WATCHDOG_OOM_MARKER } from '../src/daemon/oxigraph-parent-watchdog.js';
import { waitForCondition } from './fixtures/oxigraph-server-real-fixture.js';

// A child that never ran: it only answers `kill` and the exit fields.
function fakeChild(fields: { exitCode?: number | null; pid?: number | undefined } = {}) {
  return Object.assign(new EventEmitter(), {
    pid: 'pid' in fields ? fields.pid : 2 ** 22 + 9,
    exitCode: fields.exitCode ?? null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as import('node:child_process').ChildProcess & { kill: ReturnType<typeof vi.fn> };
}

// A spawn that records what a launch strategy asks for and starts nothing.
function recordingSpawn(child = fakeChild()) {
  const calls: Array<{ command: string; args: readonly string[]; options: Parameters<typeof spawn>[2] }> = [];
  const spawnProcess = ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
    calls.push({ command, args, options });
    return child;
  }) as unknown as typeof spawn;
  return { calls, spawnProcess, child };
}

describe('Oxigraph launch strategies', () => {
  it.each(['linux', 'darwin'] as const)(
    'ties an unscoped Oxigraph to the daemon through the direct parent watchdog on %s',
    async (platform) => {
      const strategy = createOxigraphLaunchStrategy({
        platform,
        parentPid: 42,
        uid: 1000,
        nodeExecutable: '/opt/node',
        watchdogPath: '/opt/oxigraph-watchdog.js',
      });
      const { calls, spawnProcess } = recordingSpawn();
      const oxigraph = strategy.launch(spawnProcess, '/opt/oxigraph', ['serve'], 'ignore');
      expect(calls).toEqual([{
        command: '/opt/node',
        args: ['/opt/oxigraph-watchdog.js', '--direct', '42', '/opt/oxigraph', 'serve'],
        // The watchdog leads its own process group, which `terminate` signals.
        options: { stdio: 'ignore', detached: true },
      }]);
      const resolver = vi.fn(async () => 4242);
      await expect(oxigraph.resolveListenerPid(7878, '127.0.0.1', resolver)).resolves.toBe(4242);
      expect(resolver).toHaveBeenCalledWith(oxigraph.child, 7878, '127.0.0.1', 'process-tree');
    },
  );

  // Launches through `strategy`, with the spawn options it chooses, a wrapper
  // that starts a long-lived child in place of the watchdog, SIGKILLs the
  // launch through its handle, and reports whether that child died too.
  const groupKillReachesDescendant = async (strategy: ReturnType<typeof createOxigraphLaunchStrategy>) => {
    const oxigraph = strategy.launch(
      ((_command: string, _args: readonly string[], options: Parameters<typeof spawn>[2]) => spawn(process.execPath, [
        '-e',
        "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);",
      ], options)) as typeof spawn,
      '/opt/oxigraph',
      ['serve'],
      ['ignore', 'pipe', 'ignore'],
    );
    const [chunk] = await once(oxigraph.child.stdout!, 'data');
    const descendant = Number(String(chunk).trim());
    try {
      const exited = once(oxigraph.child, 'exit');
      oxigraph.terminate('SIGKILL');
      await exited;
      expect(oxigraph.alive()).toBe(false);
      return await waitForCondition(() => {
        try { process.kill(descendant, 0); return false; } catch { return true; }
      });
    } finally {
      try { process.kill(descendant, 'SIGKILL'); } catch { /* already gone */ }
    }
  };

  it('signals the direct watchdog\'s whole process group, so a SIGKILL also reaches Oxigraph', async () => {
    const strategy = createOxigraphLaunchStrategy({ platform: process.platform, parentPid: 42, uid: 1000 });
    expect(await groupKillReachesDescendant(strategy)).toBe(true);
  });

  // The launch's half only: `systemd-run` is replaced by the stand-in, so
  // this does not prove what systemd does. `systemd-run --scope` execs its
  // command in place without changing the process group, and the watchdog
  // starts Oxigraph without a new group, so they stay in the one signalled
  // here; no test in this suite runs a real user scope.
  it('launches a scope leading its own process group and signals that group through the handle', async () => {
    const strategy = createOxigraphLaunchStrategy({
      platform: 'linux', parentPid: 42, uid: 1000, memoryLimits: { maxMiB: 3072 },
    });
    expect(await groupKillReachesDescendant(strategy)).toBe(true);
  });

  it('signals only the spawned child on Windows', () => {
    const strategy = createOxigraphLaunchStrategy({ platform: 'win32', parentPid: 42, uid: -1 });
    const { spawnProcess, child } = recordingSpawn();
    strategy.launch(spawnProcess, '/opt/oxigraph', ['serve'], 'ignore').terminate('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('signals nothing once its child has exited or failed to spawn', () => {
    const strategy = createOxigraphLaunchStrategy({ platform: 'linux', parentPid: 42, uid: 1000 });
    const exited = recordingSpawn(fakeChild({ exitCode: 0 }));
    const exitedLaunch = strategy.launch(exited.spawnProcess, '/opt/oxigraph', ['serve'], 'ignore');
    exitedLaunch.terminate('SIGKILL');
    expect(exitedLaunch.alive()).toBe(false);
    expect(exited.child.kill).not.toHaveBeenCalled();

    // A spawn that failed never got a PID.
    const failed = recordingSpawn(fakeChild({ pid: undefined }));
    const failedLaunch = strategy.launch(failed.spawnProcess, '/opt/oxigraph', ['serve'], 'ignore');
    failed.child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    failedLaunch.terminate('SIGKILL');
    expect(failedLaunch.alive()).toBe(false);
    expect(failed.child.kill).not.toHaveBeenCalled();
  });

  it('keeps a launch alive, and signalling it, after a signal it could not deliver', () => {
    const strategy = createOxigraphLaunchStrategy({ platform: 'win32', parentPid: 42, uid: -1 });
    const refused = recordingSpawn();
    const launch = strategy.launch(refused.spawnProcess, '/opt/oxigraph', ['serve'], 'ignore');
    // Node reports an undeliverable signal as an `error` on a running child.
    refused.child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
    expect(launch.alive()).toBe(true);
    launch.terminate('SIGKILL');
    expect(refused.child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('attributes an OOM kill per launch: the scoped watchdog\'s marker, or a cgroup counter that grew', () => {
    const scoped = createOxigraphLaunchStrategy({
      platform: 'linux', parentPid: 42, uid: 1000, memoryLimits: { maxMiB: 3072 },
    });
    const direct = createOxigraphLaunchStrategy({ platform: 'linux', parentPid: 42, uid: 1000 });
    const launchOn = (strategy: typeof scoped) =>
      strategy.launch(recordingSpawn().spawnProcess, '/opt/oxigraph', ['serve'], 'ignore');
    const noOomKill = () => 0;

    // The scoped watchdog reports the kill on stderr and exits 200.
    const reported = launchOn(scoped);
    const other = launchOn(scoped);
    reported.observeStderr(`[watchdog] ${OXIGRAPH_WATCHDOG_OOM_MARKER}`);
    expect(reported.classifyOomExit({ code: 200, signal: null, readOomKill: noOomKill })).toBe(true);
    // Another launch of the same strategy saw no marker.
    expect(other.classifyOomExit({ code: 200, signal: null, readOomKill: noOomKill })).toBe(false);
    // A direct watchdog never reports it; the marker text alone proves nothing.
    const unscoped = launchOn(direct);
    unscoped.observeStderr(OXIGRAPH_WATCHDOG_OOM_MARKER);
    expect(unscoped.classifyOomExit({ code: 1, signal: null, readOomKill: noOomKill })).toBe(false);

    // Cgroup evidence: the listener's oom_kill counter, taken once, then grew.
    const counted = launchOn(direct);
    const read = vi.fn(() => ({ dir: '/sys/fs/cgroup/dkg', oomKill: 3 }));
    counted.captureOomSnapshot(4100, read);
    counted.captureOomSnapshot(4100, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(counted.classifyOomExit({ code: 137, signal: null, readOomKill: () => 4 })).toBe(true);
    expect(counted.classifyOomExit({ code: 137, signal: null, readOomKill: () => 3 })).toBe(false);
    // Only a SIGKILL-compatible exit counts.
    expect(counted.classifyOomExit({ code: 1, signal: null, readOomKill: () => 4 })).toBe(false);
  });

  it('launches the binary directly on Windows, where only the direct child can own the listener', async () => {
    const strategy = createOxigraphLaunchStrategy({
      platform: 'win32',
      parentPid: 42,
      uid: -1,
    });
    const { calls, spawnProcess } = recordingSpawn();
    const oxigraph = strategy.launch(spawnProcess, 'C:\\oxigraph.exe', ['serve'], 'ignore');
    expect(calls).toEqual([{ command: 'C:\\oxigraph.exe', args: ['serve'], options: { stdio: 'ignore' } }]);
    const resolver = vi.fn(async () => 4242);
    await oxigraph.resolveListenerPid(7878, '127.0.0.1', resolver);
    expect(resolver).toHaveBeenCalledWith(oxigraph.child, 7878, '127.0.0.1', 'child-only');
  });

  it('wraps Oxigraph in a finite systemd user scope', () => {
    const strategy = createOxigraphLaunchStrategy({
      memoryLimits: { highMiB: 2048, maxMiB: 3072 },
      platform: 'linux',
      parentPid: 42,
      uid: 1000,
      nodeExecutable: '/opt/node',
      watchdogPath: '/opt/oxigraph-watchdog.js',
    });
    const { calls, spawnProcess } = recordingSpawn();
    strategy.launch(spawnProcess, '/opt/oxigraph', ['serve'], 'ignore');
    strategy.launch(spawnProcess, '/opt/oxigraph', ['serve'], 'ignore');
    strategy.launch(spawnProcess, '/opt/oxigraph', ['serve', '--bind', '127.0.0.1:7878'], 'ignore');
    const spec = calls[2];

    expect(spec.command).toBe('systemd-run');
    expect(spec.options).toMatchObject({
      stdio: 'ignore',
      env: {
        XDG_RUNTIME_DIR: '/run/user/1000',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      },
    });
    // The scope leads its own process group, which `terminate` signals.
    expect(spec.options).toMatchObject({ detached: true });
    expect(spec.args.slice(0, 8)).toEqual([
      '--user', '--scope', '--collect', '--quiet',
      '--unit=dkg-oxigraph-42-3',
      '--property=MemoryHigh=2048M',
      '--property=MemoryMax=3072M',
      '--property=MemorySwapMax=0',
    ]);
    expect(spec.args.slice(-7)).toEqual([
      '/opt/node', '/opt/oxigraph-watchdog.js', '42',
      '/opt/oxigraph', 'serve', '--bind', '127.0.0.1:7878',
    ]);
  });

  it('fails closed when finite scope limits cannot be enforced', () => {
    expect(() => createOxigraphLaunchStrategy({
      memoryLimits: { maxMiB: 3072 },
      platform: 'darwin',
      parentPid: 42,
      uid: 1000,
    })).toThrow(/require Linux/);
  });
});
