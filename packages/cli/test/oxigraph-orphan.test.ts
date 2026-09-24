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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOxigraphServer } from '../src/daemon/oxigraph-server.js';
import { findListenOwnerPid } from '../src/daemon/oxigraph-listen-port.js';
import { createOxigraphLaunchStrategy } from '../src/daemon/oxigraph-launch-strategy.js';
import {
  lsofLockHolders,
  OXIGRAPH_OWNER_RECORD,
  oxigraphStoreArgs,
  procLockHolders,
  readOxigraphOwnerRecord,
  recordOxigraphOwner,
  runsManagedOxigraphStore,
  stopOrphanedOxigraph,
  type OrphanedOxigraphIo,
  type OxigraphOwnerRecord,
} from '../src/daemon/oxigraph-orphan.js';
import {
  procDescribeProcess,
  procProcessStart,
  processStartProbe,
  psDescribeProcess,
  psProcessStart,
  type ProcessDescriber,
  type ProcessStartProbe,
} from '../src/daemon/process-probe.js';
import {
  createOxigraphStandinFixture,
  fetchPid,
  freePort,
  portAnswers,
  spawnOrphan,
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

/** Every process start-time probe this host can run, not only its default. */
function hostStartProbes(): Array<[string, ProcessStartProbe]> {
  const probes: Array<[string, ProcessStartProbe]> = [];
  if (hostHas('ps')) probes.push(['ps', psProcessStart]);
  if (hostHasProcfs) probes.push(['procfs', procProcessStart]);
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
  it('stops Oxigraph with its SIGKILLed worker, so the respawned worker can start', async () => {
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
    } finally {
      if (second) await stopWorker(second);
      if (first) first.child.kill('SIGKILL');
      killIfAlive(firstListenerPid);
      killIfAlive(secondListenerPid);
      await rm(location, { recursive: true, force: true });
    }
  }, 60_000);

  it('reclaims a replacement worker\'s store from an orphan whose watchdog cannot act', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-respawn-'));
    let first: WorkerProcess | undefined;
    let second: WorkerProcess | undefined;
    let firstListenerPid: number | undefined;
    let stoppedWatchdog: number | null = null;
    try {
      first = await startWorker(port, location);
      firstListenerPid = await fetchPid(port);
      // Freeze the old watchdog so it cannot stop Oxigraph on its next poll:
      // only the replacement's reclaim can then free the store.
      stoppedWatchdog = parentPid(firstListenerPid);
      expect(stoppedWatchdog).not.toBeNull();
      process.kill(stoppedWatchdog!, 'SIGSTOP');
      const exited = once(first.child, 'exit');
      first.child.kill('SIGKILL');
      await exited;

      second = await startWorker(port, location);
      expect(await fetchPid(port)).not.toBe(firstListenerPid);
      expect(second.stderr()).toContain(
        `stopping orphaned Oxigraph pid ${firstListenerPid} (its recorded daemon pid ${first.child.pid} has exited)`,
      );
    } finally {
      if (second) await stopWorker(second);
      if (first) first.child.kill('SIGKILL');
      killIfAlive(stoppedWatchdog ?? undefined);
      killIfAlive(firstListenerPid);
      await rm(location, { recursive: true, force: true });
    }
  }, 60_000);

  it('reclaims the Oxigraph of a worker killed before its store was ready, with its watchdog frozen', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-preready-'));
    // Oxigraph starts but is never verified ready, like a long WAL replay.
    const first = spawn(process.execPath, [
      '--import', 'tsx',
      fileURLToPath(new URL('./fixtures/oxigraph-worker-process.ts', import.meta.url)),
      lockingStandin.binaryPath, location, String(port), 'never-ready',
    ], { stdio: 'ignore' });
    let second: WorkerProcess | undefined;
    let listenerPid: number | undefined;
    let frozenWatchdog: number | null = null;
    try {
      expect(await waitForCondition(() => portAnswers(port), 10_000)).toBe(true);
      listenerPid = await fetchPid(port);
      frozenWatchdog = parentPid(listenerPid);
      // The launch was recorded at spawn, before any readiness.
      const recorded = await waitForCondition(async () => {
        const text = await readFile(join(location, OXIGRAPH_OWNER_RECORD), 'utf8').catch(() => '');
        return text.includes(`"pid":${frozenWatchdog}`);
      }, 10_000);
      expect(recorded, 'the launch was not recorded at spawn').toBe(true);
      process.kill(frozenWatchdog!, 'SIGSTOP');
      const exited = once(first, 'exit');
      first.kill('SIGKILL');
      await exited;

      second = await startWorker(port, location);
      expect(await fetchPid(port)).not.toBe(listenerPid);
      expect(second.stderr()).toContain(
        `stopping orphaned Oxigraph pid ${listenerPid} (its recorded daemon pid ${first.pid} has exited)`,
      );
    } finally {
      if (second) await stopWorker(second);
      first.kill('SIGKILL');
      killIfAlive(frozenWatchdog ?? undefined);
      killIfAlive(listenerPid);
      await rm(location, { recursive: true, force: true });
    }
  }, 60_000);

  it('reclaims its own Oxigraph on restart when only the watchdog it launched is killed', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-restart-'));
    const lines: string[] = [];
    let listenerPid: number | undefined;
    const handle = await startOxigraphServer({
      binaryPath: lockingStandin.binaryPath,
      location,
      port,
      readyTimeoutMs: 10_000,
      readyIntervalMs: 50,
      restartBackoffBaseMs: 50,
      restartBackoffMaxMs: 50,
      log: (line) => lines.push(line),
    });
    try {
      listenerPid = await fetchPid(port);
      const watchdog = parentPid(listenerPid);
      expect(watchdog).not.toBeNull();
      expect(watchdog).not.toBe(process.pid);
      // Oxigraph keeps running, adopted by init, with the lock and the port.
      process.kill(watchdog!, 'SIGKILL');

      expect(await waitForCondition(async () => {
        const pid = await fetchPid(port).catch(() => undefined);
        return pid !== undefined && pid !== listenerPid && !handle.getRecoveryState().recovering;
      }, 20_000)).toBe(true);
      expect(pidIsGone(listenerPid)).toBe(true);
      expect(lines.join('\n')).toContain(
        `stopping orphaned Oxigraph pid ${listenerPid} (its recorded launcher pid ${watchdog} has exited)`,
      );
    } finally {
      await handle.stop();
      killIfAlive(listenerPid);
      await rm(location, { recursive: true, force: true });
    }
  }, 30_000);

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

  beforeEach(async () => {
    location = await mkdtemp(join(tmpdir(), 'oxi-orphan-table-'));
    await writeFile(join(location, 'LOCK'), '');
  });

  afterEach(async () => {
    await rm(location, { recursive: true, force: true });
  });

  interface FakeProcess {
    ppid: number;
    command: string;
    holdsLock: boolean;
    /** Start-time token; defaults to `t<pid>`. */
    start?: string;
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
      processStart: async (pid) => {
        const entry = table.get(pid);
        return entry?.alive ? entry.start ?? `t${pid}` : null;
      },
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
    `${binary} ${oxigraphStoreArgs(store).join(' ')} --bind 127.0.0.1:7901`;
  const identity = (pid: number) => ({ pid, start: `t${pid}` });
  const writeRecord = async (record: Partial<OxigraphOwnerRecord> = {}) => {
    await writeFile(join(location, OXIGRAPH_OWNER_RECORD), JSON.stringify({
      daemon: identity(4000),
      launcher: identity(4099),
      oxigraph: identity(4100),
      binaryPath,
      ...record,
    }));
  };
  const run = async (io: OrphanedOxigraphIo, extra: { knownBinaryDirs?: string[] } = {}) => {
    const lines: string[] = [];
    const signalled = await stopOrphanedOxigraph({
      binaryPath, location, log: (line) => lines.push(line), io, ...extra,
    });
    return { signalled, log: lines.join('\n') };
  };

  describe('without an owner record (an orphan from an earlier release)', () => {
    it('stops an orphan adopted by PID 1 with SIGTERM and returns once the lock is free', async () => {
      const { table, signals, io } = processTable({
        4100: { ppid: 1, command: serve(location), holdsLock: true },
      });

      const { signalled, log } = await run(io);
      expect(signalled).toEqual([4100]);
      expect(signals).toEqual([[4100, 'SIGTERM']]);
      expect(table.get(4100)!.alive).toBe(false);
      expect(log).toMatch(/stopping orphaned Oxigraph pid 4100 \(it was reparented to PID 1\)/);
      expect(log).toMatch(/released by the orphaned Oxigraph/);
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

    it.each([
      ['the binary an earlier release pinned beside the current one', '/home/dkg/.dkg/oxigraph/oxigraph-v0.5.7'],
      ['the PATH binary, from a known binary directory', '/usr/local/bin/oxigraph'],
    ])('stops an orphan that runs %s', async (_label, binary) => {
      const { signals, io } = processTable({
        4100: { ppid: 1, command: serve(location, binary), holdsLock: true },
      });

      const { signalled } = await run(io, { knownBinaryDirs: ['/usr/local/bin'] });
      expect(signalled).toEqual([4100]);
      expect(signals).toEqual([[4100, 'SIGTERM']]);
    });

    it.each([
      ['a live daemon worker', 'node /opt/dkg/dist/cli.js daemon-worker'],
      ['an operator shell', '/bin/bash'],
      // Without a record a subreaper cannot be told from a live owner; the
      // log names it so an operator can decide.
      ['a subreaper', '/lib/systemd/systemd --user'],
    ])('leaves this store\'s Oxigraph running while its parent is %s', async (_label, parentCommand) => {
      const { table, signals, io } = processTable({
        4099: { ppid: 1, command: parentCommand, holdsLock: false },
        4100: { ppid: 4099, command: serve(location), holdsLock: true },
      });

      const { signalled, log } = await run(io);
      expect(signalled).toEqual([]);
      expect(signals).toEqual([]);
      expect(table.get(4100)!.alive).toBe(true);
      expect(log).toContain(
        `held by pid 4100 (parent 4099): ${serve(location)}. Leaving it running: ` +
          `there is no owner record, and its parent pid 4099 is still running: ${parentCommand}.`,
      );
    });

    it('falls back to the PID 1 rule when the owner record is unreadable', async () => {
      await writeFile(join(location, OXIGRAPH_OWNER_RECORD), '{"daemon": 4000');
      const { signals, io } = processTable({
        4099: { ppid: 1, command: '/lib/systemd/systemd --user', holdsLock: false },
        4100: { ppid: 4099, command: serve(location), holdsLock: true },
      });

      const { signalled } = await run(io);
      expect(signalled).toEqual([]);
      expect(signals).toEqual([]);
    });
  });

  describe('with an owner record', () => {
    it('leaves every holder running while the recorded daemon and launcher both run', async () => {
      await writeRecord();
      const { table, signals, io } = processTable({
        4000: { ppid: 1, command: 'node /opt/dkg/dist/cli.js daemon-worker', holdsLock: false },
        4099: { ppid: 4000, command: 'node oxigraph-parent-watchdog.js --direct 4000', holdsLock: false },
        4100: { ppid: 1, command: serve(location), holdsLock: true },
      });

      const { signalled, log } = await run(io);
      expect(signalled).toEqual([]);
      expect(signals).toEqual([]);
      expect(table.get(4100)!.alive).toBe(true);
      expect(log).toMatch(/Leaving it running: this store's recorded daemon pid 4000 and launcher pid 4099 are still running/);
    });

    it.each([
      // The worker was SIGKILLed and a subreaper, not PID 1, adopted Oxigraph.
      ['its daemon exited and a subreaper adopted it', {
        900: { ppid: 1, command: '/lib/systemd/systemd --user', holdsLock: false },
        4099: { ppid: 900, command: 'node oxigraph-parent-watchdog.js --direct 4000', holdsLock: false },
        4100: { ppid: 900, command: serve(location), holdsLock: true },
      }, 'its recorded daemon pid 4000 has exited'],
      // The daemon runs on but its watchdog was killed on its own.
      ['its launcher was killed while the daemon runs on', {
        4000: { ppid: 1, command: 'node /opt/dkg/dist/cli.js daemon-worker', holdsLock: false },
        4100: { ppid: 1, command: serve(location), holdsLock: true },
      }, 'its recorded launcher pid 4099 has exited'],
      // A respawned worker reused the dead daemon's PID; the start time differs.
      ['the recorded daemon PID now names another process', {
        4000: { ppid: 1, command: 'node /opt/dkg/dist/cli.js daemon-worker', holdsLock: false, start: 'later' },
        4099: { ppid: 1, command: 'node oxigraph-parent-watchdog.js --direct 4000', holdsLock: false },
        4100: { ppid: 4099, command: serve(location), holdsLock: true },
      }, 'its recorded daemon pid 4000 has exited'],
    ] as const)('stops this store\'s Oxigraph once %s', async (_label, entries, because) => {
      await writeRecord();
      const { signals, io } = processTable(entries);

      const { signalled, log } = await run(io);
      expect(signalled).toEqual([4100]);
      expect(signals).toEqual([[4100, 'SIGTERM']]);
      expect(log).toContain(`stopping orphaned Oxigraph pid 4100 (${because})`);
    });

    it('stops an orphan launched from the binary the record names after the node moved to another', async () => {
      // Not the recorded Oxigraph (a launch killed before it was recorded),
      // but it runs the recorded binary for this store and init adopted it.
      await writeRecord({ binaryPath: '/usr/local/bin/oxigraph', oxigraph: identity(4555) });
      const { signals, io } = processTable({
        4100: { ppid: 1, command: serve(location, '/usr/local/bin/oxigraph'), holdsLock: true },
      });

      const { signalled } = await run(io);
      expect(signalled).toEqual([4100]);
      expect(signals).toEqual([[4100, 'SIGTERM']]);
    });

    it('stops the recorded Oxigraph by identity even when its command line is unrecognised', async () => {
      await writeRecord();
      const { signals, io } = processTable({
        4100: { ppid: 900, command: 'oxigraph-renamed serve --location elsewhere', holdsLock: true },
      });

      const { signalled } = await run(io);
      expect(signalled).toEqual([4100]);
      expect(signals).toEqual([[4100, 'SIGTERM']]);
    });

    it('leaves an unrecorded holder with a live parent running even when the recorded owner exited', async () => {
      await writeRecord();
      const { table, signals, io } = processTable({
        4098: { ppid: 1, command: '/bin/bash', holdsLock: false },
        4200: { ppid: 4098, command: serve(location), holdsLock: true },
      });

      const { signalled, log } = await run(io);
      expect(signalled).toEqual([]);
      expect(signals).toEqual([]);
      expect(table.get(4200)!.alive).toBe(true);
      expect(log).toContain(
        'Leaving it running: it is not the Oxigraph recorded for this store, ' +
          'and its parent pid 4098 is still running: /bin/bash.',
      );
    });

    it('stops a child of the recorded launcher when the launch was killed before it was ready', async () => {
      await writeRecord({ oxigraph: undefined });
      const { signals, io } = processTable({
        // The daemon (4000) is gone; its watchdog (4099) lives on but cannot act.
        4099: { ppid: 1, command: 'node oxigraph-parent-watchdog.js --direct 4000', holdsLock: false },
        4100: { ppid: 4099, command: serve(location), holdsLock: true },
      });

      const { signalled, log } = await run(io);
      expect(signalled).toEqual([4100]);
      expect(signals).toEqual([[4100, 'SIGTERM']]);
      expect(log).toContain('stopping orphaned Oxigraph pid 4100 (its recorded daemon pid 4000 has exited)');
    });

    it.each([
      ['its parent only reuses the recorded launcher PID', {
        4099: { ppid: 1, command: '/bin/bash', holdsLock: false, start: 'later' },
        4100: { ppid: 4099, command: serve(location), holdsLock: true },
      }],
      ['it is not this node\'s Oxigraph for this store', {
        4099: { ppid: 1, command: 'node oxigraph-parent-watchdog.js --direct 4000', holdsLock: false },
        4100: { ppid: 4099, command: `/usr/bin/backup ${location}`, holdsLock: true },
      }],
    ] as const)('leaves a child of the recorded launcher PID running when %s', async (_label, entries) => {
      await writeRecord({ oxigraph: undefined });
      const { signals, io } = processTable(entries);

      const { signalled } = await run(io);
      expect(signalled).toEqual([]);
      expect(signals).toEqual([]);
    });

    it('does not stop a foreign holder whose PID the record names but whose start time differs', async () => {
      await writeRecord();
      const { signals, io } = processTable({
        4100: { ppid: 1, command: `/usr/bin/backup ${location}`, holdsLock: true, start: 'later' },
      });

      const { signalled, log } = await run(io);
      expect(signalled).toEqual([]);
      expect(signals).toEqual([]);
      expect(log).toMatch(/Leaving it running: it is not this node's Oxigraph serving this store/);
    });
  });

  it.each([
    ['a binary outside this node\'s binary directories', serve(location, '/opt/other/oxigraph')],
    ['another executable in this node\'s binary directory', serve(location, '/home/dkg/.dkg/oxigraph/rocksdb-tool')],
    ['another store whose path extends this one', serve(`${location}-2`)],
    ['a non-serve command on this binary', `${binaryPath} dump --location ${location}`],
    ['an unrelated tool', `sqlite3 ${location}/LOCK`],
  ])('leaves an orphaned lock holder running when it is %s', async (_label, command) => {
    const { table, signals, io } = processTable({
      4100: { ppid: 1, command, holdsLock: true },
    });

    const { signalled, log } = await run(io);
    expect(signalled).toEqual([]);
    expect(signals).toEqual([]);
    expect(table.get(4100)!.alive).toBe(true);
    expect(log).toMatch(/Leaving it running: it is not this node's Oxigraph serving this store/);
  });

  it('stops only the orphan when a foreign process also holds the lock', async () => {
    const { signals, io } = processTable({
      4100: { ppid: 1, command: serve(location), holdsLock: true },
      4200: { ppid: 1, command: `/usr/bin/backup ${location}`, holdsLock: true },
      4300: { ppid: 1, command: serve(location), holdsLock: false },
    });

    const { signalled } = await run(io);
    expect(signalled).toEqual([4100]);
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

  it('recognises the exact Oxigraph argv that the direct and scoped launches build', () => {
    const serveArgs = [...oxigraphStoreArgs('/data/ox'), '--bind', '127.0.0.1:7878'];
    for (const memoryLimits of [undefined, { maxMiB: 3072 }]) {
      const spec = createOxigraphLaunchStrategy({
        memoryLimits,
        platform: 'linux',
        parentPid: 42,
        uid: 1000,
        nodeExecutable: '/opt/node',
        watchdogPath: '/opt/oxigraph-watchdog.js',
      }).nextSpawnSpec(binaryPath, serveArgs);
      // The argv the watchdog execs for Oxigraph: the binary and its arguments.
      const oxigraphArgv = spec.args.slice(spec.args.indexOf(binaryPath));
      expect(runsManagedOxigraphStore(oxigraphArgv.join(' '), '/data/ox', [binaryPath])).toBe(true);
    }
  });

  it('matches this store\'s arguments from known binaries only, including through a #! interpreter', () => {
    expect(runsManagedOxigraphStore(serve('/data/ox'), '/data/ox', [binaryPath])).toBe(true);
    expect(runsManagedOxigraphStore(`node ${serve('/data/ox')}`, '/data/ox', [binaryPath])).toBe(true);
    expect(runsManagedOxigraphStore(`${binaryPath} serve --location /data/ox`, '/data/ox', [binaryPath])).toBe(true);
    expect(runsManagedOxigraphStore(serve('/data/ox', `${binaryPath}-old`), '/data/ox', [binaryPath])).toBe(true);
    expect(runsManagedOxigraphStore(serve('/data/ox2'), '/data/ox', [binaryPath])).toBe(false);
    expect(runsManagedOxigraphStore(serve('/data/ox', '/opt/other/oxigraph-v0.5.8'), '/data/ox', [binaryPath])).toBe(false);
    expect(runsManagedOxigraphStore(
      serve('/data/ox', '/opt/other/oxigraph-v0.5.8'), '/data/ox', [binaryPath], ['/opt/other'],
    )).toBe(true);
    expect(runsManagedOxigraphStore(serve('/data/ox', '/usr/bin/python3'), '/data/ox', ['/usr/bin/oxigraph'])).toBe(false);
  });
});

describe('stopOrphanedOxigraph (real processes)', () => {
  it('describes an exited process as gone with every probe on this host', async () => {
    const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(exited, 'exit');
    for (const [name, describeProcess] of hostProcessProbes()) {
      expect(await describeProcess(exited.pid!), name).toBeNull();
    }
    for (const [name, processStart] of hostStartProbes()) {
      expect(await processStart(exited.pid!), name).toBeNull();
    }
  });

  it('records the owner of a ready store with a stable start time from every probe on this host', async () => {
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-record-'));
    const launcher = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      expect(hostStartProbes().length).toBeGreaterThan(0);
      for (const [name, processStart] of hostStartProbes()) {
        const start = await processStart(launcher.pid!);
        expect(start, name).toMatch(/\S/);
        expect(await processStart(launcher.pid!), name).toBe(start);
        expect(await processStart(process.pid), name).not.toBeNull();
      }
      await recordOxigraphOwner({
        location,
        binaryPath: '/opt/oxigraph',
        launcherPid: launcher.pid!,
        oxigraphPid: launcher.pid!,
        log: () => {},
      });
      const record = await readOxigraphOwnerRecord(location);
      expect(record).toMatchObject({
        binaryPath: '/opt/oxigraph',
        daemon: { pid: process.pid },
        launcher: { pid: launcher.pid },
        oxigraph: { pid: launcher.pid },
      });
    } finally {
      launcher.kill('SIGKILL');
      await rm(location, { recursive: true, force: true });
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
        ...oxigraphStoreArgs(location), '--bind', `127.0.0.1:${port}`,
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

  it('stops a recorded Oxigraph whose daemon has exited even though a live process adopted it', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-adopted-'));
    // A live parent that is neither PID 1 nor a watchdog, like a subreaper.
    const adopter = spawn(process.execPath, [
      '-e',
      "require('node:child_process').spawn(process.argv[1], process.argv.slice(2), { stdio: 'ignore' }); setInterval(() => {}, 60_000);",
      lockingStandin.binaryPath, ...oxigraphStoreArgs(location), '--bind', `127.0.0.1:${port}`,
    ], { stdio: 'ignore' });
    const deadDaemon = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(deadDaemon, 'exit');
    let databasePid: number | undefined;
    const lines: string[] = [];
    try {
      expect(await waitForCondition(() => portAnswers(port))).toBe(true);
      databasePid = await fetchPid(port);
      expect(parentPid(databasePid)).toBe(adopter.pid);
      // The same probe the reclaim reads identities with on this platform.
      const start = processStartProbe(process.platform);
      await writeFile(join(location, OXIGRAPH_OWNER_RECORD), JSON.stringify({
        daemon: { pid: deadDaemon.pid, start: 'exited' },
        launcher: { pid: adopter.pid, start: await start(adopter.pid!) },
        oxigraph: { pid: databasePid, start: await start(databasePid) },
        binaryPath: lockingStandin.binaryPath,
      }));

      await expect(stopOrphanedOxigraph({
        binaryPath: lockingStandin.binaryPath,
        location,
        log: (line) => lines.push(line),
      })).resolves.toEqual([databasePid]);
      expect(await waitForCondition(async () => !(await portAnswers(port)))).toBe(true);
      expect(lines.join('\n')).toContain(
        `stopping orphaned Oxigraph pid ${databasePid} (its recorded daemon pid ${deadDaemon.pid} has exited)`,
      );
    } finally {
      adopter.kill('SIGKILL');
      killIfAlive(databasePid);
      await rm(location, { recursive: true, force: true });
    }
  }, 30_000);

  it('leaves a lock holder with a live parent running when there is no owner record', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-owned-'));
    // Owned by this test process, as another daemon's Oxigraph would be.
    const owned = spawn(lockingStandin.binaryPath, [
      ...oxigraphStoreArgs(location), '--bind', `127.0.0.1:${port}`,
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
