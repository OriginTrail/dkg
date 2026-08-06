/**
 * Supervised Oxigraph server — REAL process supervision, NO mocks.
 *
 * The retired version drove `startOxigraphServer` with an injected spawn
 * factory returning a `FakeChild` EventEmitter and a fetch stub for the
 * readiness probe — process lifecycle (signals, exits, bind failures) was
 * hand-emulated, so a divergence between the emulation and real OS process
 * behaviour could never surface.
 *
 * This version spawns a REAL executable child. The stand-in is a tiny Node
 * program with oxigraph's CLI surface (`serve --location <dir> --bind
 * <host:port>`) that binds a REAL port, answers the REAL readiness probe over
 * real HTTP, exits non-zero on a REAL bind failure (EADDRINUSE), and honours
 * REAL SIGTERM — so every supervision contract (ready-probe resolution,
 * failed-start rejection + cleanup, stop() semantics, crash → restart with
 * backoff, no restart after stop) is proven against genuine OS processes,
 * sockets, and signals. The unit under test — the supervisor — is exactly the
 * production code path; only the supervised binary's identity differs, and
 * the binary's own behaviour is real, not emitted by the test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SparqlHttpStore,
  attachManagedOxigraphLeaseV1,
  type SparqlHttpStoreOptions,
} from '@origintrail-official/dkg-storage';
import { startOxigraphServer } from '../src/daemon/oxigraph-server.js';
import { createOxigraphLaunchStrategy } from '../src/daemon/oxigraph-launch-strategy.js';
import { OXIGRAPH_WATCHDOG_OOM_MARKER } from '../src/daemon/oxigraph-parent-watchdog.js';
import {
  childOwnsListenPort,
  findListenOwnerPid,
} from '../src/daemon/oxigraph-listen-port.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let dir: string;
let standin: string;

// A real port that is free at allocation time. The OS hands us an ephemeral
// port; we close the probe listener and reuse the number immediately.
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no port'));
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function fetchPid(port: number): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/pid`);
  return Number(await res.text());
}

async function fetchArgs(port: number): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${port}/args`);
  return await res.json() as string[];
}

async function portAnswers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/query`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oxi-server-real-'));
  standin = join(dir, 'oxigraph-standin.cjs');
  await writeFile(
    standin,
    `#!/usr/bin/env node
// Real stand-in server with oxigraph's CLI surface. Binds a REAL port,
// answers the readiness probe, exposes its pid, exits 1 on a REAL bind
// failure, exits 0 on SIGTERM.
const http = require('node:http');
const bindIdx = process.argv.indexOf('--bind');
const [host, port] = process.argv[bindIdx + 1].split(':');
const srv = http.createServer((req, res) => {
  if (req.url === '/pid') { res.statusCode = 200; res.end(String(process.pid)); return; }
  if (req.url === '/args') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(process.argv.slice(2)));
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/sparql-results+json');
  res.end(JSON.stringify({ head: {}, boolean: true }));
});
srv.on('error', (e) => { console.error('bind failed: ' + e.message); process.exit(1); });
srv.listen(Number(port), host);
process.on('SIGTERM', () => { srv.close(() => process.exit(0)); setTimeout(() => process.exit(0), 100).unref(); });
`,
    'utf8',
  );
  await chmod(standin, 0o755);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

function startOpts(port: number, extra: Record<string, unknown> = {}) {
  return {
    binaryPath: standin,
    location: dir,
    port,
    readyTimeoutMs: 5_000,
    readyIntervalMs: 50,
    stopGraceMs: 1_000,
    restartBackoffBaseMs: 100,
    restartBackoffMaxMs: 200,
    log: () => {},
    ...extra,
  };
}

describe('buildOxigraphSpawnSpec', () => {
  it('launches the binary directly when memory isolation is not configured', () => {
    const strategy = createOxigraphLaunchStrategy({
      platform: 'linux',
      parentPid: 42,
      uid: 1000,
    });
    expect(strategy.nextSpawnSpec('/opt/oxigraph', ['serve']))
      .toEqual({ command: '/opt/oxigraph', args: ['serve'] });
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
    strategy.nextSpawnSpec('/opt/oxigraph', ['serve']);
    strategy.nextSpawnSpec('/opt/oxigraph', ['serve']);
    const spec = strategy.nextSpawnSpec(
      '/opt/oxigraph',
      ['serve', '--bind', '127.0.0.1:7878'],
    );

    expect(spec.command).toBe('systemd-run');
    expect(spec.environment).toEqual({
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    });
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

describe('startOxigraphServer (real child processes)', () => {
  it('threads memory limits through systemd launch, descendant readiness, and listener cgroup sampling', async () => {
    const port = await freePort();
    let launchedCommand = '';
    let launchedArgs: readonly string[] = [];
    let launchedEnv: NodeJS.ProcessEnv | undefined;
    let ownershipPolicy: 'child-only' | 'process-tree' | undefined;
    const snapshotPids: number[] = [];
    const resolvedListenerPid = 424_242;

    const injectedSpawn = ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      launchedCommand = command;
      launchedArgs = args;
      launchedEnv = options?.env;
      const binaryIndex = args.indexOf(standin);
      expect(binaryIndex).toBeGreaterThan(0);
      return spawn(standin, args.slice(binaryIndex + 1), options);
    }) as typeof spawn;

    const handle = await startOxigraphServer(startOpts(port, {
      memoryLimits: { highMiB: 128, maxMiB: 256 },
      platform: 'linux',
      io: {
        spawn: injectedSpawn,
        findListenOwnerPid: async (child: import('node:child_process').ChildProcess, _port: number, _host: string, ownership?: 'child-only' | 'process-tree') => {
          ownershipPolicy = ownership;
          expect(child.pid).toBeDefined();
          return resolvedListenerPid;
        },
        readCgroupOomSnapshot: (pid: number) => {
          snapshotPids.push(pid);
          return { dir: '/sys/fs/cgroup/dkg-test-oxi', oomKill: 0 };
        },
      },
    }));
    try {
      expect(launchedCommand).toBe('systemd-run');
      expect(launchedArgs).toContain('--property=MemoryHigh=128M');
      expect(launchedArgs).toContain('--property=MemoryMax=256M');
      expect(launchedArgs).toContain('--property=MemorySwapMax=0');
      expect(launchedEnv?.XDG_RUNTIME_DIR).toMatch(/^\/run\/user\/\d+$/);
      expect(ownershipPolicy).toBe('process-tree');
      expect(snapshotPids).toEqual([resolvedListenerPid]);
    } finally {
      await handle.stop();
    }
  });

  it.runIf(process.platform === 'linux')('accepts a descendant process as the verified listener owner', async () => {
    const port = await freePort();
    const wrapper = spawn('/bin/sh', [
      '-c',
      '"$@" & child=$!; trap \'kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null\' TERM; wait "$child"',
      'wrapper',
      standin,
      'serve',
      '--location', dir,
      '--bind', `127.0.0.1:${port}`,
    ], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 50 && !(await portAnswers(port)); i++) await sleep(20);
      const listenerPid = await fetchPid(port);
      expect(await childOwnsListenPort(wrapper, port, '127.0.0.1')).toBe(false);
      expect(await childOwnsListenPort(wrapper, port, '127.0.0.1', 'process-tree')).toBe(true);
      expect(await findListenOwnerPid(wrapper, port, '127.0.0.1', 'process-tree')).toBe(listenerPid);
    } finally {
      wrapper.kill('SIGTERM');
      await new Promise<void>((resolve) => wrapper.once('exit', () => resolve()));
    }
  });

  it('spawns the binary and resolves once the real readiness probe answers', async () => {
    const port = await freePort();
    const handle = await startOxigraphServer(startOpts(port));
    try {
      expect(handle.port).toBe(port);
      expect(handle.queryEndpoint).toContain(`:${port}`);
      // The child really owns a really-bound socket.
      expect(await portAnswers(port)).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it('passes the native Oxigraph query timeout to the child process', async () => {
    const port = await freePort();
    const handle = await startOxigraphServer(startOpts(port, { queryTimeoutS: 35 }));
    try {
      const args = await fetchArgs(port);
      const timeoutIndex = args.indexOf('--timeout-s');
      expect(timeoutIndex).toBeGreaterThanOrEqual(0);
      expect(args[timeoutIndex + 1]).toBe('35');
    } finally {
      await handle.stop();
    }
  });

  it('rejects (and does not leak the child) when the bind REALLY fails — port already taken', async () => {
    const port = await freePort();
    // Genuinely occupy the port so the child hits a real EADDRINUSE. Track
    // the blocker's accepted sockets: the supervisor's (client-aborted)
    // readiness probes leave half-open server-side connections behind, and
    // `server.close()` waits for them — destroy them so teardown completes.
    const blocker: Server = createServer();
    const blockerSockets = new Set<import('node:net').Socket>();
    blocker.on('connection', (s) => {
      blockerSockets.add(s);
      s.on('close', () => blockerSockets.delete(s));
    });
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));
    try {
      await expect(
        startOxigraphServer(startOpts(port, { readyTimeoutMs: 1_500 })),
      ).rejects.toThrow(/ready|bind|exit/i);
    } finally {
      for (const s of blockerSockets) s.destroy();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
    // The failed child must not linger holding anything; the blocker is
    // closed, and nothing answers the probe (the supervisor killed it).
    await sleep(150);
    expect(await portAnswers(port)).toBe(false);
  });

  it('stop() terminates the real child (SIGTERM) and frees the port', async () => {
    const port = await freePort();
    const handle = await startOxigraphServer(startOpts(port));
    expect(await portAnswers(port)).toBe(true);
    await handle.stop();
    // The real process exited and the real socket is released.
    await sleep(100);
    expect(await portAnswers(port)).toBe(false);
  });

  it('restarts the child after an unexpected crash (real SIGKILL), with a new pid', async () => {
    const port = await freePort();
    const handle = await startOxigraphServer(startOpts(port));
    try {
      const pid1 = await fetchPid(port);
      expect(pid1).toBeGreaterThan(0);

      // Genuinely crash the supervised child from outside.
      process.kill(pid1, 'SIGKILL');

      // The supervisor must respawn it (backoff base 100ms). Poll until the
      // probe answers again with a DIFFERENT real pid.
      let pid2 = 0;
      for (let i = 0; i < 100; i++) {
        await sleep(100);
        try {
          pid2 = await fetchPid(port);
          if (pid2 && pid2 !== pid1) break;
        } catch {
          /* not back yet */
        }
      }
      expect(pid2, 'supervisor never respawned the crashed child').toBeGreaterThan(0);
      expect(pid2).not.toBe(pid1);
    } finally {
      await handle.stop();
    }
  });

  it('does NOT restart after stop() — the port stays free past the backoff window', async () => {
    const port = await freePort();
    const handle = await startOxigraphServer(startOpts(port));
    expect(await portAnswers(port)).toBe(true);
    await handle.stop();
    // Wait well past restartBackoffMaxMs: a buggy supervisor would have
    // respawned by now and the probe would answer.
    await sleep(600);
    expect(await portAnswers(port)).toBe(false);
  });
});

