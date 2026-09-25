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
 * This file: the watchdog, the managed server and the reclaim around a
 * worker's death, with real worker processes.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOxigraphServer } from '../src/daemon/oxigraph-server.js';
import { findListenOwnerPid } from '../src/daemon/oxigraph-listen-port.js';
import { OXIGRAPH_OWNER_RECORD, recordOxigraphLaunch } from '../src/daemon/oxigraph-owner-record.js';
import { reclaimHost, stopOrphanedOxigraph } from '../src/daemon/oxigraph-orphan.js';
import { oxigraphStoreArgs } from '../src/daemon/oxigraph-store-launch.js';
import {
  createOxigraphStoreOwnership,
  type OxigraphStoreOwnershipInput,
  type OxigraphStoreOwnershipSteps,
} from '../src/daemon/oxigraph-store-ownership.js';
import type { OxigraphLaunchHandle } from '../src/daemon/oxigraph-launch-strategy.js';
import {
  createOxigraphStandinFixture,
  fetchPid,
  freePort,
  portAnswers,
  sleep,
  spawnOrphan,
  waitForCondition,
  type OxigraphStandinFixture,
} from './fixtures/oxigraph-server-real-fixture.js';
import {
  killIfAlive,
  parentPid,
  pidIsGone,
  startWorker,
  stopWorker,
  type WorkerProcess,
} from './fixtures/oxigraph-orphan-harness.js';

let lockingStandin: OxigraphStandinFixture;

beforeAll(async () => {
  lockingStandin = await createOxigraphStandinFixture({ holdStoreLock: true });
});

afterAll(async () => {
  await lockingStandin.cleanup();
});

