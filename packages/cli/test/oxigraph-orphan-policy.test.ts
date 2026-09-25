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
 * This file: the reclaim's decisions against an injected process table, and
 * how a holder's command line is matched.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { ChildProcess, spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { OxigraphBinaryCatalog } from '../src/daemon/oxigraph-binary.js';
import { createOxigraphLaunchStrategy } from '../src/daemon/oxigraph-launch-strategy.js';
import { oxigraphStoreArgs } from '../src/daemon/oxigraph-store-launch.js';
import { stopOrphanedOxigraph, type OrphanedOxigraphIo } from '../src/daemon/oxigraph-orphan.js';
import { psProcessInspector } from '../src/daemon/process-probe.js';
import {
  checkIdentity,
  OXIGRAPH_OWNER_RECORD,
  OXIGRAPH_OWNER_RECORD_SCHEMA,
  type OxigraphOwnerRecordRead,
  type OxigraphOwnerRecordV1,
} from '../src/daemon/oxigraph-owner-record.js';
import {
  classifyHolder,
  deriveOwnership,
  matchManagedOxigraphStore,
} from '../src/daemon/oxigraph-reclaim-policy.js';
import { processTable, type FakeProcess } from './fixtures/oxigraph-process-table.js';

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

  const serve = (store: string, binary = binaryPath) =>
    [binary, ...oxigraphStoreArgs(store), '--bind', '127.0.0.1:7901'];
  const directWatchdog = (daemonPid: number) =>
    ['node', 'oxigraph-parent-watchdog.js', '--direct', String(daemonPid)];
  const daemonWorker = ['node', '/opt/dkg/dist/cli.js', 'daemon-worker'];
  const identity = (pid: number) => ({ pid, start: `t${pid}` });
  const writeRecord = async (record: Partial<OxigraphOwnerRecordV1> = {}) => {
    await writeFile(join(location, OXIGRAPH_OWNER_RECORD), JSON.stringify({
      schema: OXIGRAPH_OWNER_RECORD_SCHEMA,
      daemon: identity(4000),
      launcher: identity(4099),
      oxigraph: identity(4100),
      binaryPath,
      ...record,
    }));
  };
  const run = async (io: Partial<OrphanedOxigraphIo>, extra: { binaries?: OxigraphBinaryCatalog } = {}) => {
    const lines: string[] = [];
    const signalled = await stopOrphanedOxigraph({
      binaryPath, location, log: (line) => lines.push(line), io, ...extra,
    });
    return { signalled, log: lines.join('\n') };
  };

  describe('without an owner record (an orphan from an earlier release)', () => {
    it('stops an orphan adopted by PID 1 with SIGTERM and returns once the lock is free', async () => {
      const { table, signals, io } = processTable({
        4100: { ppid: 1, argv: serve(location), holdsLock: true },
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
        4100: { ppid: 1, argv: serve(location), holdsLock: true, ignoresTerm: true },
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
        4100: { ppid: 1, argv: serve(location, binary), holdsLock: true },
      });

      const { signalled } = await run(io, {
        binaries: { paths: [binaryPath], dirs: [dirname(binaryPath), '/usr/local/bin'] },
      });
      expect(signalled).toEqual([4100]);
      expect(signals).toEqual([[4100, 'SIGTERM']]);
    });

    it.each([
      ['a live daemon worker', daemonWorker],
      ['an operator shell', ['/bin/bash']],
      // Without a record a subreaper cannot be told from a live owner; the
      // log names it so an operator can decide.
      ['a subreaper', ['/lib/systemd/systemd', '--user']],
    ])('leaves this store\'s Oxigraph running while its parent is %s', async (_label, parentArgv) => {
      const { table, signals, io } = processTable({
        4099: { ppid: 1, argv: parentArgv, holdsLock: false },
        4100: { ppid: 4099, argv: serve(location), holdsLock: true },
      });

      const { signalled, log } = await run(io);
      expect(signalled).toEqual([]);
      expect(signals).toEqual([]);
      expect(table.get(4100)!.alive).toBe(true);
      expect(log).toContain(
        `held by pid 4100 (parent 4099): ${serve(location).join(' ')}. Leaving it running: ` +
          `there is no owner record, and its parent pid 4099 is still running: ${parentArgv.join(' ')}.`,
      );
    });

    it('falls back to the PID 1 rule for a malformed or unversioned owner record', async () => {
      for (const content of ['{"daemon": 4000', JSON.stringify({ daemon: identity(4000), launcher: identity(4099), binaryPath })]) {
        await writeFile(join(location, OXIGRAPH_OWNER_RECORD), content);
        const { signals, io } = processTable({
          4099: { ppid: 1, argv: ['/lib/systemd/systemd', '--user'], holdsLock: false },
          4100: { ppid: 4099, argv: serve(location), holdsLock: true },
        });

        const { signalled, log } = await run(io);
        expect(signalled).toEqual([]);
        expect(signals).toEqual([]);
        expect(log).toContain('ignoring a malformed owner record');
        expect(log).toContain('there is no owner record');
      }
    });

    it('leaves every holder running when the owner record exists but cannot be read', async () => {
      // A directory where the record belongs: reading it fails with EISDIR,
      // whoever runs the test.
      await mkdir(join(location, OXIGRAPH_OWNER_RECORD));
      const { table, signals, io } = processTable({
        // Without a record, the PID 1 rule would stop this holder.
        4100: { ppid: 1, argv: serve(location), holdsLock: true },
      });

      const { signalled, log } = await run(io);
      expect(signalled).toEqual([]);
      expect(signals).toEqual([]);
      expect(table.get(4100)!.alive).toBe(true);
      expect(log).toMatch(/Leaving it running: its owner could not be determined \(the owner record could not be read: .*EISDIR/);
    });
  });

  describe('on a fully injected host (no filesystem or process-table access)', () => {
    const store = '/nonexistent/oxigraph-data';
    const recorded: OxigraphOwnerRecordRead = {
      kind: 'v1',
      record: {
        schema: OXIGRAPH_OWNER_RECORD_SCHEMA,
        daemon: identity(4000),
        launcher: identity(4099),
        oxigraph: identity(4100),
        binaryPath,
      },
    };

    it('runs the complete reclaim from the host\'s lock, owner record and process table', async () => {
      const { table, signals, io } = processTable({
        4100: { ppid: 900, argv: serve(store), holdsLock: true },
      });
      const lines: string[] = [];
      const signalled = await stopOrphanedOxigraph({
        binaryPath,
        location: store,
        log: (line) => lines.push(line),
        io: {
          ...io,
          platform: 'linux',
          lockExists: async (lockPath) => lockPath === `${store}/LOCK`,
          readOwnerRecord: async () => recorded,
        },
      });
      expect(signalled).toEqual([4100]);
      expect(signals).toEqual([[4100, 'SIGTERM']]);
      expect(table.get(4100)!.alive).toBe(false);
      expect(lines.join('\n')).toContain('stopping orphaned Oxigraph pid 4100 (its recorded daemon pid 4000 has exited)');
    });

    it.each(['win32', 'linux'] as const)('does nothing on %s when the host says there is nothing to reclaim', async (platform) => {
      const listLockHolders = async (): Promise<number[]> => { throw new Error('must not list holders'); };
      await expect(stopOrphanedOxigraph({
        binaryPath,
        location: store,
        log: () => {},
        // Windows is skipped outright; elsewhere the missing lock file ends it.
        io: { platform, lockExists: async () => false, listLockHolders },
      })).resolves.toEqual([]);
    });

    it('does not signal when the real ps classifier cannot read the holder', async () => {
      // `ps` killed on its timeout: exit status 1 but no output, and not an exit.
      const timedOut = Object.assign(new Error('Command failed: ps'), {
        code: 1, killed: true, signal: 'SIGTERM', stdout: '', stderr: '',
      });
      const inspectProcess = psProcessInspector(async () => { throw timedOut; });
      const signals: Array<[number, NodeJS.Signals]> = [];
      const lines: string[] = [];
      const signalled = await stopOrphanedOxigraph({
        binaryPath,
        location: store,
        log: (line) => lines.push(line),
        io: {
          platform: 'darwin',
          lockExists: async () => true,
          readOwnerRecord: async () => recorded,
          listLockHolders: async () => [4100],
          inspectProcess,
          checkIdentity: (id) => checkIdentity(id, inspectProcess),
          signal: (pid, name) => { signals.push([pid, name]); },
          sleep: async () => {},
          now: () => 0,
        },
      });
      expect(signalled).toEqual([]);
      expect(signals).toEqual([]);
      expect(lines.join('\n')).toContain('is held by pid 4100, which could not be inspected (ps: Command failed: ps)');
    });
  });

  describe('after SIGTERM, until the signalled orphan is confirmed gone', () => {
    const reap = async (io: Partial<OrphanedOxigraphIo>) => {
      const lines: string[] = [];
      const signalled = await stopOrphanedOxigraph({
        binaryPath, location, log: (line) => lines.push(line), io,
        stopGraceMs: 500, pollIntervalMs: 100, timeoutMs: 5_000,
      });
      return { signalled, log: lines.join('\n') };
    };

    it('keeps waiting, and escalates, for an orphan that closed LOCK but still runs', async () => {
      const { table, signals, io } = processTable({
        4100: { ppid: 1, argv: serve(location), holdsLock: true, ignoresTerm: true },
      });
      const signal = io.signal;
      io.signal = (pid, name) => {
        signal(pid, name);
        // Shutting down: LOCK is closed, the process is not gone yet.
        table.get(4100)!.holdsLock = false;
      };

      const { signalled, log } = await reap(io);
      expect(signalled).toEqual([4100]);
      expect(signals).toEqual([[4100, 'SIGTERM'], [4100, 'SIGKILL']]);
      expect(table.get(4100)!.alive).toBe(false);
      expect(log).toContain('did not exit on SIGTERM; sending SIGKILL');
      expect(log.indexOf('released by the orphaned Oxigraph')).toBeGreaterThan(log.indexOf('sending SIGKILL'));
    });

    it('does not take a failed holder scan for a release', async () => {
      const { table, signals, io } = processTable({
        4100: { ppid: 1, argv: serve(location), holdsLock: true, ignoresTerm: true },
      });
      const list = io.listLockHolders;
      let scans = 0;
      io.listLockHolders = async (lockPath) => {
        scans += 1;
        if (scans > 1) throw new Error('lsof timed out');
        return list(lockPath);
      };

      const { signalled, log } = await reap(io);
      expect(signalled).toEqual([4100]);
      expect(signals).toEqual([[4100, 'SIGTERM'], [4100, 'SIGKILL']]);
      expect(table.get(4100)!.alive).toBe(false);
      expect(log).toContain('released by the orphaned Oxigraph');
    });

    it('does not signal a recycled PID while it waits for an orphan that left the holder list', async () => {
      const { table, signals, io } = processTable({
        4100: { ppid: 1, argv: serve(location), holdsLock: true, ignoresTerm: true },
      });
      const signal = io.signal;
      io.signal = (pid, name) => {
        signal(pid, name);
        // The orphan exits after SIGTERM after all, and an unrelated process
        // receives its PID.
        table.set(4100, { ppid: 1, argv: ['/usr/bin/vim'], holdsLock: false, start: 'recycled', alive: true });
      };

      const { signalled, log } = await reap(io);
      expect(signalled).toEqual([4100]);
      expect(signals).toEqual([[4100, 'SIGTERM']]);
      expect(table.get(4100)!.alive).toBe(true);
      expect(log).toContain('released by the orphaned Oxigraph');
    });

    it('leaves the outcome to the spawn when the holders cannot be listed at all', async () => {
      const { signals, io } = processTable({
        4100: { ppid: 1, argv: serve(location), holdsLock: true },
      });
      io.listLockHolders = async () => { throw new Error('lsof timed out'); };

      const { signalled, log } = await reap(io);
      expect(signalled).toEqual([]);
      expect(signals).toEqual([]);
      expect(log).toContain('could not list the processes holding');
      expect(log).not.toContain('released');
    });
  });

  describe('when a process cannot be read (a ps timeout, a /proc error)', () => {
    it('does not take a recorded daemon it cannot read for one that exited', async () => {
      await writeRecord();
      const { table, signals, io } = processTable({
        4000: { ppid: 1, argv: daemonWorker, holdsLock: false, unreadable: true },
        4099: { ppid: 4000, argv: directWatchdog(4000), holdsLock: false },
        4100: { ppid: 1, argv: serve(location), holdsLock: true },
      });

      const { signalled, log } = await run(io);
      expect(signalled).toEqual([]);
      expect(signals).toEqual([]);
      expect(table.get(4100)!.alive).toBe(true);
      expect(log).toContain(
        'its owner could not be determined (could not tell whether the recorded daemon pid 4000 ' +
          'is still running: ps timed out)',
      );
    });

    it('still stops the recorded Oxigraph when one recorded owner has confirmedly exited', async () => {
      await writeRecord();
      const { signals, io } = processTable({
        4000: { ppid: 1, argv: daemonWorker, holdsLock: false, unreadable: true },
        4100: { ppid: 1, argv: serve(location), holdsLock: true },
      });

      const { signalled, log } = await run(io);
      expect(signalled).toEqual([4100]);
      expect(signals).toEqual([[4100, 'SIGTERM']]);
      expect(log).toContain('stopping orphaned Oxigraph pid 4100 (its recorded launcher pid 4099 has exited)');
    });

    it('does not take a parent it cannot read for one that exited', async () => {
      const { table, signals, io } = processTable({
        4099: { ppid: 1, argv: daemonWorker, holdsLock: false, unreadable: true },
        4100: { ppid: 4099, argv: serve(location), holdsLock: true },
      });

      const { signalled, log } = await run(io);
      expect(signalled).toEqual([]);
      expect(signals).toEqual([]);
      expect(table.get(4100)!.alive).toBe(true);
      expect(log).toContain(
        'Leaving it running: could not tell whether its parent pid 4099 is still running (ps timed out).',
      );
    });

    it('leaves a lock holder it cannot inspect running', async () => {
      const { table, signals, io } = processTable({
        4100: { ppid: 1, argv: serve(location), holdsLock: true, unreadable: true },
      });

      const { signalled, log } = await run(io);
      expect(signalled).toEqual([]);
      expect(signals).toEqual([]);
      expect(table.get(4100)!.alive).toBe(true);
      expect(log).toContain('is held by pid 4100, which could not be inspected (ps timed out). Leaving it running.');
    });

    it('does not signal an orphan whose identity cannot be confirmed right before SIGTERM', async () => {
      const { table, signals, io } = processTable({
        4100: { ppid: 1, argv: serve(location), holdsLock: true },
      }, {
        // Readable when judged, unreadable when re-checked before the signal.
        onInspect: (pid, processes) => {
          if (pid === 4100) processes.get(4100)!.unreadable = true;
        },
      });

      const { signalled, log } = await run(io);
      expect(signalled).toEqual([]);
      expect(signals).toEqual([]);
      expect(table.get(4100)!.alive).toBe(true);
      expect(log).toContain('could not confirm that pid 4100 is still the orphaned Oxigraph');
      expect(log).not.toContain('stopping orphaned Oxigraph pid 4100');
    });

    it('does not escalate to SIGKILL while a signalled orphan cannot be read', async () => {
      const { table, signals, io } = processTable({
        4100: { ppid: 1, argv: serve(location), holdsLock: true, ignoresTerm: true },
      });
      const signal = io.signal;
      io.signal = (pid, name) => {
        signal(pid, name);
        table.get(4100)!.unreadable = true;
      };

      const lines: string[] = [];
      await stopOrphanedOxigraph({
        binaryPath, location, log: (line) => lines.push(line), io,
        stopGraceMs: 500, pollIntervalMs: 100, timeoutMs: 2_000,
      });
      expect(signals).toEqual([[4100, 'SIGTERM']]);
      expect(lines.join('\n')).toMatch(/orphaned Oxigraph pid 4100 was not confirmed gone 2000ms after the reclaim began; starting anyway/);
      expect(lines.join('\n')).not.toMatch(/released by the orphaned Oxigraph/);
    });
  });

  describe('with an owner record', () => {
    it('leaves every holder running while the recorded daemon and launcher both run', async () => {
      await writeRecord();
      const { table, signals, io } = processTable({
        4000: { ppid: 1, argv: daemonWorker, holdsLock: false },
        4099: { ppid: 4000, argv: directWatchdog(4000), holdsLock: false },
        4100: { ppid: 1, argv: serve(location), holdsLock: true },
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
        900: { ppid: 1, argv: ['/lib/systemd/systemd', '--user'], holdsLock: false },
        4099: { ppid: 900, argv: directWatchdog(4000), holdsLock: false },
        4100: { ppid: 900, argv: serve(location), holdsLock: true },
      }, 'its recorded daemon pid 4000 has exited'],
      // The daemon runs on but its watchdog was killed on its own.
      ['its launcher was killed while the daemon runs on', {
        4000: { ppid: 1, argv: daemonWorker, holdsLock: false },
        4100: { ppid: 1, argv: serve(location), holdsLock: true },
      }, 'its recorded launcher pid 4099 has exited'],
      // A respawned worker reused the dead daemon's PID; the start time differs.
      ['the recorded daemon PID now names another process', {
        4000: { ppid: 1, argv: daemonWorker, holdsLock: false, start: 'later' },
        4099: { ppid: 1, argv: directWatchdog(4000), holdsLock: false },
        4100: { ppid: 4099, argv: serve(location), holdsLock: true },
      }, 'its recorded daemon pid 4000 has exited'],
    ] as const)('stops this store\'s Oxigraph once %s', async (_label, entries, because) => {
      await writeRecord();
      const { signals, io } = processTable(entries as unknown as Record<number, Omit<FakeProcess, 'alive'>>);

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
        4100: { ppid: 1, argv: serve(location, '/usr/local/bin/oxigraph'), holdsLock: true },
      });

      const { signalled } = await run(io);
      expect(signalled).toEqual([4100]);
      expect(signals).toEqual([[4100, 'SIGTERM']]);
    });

    it('stops the recorded Oxigraph by identity even when its command line is unrecognised', async () => {
      await writeRecord();
      const { signals, io } = processTable({
        4100: { ppid: 900, argv: ['oxigraph-renamed', 'serve', '--location', 'elsewhere'], holdsLock: true },
      });

      const { signalled } = await run(io);
      expect(signalled).toEqual([4100]);
      expect(signals).toEqual([[4100, 'SIGTERM']]);
    });

    it('leaves an unrecorded holder with a live parent running even when the recorded owner exited', async () => {
      await writeRecord();
      const { table, signals, io } = processTable({
        4098: { ppid: 1, argv: ['/bin/bash'], holdsLock: false },
        4200: { ppid: 4098, argv: serve(location), holdsLock: true },
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
        4099: { ppid: 1, argv: directWatchdog(4000), holdsLock: false },
        4100: { ppid: 4099, argv: serve(location), holdsLock: true },
      });

      const { signalled, log } = await run(io);
      expect(signalled).toEqual([4100]);
      expect(signals).toEqual([[4100, 'SIGTERM']]);
      expect(log).toContain('stopping orphaned Oxigraph pid 4100 (its recorded daemon pid 4000 has exited)');
    });

    it('stops a pre-ready Oxigraph with a wrapper between the recorded launcher and Oxigraph', async () => {
      await writeRecord({ oxigraph: undefined });
      const { table, signals, io } = processTable({
        // The recorded launcher (the watchdog) -> a wrapper -> Oxigraph.
        4099: { ppid: 1, argv: ['node', 'oxigraph-parent-watchdog.js', '4000'], holdsLock: false },
        4100: { ppid: 4099, argv: ['/bin/sh', '-c', 'exec "$@"'], holdsLock: false },
        4101: { ppid: 4100, argv: serve(location), holdsLock: true },
      });

      const { signalled, log } = await run(io);
      expect(signalled).toEqual([4101]);
      expect(signals).toEqual([[4101, 'SIGTERM']]);
      expect(table.get(4099)!.alive).toBe(true);
      expect(table.get(4100)!.alive).toBe(true);
      expect(log).toContain('stopping orphaned Oxigraph pid 4101 (its recorded daemon pid 4000 has exited)');
    });

    it.each([
      ['its parent only reuses the recorded launcher PID', {
        4099: { ppid: 1, argv: ['/bin/bash'], holdsLock: false, start: 'later' },
        4100: { ppid: 4099, argv: serve(location), holdsLock: true },
      }],
      ['it is not this node\'s Oxigraph for this store', {
        4099: { ppid: 1, argv: directWatchdog(4000), holdsLock: false },
        4100: { ppid: 4099, argv: ['/usr/bin/backup', location], holdsLock: true },
      }],
    ] as const)('leaves a child of the recorded launcher PID running when %s', async (_label, entries) => {
      await writeRecord({ oxigraph: undefined });
      const { signals, io } = processTable(entries as unknown as Record<number, Omit<FakeProcess, 'alive'>>);

      const { signalled } = await run(io);
      expect(signalled).toEqual([]);
      expect(signals).toEqual([]);
    });

    it('does not stop a foreign holder whose PID the record names but whose start time differs', async () => {
      await writeRecord();
      const { signals, io } = processTable({
        4100: { ppid: 1, argv: ['/usr/bin/backup', location], holdsLock: true, start: 'later' },
      });

      const { signalled, log } = await run(io);
      expect(signalled).toEqual([]);
      expect(signals).toEqual([]);
      expect(log).toMatch(/Leaving it running: it is not this node's Oxigraph serving this store/);
    });
  });

  describe('pure decisions from explicit observations', () => {
    const instance = (pid: number, ppid: number, argv: string[], start = `t${pid}`) =>
      ({ pid, start, ppid, argv, command: argv.join(' ') });
    const binaries = { paths: [binaryPath], dirs: [] };
    const record: OxigraphOwnerRecordV1 = {
      schema: OXIGRAPH_OWNER_RECORD_SCHEMA,
      daemon: identity(4000),
      launcher: identity(4099),
      binaryPath,
    };

    const running = { state: 'running' } as const;
    const gone = { state: 'gone' } as const;
    const unknown = { state: 'unknown', reason: 'ps timed out' } as const;
    const complete = { state: 'complete' } as const;

    it('derives ownership from the record and the states of the recorded processes', () => {
      expect(deriveOwnership({ kind: 'absent' }, null)).toEqual({ kind: 'unrecorded' });
      expect(deriveOwnership({ kind: 'invalid' }, null)).toEqual({ kind: 'invalid-record' });
      expect(deriveOwnership({ kind: 'unreadable', reason: 'EACCES' }, null))
        .toEqual({ kind: 'unknown', reason: 'the owner record could not be read: EACCES' });
      expect(deriveOwnership({ kind: 'v1', record }, { daemon: running, launcher: running }))
        .toEqual({ kind: 'owners-live', record });
      expect(deriveOwnership({ kind: 'v1', record }, { daemon: gone, launcher: running }))
        .toEqual({ kind: 'owner-gone', record, gone: { role: 'daemon', pid: 4000 } });
      expect(deriveOwnership({ kind: 'v1', record }, { daemon: running, launcher: gone }))
        .toEqual({ kind: 'owner-gone', record, gone: { role: 'launcher', pid: 4099 } });
      // One confirmed exit is enough; otherwise an unreadable owner is unknown.
      expect(deriveOwnership({ kind: 'v1', record }, { daemon: unknown, launcher: gone }))
        .toEqual({ kind: 'owner-gone', record, gone: { role: 'launcher', pid: 4099 } });
      expect(deriveOwnership({ kind: 'v1', record }, { daemon: running, launcher: unknown })).toEqual({
        kind: 'unknown',
        reason: 'could not tell whether the recorded launcher pid 4099 is still running: ps timed out',
      });
      expect(deriveOwnership({ kind: 'v1', record }, null))
        .toEqual({ kind: 'unknown', reason: 'the recorded owners were not checked' });
    });

    it('leaves every holder while ownership is unknown, even one adopted by PID 1', () => {
      const ownership = deriveOwnership({ kind: 'unreadable', reason: 'EIO' }, null);
      expect(classifyHolder(
        { holder: instance(4100, 1, serve('/data/ox')), ancestors: [], ancestryEnd: complete },
        { location: '/data/ox', ownership, binaries },
      )).toEqual({
        action: 'leave',
        reason: { kind: 'ownership-unknown', reason: 'the owner record could not be read: EIO' },
      });
    });

    it('stops a descendant of the recorded launcher, and leaves one whose launcher start time differs', () => {
      const ownership = deriveOwnership({ kind: 'v1', record }, { daemon: gone, launcher: running });
      const holder = instance(4101, 4100, serve('/data/ox'));
      const watchdog = instance(4100, 4099, ['node', 'oxigraph-parent-watchdog.js', '4000']);
      const scope = instance(4099, 1, ['systemd-run', '--scope']);
      expect(classifyHolder(
        { holder, ancestors: [watchdog, scope], ancestryEnd: complete },
        { location: '/data/ox', ownership, binaries },
      )).toEqual({ action: 'stop', reason: { kind: 'owner-gone', role: 'daemon', pid: 4000 } });
      const impostor = instance(4099, 1, ['/bin/bash'], 'later');
      expect(classifyHolder(
        { holder, ancestors: [watchdog, impostor], ancestryEnd: complete },
        { location: '/data/ox', ownership, binaries },
      )).toMatchObject({ action: 'leave', reason: { kind: 'parent-alive', ppid: 4100, recorded: true } });
    });

    it('stops a holder only when its parent has confirmedly exited, without a record', () => {
      const ownership = deriveOwnership({ kind: 'absent' }, null);
      const holder = instance(4100, 4099, serve('/data/ox'));
      const ctx = { location: '/data/ox', ownership, binaries };
      expect(classifyHolder({ holder, ancestors: [], ancestryEnd: gone }, ctx))
        .toEqual({ action: 'stop', reason: { kind: 'parent-exited', ppid: 4099 } });
      expect(classifyHolder({ holder, ancestors: [], ancestryEnd: unknown }, ctx))
        .toEqual({ action: 'leave', reason: { kind: 'parent-unknown', ppid: 4099, reason: 'ps timed out' } });
      expect(classifyHolder({ holder, ancestors: [instance(4099, 1, ['/bin/bash'])], ancestryEnd: complete }, ctx))
        .toEqual({
          action: 'leave',
          reason: { kind: 'parent-alive', ppid: 4099, parentCommand: '/bin/bash', recorded: false },
        });
    });
  });

  it('does not signal a PID recycled between judging the orphan and signalling it', async () => {
    const { table, signals, io } = processTable({
      4100: { ppid: 1, argv: serve(location), holdsLock: true },
    }, {
      // The orphan exits right after it is inspected, and an unrelated
      // process of the same user receives its PID.
      onInspect: (pid, processes) => {
        if (pid !== 4100) return;
        processes.set(4100, { ppid: 1, argv: ['/usr/bin/vim'], holdsLock: false, start: 'recycled', alive: true });
      },
    });

    const { signalled } = await run(io);
    expect(signalled).toEqual([]);
    expect(signals).toEqual([]);
    expect(table.get(4100)!.alive).toBe(true);
  });

  // The table is built before beforeEach creates the store, so each case
  // takes the store path.
  it.each([
    ['a binary outside this node\'s binary directories', (store: string) => serve(store, '/opt/other/oxigraph')],
    ['another executable in this node\'s binary directory', (store: string) => serve(store, '/home/dkg/.dkg/oxigraph/rocksdb-tool')],
    ['another store whose path extends this one', (store: string) => serve(`${store}-2`)],
    ['a non-serve command on this binary', (store: string) => [binaryPath, 'dump', '--location', store]],
    ['an unrelated tool', (store: string) => ['sqlite3', `${store}/LOCK`]],
    // The exact Oxigraph command, but as arguments of another program.
    ['another program with the Oxigraph command among its arguments',
      (store: string) => ['node', '/opt/backup.js', binaryPath, 'serve', '--location', store]],
  ])('leaves an orphaned lock holder running when it is %s', async (_label, argvFor) => {
    const { table, signals, io } = processTable({
      4100: { ppid: 1, argv: argvFor(location), holdsLock: true },
    });

    const { signalled, log } = await run(io);
    expect(signalled).toEqual([]);
    expect(signals).toEqual([]);
    expect(table.get(4100)!.alive).toBe(true);
    expect(log).toMatch(/Leaving it running: it is not this node's Oxigraph serving this store/);
  });

  it('stops only the orphan when a foreign process also holds the lock', async () => {
    const { signals, io } = processTable({
      4100: { ppid: 1, argv: serve(location), holdsLock: true },
      4200: { ppid: 1, argv: ['/usr/bin/backup', location], holdsLock: true },
      4300: { ppid: 1, argv: serve(location), holdsLock: false },
    });

    const { signalled } = await run(io);
    expect(signalled).toEqual([4100]);
    expect(signals).toEqual([[4100, 'SIGTERM']]);
  });

  it('gives up after the timeout and leaves the lock error to the spawn', async () => {
    const { signals, io } = processTable({
      4100: { ppid: 1, argv: serve(location), holdsLock: true, ignoresTerm: true },
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
    expect(lines.join('\n')).toMatch(/pid 4100 was not confirmed gone 2000ms after the reclaim began; starting anyway/);
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
      let launched: readonly string[] = [];
      createOxigraphLaunchStrategy({
        memoryLimits,
        platform: 'linux',
        parentPid: 42,
        uid: 1000,
        nodeExecutable: '/opt/node',
        watchdogPath: '/opt/oxigraph-watchdog.js',
      }).launch(((_command: string, args: readonly string[]) => {
        launched = args;
        return { pid: 4242 } as ChildProcess;
      }) as unknown as typeof spawn, binaryPath, serveArgs, 'ignore');
      // The argv the watchdog execs for Oxigraph: the binary and its arguments.
      const argv = launched.slice(launched.indexOf(binaryPath));
      expect(matchManagedOxigraphStore(
        { argv, command: argv.join(' ') }, '/data/ox', { paths: [binaryPath], dirs: [] },
      )).toBe('match');
    }
  });

  it('compares exact argv token by token, including paths with spaces', () => {
    const binaries = { paths: ['/opt/oxigraph'], dirs: ['/opt'] };
    const exact = (argv: string[]) => ({ argv, command: argv.join(' ') });
    expect(matchManagedOxigraphStore(exact(['/opt/oxigraph', 'serve', '--location', '/data/store name']), '/data/store name', binaries)).toBe('match');
    // Flattened, these two are the same text; as argv they differ.
    expect(matchManagedOxigraphStore(exact(['/opt/oxigraph', 'serve', '--location', '/data/store', 'name']), '/data/store name', binaries)).toBe('no-match');
    expect(matchManagedOxigraphStore(exact(['node', '/opt/oxigraph-v0.5.7', 'serve', '--location', '/data/ox']), '/data/ox', binaries)).toBe('match');
    // A catalogued path among another program's arguments is not its executable.
    const foreign = ['node', 'backup.js', '/opt/oxigraph-v0.5.8', 'serve', '--location', '/data/ox'];
    expect(matchManagedOxigraphStore(exact(foreign), '/data/ox', binaries)).toBe('no-match');
    expect(matchManagedOxigraphStore({ argv: null, command: foreign.join(' ') }, '/data/ox', binaries)).toBe('no-match');
    expect(matchManagedOxigraphStore(exact(['/usr/bin/rsync', '/opt/oxigraph', 'serve', '--location', '/data/ox']), '/data/ox', binaries)).toBe('no-match');
    expect(matchManagedOxigraphStore(exact(['/opt/oxigraph', 'serve', '--location', '/data/ox2']), '/data/ox', binaries)).toBe('no-match');
    expect(matchManagedOxigraphStore(exact(['/opt/other/oxigraph', 'serve', '--location', '/data/ox']), '/data/ox', binaries)).toBe('no-match');
    expect(matchManagedOxigraphStore(exact(['/opt/python3', 'serve', '--location', '/data/ox']), '/data/ox', binaries)).toBe('no-match');
  });

  it('matches display-only text only when neither the store nor a binary path has whitespace', () => {
    const display = (command: string) => ({ argv: null, command });
    const binaries = { paths: ['/opt/oxigraph'], dirs: ['/opt'] };
    expect(matchManagedOxigraphStore(display('/opt/oxigraph serve --location /data/ox --bind 127.0.0.1:7878'), '/data/ox', binaries)).toBe('match');
    expect(matchManagedOxigraphStore(display('/opt/oxigraph serve --location /data/ox2'), '/data/ox', binaries)).toBe('no-match');
    expect(matchManagedOxigraphStore(display('/opt/oxigraph serve --location /data/store name'), '/data/store name', binaries)).toBe('ambiguous');
    expect(matchManagedOxigraphStore(display('/my apps/oxigraph serve --location /data/ox'), '/data/ox', { paths: ['/my apps/oxigraph'], dirs: [] })).toBe('ambiguous');
  });

  it('leaves a display-only holder running when its command line is ambiguous', async () => {
    const spaced = join(location, 'store name');
    await mkdir(spaced);
    await writeFile(join(spaced, 'LOCK'), '');
    const { signals, io } = processTable({
      4100: { ppid: 1, argv: [binaryPath, ...oxigraphStoreArgs(spaced)], holdsLock: true, displayOnly: true },
    });
    const lines: string[] = [];

    await expect(stopOrphanedOxigraph({ binaryPath, location: spaced, log: (line) => lines.push(line), io }))
      .resolves.toEqual([]);
    expect(signals).toEqual([]);
    expect(lines.join('\n')).toContain('its command line cannot be matched reliably');
  });
});
