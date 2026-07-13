/**
 * Supervised local Oxigraph server (Release 2, phase 2b lifecycle; used
 * opt-in in 2a via `store.backend: 'oxigraph-server'`).
 *
 * # What this is
 *
 * The DKG daemon spawns a single `oxigraph serve` child bound to
 * loopback, health-checks it before the agent boots, and restarts it
 * (with backoff) if it dies unexpectedly. The agent then talks to it over
 * the existing `sparql-http` adapter — this module owns only the child
 * process lifecycle, not the SPARQL traffic.
 *
 * Moving the triple store out of the in-process Oxigraph worker into this
 * external server is what buys MVCC concurrent reads (reads stop blocking
 * on the single writer) and incremental RocksDB persistence (no
 * O(total-triples) full-dump flush).
 *
 * # Security
 *
 * `oxigraph serve` has no native authentication (upstream documents auth
 * as an nginx-proxy concern). For a daemon-managed *local* server the
 * security boundary is therefore the loopback bind (`127.0.0.1`): the
 * endpoint is never exposed off-host. We do NOT send an Authorization
 * header to the managed server because it would be meaningless — the
 * `sparql-http` adapter's `auth` option remains for operators pointing at
 * their own externally-secured SPARQL endpoint.
 *
 * # Shutdown ordering
 *
 * The handle's `stop()` sets a `stopping` flag (so the exit handler does
 * NOT restart), sends SIGTERM, and escalates to SIGKILL after a grace
 * period. Callers must stop the server AFTER the agent has stopped
 * issuing store queries, so an in-flight SPARQL request never races a
 * killed child.
 *
 * `spawn`/`fetch` are injectable so unit tests exercise ready-polling,
 * crash-restart, and shutdown without launching a real binary.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { findListenOwnerPid } from './oxigraph-listen-port.js';
import {
  createOxigraphLaunchStrategy,
  type OxigraphMemoryLimits,
} from './oxigraph-launch-strategy.js';
import { invalidateExternalStoreQuadsCache } from './routes/status.js';
import {
  readCgroupOomSnapshot,
  readCgroupOomKill,
  type CgroupOomSnapshot,
} from './oxigraph-memory.js';

export interface OxigraphServerIo {
  spawn: typeof spawn;
  fetch: typeof globalThis.fetch;
  /**
   * Resolve the child/descendant PID that owns the listen socket (not merely
   * that something on the port returns HTTP 200).
   */
  findListenOwnerPid: (
    child: ChildProcess,
    port: number,
    host: string,
    ownership?: 'child-only' | 'process-tree',
  ) => Promise<number | null>;
  /** Best-effort cgroup OOM snapshot (dir + oom_kill) for a live pid. Injectable for tests. */
  readCgroupOomSnapshot: (pid: number) => CgroupOomSnapshot | null;
  /** Best-effort exit-time re-read of oom_kill from a captured cgroup dir. */
  readCgroupOomKill: (dir: string) => number | null;
}

export interface StartOxigraphServerOptions {
  /** Absolute path to the verified `oxigraph` binary. */
  binaryPath: string;
  /** RocksDB storage directory (`--location`). */
  location: string;
  /** Bind host. Always loopback in production; overridable for tests. */
  host?: string;
  /** Bind port. */
  port: number;
  log?: (msg: string) => void;
  /** Total time to wait for the server to answer before failing start. */
  readyTimeoutMs?: number;
  /** Native Oxigraph query timeout (`oxigraph serve --timeout-s`). */
  queryTimeoutS?: number;
  /** Poll interval while waiting for readiness. */
  readyIntervalMs?: number;
  /** Grace period between SIGTERM and SIGKILL on stop. */
  stopGraceMs?: number;
  /** Base delay for restart backoff after an unexpected crash. */
  restartBackoffBaseMs?: number;
  /** Cap for restart backoff. */
  restartBackoffMaxMs?: number;
  /** Optional finite limits for an isolated systemd user scope (Linux only). */
  memoryLimits?: OxigraphMemoryLimits;
  /** Runtime platform. Injectable so command construction is portable in tests. */
  platform?: NodeJS.Platform;
  /** Parent identity override for cross-platform systemd command tests. */
  parentIdentity?: string;
  io?: Partial<OxigraphServerIo>;
}

