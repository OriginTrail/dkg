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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createManagedOxigraphSparqlStoreV1,
} from '@origintrail-official/dkg-storage';
import { startOxigraphServer } from '../src/daemon/oxigraph-server.js';
import { createOxigraphLaunchStrategy } from '../src/daemon/oxigraph-launch-strategy.js';
import { OXIGRAPH_WATCHDOG_OOM_MARKER } from '../src/daemon/oxigraph-parent-watchdog.js';
import { OXIGRAPH_VERSION } from '../src/daemon/oxigraph-binary.js';
import {
  childOwnsListenPort,
  findListenOwnerPid,
} from '../src/daemon/oxigraph-listen-port.js';
import {
  createOxigraphStandinFixture,
  fetchPid,
  freePort,
  portAnswers,
  sleep,
  type OxigraphStandinFixture,
} from './fixtures/oxigraph-server-real-fixture.js';

let dir: string;
let standin: string;
let standinFixture: OxigraphStandinFixture;

async function fetchArgs(port: number): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${port}/args`);
  return await res.json() as string[];
}

async function executableVersion(binaryPath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Oxigraph --version exited ${code}: ${stderr.trim()}`));
    });
  });
}

beforeAll(async () => {
  standinFixture = await createOxigraphStandinFixture();
  dir = standinFixture.directory;
  standin = standinFixture.binaryPath;
});