describe('directly launched Oxigraph under the parent watchdog', () => {
  it('stops Oxigraph with its SIGKILLed worker, so the respawned worker can start', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-worker-'));
    let first: WorkerProcess | undefined;
    let second: WorkerProcess | undefined;
    let firstListenerPid: number | undefined;
    let secondListenerPid: number | undefined;
    try {
      first = await startWorker(lockingStandin.binaryPath, port, location);
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

      second = await startWorker(lockingStandin.binaryPath, port, location);
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
      first = await startWorker(lockingStandin.binaryPath, port, location);
      firstListenerPid = await fetchPid(port);
      // Freeze the old watchdog so it cannot stop Oxigraph on its next poll:
      // only the replacement's reclaim can then free the store.
      stoppedWatchdog = parentPid(firstListenerPid);
      expect(stoppedWatchdog).not.toBeNull();
      process.kill(stoppedWatchdog!, 'SIGSTOP');
      const exited = once(first.child, 'exit');
      first.child.kill('SIGKILL');
      await exited;

      second = await startWorker(lockingStandin.binaryPath, port, location);
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

  it.each([
    ['an existing store directory', false],
    // A fresh node: the spawn-time record must not depend on Oxigraph
    // creating the directory first.
    ['a store directory that does not exist yet', true],
  ] as const)('reclaims the Oxigraph of a worker killed before its store was ready, with its watchdog frozen, in %s', async (_label, fresh) => {
    const port = await freePort();
    const root = await mkdtemp(join(tmpdir(), 'oxi-orphan-preready-'));
    const location = fresh ? join(root, 'oxigraph-data') : root;
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

      second = await startWorker(lockingStandin.binaryPath, port, location);
      expect(await fetchPid(port)).not.toBe(listenerPid);
      expect(second.stderr()).toContain(
        `stopping orphaned Oxigraph pid ${listenerPid} (its recorded daemon pid ${first.pid} has exited)`,
      );
    } finally {
      if (second) await stopWorker(second);
      first.kill('SIGKILL');
      killIfAlive(frozenWatchdog ?? undefined);
      killIfAlive(listenerPid);
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps the owner record of an orphan it could not look for, so a later start still reclaims it', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-held-'));
    let first: WorkerProcess | undefined;
    let second: WorkerProcess | undefined;
    let listenerPid: number | undefined;
    let frozenWatchdog: number | null = null;
    try {
      // Launch A's worker dies with A's watchdog frozen: A's Oxigraph keeps
      // LOCK under a live parent that is not PID 1, and only A's owner record
      // identifies it.
      first = await startWorker(lockingStandin.binaryPath, port, location);
      listenerPid = await fetchPid(port);
      frozenWatchdog = parentPid(listenerPid);
      expect(frozenWatchdog).not.toBeNull();
      process.kill(frozenWatchdog!, 'SIGSTOP');
      const exited = once(first.child, 'exit');
      first.child.kill('SIGKILL');
      await exited;
      const recordPath = join(location, OXIGRAPH_OWNER_RECORD);
      const recordOfA = await readFile(recordPath, 'utf8');

      // The next start runs the production steps, but cannot list the lock
      // holders (an lsof timeout).
      let spawns = 0;
      const countingSpawn = ((...args: Parameters<typeof spawn>) => {
        spawns += 1;
        return spawn(...args);
      }) as typeof spawn;
      await expect(startOxigraphServer({
        binaryPath: lockingStandin.binaryPath,
        location,
        port,
        readyTimeoutMs: 10_000,
        log: () => {},
        io: { spawn: countingSpawn },
        storeOwnership: (input) => {
          const host = reclaimHost(input.platform);
          return createOxigraphStoreOwnership({
            ...input,
            steps: {
              reclaim: () => stopOrphanedOxigraph({
                location: input.location,
                binaryPath: input.binaryPath,
                log: input.log,
                io: { ...host, listLockHolders: async () => { throw new Error('lsof timed out'); } },
              }),
              recordLaunch: (launcherPid) => recordOxigraphLaunch({
                location: input.location,
                binaryPath: input.binaryPath,
                launcherPid,
                platform: input.platform,
                inspect: host.inspectProcess,
                bootId: host.bootId,
                log: input.log,
              }),
            },
          });
        },
      })).rejects.toThrow(
        `${location}/LOCK may still be held by this node's Oxigraph ` +
          `(the processes holding ${location}/LOCK could not be listed); not starting another over it`,
      );
      // Nothing was started over A, and A's record is untouched.
      expect(spawns).toBe(0);
      expect(await readFile(recordPath, 'utf8')).toBe(recordOfA);
      expect(pidIsGone(listenerPid)).toBe(false);

      // The start after it (the supervisor's next worker) can look, and
      // stops A by its record.
      second = await startWorker(lockingStandin.binaryPath, port, location);
      expect(await fetchPid(port)).not.toBe(listenerPid);
      expect(second.stderr()).toContain(
        `stopping orphaned Oxigraph pid ${listenerPid} (its recorded daemon pid ${first.child.pid} has exited)`,
      );
    } finally {
      if (second) await stopWorker(second);
      if (first) first.child.kill('SIGKILL');
      killIfAlive(frozenWatchdog ?? undefined);
      killIfAlive(listenerPid);
      await rm(location, { recursive: true, force: true });
    }
  }, 60_000);

  // The production store ownership with both of its steps replaced (no real
  // reclaim or record runs), to force the outcome under test or observe the
  // order: `spawned` for the record at spawn, `ready` for its extension.
  const ownershipWith = (hooks: {
    reclaim?: () => Promise<void>;
    spawned?: (launcherPid: number) => Promise<void>;
    ready?: (launcherPid: number, oxigraphPid: number) => Promise<void>;
  }) => (input: OxigraphStoreOwnershipInput) => createOxigraphStoreOwnership({
    ...input,
    steps: {
      reclaim: async () => {
        await hooks.reclaim?.();
        return { held: null };
      },
      recordLaunch: async (launcherPid) => {
        await hooks.spawned?.(launcherPid);
        return { markReady: async (oxigraphPid) => { await hooks.ready?.(launcherPid, oxigraphPid); } };
      },
    },
  });

  it('waits for a restart\'s reclaim when stop() is called during it, and neither spawns nor reclaims again', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-stop-reclaim-'));
    let spawns = 0;
    let reclaims = 0;
    let running = 0;
    let mostAtOnce = 0;
    let releaseReclaim: (() => void) | undefined;
    const countingSpawn = ((...args: Parameters<typeof spawn>) => {
      spawns += 1;
      return spawn(...args);
    }) as typeof spawn;
    const handle = await startOxigraphServer({
      binaryPath: lockingStandin.binaryPath,
      location,
      port,
      readyTimeoutMs: 10_000,
      readyIntervalMs: 50,
      restartBackoffBaseMs: 50,
      restartBackoffMaxMs: 50,
      log: () => {},
      io: { spawn: countingSpawn },
      storeOwnership: ownershipWith({
        reclaim: async () => {
          reclaims += 1;
          running += 1;
          mostAtOnce = Math.max(mostAtOnce, running);
          try {
            // The restart's reclaim blocks until the test releases it.
            if (reclaims === 2) await new Promise<void>((resolve) => { releaseReclaim = resolve; });
          } finally {
            running -= 1;
          }
        },
      }),
    });
    try {
      expect(spawns).toBe(1);
      process.kill(await fetchPid(port), 'SIGKILL');
      expect(await waitForCondition(() => releaseReclaim !== undefined, 10_000)).toBe(true);
      let stopped = false;
      const stopping = handle.stop().then(() => { stopped = true; });
      await sleep(300);
      expect(stopped, 'stop() resolved while the restart was still reclaiming the store').toBe(false);
      releaseReclaim!();
      await stopping;
      // The restart's reclaim ran after the dead launch's wrapper exited, so
      // it covered that launch: no second reclaim, and none alongside it.
      expect(reclaims).toBe(2);
      expect(mostAtOnce).toBe(1);
      await sleep(300);
      expect(spawns).toBe(1);
      expect(await portAnswers(port)).toBe(false);
    } finally {
      killIfAlive(await fetchPid(port).catch(() => undefined));
      await handle.stop();
      await rm(location, { recursive: true, force: true });
    }
  }, 30_000);

  it('drives the launch and every ownership step from one injected host (Windows, on this host)', async () => {
    const port = await freePort();
    const orphanPort = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-host-'));
    // A PID-1 orphan holding this store, which a Unix host would reclaim.
    const orphan = await spawnOrphan(lockingStandin.binaryPath, [
      ...oxigraphStoreArgs(location), '--bind', `127.0.0.1:${orphanPort}`,
    ]);
    const platforms: NodeJS.Platform[] = [];
    let handle: Awaited<ReturnType<typeof startOxigraphServer>> | undefined;
    try {
      expect(await waitForCondition(() => portAnswers(orphanPort))).toBe(true);
      handle = await startOxigraphServer({
        binaryPath: lockingStandin.binaryPath,
        location,
        port,
        platform: 'win32',
        readyTimeoutMs: 10_000,
        readyIntervalMs: 50,
        log: () => {},
        storeOwnership: (input) => {
          platforms.push(input.platform);
          return createOxigraphStoreOwnership(input);
        },
      });
      expect(platforms).toEqual(['win32']);
      // The Windows launch: Oxigraph itself, no watchdog.
      expect(parentPid(await fetchPid(port))).toBe(process.pid);
      // The Windows ownership: no reclaim, and no owner record.
      expect(pidIsGone(orphan)).toBe(false);
      await expect(readFile(join(location, OXIGRAPH_OWNER_RECORD), 'utf8')).rejects.toThrow(/ENOENT/);
    } finally {
      await handle?.stop();
      killIfAlive(orphan);
      await rm(location, { recursive: true, force: true });
    }
  }, 30_000);

  describe('store-ownership failure contract', () => {
    it('fails boot without spawning when the reclaim rejects', async () => {
      const port = await freePort();
      const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-reject-before-'));
      const recorded: number[] = [];
      try {
        await expect(startOxigraphServer({
          binaryPath: lockingStandin.binaryPath,
          location,
          port,
          readyTimeoutMs: 10_000,
          log: () => {},
          storeOwnership: ownershipWith({
            reclaim: async () => { throw new Error('reclaim defect'); },
            spawned: async (launcherPid) => { recorded.push(launcherPid); },
          }),
        })).rejects.toThrow('reclaim defect');
        expect(recorded).toEqual([]);
        expect(await portAnswers(port)).toBe(false);
      } finally {
        await rm(location, { recursive: true, force: true });
      }
    }, 30_000);

    it.each([
      ['the spawn-time record', 'spawned'],
      ['the ready-time record', 'ready'],
    ] as const)('stops the child and fails boot when %s rejects', async (_label, failing) => {
      const port = await freePort();
      const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-reject-record-'));
      let launcher: number | undefined;
      try {
        await expect(startOxigraphServer({
          binaryPath: lockingStandin.binaryPath,
          location,
          port,
          readyTimeoutMs: 10_000,
          readyIntervalMs: 50,
          log: () => {},
          storeOwnership: ownershipWith({
            spawned: async (launcherPid) => {
              launcher = launcherPid;
              if (failing === 'spawned') throw new Error('record defect');
            },
            ready: async () => {
              if (failing === 'ready') throw new Error('record defect');
            },
          }),
        })).rejects.toThrow('record defect');
        expect(launcher).toBeDefined();
        expect(pidIsGone(launcher!)).toBe(true);
        expect(await waitForCondition(async () => !(await portAnswers(port)))).toBe(true);
      } finally {
        killIfAlive(launcher);
        await rm(location, { recursive: true, force: true });
      }
    }, 30_000);

    it('retries a restart whose record step rejects, and recovers once it resolves', async () => {
      const port = await freePort();
      const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-reject-restart-'));
      const lines: string[] = [];
      let launches = 0;
      const handle = await startOxigraphServer({
        binaryPath: lockingStandin.binaryPath,
        location,
        port,
        readyTimeoutMs: 10_000,
        readyIntervalMs: 50,
        restartBackoffBaseMs: 50,
        restartBackoffMaxMs: 50,
        log: (line) => lines.push(line),
        storeOwnership: ownershipWith({
          spawned: async () => {
            launches += 1;
            if (launches === 2) throw new Error('record defect on restart');
          },
        }),
      });
      try {
        const first = await fetchPid(port);
        process.kill(first, 'SIGKILL');
        expect(await waitForCondition(async () => {
          const pid = await fetchPid(port).catch(() => undefined);
          return launches >= 3 && pid !== undefined && pid !== first && !handle.getRecoveryState().recovering;
        }, 20_000)).toBe(true);
        expect(lines.join('\n')).toContain('restart attempt failed: record defect on restart');
      } finally {
        await handle.stop();
        await rm(location, { recursive: true, force: true });
      }
    }, 30_000);
  });

  it('does not report ready when Oxigraph exits while its owner record is written', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-record-race-'));
    const lines: string[] = [];
    try {
      await expect(startOxigraphServer({
        binaryPath: lockingStandin.binaryPath,
        location,
        port,
        readyTimeoutMs: 10_000,
        readyIntervalMs: 50,
        log: (line) => lines.push(line),
        storeOwnership: ownershipWith({
          ready: async (launcherPid, oxigraphPid) => {
            // The verified Oxigraph dies during the ready-time write, and its
            // watchdog exits with it before the write completes.
            process.kill(oxigraphPid, 'SIGKILL');
            await waitForCondition(() => pidIsGone(launcherPid), 5_000);
          },
        }),
      })).rejects.toThrow(/exited during startup/);
      expect(lines.join('\n')).not.toMatch(/Oxigraph server ready/);
    } finally {
      await rm(location, { recursive: true, force: true });
    }
  }, 30_000);

  it('reclaims before every spawn and records at spawn and at readiness, for boot and restart', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-sequence-'));
    const events: string[] = [];
    const handle = await startOxigraphServer({
      binaryPath: lockingStandin.binaryPath,
      location,
      port,
      readyTimeoutMs: 10_000,
      readyIntervalMs: 50,
      restartBackoffBaseMs: 50,
      restartBackoffMaxMs: 50,
      log: () => {},
      storeOwnership: ownershipWith({
        reclaim: async () => { events.push('before-spawn'); },
        spawned: async (launcherPid) => { events.push(`spawned:${launcherPid}`); },
        ready: async (launcherPid, oxigraphPid) => { events.push(`ready:${launcherPid}:${oxigraphPid}`); },
      }),
    });
    try {
      const first = await fetchPid(port);
      process.kill(first, 'SIGKILL');
      expect(await waitForCondition(() => events.length >= 6, 20_000)).toBe(true);
      const second = await fetchPid(port);
      const [launch1, launch2] = [events[1].split(':')[1], events[4].split(':')[1]];
      expect(events).toEqual([
        'before-spawn', `spawned:${launch1}`, `ready:${launch1}:${first}`,
        'before-spawn', `spawned:${launch2}`, `ready:${launch2}:${second}`,
      ]);
      expect(launch2).not.toBe(launch1);
    } finally {
      await handle.stop();
      await rm(location, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not resolve stop() while an owner record is still being written', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-stop-write-'));
    const events: string[] = [];
    let launches = 0;
    // The restart's spawn-time write is slow; stop() is called during it.
    const slowHandle = await startOxigraphServer({
      binaryPath: lockingStandin.binaryPath,
      location,
      port,
      readyTimeoutMs: 10_000,
      readyIntervalMs: 50,
      restartBackoffBaseMs: 50,
      restartBackoffMaxMs: 50,
      log: () => {},
      storeOwnership: ownershipWith({
        ready: async () => { events.push('ready-write'); },
        spawned: async () => {
          launches += 1;
          if (launches < 2) return;
          events.push('spawned-write-started');
          await new Promise((resolve) => setTimeout(resolve, 500));
          events.push('spawned-write-finished');
        },
      }),
    });
    try {
      process.kill(await fetchPid(port), 'SIGKILL');
      expect(await waitForCondition(() => events.includes('spawned-write-started'), 10_000)).toBe(true);
      await slowHandle.stop();
      events.push('stopped');
      expect(events).toEqual(['ready-write', 'spawned-write-started', 'spawned-write-finished', 'stopped']);
    } finally {
      await slowHandle.stop();
      await rm(location, { recursive: true, force: true });
    }
  }, 30_000);

  it('reclaims the Oxigraph of a first launch whose watchdog dies before the store is ready', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-boot-stranded-'));
    const lines: string[] = [];
    let listenerPid: number | undefined;
    // The store is never verified ready (like a long WAL replay), so the
    // watchdog dies while the first start is still opening it.
    const started = startOxigraphServer({
      binaryPath: lockingStandin.binaryPath,
      location,
      port,
      readyTimeoutMs: 20_000,
      readyIntervalMs: 50,
      log: (line) => lines.push(line),
      io: { findListenOwnerPid: async () => null },
    });
    try {
      expect(await waitForCondition(() => portAnswers(port), 10_000)).toBe(true);
      listenerPid = await fetchPid(port);
      const watchdog = parentPid(listenerPid);
      expect(watchdog).not.toBeNull();
      process.kill(watchdog!, 'SIGKILL');

      await expect(started).rejects.toThrow(/exited during startup/);
      expect(await waitForCondition(() => pidIsGone(listenerPid!), 5_000)).toBe(true);
      expect(await portAnswers(port)).toBe(false);
      expect(lines.join('\n')).toContain(`stopping orphaned Oxigraph pid ${listenerPid} (`);
    } finally {
      killIfAlive(listenerPid);
      await started.catch(() => {});
      await rm(location, { recursive: true, force: true });
    }
  }, 40_000);

  it('reclaims the Oxigraph of a watchdog killed on its own when the server stops before restarting', async () => {
    const port = await freePort();
    const location = await mkdtemp(join(tmpdir(), 'oxi-orphan-stop-stranded-'));
    const lines: string[] = [];
    let listenerPid: number | undefined;
    const handle = await startOxigraphServer({
      binaryPath: lockingStandin.binaryPath,
      location,
      port,
      readyTimeoutMs: 10_000,
      readyIntervalMs: 50,
      // The restart would reclaim it as well; stop() comes first here.
      restartBackoffBaseMs: 60_000,
      restartBackoffMaxMs: 60_000,
      log: (line) => lines.push(line),
    });
    try {
      listenerPid = await fetchPid(port);
      const watchdog = parentPid(listenerPid);
      expect(watchdog).not.toBeNull();
      process.kill(watchdog!, 'SIGKILL');
      expect(await waitForCondition(() => handle.getRecoveryState().recovering, 10_000)).toBe(true);
      // The watchdog is gone; its Oxigraph still runs and holds the store.
      expect(pidIsGone(listenerPid)).toBe(false);

      await handle.stop();
      expect(await waitForCondition(() => pidIsGone(listenerPid!), 5_000)).toBe(true);
      expect(await portAnswers(port)).toBe(false);
      expect(lines.join('\n')).toContain(
        `stopping orphaned Oxigraph pid ${listenerPid} (its recorded launcher pid ${watchdog} has exited)`,
      );
    } finally {
      await handle.stop();
      killIfAlive(listenerPid);
      await rm(location, { recursive: true, force: true });
    }
  }, 30_000);

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