export interface OxigraphServerHandle {
  readonly host: string;
  readonly port: number;
  readonly queryEndpoint: string;
  readonly updateEndpoint: string;
  /** Stop the server and prevent further restarts. Idempotent. */
  stop(): Promise<void>;
  /**
   * Synchronous best-effort SIGTERM for `process.on('exit')` handlers
   * (which cannot await). Prevents orphaning the server when boot hits a
   * fatal `process.exit()` after the server started. Idempotent.
   */
  killSync(): void;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_READY_INTERVAL_MS = 500;
const DEFAULT_STOP_GRACE_MS = 5_000;
const DEFAULT_RESTART_BASE_MS = 1_000;
const DEFAULT_RESTART_MAX_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/**
 * Spawn and health-check a local Oxigraph server. Resolves once the
 * server answers an `ASK` probe; rejects if it never becomes ready within
 * `readyTimeoutMs` (the child is killed first so we don't leak it).
 */
export async function startOxigraphServer(
  opts: StartOxigraphServerOptions,
): Promise<OxigraphServerHandle> {
  const launchStrategy = createOxigraphLaunchStrategy({
    memoryLimits: opts.memoryLimits,
    platform: opts.platform ?? process.platform,
    parentPid: process.pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
    parentIdentity: opts.parentIdentity,
  });
  const ioOverrides = opts.io ?? {};
  const io: OxigraphServerIo = {
    spawn: ioOverrides.spawn ?? spawn,
    fetch: ioOverrides.fetch ?? globalThis.fetch,
    findListenOwnerPid: ioOverrides.findListenOwnerPid ?? findListenOwnerPid,
    readCgroupOomSnapshot: ioOverrides.readCgroupOomSnapshot ?? readCgroupOomSnapshot,
    readCgroupOomKill: ioOverrides.readCgroupOomKill ?? readCgroupOomKill,
  };
  const markStoreDown = (): void => {
    invalidateExternalStoreQuadsCache();
  };
  const log = opts.log ?? (() => {});
  const host = opts.host ?? DEFAULT_HOST;
  const { port } = opts;
  const bind = `${host}:${port}`;
  const base = `http://${host}:${port}`;
  const queryEndpoint = `${base}/query`;
  const updateEndpoint = `${base}/update`;
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const readyIntervalMs = opts.readyIntervalMs ?? DEFAULT_READY_INTERVAL_MS;
  const stopGraceMs = opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const restartBase = opts.restartBackoffBaseMs ?? DEFAULT_RESTART_BASE_MS;
  const restartMax = opts.restartBackoffMaxMs ?? DEFAULT_RESTART_MAX_MS;
  const queryTimeoutS = normalizePositiveInteger(opts.queryTimeoutS);

  let stopping = false;
  let ready = false;
  let child: ChildProcess | null = null;
  let restarts = 0;
  // Tail of the child's stderr, surfaced in the startup error so a bind
  // failure (`Address already in use`) is visible to the operator.
  let lastStderr = '';
  // Children whose `error` event fired (ENOENT/EACCES/loader mismatch): the
  // process never ran, so `exitCode`/`signalCode` stay null and would make
  // childAlive() wrongly report it alive. Track them so childAlive() and the
  // ready/revive loops treat a spawn error as a dead child.
  const erroredChildren = new WeakSet<ChildProcess>();
  const oomSnapshots = new WeakMap<ChildProcess, CgroupOomSnapshot>();

  const spawnChild = (): ChildProcess => {
    const args = ['serve', '--location', opts.location, '--bind', bind];
    if (queryTimeoutS !== undefined) args.push('--timeout-s', String(queryTimeoutS));
    const spawnSpec = launchStrategy.nextSpawnSpec(opts.binaryPath, args);
    const c = io.spawn(
      spawnSpec.command,
      spawnSpec.args,
      {
        stdio: spawnSpec.stdio ?? ['ignore', 'pipe', 'pipe'],
        ...(spawnSpec.environment
          ? { env: { ...process.env, ...spawnSpec.environment } }
          : {}),
      },
    );
    // Without this listener Node throws the `error` event as an uncaught
    // exception, killing the daemon. Route it through the normal
    // startup/revive failure path instead (the binary couldn't be executed).
    c.once('error', (err) => {
      erroredChildren.add(c);
      lastStderr = `${lastStderr}spawn error: ${(err as Error).message}\n`.slice(-1_000);
      log(`[oxigraph] failed to launch binary: ${(err as Error).message}`);
    });
    c.stderr?.on('data', (b) => {
      const line = b.toString('utf-8').trim();
      if (line) {
        launchStrategy.observeStderr(c, line);
        lastStderr = `${lastStderr}${line}\n`.slice(-1_000);
        log(`[oxigraph] ${line}`);
      }
    });
    c.once('exit', (code, signal) => {
      if (stopping) return;
      // Two cases land here with `ready === false` and must NOT (re)start:
      //   1. Startup-phase exit — usually a bind failure (the port is taken
      //      by another local SPARQL server). The ready loop observes the
      //      dead child and fails fast with the captured stderr.
      //   2. A respawned child that died while revive() was still
      //      re-validating ownership — revive() owns rescheduling in that
      //      window, so we must not double-schedule here.
      // Restarting on either would risk looping against a port we can't own,
      // and a foreign server answering there could be mistaken for ours.
      if (!ready) return;
      // We just lost a confirmed-healthy child. Drop `ready` immediately so
      // nothing treats the (now foreign-or-dead) endpoint as ours, then hand
      // off to revive(), which respawns and re-proves ownership before
      // restoring `ready`.
      ready = false;
      markStoreDown();
      // Best-effort OOM classification: `oom_kill` is cgroup-scoped, not
      // per-PID, so use an increment only as supporting evidence for a
      // SIGKILL-compatible child death. This catches MemoryMax/host OOM kills
      // without labelling unrelated non-SIGKILL exits as OOM.
      let oomNote = '';
      const oomSnapshot = oomSnapshots.get(c);
      if (launchStrategy.classifyOomExit({
        child: c,
        code,
        signal,
        snapshot: oomSnapshot,
        readOomKill: io.readCgroupOomKill,
      })) {
        oomNote = ', OOM-killed by cgroup memory cap (or host OOM)';
      }
      scheduleRevive(
        `server exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}${oomNote})`,
      );
    });
    return c;
  };

  const childAlive = (): boolean =>
    child != null &&
    !erroredChildren.has(child) &&
    child.exitCode === null &&
    child.signalCode === null;

  const captureOomSnapshotForListener = (c: ChildProcess, listenerPid: number): void => {
    if (oomSnapshots.has(c)) return;
    const snapshot = io.readCgroupOomSnapshot(listenerPid);
    if (snapshot) oomSnapshots.set(c, snapshot);
  };

  const probeReady = async (): Promise<number | null> => {
    const c = child;
    if (!c || !childAlive()) return null;
    try {
      const res = await io.fetch(queryEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-query',
          Accept: 'application/sparql-results+json',
        },
        body: 'ASK { ?s ?p ?o }',
        signal: AbortSignal.timeout(readyIntervalMs + 1_000),
      });
      if (!res.ok) return null;
      const listenerPid = await launchStrategy.resolveListenerPid(
        c,
        port,
        host,
        io.findListenOwnerPid,
      );
      return listenerPid !== null && childAlive() ? listenerPid : null;
    } catch {
      return null;
    }
  };

  // Schedule a supervised restart with capped exponential backoff. Used both
  // for a healthy child that crashed and for a revive attempt that couldn't
  // re-establish ownership, so a crash-looping binary (or a permanently-taken
  // port) never pegs the CPU.
  const scheduleRevive = (reason: string): void => {
    restarts += 1;
    const delay = Math.min(restartMax, restartBase * 2 ** (restarts - 1));
    log(`[oxigraph] ${reason}; restart #${restarts} in ${delay}ms`);
    setTimeout(() => {
      void revive();
    }, delay).unref?.();
  };

  // Respawn and re-validate ownership after a steady-state crash. Mirrors
  // the startup ownership guard: `ready` is restored ONLY once the child WE
  // spawned is confirmed to be the process answering on the port. If another
  // process grabbed the port during the downtime, the respawned child dies on
  // bind and we keep retrying with `ready` false — so the agent's store
  // queries surface honest errors rather than silently hitting a foreign
  // SPARQL server.
  const revive = async (): Promise<void> => {
    if (stopping) return;
    child = spawnChild();
    const reviveDeadline = Date.now() + readyTimeoutMs;
    while (Date.now() < reviveDeadline) {
      if (stopping) return;
      // Respawned child died (its own exit handler stays out of the way
      // because `ready` is false). Retry with backoff; never adopt whatever
      // may now be answering on the port.
      if (!childAlive()) break;
      const listenerPid = await probeReady();
      if (listenerPid !== null && childAlive()) {
        captureOomSnapshotForListener(child!, listenerPid);
        ready = true;
        restarts = 0;
        log(`[oxigraph] server restarted and healthy on ${bind}.`);
        return;
      }
      await sleep(readyIntervalMs);
    }
    if (stopping) return;
    // Timed out with the child still running but unresponsive. Kill it
    // before respawning — otherwise each retry stacks another live
    // `oxigraph serve`, and they fight over the port (self-inflicted
    // EADDRINUSE). Its exit handler won't restart (ready is false).
    if (childAlive()) {
      try {
        child!.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
    }
    scheduleRevive(`respawned server did not become ready on ${bind}`);
  };

  // Synchronous best-effort kill for process-exit handlers (which can't
  // await): signals the child so a fatal `process.exit()` elsewhere in
  // boot doesn't orphan the server. Safe to call alongside `stop()`.
  const killSync = (): void => {
    stopping = true;
    markStoreDown();
    try {
      if (childAlive()) child!.kill('SIGTERM');
    } catch {
      /* best-effort */
    }
  };

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    markStoreDown();
    const c = child;
    child = null;
    if (!c || c.exitCode !== null || c.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };
      c.once('exit', done);
      c.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (c.exitCode === null && c.signalCode === null) {
          log('[oxigraph] did not exit on SIGTERM; sending SIGKILL');
          c.kill('SIGKILL');
        }
      }, stopGraceMs);
      killTimer.unref?.();
    });
    log('[oxigraph] server stopped');
  };

  log(
    queryTimeoutS !== undefined
      ? `Starting Oxigraph server on ${bind} (location: ${opts.location}, query timeout: ${queryTimeoutS}s)…`
      : `Starting Oxigraph server on ${bind} (location: ${opts.location})…`,
  );
  const launchSummary = launchStrategy.logSummary();
  if (launchSummary) log(launchSummary);
  child = spawnChild();

  const deadline = Date.now() + readyTimeoutMs;
  let attempt = 0;
  let childDied = false;
  while (Date.now() < deadline) {
    attempt += 1;
    // Our spawned child exited during startup — almost always a bind
    // failure. Stop probing and fail fast; do NOT adopt whatever may be
    // answering on the port (it could be a foreign SPARQL server).
    if (!childAlive()) {
      childDied = true;
      break;
    }
    const listenerPid = await probeReady();
    if (listenerPid !== null) {
      // Only trust a 200 if the child WE spawned is the one still alive
      // and bound — guards the race where a foreign server answers while
      // our child has just died on EADDRINUSE.
      if (childAlive()) {
        captureOomSnapshotForListener(child!, listenerPid);
        ready = true;
        log(`Oxigraph server ready on ${bind} after ${attempt} probe(s).`);
        return { host, port, queryEndpoint, updateEndpoint, stop, killSync };
      }
      childDied = true;
      break;
    }
    await sleep(readyIntervalMs);
  }

  // Never became ready — stop the child so we don't leak it, then throw.
  await stop();
  const stderrHint = lastStderr.trim()
    ? ` Last server output:\n${lastStderr.trim()}`
    : '';
  throw new Error(
    childDied
      ? `Oxigraph server exited during startup on ${bind} ` +
        `(binary: ${opts.binaryPath}, location: ${opts.location}). ` +
        `The port may already be in use by another process.${stderrHint}`
      : `Oxigraph server did not become ready on ${bind} within ${readyTimeoutMs}ms ` +
        `(binary: ${opts.binaryPath}, location: ${opts.location}).${stderrHint}`,
  );
}
