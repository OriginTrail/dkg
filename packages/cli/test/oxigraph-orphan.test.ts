/**
 * Orphaned managed Oxigraph — the 2026-09-23 testnet incident, with real
 * processes.
 *
 * After five failed liveness probes the supervisor SIGKILLs its worker. A
 * SIGKILLed worker runs no cleanup, so a directly launched `oxigraph serve`
 * child survived, reparented to init, still holding the port and
 * `<location>/LOCK`. Every respawned worker then failed to open the store
 * ("While lock file … Resource temporarily unavailable") until the
 * supervisor gave up.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOxigraphServer } from '../src/daemon/oxigraph-server.js';
import { findListenOwnerPid } from '../src/daemon/oxigraph-listen-port.js';
import {
  lsofLockHolders,
  procLockHolders,
  runsManagedOxigraphStore,
  stopOrphanedOxigraph,
  watchedDaemonPid,
  type OrphanedOxigraphIo,
} from '../src/daemon/oxigraph-orphan.js';
import {
  procDescribeProcess,
  psDescribeProcess,
  type ProcessDescriber,
} from '../src/daemon/process-probe.js';
import {
  createOxigraphStandinFixture,
  fetchPid,
  freePort,
  portAnswers,
  waitForCondition,
  type OxigraphStandinFixture,
} from './fixtures/oxigraph-server-real-fixture.js';

let lockingStandin: OxigraphStandinFixture;

beforeAll(async () => {
  lockingStandin = await createOxigraphStandinFixture({ holdStoreLock: true });
});

afterAll(async () => {
  await lockingStandin.cleanup();
});

function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

const hostHasProcfs = existsSync('/proc/self/fd');
const hostHas = (tool: string): boolean =>
  spawnSync(tool, ['-h'], { stdio: 'ignore' }).error === undefined;

/** Every lock-holder probe this host can run, not only its default. */
function hostLockHolderProbes(): Array<[string, (lockPath: string) => Promise<number[]>]> {
  const probes: Array<[string, (lockPath: string) => Promise<number[]>]> = [];
  if (hostHas('lsof')) probes.push(['lsof', lsofLockHolders]);
  if (hostHasProcfs) probes.push(['procfs', procLockHolders]);
  return probes;
}

/** Every process-description probe this host can run, not only its default. */
function hostProcessProbes(): Array<[string, ProcessDescriber]> {
  const probes: Array<[string, ProcessDescriber]> = [];
  if (hostHas('ps')) probes.push(['ps', psDescribeProcess]);
  if (hostHasProcfs) probes.push(['procfs', procDescribeProcess]);
  return probes;
}