describe('store ownership launches', () => {
  const notSpawnable = (): OxigraphLaunchHandle => {
    throw new Error('spawned after close()');
  };
  // A launch handle that notes the signals it is sent; `exit` makes its
  // wrapper exit on its own.
  const handleFor = (pid: number) => {
    const signals: NodeJS.Signals[] = [];
    let alive = true;
    const oxigraph = {
      child: { pid } as ChildProcess,
      alive: () => alive,
      terminate: (signal: NodeJS.Signals) => { signals.push(signal); },
    } as unknown as OxigraphLaunchHandle;
    return { oxigraph, signals, exit: () => { alive = false; } };
  };
  const storeFree = async () => ({ held: null });
  // A launch recorder that notes each write it would make.
  const recording = (records: string[]): OxigraphStoreOwnershipSteps['recordLaunch'] => async (launcherPid) => {
    records.push(`spawned:${launcherPid}`);
    return { markReady: async (oxigraphPid) => { records.push(`ready:${launcherPid}:${oxigraphPid}`); } };
  };
  const ownershipWithSteps = (steps: OxigraphStoreOwnershipSteps) => createOxigraphStoreOwnership({
    platform: process.platform,
    location: '/nonexistent/oxigraph-data',
    binaryPath: '/opt/oxigraph',
    log: () => {},
    steps,
  });

  it('neither spawns nor records once closed while the reclaim is still running, and close() waits for it', async () => {
    let releaseReclaim!: () => void;
    const records: string[] = [];
    let spawns = 0;
    const ownership = ownershipWithSteps({
      reclaim: () => new Promise((resolve) => { releaseReclaim = () => resolve({ held: null }); }),
      recordLaunch: recording(records),
    });

    const launched = ownership.launch(() => {
      spawns += 1;
      return notSpawnable();
    });
    let closed = false;
    const closing = ownership.close().then(() => { closed = true; });
    await sleep(50);
    expect(closed).toBe(false);
    releaseReclaim();
    await closing;

    await expect(launched).resolves.toBeNull();
    expect(spawns).toBe(0);
    expect(records).toEqual([]);
  });

  it('refuses to spawn or record over a store the reclaim leaves possibly held', async () => {
    const records: string[] = [];
    let spawns = 0;
    const ownership = ownershipWithSteps({
      reclaim: async () => ({ held: 'pid 4100: it could not be inspected' }),
      recordLaunch: recording(records),
    });

    await expect(ownership.launch(() => {
      spawns += 1;
      return notSpawnable();
    })).rejects.toThrow(
      '/nonexistent/oxigraph-data/LOCK may still be held by this node\'s Oxigraph ' +
        '(pid 4100: it could not be inspected); not starting another over it',
    );
    expect(spawns).toBe(0);
    // The previous owner record stays: nothing replaced it.
    expect(records).toEqual([]);
  });

  it('records nothing for a launch that becomes ready after close()', async () => {
    const records: string[] = [];
    const ownership = ownershipWithSteps({ reclaim: storeFree, recordLaunch: recording(records) });
    const { oxigraph } = handleFor(4099);
    const launch = await ownership.launch(() => oxigraph);
    expect(launch?.oxigraph).toBe(oxigraph);
    expect(records).toEqual(['spawned:4099']);

    await ownership.close();
    await launch!.ready(4100);
    expect(records).toEqual(['spawned:4099']);
    await expect(ownership.launch(notSpawnable)).resolves.toBeNull();
  });

  it('kills what it spawned through the launch handle when recording the launch rejects, then rejects', async () => {
    const ownership = ownershipWithSteps({
      reclaim: storeFree,
      recordLaunch: async () => { throw new Error('record defect'); },
    });
    const { oxigraph, signals } = handleFor(4099);
    await expect(ownership.launch(() => oxigraph)).rejects.toThrow('record defect');
    expect(signals).toEqual(['SIGKILL']);
  });

  it('reclaims once more on close() when the last launch\'s wrapper had already exited, and only once', async () => {
    const events: string[] = [];
    const ownership = ownershipWithSteps({
      reclaim: async () => { events.push('reclaim'); return { held: null }; },
      recordLaunch: recording(events),
    });
    const { oxigraph, exit } = handleFor(4099);
    await ownership.launch(() => oxigraph);
    // The watchdog was killed on its own; its Oxigraph may still run.
    exit();

    const closing = ownership.close();
    expect(ownership.close()).toBe(closing);
    await closing;
    await ownership.close();
    await expect(ownership.launch(notSpawnable)).resolves.toBeNull();
    expect(events).toEqual(['reclaim', 'spawned:4099', 'reclaim']);
  });

  it('does not reclaim on close() for a launch still running when it is called', async () => {
    const events: string[] = [];
    const ownership = ownershipWithSteps({
      reclaim: async () => { events.push('reclaim'); return { held: null }; },
      recordLaunch: recording(events),
    });
    const { oxigraph, exit } = handleFor(4099);
    await ownership.launch(() => oxigraph);

    const closing = ownership.close();
    // The caller stops the live launch after closing.
    exit();
    await closing;
    expect(events).toEqual(['reclaim', 'spawned:4099']);
  });

  it('does not repeat on close() a reclaim in flight that began after the last wrapper exited', async () => {
    let reclaims = 0;
    let running = 0;
    let mostAtOnce = 0;
    let releaseReclaim: (() => void) | undefined;
    const ownership = ownershipWithSteps({
      reclaim: async () => {
        reclaims += 1;
        running += 1;
        mostAtOnce = Math.max(mostAtOnce, running);
        try {
          if (reclaims === 2) await new Promise<void>((resolve) => { releaseReclaim = resolve; });
        } finally {
          running -= 1;
        }
        return { held: null };
      },
      recordLaunch: recording([]),
    });
    const { oxigraph, exit } = handleFor(4099);
    await ownership.launch(() => oxigraph);
    exit();
    // A restart, whose reclaim is still running when the owner closes.
    const restart = ownership.launch(notSpawnable);
    expect(releaseReclaim).toBeDefined();

    let closed = false;
    const closing = ownership.close().then(() => { closed = true; });
    await sleep(50);
    expect(closed).toBe(false);
    releaseReclaim!();
    await closing;
    await expect(restart).resolves.toBeNull();
    expect(reclaims).toBe(2);
    expect(mostAtOnce).toBe(1);
  });
});
