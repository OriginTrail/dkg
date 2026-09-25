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
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOxigraphLaunchStrategy } from '../src/daemon/oxigraph-launch-strategy.js';
import { oxigraphStoreArgs } from '../src/daemon/oxigraph-store-launch.js';
import { stopOrphanedOxigraph, type OrphanedOxigraphIo } from '../src/daemon/oxigraph-orphan.js';
import {
  OXIGRAPH_OWNER_RECORD,
  OXIGRAPH_OWNER_RECORD_SCHEMA,
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

      const { signalled } = await run(io, { knownBinaryDirs: ['/usr/local/bin'] });
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

    it('falls back to the PID 1 rule for an unreadable or unversioned owner record', async () => {
      for (const content of ['{"daemon": 4000', JSON.stringify({ daemon: identity(4000), launcher: identity(4099), binaryPath })]) {
        await writeFile(join(location, OXIGRAPH_OWNER_RECORD), content);
        const { signals, io } = processTable({
          4099: { ppid: 1, argv: ['/lib/systemd/systemd', '--user'], holdsLock: false },
          4100: { ppid: 4099, argv: serve(location), holdsLock: true },
        });

        const { signalled, log } = await run(io);
        expect(signalled).toEqual([]);
        expect(signals).toEqual([]);
        expect(log).toContain('ignoring an unreadable owner record');
        expect(log).toContain('there is no owner record');
      }
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

    it('stops a pre-ready Oxigraph under a systemd scope, where the watchdog sits between launcher and Oxigraph', async () => {
      await writeRecord({ oxigraph: undefined });
      const { table, signals, io } = processTable({
        // systemd-run (the recorded launcher) -> watchdog -> Oxigraph.
        4099: { ppid: 1, argv: ['systemd-run', '--user', '--scope', '--', 'node', 'oxigraph-parent-watchdog.js', '4000'], holdsLock: false },
        4100: { ppid: 4099, argv: ['node', 'oxigraph-parent-watchdog.js', '4000'], holdsLock: false },
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

    it('derives ownership from the record and which recorded processes still run', () => {
      expect(deriveOwnership({ kind: 'absent' }, { daemon: false, launcher: false })).toEqual({ kind: 'unrecorded' });
      expect(deriveOwnership({ kind: 'invalid' }, { daemon: false, launcher: false })).toEqual({ kind: 'invalid-record' });
      expect(deriveOwnership({ kind: 'v1', record }, { daemon: true, launcher: true }))
        .toEqual({ kind: 'owners-live', record });
      expect(deriveOwnership({ kind: 'v1', record }, { daemon: false, launcher: true }))
        .toEqual({ kind: 'owner-gone', record, gone: { role: 'daemon', pid: 4000 } });
      expect(deriveOwnership({ kind: 'v1', record }, { daemon: true, launcher: false }))
        .toEqual({ kind: 'owner-gone', record, gone: { role: 'launcher', pid: 4099 } });
    });

    it('stops a descendant of the recorded launcher, and leaves one whose launcher start time differs', () => {
      const ownership = deriveOwnership({ kind: 'v1', record }, { daemon: false, launcher: true });
      const holder = instance(4101, 4100, serve('/data/ox'));
      const watchdog = instance(4100, 4099, ['node', 'oxigraph-parent-watchdog.js', '4000']);
      const scope = instance(4099, 1, ['systemd-run', '--scope']);
      expect(classifyHolder({ holder, ancestors: [watchdog, scope] }, { location: '/data/ox', ownership, binaries }))
        .toEqual({ action: 'stop', reason: { kind: 'owner-gone', role: 'daemon', pid: 4000 } });
      const impostor = instance(4099, 1, ['/bin/bash'], 'later');
      expect(classifyHolder({ holder, ancestors: [watchdog, impostor] }, { location: '/data/ox', ownership, binaries }))
        .toMatchObject({ action: 'leave', reason: { kind: 'parent-alive', ppid: 4100, recorded: true } });
    });

    it('stops a holder whose parent has exited and leaves one whose parent is alive, without a record', () => {
      const ownership = deriveOwnership({ kind: 'absent' }, { daemon: false, launcher: false });
      const holder = instance(4100, 4099, serve('/data/ox'));
      expect(classifyHolder({ holder, ancestors: [] }, { location: '/data/ox', ownership, binaries }))
        .toEqual({ action: 'stop', reason: { kind: 'parent-exited', ppid: 4099 } });
      expect(classifyHolder({ holder, ancestors: [instance(4099, 1, ['/bin/bash'])] }, { location: '/data/ox', ownership, binaries }))
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
      const argv = spec.args.slice(spec.args.indexOf(binaryPath));
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