function killIfAlive(pid: number | undefined): void {
  if (pid === undefined || pidIsGone(pid)) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

interface WorkerProcess {
  child: ChildProcess;
  stderr(): string;
}

/** Start a real worker process that owns one managed Oxigraph and wait until it is ready. */
async function startWorker(port: number, location: string): Promise<WorkerProcess> {
  const child = spawn(process.execPath, [
    '--import', 'tsx',
    fileURLToPath(new URL('./fixtures/oxigraph-worker-process.ts', import.meta.url)),
    lockingStandin.binaryPath,
    location,
    String(port),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const ready = await Promise.race([
    once(child.stdout!, 'data').then(() => true),
    once(child, 'exit').then(() => false),
  ]);
  if (!ready) throw new Error(`worker exited before its Oxigraph was ready:\n${stderr}`);
  return { child, stderr: () => stderr };
}

/** Start a process whose parent exits at once, so init adopts it. */
async function spawnOrphan(command: string, args: string[]): Promise<number> {
  const launcher = spawn(process.execPath, [
    '-e',
    `const child = require('node:child_process').spawn(process.argv[1], process.argv.slice(2), { detached: true, stdio: 'ignore' });
     child.unref();
     console.log(child.pid);`,
    command,
    ...args,
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  const launcherExited = once(launcher, 'exit');
  const [chunk] = await once(launcher.stdout!, 'data');
  await launcherExited;
  return Number(String(chunk).trim());
}

function parentPid(pid: number): number | null {
  try {
    return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  } catch {
    return null;
  }
}

async function stopWorker(worker: WorkerProcess): Promise<void> {
  const { child } = worker;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

describe('directly launched Oxigraph under the parent watchdog', () => {
  it('releases the store, so the respawned worker can open it', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-worker-'));
    let first: WorkerProcess | undefined;
    let second: WorkerProcess | undefined;
    let firstListenerPid: number | undefined;
    let secondListenerPid: number | undefined;
    try {
      first = await startWorker(port, location);
      firstListenerPid = await fetchPid(port);

      // What the supervisor does after five failed liveness probes.
      const exited = once(first.child, 'exit');
      first.child.kill('SIGKILL');
      await exited;

      const released = await waitForCondition(
        async () => pidIsGone(firstListenerPid!) && !(await portAnswers(port)),
        10_000,
      );
      expect(released, `Oxigraph pid ${firstListenerPid} outlived its SIGKILLed worker`).toBe(true);

      second = await startWorker(port, location);
      secondListenerPid = await fetchPid(port);
      expect(secondListenerPid).not.toBe(firstListenerPid);
      expect(existsSync(join(location, 'LOCK'))).toBe(true);
    } finally {
      if (second) await stopWorker(second);
      if (first) first.child.kill('SIGKILL');
      killIfAlive(firstListenerPid);
      killIfAlive(secondListenerPid);
      await rm(location, { recursive: true, force: true });
    }
  }, 60_000);

  it('lets a worker respawned at once open the store while the old watchdog is still polling', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-respawn-'));
    let first: WorkerProcess | undefined;
    let second: WorkerProcess | undefined;
    let firstListenerPid: number | undefined;
    try {
      first = await startWorker(port, location);
      firstListenerPid = await fetchPid(port);
      const exited = once(first.child, 'exit');
      first.child.kill('SIGKILL');
      await exited;

      // No wait for the old Oxigraph: a replacement that dies on the held
      // lock would spend one of the supervisor's five crash restarts.
      second = await startWorker(port, location);
      expect(await fetchPid(port)).not.toBe(firstListenerPid);
      expect(pidIsGone(firstListenerPid)).toBe(true);
    } finally {
      if (second) await stopWorker(second);
      if (first) first.child.kill('SIGKILL');
      killIfAlive(firstListenerPid);
      await rm(location, { recursive: true, force: true });
    }
  }, 60_000);

  it('kills Oxigraph with its watchdog when a respawn misses its ready deadline', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-revive-'));
    let withholdOwnership = false;
    const listenerPids: number[] = [];
    const lines: string[] = [];
    const handle = await startOxigraphServer({
      binaryPath: lockingStandin.binaryPath,
      location,
      port,
      readyTimeoutMs: 1_000,
      readyIntervalMs: 50,
      restartBackoffBaseMs: 50,
      restartBackoffMaxMs: 50,
      log: (line) => lines.push(line),
      io: {
        findListenOwnerPid: async (child, childPort, host, ownership) => withholdOwnership
          ? null
          : await findListenOwnerPid(child, childPort, host, ownership),
      },
    });
    try {
      listenerPids.push(await fetchPid(port));
      withholdOwnership = true;
      process.kill(listenerPids[0], 'SIGKILL');
      // The first respawn answers HTTP but never proves ownership, so the
      // supervisor kills it at the ready deadline and tries again.
      expect(await waitForCondition(async () => {
        const pid = await fetchPid(port).catch(() => undefined);
        return pid !== undefined && pid !== listenerPids[0];
      })).toBe(true);
      listenerPids.push(await fetchPid(port));
      expect(
        await waitForCondition(() => pidIsGone(listenerPids[1]), 5_000),
        `respawned Oxigraph pid ${listenerPids[1]} outlived its watchdog (parent now ${parentPid(listenerPids[1])})`,
      ).toBe(true);

      withholdOwnership = false;
      expect(await waitForCondition(() => !handle.getRecoveryState().recovering, 10_000)).toBe(true);
      // The supervisor's own kill reached Oxigraph; the pre-spawn orphan
      // reclaim never had to step in.
      expect(lines.join('\n')).not.toMatch(/orphaned Oxigraph/);
    } finally {
      await handle.stop();
      for (const pid of listenerPids) killIfAlive(pid);
      await rm(location, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('stopOrphanedOxigraph (injected process table)', () => {
  const binaryPath = '/home/dkg/.dkg/oxigraph/oxigraph-v0.5.8';
  let location: string;

  beforeAll(async () => {
    location = await mkdtemp(join(tmpdir(), 'oxi-orphan-table-'));
    await writeFile(join(location, 'LOCK'), '');
  });

  afterAll(async () => {
    await rm(location, { recursive: true, force: true });
  });

  interface FakeProcess {
    ppid: number;
    command: string;
    holdsLock: boolean;
    ignoresTerm?: boolean;
    alive: boolean;
  }

  function processTable(entries: Record<number, Omit<FakeProcess, 'alive'>>) {
    const table = new Map<number, FakeProcess>(
      Object.entries(entries).map(([pid, entry]) => [Number(pid), { ...entry, alive: true }]),
    );
    let clock = 0;
    const signals: Array<[number, NodeJS.Signals]> = [];
    const io: OrphanedOxigraphIo = {
      listLockHolders: vi.fn(async () =>
        [...table].filter(([, entry]) => entry.alive && entry.holdsLock).map(([pid]) => pid)),
      describeProcess: async (pid) => {
        const entry = table.get(pid);
        return entry?.alive ? { ppid: entry.ppid, command: entry.command } : null;
      },
      isProcessAlive: (pid) => table.get(pid)?.alive ?? false,
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        const entry = table.get(pid);
        if (!entry?.alive) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
        if (signal === 'SIGKILL' || !entry.ignoresTerm) entry.alive = false;
      },
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
    };
    return { table, signals, io };
  }

  const serve = (store: string, binary = binaryPath) =>
    `${binary} serve --location ${store} --bind 127.0.0.1:7901`;
  const directWatchdog = (daemonPid: number, store: string) =>
    `/usr/bin/node /opt/dkg/dist/daemon/oxigraph-parent-watchdog.js --direct ${daemonPid} ${serve(store)}`;

  it('stops an orphan of this store with SIGTERM and returns once the lock is free', async () => {
    const { table, signals, io } = processTable({
      4100: { ppid: 1, command: serve(location), holdsLock: true },
    });
    const lines: string[] = [];

    await expect(stopOrphanedOxigraph({ binaryPath, location, log: (line) => lines.push(line), io }))
      .resolves.toEqual([4100]);
    expect(signals).toEqual([[4100, 'SIGTERM']]);
    expect(table.get(4100)!.alive).toBe(false);
    expect(lines.join('\n')).toMatch(/stopping orphaned Oxigraph pid 4100/);
    expect(lines.join('\n')).toMatch(/released by the orphaned Oxigraph/);
  });

  it('escalates to SIGKILL once the stop grace expires', async () => {
    const { signals, io } = processTable({
      4100: { ppid: 1, command: serve(location), holdsLock: true, ignoresTerm: true },
    });

    await stopOrphanedOxigraph({
      binaryPath, location, log: () => {}, io, stopGraceMs: 500, pollIntervalMs: 100,
    });
    expect(signals).toEqual([[4100, 'SIGTERM'], [4100, 'SIGKILL']]);
  });

  it('stops an orphan that still runs the binary an earlier release pinned', async () => {
    const { signals, io } = processTable({
      4100: { ppid: 1, command: serve(location, '/home/dkg/.dkg/oxigraph/oxigraph-v0.5.7'), holdsLock: true },
    });

    await expect(stopOrphanedOxigraph({ binaryPath, location, log: () => {}, io }))
      .resolves.toEqual([4100]);
    expect(signals).toEqual([[4100, 'SIGTERM']]);
  });

  it('stops this store\'s Oxigraph at once when its watchdog\'s daemon has exited', async () => {
    // A worker respawned within the watchdog's one-second poll: the old
    // daemon (4000) is gone, so its watchdog (4099) is about to stop it anyway.
    const { signals, io } = processTable({
      4099: { ppid: 1, command: directWatchdog(4000, location), holdsLock: false },
      4100: { ppid: 4099, command: serve(location), holdsLock: true },
    });

    await expect(stopOrphanedOxigraph({ binaryPath, location, log: () => {}, io }))
      .resolves.toEqual([4100]);
    expect(signals).toEqual([[4100, 'SIGTERM']]);
  });

  it('leaves this store\'s Oxigraph running while its watchdog\'s daemon is alive', async () => {
    const { table, signals, io } = processTable({
      4000: { ppid: 1, command: 'node /opt/dkg/dist/cli.js daemon-worker', holdsLock: false },
      4099: { ppid: 4000, command: directWatchdog(4000, location), holdsLock: false },
      4100: { ppid: 4099, command: serve(location), holdsLock: true },
    });
    const lines: string[] = [];

    await expect(stopOrphanedOxigraph({ binaryPath, location, log: (line) => lines.push(line), io }))
      .resolves.toEqual([]);
    expect(signals).toEqual([]);
    expect(table.get(4100)!.alive).toBe(true);
    expect(lines.join('\n')).toMatch(/Leaving it running: its watchdog pid 4099 still serves live daemon pid 4000/);
  });

  it.each([
    ['a live daemon worker', 'node /opt/dkg/dist/cli.js daemon-worker'],
    ['an operator shell', '/bin/bash'],
    // A subreaper adopts orphans instead of PID 1; the log names it so an
    // operator can tell it from a live owner.
    ['a subreaper', '/lib/systemd/systemd --user'],
  ])('leaves this store\'s Oxigraph running while its parent is %s', async (_label, parentCommand) => {
    const { table, signals, io } = processTable({
      4099: { ppid: 1, command: parentCommand, holdsLock: false },
      4100: { ppid: 4099, command: serve(location), holdsLock: true },
    });
    const lines: string[] = [];

    await expect(stopOrphanedOxigraph({ binaryPath, location, log: (line) => lines.push(line), io }))
      .resolves.toEqual([]);
    expect(signals).toEqual([]);
    expect(table.get(4100)!.alive).toBe(true);
    expect(lines.join('\n')).toContain(
      `held by pid 4100 (parent 4099): ${serve(location)}. ` +
        `Leaving it running: its parent pid 4099 is still running: ${parentCommand}.`,
    );
  });

  it.each([
    ['a binary outside this node\'s binary directory', serve(location, '/usr/local/bin/oxigraph')],
    ['another executable in this node\'s binary directory', serve(location, '/home/dkg/.dkg/oxigraph/rocksdb-tool')],
    ['another store whose path extends this one', serve(`${location}-2`)],
    ['a non-serve command on this binary', `${binaryPath} dump --location ${location}`],
    ['an unrelated tool', `sqlite3 ${location}/LOCK`],
  ])('leaves an orphaned lock holder running when it is %s', async (_label, command) => {
    const { table, signals, io } = processTable({
      4100: { ppid: 1, command, holdsLock: true },
    });
    const lines: string[] = [];

    await expect(stopOrphanedOxigraph({ binaryPath, location, log: (line) => lines.push(line), io }))
      .resolves.toEqual([]);
    expect(signals).toEqual([]);
    expect(table.get(4100)!.alive).toBe(true);
    expect(lines.join('\n')).toMatch(/Leaving it running: it is not this node's Oxigraph serving this store/);
  });

  it('stops only the orphan when a foreign process also holds the lock', async () => {
    const { signals, io } = processTable({
      4100: { ppid: 1, command: serve(location), holdsLock: true },
      4200: { ppid: 1, command: `/usr/bin/backup ${location}`, holdsLock: true },
      4300: { ppid: 1, command: serve(location), holdsLock: false },
    });

    await expect(stopOrphanedOxigraph({ binaryPath, location, log: () => {}, io }))
      .resolves.toEqual([4100]);
    expect(signals).toEqual([[4100, 'SIGTERM']]);
  });

  it('gives up after the timeout and leaves the lock error to the spawn', async () => {
    const { signals, io } = processTable({
      4100: { ppid: 1, command: serve(location), holdsLock: true, ignoresTerm: true },
    });
    io.signal = (pid, signal) => {
      signals.push([pid, signal]);
      // A process that survives SIGKILL (uninterruptible sleep) still holds the lock.
    };
    const lines: string[] = [];

    await expect(stopOrphanedOxigraph({
      binaryPath, location, log: (line) => lines.push(line), io,
      stopGraceMs: 500, timeoutMs: 2_000, pollIntervalMs: 100,
    })).resolves.toEqual([4100]);
    expect(signals).toEqual([[4100, 'SIGTERM'], [4100, 'SIGKILL']]);
    expect(lines.join('\n')).toMatch(/pid 4100 still holds .* after 2000ms; starting anyway/);
  });

  it('does not look for holders when the store has no LOCK file yet', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'oxi-orphan-fresh-'));
    const { io } = processTable({});
    try {
      await expect(stopOrphanedOxigraph({ binaryPath, location: fresh, log: () => {}, io }))
        .resolves.toEqual([]);
      expect(io.listLockHolders).not.toHaveBeenCalled();
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it('matches this node\'s serve command for this store, including through a #! interpreter', () => {
    expect(runsManagedOxigraphStore(serve('/data/ox'), binaryPath, '/data/ox')).toBe(true);
    expect(runsManagedOxigraphStore(`node ${serve('/data/ox')}`, binaryPath, '/data/ox')).toBe(true);
    expect(runsManagedOxigraphStore(`${binaryPath} serve --location /data/ox`, binaryPath, '/data/ox')).toBe(true);
    expect(runsManagedOxigraphStore(serve('/data/ox', `${binaryPath}-old`), binaryPath, '/data/ox')).toBe(true);
    expect(runsManagedOxigraphStore(serve('/data/ox2'), binaryPath, '/data/ox')).toBe(false);
    expect(runsManagedOxigraphStore(serve('/data/ox', '/opt/other/oxigraph-v0.5.8'), binaryPath, '/data/ox')).toBe(false);
    // A PATH binary: only that exact executable, or an `oxigraph*` beside it.
    expect(runsManagedOxigraphStore(serve('/data/ox', '/usr/bin/oxigraph'), '/usr/bin/oxigraph', '/data/ox')).toBe(true);
    expect(runsManagedOxigraphStore(serve('/data/ox', '/usr/bin/python3'), '/usr/bin/oxigraph', '/data/ox')).toBe(false);
  });

  it('reads the daemon PID from a direct, scoped or source-run watchdog of this store only', () => {
    const tail = serve('/data/ox');
    expect(watchedDaemonPid(directWatchdog(4000, '/data/ox'), binaryPath, '/data/ox')).toBe(4000);
    expect(watchedDaemonPid(`/usr/bin/node /opt/dkg/dist/daemon/oxigraph-parent-watchdog.js 4001 ${tail}`, binaryPath, '/data/ox'))
      .toBe(4001);
    expect(watchedDaemonPid(
      `node --import file:///repo/node_modules/tsx/dist/loader.mjs /repo/src/daemon/oxigraph-parent-watchdog.ts --direct 4002 ${tail}`,
      binaryPath,
      '/data/ox',
    )).toBe(4002);
    expect(watchedDaemonPid(directWatchdog(4000, '/data/other'), binaryPath, '/data/ox')).toBeNull();
    expect(watchedDaemonPid(`node /opt/dkg/dist/cli.js daemon-worker ${tail}`, binaryPath, '/data/ox')).toBeNull();
  });
});

describe('stopOrphanedOxigraph (real processes)', () => {
  it('describes an exited process as gone with every probe on this host', async () => {
    const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(exited, 'exit');
    for (const [name, describeProcess] of hostProcessProbes()) {
      expect(await describeProcess(exited.pid!), name).toBeNull();
    }
  });

  it('stops an orphan that still holds the store lock, then the new server starts on the same store', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-real-'));
    const lockPath = join(location, 'LOCK');
    let orphanPid: number | undefined;
    const lines: string[] = [];
    try {
      // What an earlier release left behind after its worker was SIGKILLed.
      orphanPid = await spawnOrphan(lockingStandin.binaryPath, [
        'serve', '--location', location, '--bind', `127.0.0.1:${port}`,
      ]);
      expect(await waitForCondition(() => portAnswers(port))).toBe(true);
      expect(parentPid(orphanPid), 'fixture orphan was not adopted by init').toBe(1);
      const lockInode = statSync(lockPath).ino;

      const handle = await startOxigraphServer({
        binaryPath: lockingStandin.binaryPath,
        location,
        port,
        readyTimeoutMs: 10_000,
        readyIntervalMs: 50,
        log: (line) => lines.push(line),
      });
      try {
        expect(pidIsGone(orphanPid)).toBe(true);
        expect(await fetchPid(port)).not.toBe(orphanPid);
        expect(lines.join('\n')).toMatch(new RegExp(`stopping orphaned Oxigraph pid ${orphanPid}`));
        // The lock file is Oxigraph's; the daemon never removes or replaces it.
        expect(statSync(lockPath).ino).toBe(lockInode);
      } finally {
        await handle.stop();
      }
    } finally {
      killIfAlive(orphanPid);
      await rm(location, { recursive: true, force: true });
    }
  }, 30_000);

  it('stops this store\'s Oxigraph when its watchdog\'s daemon has exited, before the watchdog does', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-watchdog-'));
    // A watchdog-shaped parent whose daemon is gone but that never polls, so
    // only the reclaim can stop the database it launched.
    const deadDaemon = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(deadDaemon, 'exit');
    const watchdogScript = join(location, 'oxigraph-parent-watchdog.js');
    await writeFile(
      watchdogScript,
      "require('node:child_process').spawn(process.argv[4], process.argv.slice(5), { stdio: 'ignore' });\n"
        + 'setInterval(() => {}, 60_000);\n',
    );
    const watchdog = spawn(process.execPath, [
      watchdogScript, '--direct', String(deadDaemon.pid),
      lockingStandin.binaryPath, 'serve', '--location', location, '--bind', `127.0.0.1:${port}`,
    ], { stdio: 'ignore' });
    let databasePid: number | undefined;
    const lines: string[] = [];
    try {
      expect(await waitForCondition(() => portAnswers(port))).toBe(true);
      databasePid = await fetchPid(port);
      expect(parentPid(databasePid)).toBe(watchdog.pid);

      await expect(stopOrphanedOxigraph({
        binaryPath: lockingStandin.binaryPath,
        location,
        log: (line) => lines.push(line),
      })).resolves.toEqual([databasePid]);
      expect(pidIsGone(databasePid) || parentPid(databasePid) === null).toBe(true);
      expect(lines.join('\n')).toMatch(new RegExp(`stopping orphaned Oxigraph pid ${databasePid}`));
    } finally {
      watchdog.kill('SIGKILL');
      killIfAlive(databasePid);
      await rm(location, { recursive: true, force: true });
    }
  }, 30_000);

  it('leaves a lock holder with a live parent running', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-owned-'));
    // Owned by this test process, as another daemon's Oxigraph would be.
    const owned = spawn(lockingStandin.binaryPath, [
      'serve', '--location', location, '--bind', `127.0.0.1:${port}`,
    ], { stdio: 'ignore' });
    const lines: string[] = [];
    try {
      expect(await waitForCondition(() => portAnswers(port))).toBe(true);

      await expect(stopOrphanedOxigraph({
        binaryPath: lockingStandin.binaryPath,
        location,
        log: (line) => lines.push(line),
      })).resolves.toEqual([]);
      expect(owned.exitCode).toBeNull();
      expect(owned.signalCode).toBeNull();

      // Each discovery probe on this host sees the same holder the same way.
      const lockHolderProbes = hostLockHolderProbes();
      const processProbes = hostProcessProbes();
      expect(lockHolderProbes.length).toBeGreaterThan(0);
      expect(processProbes.length).toBeGreaterThan(0);
      for (const [name, listLockHolders] of lockHolderProbes) {
        expect(await listLockHolders(join(location, 'LOCK')), name).toEqual([owned.pid]);
      }
      for (const [name, describeProcess] of processProbes) {
        expect(await describeProcess(owned.pid!), name).toEqual({
          ppid: process.pid,
          // The stand-in is a `#!/usr/bin/env node` script.
          command: `node ${lockingStandin.binaryPath} serve --location ${location} --bind 127.0.0.1:${port}`,
        });
      }
      expect(lines.join('\n')).toMatch(
        new RegExp(`held by pid ${owned.pid} \\(parent ${process.pid}\\).*its parent pid ${process.pid} is still running`),
      );
    } finally {
      owned.kill('SIGKILL');
      await rm(location, { recursive: true, force: true });
    }
  }, 30_000);
});