afterAll(async () => {
  await standinFixture.cleanup();
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
      for (let i = 0; i < 50 && handle.getRecoveryState().recovering; i++) await sleep(20);
      expect(handle.getRecoveryState()).toEqual({ recovering: false, generation: 1 });
    } finally {
      await handle.stop();
    }
  });

  it('restarts the child on an explicit recovery request and coalesces duplicates', async () => {
    const port = await freePort();
    const logs: string[] = [];
    const handle = await startOxigraphServer(startOpts(port, { log: (line: string) => logs.push(line) }));
    try {
      const pid1 = await fetchPid(port);
      expect(handle.requestRestart('query exceeded the managed SPARQL client deadline')).toBe(true);
      expect(handle.getRecoveryState()).toEqual({ recovering: false, generation: 0 });
      expect(handle.requestRestart('duplicate timeout')).toBe(false);

      let pid2 = 0;
      for (let i = 0; i < 100; i++) {
        await sleep(100);
        try {
          pid2 = await fetchPid(port);
          if (pid2 && pid2 !== pid1) break;
        } catch {
          /* recovery is still in progress */
        }
      }
      expect(pid2, 'supervisor never recovered the explicitly restarted child').toBeGreaterThan(0);
      expect(pid2).not.toBe(pid1);
      for (let i = 0; i < 50 && handle.getRecoveryState().recovering; i++) await sleep(20);
      expect(handle.getRecoveryState()).toEqual({ recovering: false, generation: 1 });
      expect(logs.some((line) => line.includes('server terminated for recovery'))).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it('cancels recovery without signalling when listener ownership changes', async () => {
    const port = await freePort();
    const logs: string[] = [];
    let reportChangedOwner = false;
    const killProcess = vi.fn(() => true) as unknown as typeof process.kill;
    const originalFetch = globalThis.fetch;
    const handle = await startOxigraphServer(startOpts(port, {
      log: (line: string) => logs.push(line),
      io: {
        killProcess,
        findListenOwnerPid: async (child, listenerPort, host, ownership) => {
          const actual = await findListenOwnerPid(child, listenerPort, host, ownership);
          return reportChangedOwner && actual !== null ? actual + 100_000 : actual;
        },
      },
    }));
    try {
      const pid = await fetchPid(port);
      let rejectUpdate!: (error: unknown) => void;
      let markUpdateStarted!: () => void;
      const updateStarted = new Promise<void>((resolve) => { markUpdateStarted = resolve; });
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(init?.body ?? '').startsWith('INSERT')) {
          markUpdateStarted();
          return await new Promise<Response>((_resolve, reject) => { rejectUpdate = reject; });
        }
        return await originalFetch(input, init);
      }) as typeof fetch;
      const store = createManagedOxigraphSparqlStoreV1({
        queryEndpoint: `http://127.0.0.1:${port}/query`,
        updateEndpoint: `http://127.0.0.1:${port}/update`,
        timeout: 5_000,
        getRecoveryState: () => handle.getRecoveryState(),
      });
      const updateFailure = store.insert([{
        subject: 'http://ex.org/s',
        predicate: 'http://ex.org/p',
        object: '"value"',
        graph: 'http://ex.org/g',
      }]).catch((error) => error);
      await updateStarted;
      reportChangedOwner = true;
      expect(handle.requestRestart('ownership-negative-path')).toBe(true);

      for (let i = 0; i < 50 && !logs.some((line) => line.includes('ownership changed')); i++) {
        await sleep(20);
      }

      expect(killProcess).not.toHaveBeenCalled();
      expect(handle.getRecoveryState()).toEqual({ recovering: false, generation: 0 });
      const definitiveError = new Error('definitive backend failure after cancelled restart');
      rejectUpdate(definitiveError);
      expect(await updateFailure).toBe(definitiveError);
      expect(await fetchPid(port)).toBe(pid);
      expect(await portAnswers(port)).toBe(true);
      expect(logs.some((line) => line.includes('ownership changed'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      await handle.stop();
    }
  });

  it.each(['throws', 'returns false'] as const)(
    'rolls back a restart whose SIGKILL %s and accepts a later request',
    async (failureMode) => {
      const port = await freePort();
      const logs: string[] = [];
      let signalAttempts = 0;
      const killProcess = vi.fn(() => {
        signalAttempts += 1;
        if (failureMode === 'returns false') return false;
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }) as unknown as typeof process.kill;
      const handle = await startOxigraphServer(startOpts(port, {
        log: (line: string) => logs.push(line),
        io: { killProcess },
      }));
      try {
        const pid = await fetchPid(port);
        expect(handle.requestRestart(`signal failure: ${failureMode}`)).toBe(true);
        for (let i = 0; i < 50 && signalAttempts < 1; i++) await sleep(20);

        expect(signalAttempts).toBe(1);
        expect(handle.getRecoveryState()).toEqual({ recovering: false, generation: 0 });
        expect(await fetchPid(port)).toBe(pid);
        expect(await portAnswers(port)).toBe(true);

        // Rollback must restore ready, not strand the supervisor in a request
        // phase that rejects every future recovery attempt.
        expect(handle.requestRestart(`second signal failure: ${failureMode}`)).toBe(true);
        for (let i = 0; i < 50 && signalAttempts < 2; i++) await sleep(20);
        expect(signalAttempts).toBe(2);
        expect(handle.getRecoveryState()).toEqual({ recovering: false, generation: 0 });
        expect(logs.filter((line) => line.includes('could not signal')).length).toBe(2);
      } finally {
        await handle.stop();
      }
    },
  );

  it('targets the verified Oxigraph listener when a systemd-style wrapper owns the child', async () => {
    const port = await freePort();
    const wrapperPids: number[] = [];
    const recoverySignals: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    const wrapperProgram = `
      const { spawn } = require('node:child_process');
      const [command, ...args] = process.argv.slice(1);
      const child = spawn(command, args, { stdio: 'inherit' });
      process.on('SIGTERM', () => child.kill('SIGTERM'));
      child.once('exit', (code, signal) => process.exit(signal === 'SIGKILL' ? 137 : (code ?? 1)));
    `;
    const injectedSpawn = ((_command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      const binaryIndex = args.indexOf(standin);
      const wrapper = spawn(
        process.execPath,
        ['-e', wrapperProgram, standin, ...args.slice(binaryIndex + 1)],
        options,
      );
      if (wrapper.pid !== undefined) wrapperPids.push(wrapper.pid);
      return wrapper;
    }) as typeof spawn;
    const killProcess = ((pid: number, signal?: NodeJS.Signals | number) => {
      recoverySignals.push({ pid, signal: signal ?? 'SIGTERM' });
      return process.kill(pid, signal);
    }) as typeof process.kill;
    const handle = await startOxigraphServer(startOpts(port, {
      memoryLimits: { maxMiB: 256 },
      platform: 'linux',
      io: {
        spawn: injectedSpawn,
        killProcess,
        findListenOwnerPid: async () => await fetchPid(port),
      },
    }));
    try {
      const pid1 = await fetchPid(port);
      expect(handle.requestRestart('client deadline fallback')).toBe(true);

      let pid2 = 0;
      for (let i = 0; i < 100; i++) {
        await sleep(100);
        try {
          pid2 = await fetchPid(port);
          if (pid2 && pid2 !== pid1) break;
        } catch {
          /* recovery is still in progress */
        }
      }
      expect(pid2, 'supervisor did not replace the scoped listener').toBeGreaterThan(0);
      expect(pid2).not.toBe(pid1);
      expect(wrapperPids[0]).toBeGreaterThan(0);
      expect(pid1).not.toBe(wrapperPids[0]);
      expect(recoverySignals).toContainEqual({ pid: pid1, signal: 'SIGKILL' });
      expect(recoverySignals.some((entry) => entry.pid === wrapperPids[0])).toBe(false);
    } finally {
      await handle.stop();
      // Failure-path cleanup if a regression orphaned the listener behind its wrapper.
      try {
        process.kill(await fetchPid(port), 'SIGKILL');
      } catch {
        /* port is already free */
      }
    }
  });

  it('does NOT restart after stop() — the port stays free past the backoff window', async () => {
    const port = await freePort();
    const handle = await startOxigraphServer(startOpts(port));
    expect(await portAnswers(port)).toBe(true);
    await handle.stop();
    expect(handle.getRecoveryState().recovering).toBe(true);
    expect(handle.requestRestart('after-stop')).toBe(false);
    // Wait well past restartBackoffMaxMs: a buggy supervisor would have
    // respawned by now and the probe would answer.
    await sleep(600);
    expect(await portAnswers(port)).toBe(false);
  });
});

const nativeOxigraphTestBinary = process.env.DKG_OXIGRAPH_TEST_BINARY;

describe.skipIf(!nativeOxigraphTestBinary)(
  'managed response completeness (pinned real Oxigraph executable)',
  () => {
    it('rejects native-deadline SELECT and CONSTRUCT streams instead of returning partial data', async () => {
      const binaryPath = nativeOxigraphTestBinary!;
      expect(await executableVersion(binaryPath)).toBe(`oxigraph ${OXIGRAPH_VERSION}`);

      const location = await mkdtemp(join(tmpdir(), 'oxi-native-timeout-'));
      const port = await freePort();
      const handle = await startOxigraphServer({
        binaryPath,
        location,
        port,
        queryTimeoutS: 1,
        readyTimeoutMs: 10_000,
        readyIntervalMs: 50,
        stopGraceMs: 2_000,
        restartBackoffBaseMs: 100,
        restartBackoffMaxMs: 200,
        log: () => {},
      });
      const endpoint = `http://127.0.0.1:${port}`;
      const store = createManagedOxigraphSparqlStoreV1({
        queryEndpoint: `${endpoint}/query`,
        updateEndpoint: `${endpoint}/update`,
        timeout: 10_000,
      });

      try {
        await store.insert(Array.from({ length: 100 }, (_, index) => ({
          subject: `urn:s${index}`,
          predicate: 'urn:p',
          object: `"${index}"`,
          graph: '',
        })));
        const expensivePattern = `
          ?a <urn:p> ?x .
          ?b <urn:p> ?y .
          ?c <urn:p> ?z .
          ?d <urn:p> ?w .
          FILTER(SHA512(CONCAT(STR(?a), STR(?b), STR(?c), STR(?d))) != "")
        `;

        await expect(store.query(
          `SELECT (COUNT(*) AS ?count) WHERE { ${expensivePattern} }`,
        )).rejects.toMatchObject({
          code: 'STORE_OPERATION_TIMEOUT',
          backend: 'oxigraph-server',
          operation: 'query',
          outcome: 'indeterminate',
        });
        await expect(store.query(
          `CONSTRUCT { ?a <urn:joined> ?b } WHERE { ${expensivePattern} }`,
        )).rejects.toMatchObject({
          code: 'STORE_OPERATION_TIMEOUT',
          backend: 'oxigraph-server',
          operation: 'construct',
          outcome: 'indeterminate',
        });
      } finally {
        await store.close();
        await handle.stop();
        await rm(location, { recursive: true, force: true });
      }
    }, 30_000);
  },
);

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