/**
 * Ownership lease, lifecycle state machine and controlled recovery (#2052 B2).
 *
 * These cases are PLATFORM-NEUTRAL by construction, unlike the suites above:
 *
 *   - the stand-in is launched through `process.execPath` instead of by its
 *     shebang, because Windows has no shebang support (that is exactly why the
 *     suites above are environmentally red there); and
 *   - listener ownership is resolved by an injected probe that reproduces the
 *     production contract rather than shelling out to `lsof`/`netstat`: it
 *     yields a pid only while the tracked child is alive, and fails CLOSED
 *     (null) otherwise — the same fail-closed shape as `findListenOwnerPid`,
 *     which returns null for an exited child.
 *
 * Everything else is real: real processes, real ports, real HTTP, real
 * signals, real timers. No `vi.mock`, no fake timers.
 */
describe('startOxigraphServer ownership lease and lifecycle (#2052 B2)', () => {
  /**
   * Launch the stand-in via the Node executable. With no memory limits the
   * launch strategy runs the binary directly, so `command` is the stand-in
   * path and `args` are Oxigraph's own arguments.
   */
  function nodeSpawn(onSpawn: (child: ChildProcess) => void): typeof spawn {
    return ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      const child = spawn(process.execPath, [command, ...args], options);
      onSpawn(child);
      return child;
    }) as typeof spawn;
  }

  /** Fail-closed listener-ownership probe: never attributes a dead child. */
  function ownerProbe(provable: () => boolean) {
    return async (child: ChildProcess): Promise<number | null> =>
      provable() && child.pid !== undefined && child.exitCode === null && child.signalCode === null
        ? child.pid
        : null;
  }

  async function waitUntil(
    predicate: () => boolean,
    what: string,
    timeoutMs = 8_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await sleep(25);
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
  }

  /** Standard injected io: real child, real port, deterministic ownership. */
  function supervisorIo(state: { spawns: ChildProcess[]; provable: boolean }) {
    return {
      spawn: nodeSpawn((child) => state.spawns.push(child)),
      findListenOwnerPid: ownerProbe(() => state.provable),
    };
  }

  it('binds generation 1 only once the spawned child is the PROVEN listener owner', async () => {
    const port = await freePort();
    const state = { spawns: [] as ChildProcess[], provable: false };
    const start = startOxigraphServer(startOpts(port, {
      readyTimeoutMs: 6_000,
      io: supervisorIo(state),
    }));
    let settled = false;
    void start.then(() => { settled = true; }, () => { settled = true; });

    // The child really binds and really answers the readiness ASK ...
    await waitUntil(() => state.spawns.length === 1, 'the child to spawn');
    let serving = false;
    for (let i = 0; i < 100 && !serving; i += 1) {
      serving = await portAnswers(port);
      if (!serving) await sleep(25);
    }
    expect(serving, 'the stand-in never bound the port').toBe(true);
    // ... but ownership is unprovable, so the supervisor must NOT report ready.
    await sleep(200);
    expect(settled, 'became ready on an HTTP 200 alone').toBe(false);

    state.provable = true;
    const handle = await start;
    try {
      expect(handle.ownership.snapshot()).toEqual({
        childGeneration: '1',
        ready: true,
        terminal: false,
      });
    } finally {
      await handle.stop();
    }
  });

  it('does NOT advance the generation while a respawned child cannot be proven to own the port', async () => {
    const port = await freePort();
    const state = { spawns: [] as ChildProcess[], provable: true };
    const handle = await startOxigraphServer(startOpts(port, {
      restartBackoffBaseMs: 100,
      restartBackoffMaxMs: 100,
      io: supervisorIo(state),
    }));
    try {
      expect(handle.ownership.snapshot().childGeneration).toBe('1');

      // From here the respawned child binds the port and answers HTTP 200 for
      // real — we just can no longer attribute the listener to it. This is the
      // EADDRINUSE-adoption hazard: a supervisor that trusted the 200 would
      // hand capability to a process it does not own.
      state.provable = false;
      state.spawns[0].kill('SIGKILL');

      await waitUntil(() => state.spawns.length >= 2, 'the supervisor to respawn');
      await waitUntil(() => !handle.ownership.snapshot().ready, 'the lease to drop liveness');
      await sleep(800); // several probe cycles against the unprovable listener

      expect(await portAnswers(port), 'the respawned child really is serving').toBe(true);
      expect(handle.ownership.snapshot()).toMatchObject({
        childGeneration: '1',
        ready: false,
      });

      state.provable = true;
      await waitUntil(() => handle.ownership.snapshot().ready, 'ownership to be re-proven');
      expect(handle.ownership.snapshot().childGeneration).toBe('2');
    } finally {
      state.provable = true;
      await handle.stop();
    }
  });

  it('invalidates the lease with child-exit the instant the proven child dies', async () => {
    const port = await freePort();
    const state = { spawns: [] as ChildProcess[], provable: true };
    const handle = await startOxigraphServer(startOpts(port, {
      // Long backoff so nothing revives during the assertions: we are pinning
      // the state BETWEEN the death and the restart.
      restartBackoffBaseMs: 30_000,
      restartBackoffMaxMs: 30_000,
      io: supervisorIo(state),
    }));
    try {
      state.spawns[0].kill('SIGKILL');
      await waitUntil(() => !handle.ownership.snapshot().ready, 'the lease to go not-ready');
      expect(handle.ownership.snapshot()).toEqual({
        // Capability is revoked BEFORE any replacement generation exists —
        // there is no window in which a dead child still looks live.
        childGeneration: '1',
        ready: false,
        terminal: false,
        lastInvalidation: 'child-exit',
      });
    } finally {
      await handle.stop();
    }
  });

  it('stop() closes the lease as terminal shutdown and freezes the generation', async () => {
    const port = await freePort();
    const state = { spawns: [] as ChildProcess[], provable: true };
    const handle = await startOxigraphServer(startOpts(port, { io: supervisorIo(state) }));
    await handle.stop();
    expect(handle.ownership.snapshot()).toEqual({
      childGeneration: '1',
      ready: false,
      terminal: true,
      lastInvalidation: 'shutdown',
    });
    // Idempotent, and a terminal lease can never be recovered.
    await handle.stop();
    expect(handle.ownership.snapshot().lastInvalidation).toBe('shutdown');
    await expect(handle.ownership.recoverGeneration('1')).rejects.toThrow(/terminal/i);
  });

  it('killSync() does not disarm a later stop() — it still closes and escalates', async () => {
    const port = await freePort();
    const state = { spawns: [] as ChildProcess[], provable: true };
    const handle = await startOxigraphServer(startOpts(port, { io: supervisorIo(state) }));

    handle.killSync();
    // Terminating, but NOT closed: the escalation killSync() cannot perform
    // itself must still be available to stop().
    expect(handle.ownership.snapshot()).toMatchObject({
      ready: false,
      terminal: false,
      lastInvalidation: 'stop',
    });

    await handle.stop();
    // The retired single-`stopping`-flag version returned at stop()'s
    // idempotency guard here, so it never awaited the exit, never escalated to
    // SIGKILL, and never closed the lease.
    expect(handle.ownership.snapshot()).toEqual({
      childGeneration: '1',
      ready: false,
      terminal: true,
      lastInvalidation: 'shutdown',
    });
    // stop() resolved only after the port was proven released — no sleep here.
    expect(await portAnswers(port)).toBe(false);
  });

  it('cancels an armed restart at stop(): nothing is spawned after close', async () => {
    const port = await freePort();
    const state = { spawns: [] as ChildProcess[], provable: true };
    const handle = await startOxigraphServer(startOpts(port, {
      restartBackoffBaseMs: 300,
      restartBackoffMaxMs: 300,
      io: supervisorIo(state),
    }));
    state.spawns[0].kill('SIGKILL');
    await waitUntil(() => !handle.ownership.snapshot().ready, 'the crash to be observed');
    // A restart is now armed for ~300ms. Close before it fires.
    await handle.stop();

    await sleep(1_200); // well past the backoff the crash armed
    expect(state.spawns.length, 'a child was spawned after close').toBe(1);
    expect(await portAnswers(port)).toBe(false);
    expect(handle.ownership.snapshot()).toEqual({
      childGeneration: '1',
      ready: false,
      terminal: true,
      lastInvalidation: 'shutdown',
    });
  });

  it('coalesces concurrent recoveries of the SAME broken generation into one restart', async () => {
    const port = await freePort();
    const state = { spawns: [] as ChildProcess[], provable: true };
    const handle = await startOxigraphServer(startOpts(port, {
      // No automatic revive during the test: the recovery must be the thing
      // that restarts the child.
      restartBackoffBaseMs: 30_000,
      restartBackoffMaxMs: 30_000,
      io: supervisorIo(state),
    }));
    try {
      state.spawns[0].kill('SIGKILL');
      await waitUntil(() => !handle.ownership.snapshot().ready, 'the lease to drop liveness');

      const first = handle.ownership.recoverGeneration('1');
      const second = handle.ownership.recoverGeneration('1');
      const third = handle.ownership.recoverGeneration('1');
      // Every holder that observed the same broken generation shares ONE
      // operation — not N queued behind the lifecycle mutex.
      expect(second).toBe(first);
      expect(third).toBe(first);

      await expect(Promise.all([first, second, third])).resolves.toEqual(['2', '2', '2']);
      expect(state.spawns.length, 'more than one respawn for one outage').toBe(2);
      expect(handle.ownership.snapshot()).toMatchObject({
        childGeneration: '2',
        ready: true,
      });
    } finally {
      await handle.stop();
    }
  });

  it('a controlled recovery pre-empts the armed backoff instead of waiting it out', async () => {
    const port = await freePort();
    const state = { spawns: [] as ChildProcess[], provable: true };
    const backoffMs = 2_500;
    const handle = await startOxigraphServer(startOpts(port, {
      restartBackoffBaseMs: backoffMs,
      restartBackoffMaxMs: backoffMs,
      io: supervisorIo(state),
    }));
    try {
      state.spawns[0].kill('SIGKILL');
      await waitUntil(() => !handle.ownership.snapshot().ready, 'the crash to be observed');

      const startedAt = Date.now();
      await expect(handle.ownership.recoverGeneration('1')).resolves.toBe('2');
      expect(
        Date.now() - startedAt,
        'recovery waited for the backoff instead of taking over from it',
      ).toBeLessThan(backoffMs - 500);
      expect(state.spawns.length).toBe(2);

      // The superseded timer must never fire behind the recovery.
      await sleep(backoffMs);
      expect(state.spawns.length, 'the disarmed backoff still spawned a child').toBe(2);
      expect(handle.ownership.snapshot()).toMatchObject({ childGeneration: '2', ready: true });
    } finally {
      await handle.stop();
    }
  });

  it('a STALE expected generation restarts nothing and does not queue behind a live recovery', async () => {
    const port = await freePort();
    const state = { spawns: [] as ChildProcess[], provable: true };
    const handle = await startOxigraphServer(startOpts(port, {
      readyTimeoutMs: 6_000,
      restartBackoffBaseMs: 100,
      restartBackoffMaxMs: 100,
      io: supervisorIo(state),
    }));
    try {
      // Reach generation 2 through the ordinary crash/revive path.
      state.spawns[0].kill('SIGKILL');
      await waitUntil(
        () => handle.ownership.snapshot().childGeneration === '2' && handle.ownership.snapshot().ready,
        'generation 2 to be bound',
      );
      expect(state.spawns.length).toBe(2);

      // Wedge the lifecycle mutex: kill generation 2 and drive a recovery that
      // cannot prove ownership, so it holds the lock for its full deadline.
      state.provable = false;
      state.spawns[1].kill('SIGKILL');
      await waitUntil(() => !handle.ownership.snapshot().ready, 'generation 2 to die');
      const wedged = handle.ownership.recoverGeneration('2');
      wedged.catch(() => { /* asserted by the state checks below */ });
      await waitUntil(() => state.spawns.length >= 3, 'the wedging recovery to respawn');

      // A holder still on generation 1 asks to recover. Its answer does not
      // depend on how generation 2's recovery turns out, so it must be served
      // from the stale fast path — never queued behind the wedged mutex.
      const stale = handle.ownership.recoverGeneration('1');
      await expect(
        Promise.race([stale, sleep(800).then(() => 'QUEUED_BEHIND_THE_MUTEX')]),
      ).resolves.toBe('2');
      expect(state.spawns.length, 'a stale recovery restarted a child').toBe(3);
    } finally {
      state.provable = true;
      await handle.stop();
    }
  });

  it('burns the lease as terminal when the bind is still served after the child exited', async () => {
    const port = await freePort();
    const state = { spawns: [] as ChildProcess[], provable: true };
    const realFetch = globalThis.fetch;
    let foreignServerHoldsPort = false;
    const handle = await startOxigraphServer(startOpts(port, {
      stopGraceMs: 500,
      io: {
        ...supervisorIo(state),
        // Once shutdown starts, something else answers SPARQL on our bind. The
        // supervisor cannot attribute it (findListenOwnerPid fails closed on
        // the exited child), so port release is NOT provable.
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (!foreignServerHoldsPort) return await realFetch(input, init);
          return new Response(JSON.stringify({ head: {}, boolean: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/sparql-results+json' },
          });
        }) as typeof globalThis.fetch,
      },
    }));
    expect(handle.ownership.snapshot().childGeneration).toBe('1');

    foreignServerHoldsPort = true;
    await handle.stop();

    const snapshot = handle.ownership.snapshot();
    expect(snapshot.terminal).toBe(true);
    // The specific reason must survive: 'shutdown' is equally terminal but
    // tells an operator nothing about a bind we could not account for.
    expect(snapshot.lastInvalidation).toBe('port-release-unproven');
    await expect(handle.ownership.recoverGeneration('1')).rejects.toThrow(/terminal/i);
  });

  it('rejects recovery of a generation that was never bound', async () => {
    const port = await freePort();
    const state = { spawns: [] as ChildProcess[], provable: true };
    const handle = await startOxigraphServer(startOpts(port, { io: supervisorIo(state) }));
    try {
      await expect(handle.ownership.recoverGeneration('7')).rejects.toThrow(/never bound/i);
      await expect(handle.ownership.recoverGeneration('01')).rejects.toThrow(/canonical decimal/i);
      // A live generation needs no recovery: the caller's view was stale.
      await expect(handle.ownership.recoverGeneration('1')).resolves.toBe('1');
      expect(state.spawns.length).toBe(1);
    } finally {
      await handle.stop();
    }
  });

  // -------------------------------------------------------------------
  // Clean-generation handoff (#2052 B2)
  // -------------------------------------------------------------------

  it('retires the owned child and then binds a clean replacement generation', async () => {
    const port = await freePort();
    const state = { spawns: [] as ChildProcess[], provable: true };
    const handle = await startOxigraphServer(startOpts(port, { io: supervisorIo(state) }));
    try {
      expect(handle.ownership.snapshot().childGeneration).toBe('1');

      await handle.supervisorHandoff.stopAndProveOwnedChildDead();
      // Resolving means the child is really gone AND the bind is really free —
      // proven by a real probe, not assumed from the exit event.
      expect(await portAnswers(port)).toBe(false);
      expect(state.spawns.length, 'retiring must not start anything').toBe(1);
      expect(handle.ownership.snapshot()).toEqual({
        // Liveness is gone but the supervisor is NOT closed: a replacement is
        // expected, so this must not be terminal the way stop() is.
        childGeneration: '1',
        ready: false,
        terminal: false,
        lastInvalidation: 'stop',
      });

      await handle.supervisorHandoff.startAndProveCleanGeneration();
      expect(state.spawns.length).toBe(2);
      expect(handle.ownership.snapshot()).toMatchObject({ childGeneration: '2', ready: true });
      expect(await portAnswers(port)).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it('REJECTS the retire, and goes terminal, when port release cannot be proven', async () => {
    const port = await freePort();
    const state = { spawns: [] as ChildProcess[], provable: true };
    const realFetch = globalThis.fetch;
    let foreignServerHoldsPort = false;
    const handle = await startOxigraphServer(startOpts(port, {
      stopGraceMs: 500,
      io: {
        ...supervisorIo(state),
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (!foreignServerHoldsPort) return await realFetch(input, init);
          return new Response(JSON.stringify({ head: {}, boolean: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/sparql-results+json' },
          });
        }) as typeof globalThis.fetch,
      },
    }));

    foreignServerHoldsPort = true;
    // Unlike stop(), which logs and carries on because it runs from teardown,
    // this MUST reject: its caller is about to bind a replacement, and a silent
    // resolve would let that happen over a listener we cannot account for.
    await expect(handle.supervisorHandoff.stopAndProveOwnedChildDead())
      .rejects.toThrow(/could not prove/i);
    expect(handle.ownership.snapshot()).toMatchObject({
      terminal: true,
      lastInvalidation: 'port-release-unproven',
    });
    // Refused outright, not merely discouraged. The message is the observable
    // proxy for `state === 'closed'`: a failed retire must CLOSE the supervisor,
    // not merely leave it ownership-terminal but open, because "open" is a
    // state some later path could still spawn from.
    await expect(handle.supervisorHandoff.startAndProveCleanGeneration())
      .rejects.toThrow(/shutting down/i);
    expect(state.spawns.length, 'a replacement bound over an unaccounted listener').toBe(1);
  });

  it('refuses a clean-generation start that no proven-dead predecessor precedes', async () => {
    const port = await freePort();
    const state = { spawns: [] as ChildProcess[], provable: true };
    const handle = await startOxigraphServer(startOpts(port, { io: supervisorIo(state) }));
    try {
      await expect(handle.supervisorHandoff.startAndProveCleanGeneration())
        .rejects.toThrow(/proven-dead predecessor/i);
      // The live child is untouched — refusing must not damage the generation
      // the caller still holds.
      expect(state.spawns.length).toBe(1);
      expect(handle.ownership.snapshot()).toMatchObject({ childGeneration: '1', ready: true });
      expect(await portAnswers(port)).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it('lets nothing else bind a generation between the two handoff halves', async () => {
    const port = await freePort();
    const state = { spawns: [] as ChildProcess[], provable: true };
    const handle = await startOxigraphServer(startOpts(port, {
      restartBackoffBaseMs: 100,
      restartBackoffMaxMs: 100,
      io: supervisorIo(state),
    }));
    try {
      await handle.supervisorHandoff.stopAndProveOwnedChildDead();
      // The mutex is RELEASED between the two halves, so this window is the one
      // place an ordinary revive or a caller recovery could bind a generation
      // the lane never asked for, over a port the lane believes is free.
      await sleep(600); // many backoff periods
      expect(state.spawns.length, 'automatic supervision spawned into the handoff window').toBe(1);
      await expect(handle.ownership.recoverGeneration('1')).rejects.toThrow(/handoff/i);
      expect(state.spawns.length, 'a caller recovery spawned into the handoff window').toBe(1);

      await handle.supervisorHandoff.startAndProveCleanGeneration();
      expect(handle.ownership.snapshot()).toMatchObject({ childGeneration: '2', ready: true });
      expect(state.spawns.length).toBe(2);
    } finally {
      await handle.stop();
    }
  });

  it('recovers the phase when spawn throws SYNCHRONOUSLY during a clean-generation start', async () => {
    const port = await freePort();
    const state = { spawns: [] as ChildProcess[], provable: true };
    const io = supervisorIo(state);
    let failNextSpawnSynchronously = false;
    const handle = await startOxigraphServer(startOpts(port, {
      restartBackoffBaseMs: 100,
      restartBackoffMaxMs: 100,
      io: {
        ...io,
        // `child_process.spawn` raises EACCES/EFTYPE/E2BIG/EINVAL synchronously
        // rather than delivering them to the `error` event, so this is the real
        // shape of a bad binary — not a contrived failure.
        spawn: ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
          if (failNextSpawnSynchronously) {
            failNextSpawnSynchronously = false;
            throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
          }
          return io.spawn(command, args, options);
        }) as typeof spawn,
      },
    }));
    try {
      await handle.supervisorHandoff.stopAndProveOwnedChildDead();
      failNextSpawnSynchronously = true;
      await expect(handle.supervisorHandoff.startAndProveCleanGeneration())
        .rejects.toThrow(/EACCES/);

      // The throw must not escape past the recovery tail. If it does, the phase
      // stays 'retired' for the life of the process: no replacement, no
      // automatic revive, and a lease reporting "momentarily not ready" forever
      // instead of failing closed — the daemon's triple store is simply dead.
      await waitUntil(
        () => handle.ownership.snapshot().childGeneration === '2',
        'ordinary supervision to resume after the synchronous spawn failure',
      );
      expect(handle.ownership.snapshot()).toMatchObject({ childGeneration: '2', ready: true });
      expect(await portAnswers(port)).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it('does NOT accept an inconclusive probe as proof that the bind was released', async () => {
    const port = await freePort();
    const state = { spawns: [] as ChildProcess[], provable: true };
    const realFetch = globalThis.fetch;
    let probesTimeOut = false;
    const handle = await startOxigraphServer(startOpts(port, {
      stopGraceMs: 500,
      io: {
        ...supervisorIo(state),
        // A loaded listener that misses the probe deadline. #2052 is a store
        // PRESSURE issue, so this is the expected case, not an exotic one — and
        // it is NOT evidence that the socket is gone, unlike ECONNREFUSED.
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (!probesTimeOut) return await realFetch(input, init);
          throw Object.assign(new Error('The operation was aborted due to timeout'), {
            name: 'TimeoutError',
          });
        }) as typeof globalThis.fetch,
      },
    }));

    probesTimeOut = true;
    await expect(handle.supervisorHandoff.stopAndProveOwnedChildDead())
      .rejects.toThrow(/could not prove/i);
    expect(handle.ownership.snapshot()).toMatchObject({
      terminal: true,
      lastInvalidation: 'port-release-unproven',
    });
    // A failed retire must not leave an open, childless supervisor that could
    // still spawn against a listener it cannot account for.
    await sleep(600);
    expect(state.spawns.length, 'spawned after a retire that could not be proven').toBe(1);
    await expect(handle.supervisorHandoff.startAndProveCleanGeneration())
      .rejects.toThrow(/shutting down/i);
    // stop() stays safe and idempotent on that path, and does not overwrite the
    // more specific terminal reason.
    await handle.stop();
    expect(handle.ownership.snapshot().lastInvalidation).toBe('port-release-unproven');
  });

  it('resumes ordinary supervision when a lane retires and never binds a replacement', async () => {
    const port = await freePort();
    const state = { spawns: [] as ChildProcess[], provable: true };
    const handle = await startOxigraphServer(startOpts(port, {
      handoffAbandonMs: 400,
      restartBackoffBaseMs: 100,
      restartBackoffMaxMs: 100,
      io: supervisorIo(state),
    }));
    try {
      // Exactly what a lane SHUTDOWN does: destroy the client, retire the
      // child, drain — and never come back. This child is the daemon's whole
      // triple store, not the lane's private one, so one consumer's teardown
      // must not park it childless for the life of the process.
      await handle.supervisorHandoff.stopAndProveOwnedChildDead();
      expect(state.spawns.length).toBe(1);

      await waitUntil(
        () => handle.ownership.snapshot().ready,
        'the abandoned handoff to be backstopped',
      );
      expect(handle.ownership.snapshot()).toMatchObject({ childGeneration: '2', ready: true });
      expect(await portAnswers(port)).toBe(true);
      // A lane that returns late is refused — fail-closed for the lane, alive
      // for every other consumer of the store.
      await expect(handle.supervisorHandoff.startAndProveCleanGeneration())
        .rejects.toThrow(/proven-dead predecessor/i);
    } finally {
      await handle.stop();
    }
  });

  it('advertises the system-record lane only with BOTH a live lease and a handoff', async () => {
    const port = await freePort();
    const state = { spawns: [] as ChildProcess[], provable: true };
    const handle = await startOxigraphServer(startOpts(port, { io: supervisorIo(state) }));
    const base = (): Record<string | symbol, unknown> => ({
      queryEndpoint: handle.queryEndpoint,
      updateEndpoint: handle.updateEndpoint,
    });
    const laneOf = (options: Record<string | symbol, unknown>) =>
      new SparqlHttpStore(options as unknown as SparqlHttpStoreOptions)
        .getSystemRecordLaneControllerV1();
    try {
      // Neither: an ordinary external SPARQL endpoint.
      expect(laneOf(base())).toBeUndefined();
      // Lease only. Ownership is genuinely proven here, which is what makes
      // this the discriminating case: without a handoff nothing could prove the
      // retired child dead before a replacement binds, so the lane stays
      // unadvertised rather than advertising one that can never open.
      expect(laneOf(attachManagedOxigraphLeaseV1(base(), handle.ownership.lease)))
        .toBeUndefined();
      // Both.
      expect(laneOf(attachManagedOxigraphLeaseV1(
        base(),
        handle.ownership.lease,
        handle.supervisorHandoff,
      ))).toBeDefined();
    } finally {
      await handle.stop();
    }
    // A terminal lease stops advertising even with the handoff still attached.
    expect(laneOf(attachManagedOxigraphLeaseV1(
      base(),
      handle.ownership.lease,
      handle.supervisorHandoff,
    ))).toBeUndefined();
  });
});

describe('startOxigraphServer OOM classification in the restart log', () => {
  // The cgroup OOM readers are the one piece that can't be exercised against a
  // real cgroup portably in CI, so we inject ONLY those while keeping the REAL
  // child lifecycle (genuine SIGKILL -> real exit event -> the supervisor's
  // exit handler). This proves startOxigraphServer captures the per-child
  // baseline and surfaces the operator-facing OOM note — coverage the
  // parser-only oxigraph-memory tests cannot provide.
  async function waitForLog(logs: string[], re: RegExp, ms = 3_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (logs.some((l) => re.test(l))) return true;
      await sleep(25);
    }
    return false;
  }

  it('attributes a scoped wrapper SIGKILL using the resolved Oxigraph listener cgroup', async () => {
    const port = await freePort();
    const logs: string[] = [];
    const listenerPid = 777_777;
    const snapshotPids: number[] = [];
    let launched: import('node:child_process').ChildProcess | undefined;
    let oomKillAtExit = 5;
    const injectedSpawn = ((_command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      const binaryIndex = args.indexOf(standin);
      launched = spawn(standin, args.slice(binaryIndex + 1), options);
      return launched;
    }) as typeof spawn;

    const handle = await startOxigraphServer(startOpts(port, {
      memoryLimits: { maxMiB: 256 },
      platform: 'linux',
      log: (message: string) => logs.push(message),
      io: {
        spawn: injectedSpawn,
        findListenOwnerPid: async () => listenerPid,
        readCgroupOomSnapshot: (pid: number) => {
          snapshotPids.push(pid);
          return { dir: '/sys/fs/cgroup/dkg-scoped-oxi', oomKill: 5 };
        },
        readCgroupOomKill: () => oomKillAtExit,
      },
    }));
    try {
      expect(snapshotPids).toEqual([listenerPid]);
      oomKillAtExit = 6;
      launched!.kill('SIGKILL');
      expect(await waitForLog(logs, /OOM-killed by cgroup memory cap/)).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it('attributes a scoped command OOM when its wrapper translates SIGKILL to exit 137', async () => {
    const port = await freePort();
    const logs: string[] = [];
    let oomKillAtExit = 9;
    const wrapperProgram = `
      const { spawn } = require('node:child_process');
      const [command, ...args] = process.argv.slice(1);
      const child = spawn(command, args, { stdio: 'inherit' });
      process.on('SIGTERM', () => child.kill('SIGTERM'));
      child.once('exit', () => process.exit(137));
    `;
    const injectedSpawn = ((_command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      const binaryIndex = args.indexOf(standin);
      return spawn(
        process.execPath,
        ['-e', wrapperProgram, standin, ...args.slice(binaryIndex + 1)],
        options,
      );
    }) as typeof spawn;

    const handle = await startOxigraphServer(startOpts(port, {
      memoryLimits: { maxMiB: 256 },
      platform: 'linux',
      log: (message: string) => logs.push(message),
      io: {
        spawn: injectedSpawn,
        findListenOwnerPid: async () => await fetchPid(port),
        readCgroupOomSnapshot: () => ({ dir: '/sys/fs/cgroup/dkg-scoped-oxi', oomKill: 9 }),
        readCgroupOomKill: () => oomKillAtExit,
      },
    }));
    try {
      oomKillAtExit = 10;
      process.kill(await fetchPid(port), 'SIGKILL');
      expect(await waitForLog(logs, /code=137.*OOM-killed by cgroup memory cap/)).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it('uses the scoped watchdog marker when systemd removes memory.events before wrapper exit', async () => {
    const port = await freePort();
    const logs: string[] = [];
    const wrapperProgram = `
      const { spawn } = require('node:child_process');
      const [command, ...args] = process.argv.slice(1);
      const child = spawn(command, args, { stdio: 'inherit' });
      process.on('SIGTERM', () => child.kill('SIGTERM'));
      child.once('exit', () => {
        process.stderr.write(${JSON.stringify(OXIGRAPH_WATCHDOG_OOM_MARKER)} + '\\n');
        process.exit(0);
      });
    `;
    const injectedSpawn = ((_command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      const binaryIndex = args.indexOf(standin);
      return spawn(
        process.execPath,
        ['-e', wrapperProgram, standin, ...args.slice(binaryIndex + 1)],
        options,
      );
    }) as typeof spawn;

    const handle = await startOxigraphServer(startOpts(port, {
      memoryLimits: { maxMiB: 256 },
      platform: 'linux',
      log: (message: string) => logs.push(message),
      io: {
        spawn: injectedSpawn,
        findListenOwnerPid: async () => await fetchPid(port),
        readCgroupOomSnapshot: () => ({ dir: '/sys/fs/cgroup/vanished', oomKill: 12 }),
        readCgroupOomKill: () => null,
      },
    }));
    try {
      process.kill(await fetchPid(port), 'SIGKILL');
      expect(await waitForLog(logs, /code=0.*OOM-killed by cgroup memory cap/)).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it('labels an OOM-kill when the cgroup oom_kill count increments across the exit', async () => {
    const port = await freePort();
    const logs: string[] = [];
    const snapshotPids: number[] = [];
    const oomDir = '/sys/fs/cgroup/oxi';
    let oomKillAtExit = 5;
    const handle = await startOxigraphServer(
      startOpts(port, {
        log: (m: string) => logs.push(m),
        io: {
          readCgroupOomSnapshot: (pid: number) => {
            snapshotPids.push(pid);
            return { dir: oomDir, oomKill: 5 };
          },
          readCgroupOomKill: (dir: string) => {
            expect(dir).toBe(oomDir);
            return oomKillAtExit;
          },
        },
      }),
    );
    try {
      const pid = await fetchPid(port);
      expect(snapshotPids[0]).toBe(pid);
      oomKillAtExit = 6; // kernel cgroup-OOM-killed it: oom_kill 5 -> 6
      process.kill(pid, 'SIGKILL');
      const labelled = await waitForLog(
        logs,
        /server exited unexpectedly.*OOM-killed by cgroup memory cap/,
      );
      expect(labelled, `no OOM-labelled restart log; got: ${logs.join(' | ')}`).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it('omits the OOM note when the cgroup counter increments but the child was not SIGKILLed', async () => {
    const port = await freePort();
    const logs: string[] = [];
    let exitReads = 0;
    const handle = await startOxigraphServer(
      startOpts(port, {
        log: (m: string) => logs.push(m),
        io: {
          readCgroupOomSnapshot: () => ({ dir: '/sys/fs/cgroup/oxi', oomKill: 5 }),
          readCgroupOomKill: () => {
            exitReads += 1;
            return 6; // would look incremented, but the child did not die by SIGKILL
          },
        },
      }),
    );
    try {
      const pid = await fetchPid(port);
      process.kill(pid, 'SIGTERM');
      const logged = await waitForLog(logs, /server exited unexpectedly/);
      expect(logged, `no restart log; got: ${logs.join(' | ')}`).toBe(true);
      expect(exitReads).toBe(0);
      expect(logs.some((l) => /OOM-killed/.test(l))).toBe(false);
    } finally {
      await handle.stop();
    }
  });

  it('omits the OOM note on a plain crash (oom_kill unchanged)', async () => {
    const port = await freePort();
    const logs: string[] = [];
    const handle = await startOxigraphServer(
      startOpts(port, {
        log: (m: string) => logs.push(m),
        io: {
          readCgroupOomSnapshot: () => ({ dir: '/sys/fs/cgroup/oxi', oomKill: 5 }),
          readCgroupOomKill: () => 5, // unchanged → not an OOM-kill
        },
      }),
    );
    try {
      const pid = await fetchPid(port);
      process.kill(pid, 'SIGKILL');
      const logged = await waitForLog(logs, /server exited unexpectedly/);
      expect(logged, `no restart log; got: ${logs.join(' | ')}`).toBe(true);
      expect(logs.some((l) => /OOM-killed/.test(l))).toBe(false);
    } finally {
      await handle.stop();
    }
  });
});
