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
 *
 * This file: the reclaim and its process probes against real processes on
 * this host.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { statSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOxigraphServer } from '../src/daemon/oxigraph-server.js';
import { oxigraphStoreArgs } from '../src/daemon/oxigraph-store-launch.js';
import { lsofLockHolderLister, stopOrphanedOxigraph } from '../src/daemon/oxigraph-orphan.js';
import { isCatalogedOxigraph } from '../src/daemon/oxigraph-reclaim-policy.js';
import { oxigraphBinaryLocations } from '../src/daemon/oxigraph-binary.js';
import type { OxigraphLaunchHandle } from '../src/daemon/oxigraph-launch-strategy.js';
import { createOxigraphStoreOwnership } from '../src/daemon/oxigraph-store-ownership.js';
import {
  checkIdentity,
  OXIGRAPH_OWNER_RECORD,
  OXIGRAPH_OWNER_RECORD_SCHEMA,
  readOxigraphOwnerRecord,
  recordOxigraphLaunch,
} from '../src/daemon/oxigraph-owner-record.js';
import {
  bootIdReader,
  procProcessInspector,
  processInspector,
  psProcessInspector,
  type ProcessInspector,
  type ProcessLookup,
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
import {
  hostLockHolderProbes,
  hostProcessProbes,
  killIfAlive,
  parentPid,
  pidIsGone,
} from './fixtures/oxigraph-orphan-harness.js';

let lockingStandin: OxigraphStandinFixture;

beforeAll(async () => {
  lockingStandin = await createOxigraphStandinFixture({ holdStoreLock: true });
});

afterAll(async () => {
  await lockingStandin.cleanup();
});

describe('stopOrphanedOxigraph (real processes)', () => {
  it('describes an exited process as gone with every probe on this host', async () => {
    const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(exited, 'exit');
    for (const [name, inspectProcess] of hostProcessProbes()) {
      expect(await inspectProcess(exited.pid!), name).toEqual({ state: 'gone' });
    }
  });

  it('records the owner of a ready store with a stable start time from every probe on this host', async () => {
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-record-'));
    const launcher = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      expect(hostProcessProbes().length).toBeGreaterThan(0);
      for (const [name, inspectProcess] of hostProcessProbes()) {
        const first = await inspectProcess(launcher.pid!);
        expect(first, name).toMatchObject({ state: 'running', process: { start: expect.stringMatching(/\S/) } });
        // The same process reads with the same start time every time.
        expect(await inspectProcess(launcher.pid!), name).toEqual(first);
        expect(await inspectProcess(process.pid), name).toMatchObject({ state: 'running' });
      }
      const launch = await recordOxigraphLaunch({
        platform: process.platform,
        location,
        binaryPath: '/opt/oxigraph',
        launcherPid: launcher.pid!,
        log: () => {},
      });
      await launch!.markReady(launcher.pid!);
      expect(await readOxigraphOwnerRecord(location)).toMatchObject({
        kind: 'v1',
        record: {
          schema: OXIGRAPH_OWNER_RECORD_SCHEMA,
          binaryPath: '/opt/oxigraph',
          daemon: { pid: process.pid },
          launcher: { pid: launcher.pid },
          oxigraph: { pid: launcher.pid },
        },
      });
    } finally {
      launcher.kill('SIGKILL');
      await rm(location, { recursive: true, force: true });
    }
  });

  it('reads a stable identifier of this boot, and none when the host offers none', async () => {
    const readBoot = bootIdReader(process.platform);
    const boot = await readBoot();
    expect(boot).toMatch(/\S/);
    expect(await readBoot()).toBe(boot);
    // Linux reads procfs; macOS and other BSDs ask sysctl. A failure is null.
    const unreadable = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    expect(await bootIdReader('linux', { read: async () => { throw unreadable; } })()).toBeNull();
    expect(await bootIdReader('darwin', { run: async () => { throw unreadable; } })()).toBeNull();
    expect(await bootIdReader('linux', { read: async () => 'd2b6…-boot\n' })()).toBe('d2b6…-boot');
    expect(await bootIdReader('freebsd', { run: async () => ({ stdout: '{ sec = 1, usec = 2 }\n' }) })())
      .toBe('{ sec = 1, usec = 2 }');
  });

  it('checks a recorded identity as running, gone or unknown, never taking a failed read for an exit', async () => {
    const identity = { pid: 4000, start: 't1' };
    const reads = (lookup: ProcessLookup) => async () => lookup;
    const as = (start: string): ProcessLookup =>
      ({ state: 'running', process: { pid: 4000, start, ppid: 1, argv: null, command: 'node' } });
    expect(await checkIdentity(identity, reads(as('t1')))).toEqual({ state: 'running' });
    // The PID now names another process.
    expect(await checkIdentity(identity, reads(as('t2')))).toEqual({ state: 'gone' });
    expect(await checkIdentity(identity, reads({ state: 'gone' }))).toEqual({ state: 'gone' });
    expect(await checkIdentity(identity, reads({ state: 'unknown', reason: 'ps: timed out' })))
      .toEqual({ state: 'unknown', reason: 'ps: timed out' });
  });

  it('the production store ownership reclaims before it spawns, then records the launch and its ready Oxigraph', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-ownership-'));
    // An earlier release's orphan, adopted by init, still holding the store.
    const orphan = await spawnOrphan(lockingStandin.binaryPath, [
      ...oxigraphStoreArgs(location), '--bind', `127.0.0.1:${port}`,
    ]);
    const lines: string[] = [];
    let launcher: ReturnType<typeof spawn> | undefined;
    let linesAtSpawn = -1;
    try {
      expect(await waitForCondition(() => portAnswers(port))).toBe(true);
      const ownership = createOxigraphStoreOwnership({
        platform: process.platform,
        location,
        binaryPath: lockingStandin.binaryPath,
        log: (line) => lines.push(line),
      });
      const launch = await ownership.launch(() => {
        linesAtSpawn = lines.length;
        launcher = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        return {
          child: launcher,
          alive: () => launcher!.exitCode === null && launcher!.signalCode === null,
          terminate: (signal: NodeJS.Signals) => { launcher!.kill(signal); },
        } as unknown as OxigraphLaunchHandle;
      });
      // The reclaim finished before the spawn.
      expect(lines.slice(0, linesAtSpawn).join('\n')).toContain(
        `stopping orphaned Oxigraph pid ${orphan} (it was reparented to PID 1)`,
      );
      expect(lines.slice(0, linesAtSpawn).join('\n')).toContain('released by the orphaned Oxigraph');
      expect(launch?.oxigraph.child).toBe(launcher);
      // Recorded at spawn, without an Oxigraph yet ...
      const atSpawn = await readOxigraphOwnerRecord(location);
      expect(atSpawn).toMatchObject({
        kind: 'v1',
        record: { daemon: { pid: process.pid }, launcher: { pid: launcher!.pid } },
      });
      expect(atSpawn.kind === 'v1' && atSpawn.record.oxigraph).toBeUndefined();
      // ... and with the verified Oxigraph once ready.
      await launch!.ready(launcher!.pid!);
      expect(await readOxigraphOwnerRecord(location)).toMatchObject({
        kind: 'v1',
        record: { launcher: { pid: launcher!.pid }, oxigraph: { pid: launcher!.pid } },
      });
      await ownership.close();
    } finally {
      launcher?.kill('SIGKILL');
      killIfAlive(orphan);
      await rm(location, { recursive: true, force: true });
    }
  }, 30_000);

  it('recognises the binaries every resolver source gives: the selected one, the oxigraph on PATH and pinned releases in the cache', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'oxi-reclaim-cache-'));
    const decoyDir = await mkdtemp(join(tmpdir(), 'oxi-reclaim-decoy-'));
    const pathDir = await mkdtemp(join(tmpdir(), 'oxi-reclaim-path-'));
    const previousPath = process.env.PATH;
    try {
      await writeFile(join(decoyDir, 'oxigraph'), '#!/bin/sh\n'); // not executable
      await writeFile(join(pathDir, 'oxigraph'), '#!/bin/sh\nexit 0\n');
      await chmod(join(pathDir, 'oxigraph'), 0o755);
      process.env.PATH = `${decoyDir}:${pathDir}`;
      const opts = { cacheDir, platform: process.platform };
      const bundled = { path: join(cacheDir, 'oxigraph-v0.5.8'), source: 'bundled', version: '0.5.8' } as const;
      const system = { path: join(pathDir, 'oxigraph'), source: 'system', version: '0.6.0' } as const;
      for (const selected of [bundled, system]) {
        const catalog = await oxigraphBinaryLocations(selected, opts);
        expect(catalog, selected.source).toEqual({
          exact: [...new Set([selected.path, join(pathDir, 'oxigraph')])],
          cacheDir,
        });
        // An orphan from an earlier release may run an earlier pinned binary
        // from the cache, or the operator's binary on PATH; not the decoy.
        expect(isCatalogedOxigraph(catalog, join(cacheDir, 'oxigraph-v0.5.7')), selected.source).toBe(true);
        expect(isCatalogedOxigraph(catalog, join(pathDir, 'oxigraph')), selected.source).toBe(true);
        expect(isCatalogedOxigraph(catalog, join(decoyDir, 'oxigraph')), selected.source).toBe(false);
        // Nothing else beside them: other oxigraph* tools are not this node's Oxigraph.
        expect(isCatalogedOxigraph(catalog, join(pathDir, 'oxigraph-backup')), selected.source).toBe(false);
        expect(isCatalogedOxigraph(catalog, join(cacheDir, 'oxigraph-server')), selected.source).toBe(false);
      }
      // Without an oxigraph on PATH, only the selected binary is exact.
      process.env.PATH = decoyDir;
      await expect(oxigraphBinaryLocations(bundled, opts)).resolves.toEqual({ exact: [bundled.path], cacheDir });
    } finally {
      process.env.PATH = previousPath;
      for (const dir of [cacheDir, decoyDir, pathDir]) await rm(dir, { recursive: true, force: true });
    }
  });

  it('tells a missing owner record from a malformed and an unreadable one', async () => {
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-record-read-'));
    try {
      expect(await readOxigraphOwnerRecord(location)).toEqual({ kind: 'absent' });
      await writeFile(join(location, OXIGRAPH_OWNER_RECORD), '{"schema": ');
      expect(await readOxigraphOwnerRecord(location)).toEqual({ kind: 'invalid' });
      // A directory where the record belongs fails to read (EISDIR) for any
      // user, root included, unlike a permission bit.
      await rm(join(location, OXIGRAPH_OWNER_RECORD));
      await mkdir(join(location, OXIGRAPH_OWNER_RECORD));
      expect(await readOxigraphOwnerRecord(location)).toEqual({
        kind: 'unreadable',
        reason: expect.stringContaining('EISDIR'),
      });
    } finally {
      await rm(location, { recursive: true, force: true });
    }
  });

  it('records a launch once and extends that same record when it becomes ready', async () => {
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-record-launch-'));
    const reads: number[] = [];
    // Every read reports a new start time, so reading a process twice would show.
    const inspect: ProcessInspector = async (pid) => {
      reads.push(pid);
      return { state: 'running', process: { pid, start: `read-${reads.length}`, ppid: 1, argv: null, command: 'node' } };
    };
    try {
      const launch = await recordOxigraphLaunch({
        platform: process.platform,
        location, binaryPath: '/opt/oxigraph', launcherPid: 4099, log: () => {}, inspect,
        bootId: async () => 'boot-1',
      });
      const atSpawn = await readOxigraphOwnerRecord(location);
      await launch!.markReady(4100);
      const atReady = await readOxigraphOwnerRecord(location);
      if (atSpawn.kind !== 'v1' || atReady.kind !== 'v1') throw new Error('no owner record');
      expect(atSpawn.record.oxigraph).toBeUndefined();
      // The daemon and launcher identities captured at spawn, plus Oxigraph.
      expect(atSpawn.record.boot).toBe('boot-1');
      expect(atReady.record).toEqual({ ...atSpawn.record, oxigraph: { pid: 4100, start: expect.any(String) } });
      // Each process was read once: the daemon and launcher at spawn, Oxigraph when ready.
      expect(reads.sort((a, b) => a - b)).toEqual([4099, 4100, process.pid].sort((a, b) => a - b));
    } finally {
      await rm(location, { recursive: true, force: true });
    }
  });

  it('removes the previous launch\'s record before recording a launch, even one it cannot identify', async () => {
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-record-retire-'));
    try {
      // Launch A's record, still valid in this boot.
      await writeFile(join(location, OXIGRAPH_OWNER_RECORD), JSON.stringify({
        schema: OXIGRAPH_OWNER_RECORD_SCHEMA,
        boot: 'boot-1',
        daemon: { pid: 4000, start: 'a' },
        launcher: { pid: 4001, start: 'a' },
        oxigraph: { pid: 4002, start: 'a' },
        binaryPath: '/opt/oxigraph',
      }));
      expect(await readOxigraphOwnerRecord(location)).toMatchObject({ kind: 'v1' });
      // Launch B cannot be identified, so it writes no record of its own.
      await recordOxigraphLaunch({
        platform: process.platform,
        location, binaryPath: '/opt/oxigraph', launcherPid: 4099, log: () => {},
        inspect: async () => ({ state: 'unknown', reason: 'ps timed out' }),
        bootId: async () => 'boot-1',
      });
      // No record at all, rather than A's identities in force for B's launch.
      expect(await readOxigraphOwnerRecord(location)).toEqual({ kind: 'absent' });
    } finally {
      await rm(location, { recursive: true, force: true });
    }
  });

  it('writes nothing for a launch it could not identify, at spawn or when ready', async () => {
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-record-unknown-'));
    const lines: string[] = [];
    const inspect: ProcessInspector = async (pid) => pid === 4099
      ? { state: 'unknown', reason: 'ps timed out' }
      : { state: 'running', process: { pid, start: 't', ppid: 1, argv: null, command: 'node' } };
    try {
      const launch = await recordOxigraphLaunch({
        platform: process.platform,
        location, binaryPath: '/opt/oxigraph', launcherPid: 4099, log: (line) => lines.push(line), inspect,
        bootId: async () => 'boot-1',
      });
      // No record to extend: the explicit unavailable result.
      expect(launch).toBeNull();
      expect(await readOxigraphOwnerRecord(location)).toEqual({ kind: 'absent' });
      expect(lines).toEqual(['[oxigraph] could not record the store owner: could not read pid 4099: ps timed out']);
      // Windows keeps no record at all.
      await expect(recordOxigraphLaunch({
        platform: 'win32', location, binaryPath: '/opt/oxigraph', launcherPid: 4099, log: () => {},
      })).resolves.toBeNull();
    } finally {
      await rm(location, { recursive: true, force: true });
    }
  });

  it('creates a fresh store directory before recording its owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oxi-orphan-record-fresh-'));
    const location = join(root, 'not', 'yet', 'oxigraph-data');
    const launcher = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await recordOxigraphLaunch({ platform: process.platform, location, binaryPath: '/opt/oxigraph', launcherPid: launcher.pid!, log: () => {} });
      expect(await readOxigraphOwnerRecord(location)).toMatchObject({
        kind: 'v1',
        record: { launcher: { pid: launcher.pid } },
      });
    } finally {
      launcher.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves no temporary file behind when the owner record cannot be written', async () => {
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-record-fail-'));
    const lines: string[] = [];
    try {
      // A directory in the record's place makes the atomic rename fail.
      await mkdir(join(location, OXIGRAPH_OWNER_RECORD, 'blocker'), { recursive: true });
      await recordOxigraphLaunch({
        platform: process.platform,
        location,
        binaryPath: '/opt/oxigraph',
        launcherPid: process.pid,
        log: (line) => lines.push(line),
      });
      expect(lines.join('\n')).toContain('could not record the store owner');
      expect((await readdir(location)).sort()).toEqual([OXIGRAPH_OWNER_RECORD]);
    } finally {
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
      const inspect = processInspector(process.platform);
      const start = async (pid: number): Promise<string | undefined> => {
        const lookup = await inspect(pid);
        return lookup.state === 'running' ? lookup.process.start : undefined;
      };
      await writeFile(join(location, OXIGRAPH_OWNER_RECORD), JSON.stringify({
        schema: OXIGRAPH_OWNER_RECORD_SCHEMA,
        boot: await bootIdReader(process.platform)(),
        daemon: { pid: deadDaemon.pid, start: 'exited' },
        launcher: { pid: adopter.pid, start: await start(adopter.pid!) },
        oxigraph: { pid: databasePid, start: await start(databasePid) },
        binaryPath: lockingStandin.binaryPath,
      }));

      await expect(stopOrphanedOxigraph({
        binaryPath: lockingStandin.binaryPath,
        location,
        log: (line) => lines.push(line),
      })).resolves.toEqual({ signalled: [databasePid], held: null });
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
      })).resolves.toEqual({
        signalled: [],
        // It may be this node's Oxigraph: the store is not free to launch on.
        held: expect.stringMatching(new RegExp(`^pid ${owned.pid}: there is no owner record`)),
      });
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
      // The stand-in is a `#!/usr/bin/env node` script.
      const argv = ['node', lockingStandin.binaryPath, ...oxigraphStoreArgs(location), '--bind', `127.0.0.1:${port}`];
      for (const [name, inspectProcess] of processProbes) {
        expect(await inspectProcess(owned.pid!), name).toEqual({
          state: 'running',
          process: {
            pid: owned.pid,
            start: expect.stringMatching(/\S/),
            ppid: process.pid,
            // `/proc` keeps argv exact; `ps` shows only the joined text.
            argv: name === 'procfs' ? argv : null,
            command: argv.join(' '),
          },
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

describe('process probe classification (injected ps, lsof and /proc)', () => {
  const psFailure = (props: Record<string, unknown>) => Object.assign(new Error('Command failed: ps'), props);

  it.each([
    ['a timeout', { code: null, killed: true, signal: 'SIGTERM', stdout: '', stderr: '' }],
    ['exit 1 from a process killed on its timeout', { code: 1, killed: true, signal: null, stdout: '', stderr: '' }],
    ['a missing lsof', { code: 'ENOENT' }],
    ['an error on stderr', { code: 1, killed: false, signal: null, stdout: '', stderr: 'lsof: status error on LOCK' }],
  ] as const)('lsof: %s rejects rather than reading as no holders', async (_label, props) => {
    const list = lsofLockHolderLister(async () => { throw psFailure(props); });
    await expect(list('/data/ox/LOCK')).rejects.toThrow();
  });

  it('lsof: a clean exit 1 is no holders, a PID list is the holders, and other output rejects', async () => {
    const noHolder = lsofLockHolderLister(async () => {
      throw psFailure({ code: 1, killed: false, signal: null, stdout: '', stderr: '' });
    });
    await expect(noHolder('/data/ox/LOCK')).resolves.toEqual([]);
    await expect(lsofLockHolderLister(async () => ({ stdout: '4100\n4200\n' }))('/data/ox/LOCK'))
      .resolves.toEqual([4100, 4200]);
    await expect(lsofLockHolderLister(async () => ({ stdout: 'p4100\n' }))('/data/ox/LOCK'))
      .rejects.toThrow(/unexpected output/);
  });

  it.each([
    ['a clean exit 1 with no output (no such process)', { code: 1, killed: false, signal: null, stdout: '', stderr: '' }, 'gone'],
    ['a timeout', { code: null, killed: true, signal: 'SIGTERM', stdout: '', stderr: '' }, 'unknown'],
    ['exit 1 from a process killed on its timeout', { code: 1, killed: true, signal: null, stdout: '', stderr: '' }, 'unknown'],
    ['a missing ps', { code: 'ENOENT' }, 'unknown'],
    ['a permission error on stderr', { code: 1, killed: false, signal: null, stdout: '', stderr: 'ps: Operation not permitted' }, 'unknown'],
  ] as const)('ps: %s', async (_label, props, state) => {
    const inspect = psProcessInspector(async () => { throw psFailure(props); });
    expect(await inspect(4100)).toMatchObject({ state });
  });

  it('ps: parses a running process, takes a zombie as gone, and output it cannot parse as unknown', async () => {
    const answering = (stdout: string) => psProcessInspector(async () => ({ stdout }));
    expect(await answering('    1 Ss   Wed Sep  3 23:14:58 2026     /opt/oxigraph serve\n')(4100)).toEqual({
      state: 'running',
      process: { pid: 4100, start: 'Wed Sep 3 23:14:58 2026', ppid: 1, argv: null, command: '/opt/oxigraph serve' },
    });
    expect(await answering('    1 Z    Wed Sep  3 23:14:58 2026     [oxigraph]\n')(4100)).toEqual({ state: 'gone' });
    expect(await answering('garbage\n')(4100)).toMatchObject({ state: 'unknown' });
  });

  it.each([
    ['ENOENT', 'gone'],
    ['ESRCH', 'gone'],
    ['EACCES', 'unknown'],
    ['EIO', 'unknown'],
  ] as const)('/proc: a read failing with %s is %s', async (code, state) => {
    const inspect = procProcessInspector(async () => { throw Object.assign(new Error(code), { code }); });
    expect(await inspect(4100)).toMatchObject({ state });
  });

  it('/proc: parses a running process, a zombie, a malformed stat, and a process gone before its cmdline', async () => {
    // Fields after `(comm)`: state, ppid, 17 more, then starttime.
    const stat = (state: string) => `4100 (oxigraph (x)) ${state} 1 ${'0 '.repeat(17)}777 0`;
    const reading = (statText: string, cmdline: string | Error) => procProcessInspector(async (path) => {
      if (path.endsWith('/stat')) return statText;
      if (typeof cmdline === 'string') return cmdline;
      throw cmdline;
    });
    expect(await reading(stat('S'), '/opt/oxigraph\0serve\0')(4100)).toEqual({
      state: 'running',
      process: { pid: 4100, start: '777', ppid: 1, argv: ['/opt/oxigraph', 'serve'], command: '/opt/oxigraph serve' },
    });
    expect(await reading(stat('Z'), '')(4100)).toEqual({ state: 'gone' });
    expect(await reading('4100 (x) S', '')(4100)).toMatchObject({ state: 'unknown' });
    const exited = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    expect(await reading(stat('S'), exited)(4100)).toEqual({ state: 'gone' });
  });
});
