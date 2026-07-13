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
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOxigraphServer, type OxigraphServerIo } from '../src/daemon/oxigraph-server.js';
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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessesToExit(
  pids: readonly number[],
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(processExists) && Date.now() < deadline) await sleep(20);
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
  const { io: extraIo, ...rest } = extra as {
    io?: Partial<OxigraphServerIo>;
  } & Record<string, unknown>;
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
    io: {
      // Cross-platform tests simulate the Linux systemd command shape on
      // hosts where `/proc/<pid>/stat` is unavailable.
      createLaunchStrategy: (input: Parameters<typeof createOxigraphLaunchStrategy>[0]) =>
        createOxigraphLaunchStrategy({
          ...input,
          parentIdentity: `${process.pid}:test`,
        }),
      ...extraIo,
    },
    ...rest,
  };
}

function createIpcWatchdogLaunchStrategy(
  input: Parameters<typeof createOxigraphLaunchStrategy>[0],
) {
  const watchdogPath = fileURLToPath(new URL(
    '../dist/daemon/oxigraph-parent-watchdog.js',
    import.meta.url,
  ));
  const strategy = createOxigraphLaunchStrategy({
    ...input,
    platform: 'win32',
    watchdogPath,
    nodeExecutable: process.execPath,
  });
  if (process.platform !== 'win32') return strategy;

  // Windows cannot execute the shebang stand-in directly. Keep the production
  // watchdog strategy and only adapt its supervised command to `node standin`.
  return {
    ...strategy,
    nextSpawnSpec: (_binaryPath: string, binaryArgs: string[]) =>
      strategy.nextSpawnSpec(process.execPath, [standin, ...binaryArgs]),
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

  it('uses a dedicated parent IPC watchdog on Windows', async () => {
    const strategy = createOxigraphLaunchStrategy({
      platform: 'win32',
      parentPid: 42,
      uid: -1,
      nodeExecutable: 'C:\\node.exe',
      watchdogPath: 'C:\\oxigraph-parent-watchdog.js',
    });
    const spec = strategy.nextSpawnSpec('C:\\oxigraph.exe', ['serve']);
    expect(spec).toEqual({
      command: 'C:\\node.exe',
      args: [
        'C:\\oxigraph-parent-watchdog.js',
        'ipc',
        '42',
        'C:\\oxigraph.exe',
        'serve',
      ],
      environment: {
        DKG_OXIGRAPH_WATCHDOG_STOP_GRACE_MS: '5000',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let ownership: string | undefined;
    await strategy.resolveListenerPid({} as never, 7878, '127.0.0.1', async (_child, _port, _host, policy) => {
      ownership = policy;
      return 99;
    });
    expect(ownership).toBe('process-tree');
  });

  it('force-kills the complete Windows watchdog process tree', () => {
    const invocations: Array<{
      command: string;
      args: readonly string[];
      options: Record<string, unknown>;
    }> = [];
    const signals: NodeJS.Signals[] = [];
    const strategy = createOxigraphLaunchStrategy({
      platform: 'win32',
      parentPid: 42,
      uid: -1,
      io: {
        spawnSync: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
          invocations.push({ command, args, options });
          return { status: 0 };
        }) as typeof import('node:child_process').spawnSync,
      },
    });
    const child = {
      pid: 4321,
      connected: false,
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal);
        return true;
      },
    } as unknown as import('node:child_process').ChildProcess;

    expect(strategy.shutdown(child, 'force')).toBe(true);
    expect(invocations).toEqual([{
      command: 'taskkill.exe',
      args: ['/PID', '4321', '/T', '/F'],
      options: { stdio: 'ignore', windowsHide: true },
    }]);
    expect(signals).toEqual([]);
  });

  it('wraps Oxigraph in a finite systemd user scope', () => {
    const strategy = createOxigraphLaunchStrategy({
      memoryLimits: { highMiB: 2048, maxMiB: 3072 },
      platform: 'linux',
      parentPid: 42,
      uid: 1000,
      nodeExecutable: '/opt/node',
      watchdogPath: '/opt/oxigraph-watchdog.js',
      parentIdentity: '42:1234',
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
    expect(spec.args.slice(-9)).toEqual([
      '/opt/node', '/opt/oxigraph-watchdog.js', 'process-identity', '42', '42:1234',
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
        createLaunchStrategy: (input: Parameters<typeof createOxigraphLaunchStrategy>[0]) =>
          createOxigraphLaunchStrategy({
            ...input,
            parentIdentity: `${process.pid}:test`,
          }),
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

  it('stop() disconnects the real IPC watchdog and reaps wrapper plus listener', async () => {
    const port = await freePort();
    let wrapper: import('node:child_process').ChildProcess | undefined;
    const captureSpawn = ((
      command: string,
      args: readonly string[],
      options: Parameters<typeof spawn>[2],
    ) => {
      wrapper = spawn(command, args, options);
      return wrapper;
    }) as typeof spawn;

    const handle = await startOxigraphServer(startOpts(port, {
      platform: 'win32',
      io: {
        createLaunchStrategy: createIpcWatchdogLaunchStrategy,
        spawn: captureSpawn,
        // On Windows exercise the real process-tree owner lookup. Other CI
        // hosts still run the real watchdog and socket lifecycle portably.
        ...(process.platform === 'win32'
          ? {}
          : { findListenOwnerPid: async () => await fetchPid(port) }),
      },
    }));
    const listenerPid = await fetchPid(port);
    const wrapperPid = wrapper!.pid!;
    expect(listenerPid).not.toBe(wrapperPid);

    await handle.stop();

    expect(await portAnswers(port)).toBe(false);
    expect(() => process.kill(listenerPid, 0)).toThrow();
    expect(() => process.kill(wrapperPid, 0)).toThrow();
  });

  it('killSync() signals the real IPC watchdog without leaving its listener orphaned', async () => {
    const port = await freePort();
    let wrapper: import('node:child_process').ChildProcess | undefined;
    const handle = await startOxigraphServer(startOpts(port, {
      platform: 'win32',
      io: {
        createLaunchStrategy: createIpcWatchdogLaunchStrategy,
        spawn: ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
          wrapper = spawn(command, args, options);
          return wrapper;
        }) as typeof spawn,
        ...(process.platform === 'win32'
          ? {}
          : { findListenOwnerPid: async () => await fetchPid(port) }),
      },
    }));
    const listenerPid = await fetchPid(port);
    const wrapperPid = wrapper!.pid!;

    handle.killSync();
    for (let i = 0; i < 50 && await portAnswers(port); i++) await sleep(20);
    await waitForProcessesToExit([listenerPid, wrapperPid]);

    expect(await portAnswers(port)).toBe(false);
    expect(() => process.kill(listenerPid, 0)).toThrow();
    expect(() => process.kill(wrapperPid, 0)).toThrow();
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
