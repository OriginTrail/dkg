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

export interface OxigraphServerIo {
  spawn: typeof spawn;
  fetch: typeof globalThis.fetch;
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
  /** Poll interval while waiting for readiness. */
  readyIntervalMs?: number;
  /** Grace period between SIGTERM and SIGKILL on stop. */
  stopGraceMs?: number;
  /** Base delay for restart backoff after an unexpected crash. */
  restartBackoffBaseMs?: number;
  /** Cap for restart backoff. */
  restartBackoffMaxMs?: number;
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

/**
 * Spawn and health-check a local Oxigraph server. Resolves once the
 * server answers an `ASK` probe; rejects if it never becomes ready within
 * `readyTimeoutMs` (the child is killed first so we don't leak it).
 */
export async function startOxigraphServer(
  opts: StartOxigraphServerOptions,
): Promise<OxigraphServerHandle> {
  const io: OxigraphServerIo = { spawn, fetch: globalThis.fetch, ...opts.io };
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

  let stopping = false;
  let ready = false;
  let child: ChildProcess | null = null;
  let restarts = 0;
  // Tail of the child's stderr, surfaced in the startup error so a bind
  // failure (`Address already in use`) is visible to the operator.
  let lastStderr = '';

  const spawnChild = (): ChildProcess => {
    const c = io.spawn(
      opts.binaryPath,
      ['serve', '--location', opts.location, '--bind', bind],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    c.stderr?.on('data', (b) => {
      const line = b.toString('utf-8').trim();
      if (line) {
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
      scheduleRevive(
        `server exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
      );
    });
    return c;
  };

  const childAlive = (): boolean =>
    child != null && child.exitCode === null && child.signalCode === null;

  const probeReady = async (): Promise<boolean> => {
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
      return res.ok;
    } catch {
      return false;
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
      if ((await probeReady()) && childAlive()) {
        ready = true;
        restarts = 0;
        log(`[oxigraph] server restarted and healthy on ${bind}.`);
        return;
      }
      await sleep(readyIntervalMs);
    }
    if (stopping) return;
    scheduleRevive(`respawned server did not become ready on ${bind}`);
  };

  // Synchronous best-effort kill for process-exit handlers (which can't
  // await): signals the child so a fatal `process.exit()` elsewhere in
  // boot doesn't orphan the server. Safe to call alongside `stop()`.
  const killSync = (): void => {
    stopping = true;
    try {
      if (childAlive()) child!.kill('SIGTERM');
    } catch {
      /* best-effort */
    }
  };

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
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

  log(`Starting Oxigraph server on ${bind} (location: ${opts.location})…`);
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
    if (await probeReady()) {
      // Only trust a 200 if the child WE spawned is the one still alive
      // and bound — guards the race where a foreign server answers while
      // our child has just died on EADDRINUSE.
      if (childAlive()) {
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
