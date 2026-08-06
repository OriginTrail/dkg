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
 * # Lifecycle state machine and the ownership lease (#2052 B2)
 *
 * Everything that can create, prove, or destroy a child runs as an
 * exclusive section of ONE lifecycle mutex, over an explicit state:
 *
 *     starting → ready ⇄ reviving/recovering → stopping → closed
 *
 * The mutex exists because these sections mutate the same three things —
 * `child`, `state`, and the ownership generation — and interleaving them is
 * exactly how a supervisor orphans a process: a `stop()` landing between a
 * revive's spawn and its ownership proof would leave an unsupervised
 * `oxigraph serve` holding the port with nobody left to kill it.
 *
 * Layered on top is a process-local ownership lease (see
 * `managed-oxigraph-ownership-v1-internal.ts` in `@origintrail-official/dkg-storage`).
 * A NEW child generation is bound at exactly one instant — when the child WE
 * spawned is proven to own the listen socket AND is still alive — and the
 * lease is invalidated the moment that stops being true. Downstream
 * capabilities that are only safe against a process this daemon owns
 * end-to-end (the system-record materializer) gate on that lease rather than
 * on forgeable config booleans like `managedByDkg`.
 *
 * The supervisor keeps the ownership CONTROLLER (the mutation authority) and
 * hands out only {@link OxigraphServerOwnershipV1} — lease + snapshot +
 * controlled recovery. Holding that lets a consumer ask whether the managed
 * child is live; it never lets them say that it is.
 *
 * # Shutdown ordering
 *
 * `stop()` and `killSync()` set a `terminating` flag BEFORE taking the mutex,
 * so an in-flight revive bails at its next checkpoint instead of running to
 * completion while `stop()` queues behind it. `terminating` is deliberately
 * separate from `closed`: `killSync()` marks the supervisor terminating
 * without closing it, so a later `stop()` still awaits the exit and escalates
 * to SIGKILL. (Conflating the two behind one `stopping` flag is what used to
 * make `killSync()` silently disarm the escalation in `stop()`.)
 *
 * Callers must stop the server AFTER the agent has stopped issuing store
 * queries, so an in-flight SPARQL request never races a killed child.
 *
 * `spawn`/`fetch` are injectable so unit tests exercise ready-polling,
 * crash-restart, ownership loss, and shutdown without launching a real binary.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  createManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphOwnershipLeaseV1,
  type ManagedOxigraphOwnershipSnapshotV1,
  type ManagedOxigraphSupervisorHandoffV1,
} from '@origintrail-official/dkg-storage';
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
  io?: Partial<OxigraphServerIo>;
}

/**
 * Read-only ownership surface handed to the rest of the daemon.
 *
 * Deliberately NARROWER than the `ManagedOxigraphOwnershipControllerV1` the
 * supervisor keeps: `bindReadyGeneration()` and `invalidate()` are absent, so
 * no consumer can mint or extend liveness. The lease is transported to the
 * storage adapter under a symbol key (see `attachManagedOxigraphLeaseV1`), and
 * its meaning lives in a module-private table in the storage package — a
 * structurally identical object, a `structuredClone`, or anything that
 * survived `JSON.stringify` resolves to nothing.
 */
export interface OxigraphServerOwnershipV1 {
  /** Opaque live lease. Compare by identity only; carries no readable data. */
  readonly lease: ManagedOxigraphOwnershipLeaseV1;
  /** Current child generation, liveness, and terminality. */
  snapshot(): ManagedOxigraphOwnershipSnapshotV1;
  /**
   * Drive the supervisor to a proven-ready child generation, given the
   * generation the caller last observed.
   *
   * - STALE expected (lower than current): returns the newer generation
   *   WITHOUT restarting anything — a second holder that noticed the same
   *   outage must not tear down the replacement the first holder already got.
   * - Same generation, still live: returns it unchanged (the caller's view was
   *   stale, not the child).
   * - Same generation, not live: performs exactly ONE respawn+re-prove cycle;
   *   concurrent callers with the same expected generation share it.
   * - Terminal lease, unknown (higher) generation, or a failed recovery:
   *   rejects. Callers must fail closed, never assume capability.
   */
  recoverGeneration(expectedGeneration: string): Promise<string>;
}

export interface OxigraphServerHandle {
  readonly host: string;
  readonly port: number;
  readonly queryEndpoint: string;
  readonly updateEndpoint: string;
  /** Live ownership view for capability gating (#2052 B2). */
  readonly ownership: OxigraphServerOwnershipV1;
  /**
   * The supervisor's half of the system-record lane's clean-generation handoff
   * (#2052 B2): retire the owned child with a PROVEN port release, then bind a
   * replacement generation.
   *
   * Kept off {@link OxigraphServerOwnershipV1} on purpose — that view is
   * read-only, whereas this can kill and replace the child. Only the managed
   * store composition receives it.
   */
  readonly supervisorHandoff: ManagedOxigraphSupervisorHandoffV1;
  /** Stop the server and prevent further restarts. Idempotent. */
  stop(): Promise<void>;
  /**
   * Synchronous best-effort SIGTERM for `process.on('exit')` handlers
   * (which cannot await). Prevents orphaning the server when boot hits a
   * fatal `process.exit()` after the server started. Idempotent, and — unlike
   * the retired single-flag version — does NOT disarm a later `stop()`.
   */
  killSync(): void;
}

/**
 * Explicit supervisor phases. Every transition happens inside the lifecycle
 * mutex, so a reader inside an exclusive section sees a stable value.
 *
 * `reviving` covers the whole window from "a proven child died" to "a new
 * generation is bound", including the armed backoff timer — during it the
 * store is honestly down. `recovering` is the same work driven by a caller
 * through {@link OxigraphServerOwnershipV1.recoverGeneration} rather than by
 * the backoff timer, kept distinct so the two are not mistaken for each other
 * in diagnostics.
 */
type OxigraphLifecycleState =
  | 'starting'
  | 'ready'
  | 'reviving'
  | 'recovering'
  | 'stopping'
  | 'closed';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_READY_INTERVAL_MS = 500;
const DEFAULT_STOP_GRACE_MS = 5_000;
const DEFAULT_RESTART_BASE_MS = 1_000;
const DEFAULT_RESTART_MAX_MS = 30_000;
/**
 * Bounded re-probes of the bind after the child exits.
 *
 * The common case — the port is genuinely free — costs one refused connection
 * and no sleeping at all.
 *
 * The worst case is NOT `stopGraceMs`, and it is worth stating honestly because
 * `stopGraceMs` is what an operator would reach for when tuning a shutdown
 * timeout. Each probe may take up to `readyIntervalMs + 1000` = 1.5 s and they
 * are separated by `floor(stopGraceMs / attempts)`, so five attempts is up to
 * ~11.5 s, on top of `stopGraceMs` for the SIGTERM/SIGKILL wait and the bounded
 * `resolveListenOwner` lookup (~6 s on Unix across the ss/lsof/fuser fallbacks,
 * ~3 s on Windows). Worst case is therefore ~22-25 s, inside the teardown step.
 *
 * That time is only ever spent while something is STILL SERVING our bind after
 * our own child exited — precisely the leaked-descendant or foreign-listener
 * case where guessing "released" would be worse than waiting. A cheaper probe
 * would buy speed by producing more false "released" verdicts, which is the
 * wrong trade for something whose whole job is to be a proof. There is no
 * durability exposure: probing begins only after the child has exited, so
 * RocksDB is already closed and a hard kill at an outer deadline costs a log
 * line rather than the store.
 */
const PORT_RELEASE_PROBE_ATTEMPTS = 5;
/** Sentinel for "no generation has ever been bound on this lease". */
const UNBOUND_GENERATION = '0';

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/**
 * Parse a caller-supplied generation. The lease mints canonical decimal
 * strings; anything else (padded, negative, hex, empty) is a caller bug and
 * must not be silently coerced into a valid comparison.
 */
function parseGeneration(value: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(
      `Invalid managed Oxigraph child generation ${JSON.stringify(value)}; ` +
        'expected a canonical decimal string minted by the ownership lease',
    );
  }
  return BigInt(value);
}

/**
 * Spawn and health-check a local Oxigraph server. Resolves once the
 * server answers an `ASK` probe AND the child we spawned is proven to own
 * the listen socket; rejects if that never happens within `readyTimeoutMs`
 * (the child is killed first so we don't leak it).
 */
export async function startOxigraphServer(
  opts: StartOxigraphServerOptions,
): Promise<OxigraphServerHandle> {
  const launchStrategy = createOxigraphLaunchStrategy({
    memoryLimits: opts.memoryLimits,
    platform: opts.platform ?? process.platform,
    parentPid: process.pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
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

  /**
   * Mutation authority for the ownership lease. Created here and NEVER handed
   * out: consumers get {@link OxigraphServerOwnershipV1}, which can read the
   * lease but not mint one.
   */
  const ownership = createManagedOxigraphOwnershipControllerV1();

  let state: OxigraphLifecycleState = 'starting';
  /**
   * Eager "no new children, ever" signal, set the moment `stop()`/`killSync()`
   * is CALLED — before the lifecycle mutex is acquired — so an in-flight
   * revive bails at its next checkpoint instead of running a full spawn cycle
   * while `stop()` waits its turn.
   *
   * Kept separate from `state === 'closed'` on purpose: `killSync()` marks the
   * supervisor terminating without closing it, so a subsequent `stop()` still
   * awaits the exit and escalates to SIGKILL.
   */
  let terminating = false;
  /**
   * `none` — ordinary supervision. `retired` — a lane handoff has proven the
   * owned child dead and is expected to bind the replacement itself.
   *
   * While `retired`, NOTHING else may create a child: the automatic backoff
   * stays disarmed and `recoverGeneration()` refuses. Otherwise a revive could
   * slip into the window BETWEEN the handoff's two halves (the mutex is
   * released there) and bind a generation the lane never asked for, over a port
   * the lane still believes is free.
   */
  let handoffPhase: 'none' | 'retired' = 'none';
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

  // ---------------------------------------------------------------------
  // Lifecycle mutex
  // ---------------------------------------------------------------------

  /**
   * One promise chain serialises every exclusive section. Sections are chained
   * on SETTLE rather than on success: a rejected startup or recovery must not
   * deadlock every later `stop()` behind it.
   */
  let lifecycleTail: Promise<unknown> = Promise.resolve();
  const runExclusive = <T>(section: () => Promise<T>): Promise<T> => {
    const run = lifecycleTail.then(section, section);
    lifecycleTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // ---------------------------------------------------------------------
  // Restart timer (single, always cancellable)
  // ---------------------------------------------------------------------

  // The retired implementation dropped this handle on the floor, so an armed
  // backoff could never be cancelled — only talked out of running. Tracking it
  // lets `stop()` and a controlled recovery genuinely disarm the restart.
  let reviveTimer: ReturnType<typeof setTimeout> | null = null;
  const clearReviveTimer = (): void => {
    if (reviveTimer === null) return;
    clearTimeout(reviveTimer);
    reviveTimer = null;
  };

  // ---------------------------------------------------------------------
  // Child process primitives
  // ---------------------------------------------------------------------

  const childAlive = (): boolean =>
    child != null &&
    !erroredChildren.has(child) &&
    child.exitCode === null &&
    child.signalCode === null;

  /**
   * Signal the CURRENTLY TRACKED child. This is the only way this module ever
   * sends a signal: we never signal a pid we merely observed on the port, only
   * a `ChildProcess` object we created. A resolved listener pid is evidence,
   * never a kill target.
   */
  const signalTrackedChild = (signal: NodeJS.Signals): void => {
    if (!childAlive()) return;
    try {
      child!.kill(signal);
    } catch {
      /* best-effort */
    }
  };

  const captureOomSnapshotForListener = (c: ChildProcess, listenerPid: number): void => {
    if (oomSnapshots.has(c)) return;
    const snapshot = io.readCgroupOomSnapshot(listenerPid);
    if (snapshot) oomSnapshots.set(c, snapshot);
  };

  const spawnChild = (): ChildProcess => {
    // Hard invariant, not a convenience check: no code path may create a
    // process once shutdown has begun. Every caller already checks; this is
    // the last line of defence so a future edit cannot reintroduce an
    // orphaned `oxigraph serve` that outlives the daemon.
    if (terminating || state === 'closed') {
      throw new Error('Refusing to spawn a managed Oxigraph child after shutdown began');
    }
    const args = ['serve', '--location', opts.location, '--bind', bind];
    if (queryTimeoutS !== undefined) args.push('--timeout-s', String(queryTimeoutS));
    const spawnSpec = launchStrategy.nextSpawnSpec(opts.binaryPath, args);
    const c = io.spawn(
      spawnSpec.command,
      spawnSpec.args,
      {
        stdio: ['ignore', 'pipe', 'pipe'],
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
      // Only the child we CURRENTLY supervise carries liveness. A stale exit —
      // an unowned child we reaped just before respawning, or the child
      // `stop()` already detached — must never invalidate the newer, healthy
      // generation that replaced it. The exit event is delivered a tick later
      // than the kill, so without this the reaped predecessor could revoke its
      // own successor's capability.
      if (c !== child) return;
      // Shutdown already recorded the authoritative reason ('stop'); the exit
      // it is waiting for is not new information.
      if (terminating) return;
      // The child we own is gone. Record it before the phase check below so
      // the lease stays honest even for a startup-phase or revive-window
      // death, where nothing was ever bound to lose.
      ownership.invalidate('child-exit');
      // Two cases land here outside the `ready` phase and must NOT (re)start:
      //   1. Startup-phase exit — usually a bind failure (the port is taken
      //      by another local SPARQL server). The ready loop observes the
      //      dead child and fails fast with the captured stderr.
      //   2. A respawned child that died while a revive was still
      //      re-validating ownership — that loop owns rescheduling in the
      //      window, so we must not double-schedule here.
      // Restarting on either would risk looping against a port we can't own,
      // and a foreign server answering there could be mistaken for ours.
      if (state !== 'ready') return;
      // We just lost a confirmed-healthy child. Leave `ready` immediately so
      // nothing treats the (now foreign-or-dead) endpoint as ours, then hand
      // off to the backoff, which respawns and re-proves ownership before
      // binding a new generation.
      state = 'reviving';
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

  // ---------------------------------------------------------------------
  // Readiness / ownership probes
  // ---------------------------------------------------------------------

  /**
   * "Something is serving SPARQL on our bind."
   *
   * Deliberately NOT evidence of ownership — a foreign local SPARQL server
   * answers this identically, which is the whole reason `probeReady()` exists.
   * Used as the cheap first half of the readiness probe, and on the stop path
   * as the port-release probe (there, an answer is bad news).
   */
  const endpointAnswers = async (): Promise<boolean> => {
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

  /**
   * Resolve the pid owning the listener, restricted to the process tree of
   * `c`. Fails closed: `null` means "not provably ours", which includes the
   * case where `c` has already exited.
   */
  const resolveListenOwner = async (c: ChildProcess): Promise<number | null> => {
    try {
      return await launchStrategy.resolveListenerPid(c, port, host, io.findListenOwnerPid);
    } catch {
      return null;
    }
  };

  const probeReady = async (): Promise<number | null> => {
    const c = child;
    if (!c || !childAlive()) return null;
    if (!(await endpointAnswers())) return null;
    const listenerPid = await resolveListenOwner(c);
    return listenerPid !== null && childAlive() ? listenerPid : null;
  };

  /**
   * The ONE place a child generation is ever bound.
   *
   * Both the startup loop and the revive loop funnel through here at the same
   * instant: the process WE spawned is the proven owner of the listen socket
   * AND is still alive. Binding any earlier — at spawn, or on a bare HTTP 200
   * — would hand capability to a child that may be dying on EADDRINUSE while a
   * foreign SPARQL server answers on the port.
   */
  const bindProvenGeneration = (c: ChildProcess, listenerPid: number): string => {
    captureOomSnapshotForListener(c, listenerPid);
    state = 'ready';
    restarts = 0;
    return ownership.bindReadyGeneration();
  };

  // ---------------------------------------------------------------------
  // Revive (automatic, backoff-driven) and recovery (caller-driven)
  // ---------------------------------------------------------------------

  /**
   * Arm a supervised restart with capped exponential backoff. Used both for a
   * healthy child that crashed and for a revive attempt that couldn't
   * re-establish ownership, so a crash-looping binary (or a permanently-taken
   * port) never pegs the CPU.
   */
  const scheduleRevive = (reason: string): void => {
    // Never arm a restart once shutdown has begun, or while a lane handoff owns
    // the replacement.
    if (terminating || state === 'closed' || handoffPhase === 'retired') return;
    restarts += 1;
    const delay = Math.min(restartMax, restartBase * 2 ** (restarts - 1));
    log(`[oxigraph] ${reason}; restart #${restarts} in ${delay}ms`);
    state = 'reviving';
    clearReviveTimer();
    const timer = setTimeout(() => {
      // A timer that has already fired cannot be cancelled, so clearing the
      // handle is not on its own sufficient. Re-check identity (superseded or
      // disarmed) and shutdown state from inside the callback: together with
      // the guard in `spawnChild()` this makes "no child can be created after
      // close" hold even for a callback that was already queued.
      if (reviveTimer !== timer) return;
      reviveTimer = null;
      if (terminating || state === 'closed') return;
      void runExclusive(reviveLocked).catch((err: unknown) => {
        log(`[oxigraph] restart attempt failed: ${(err as Error).message}`);
      });
    }, delay);
    timer.unref?.();
    reviveTimer = timer;
  };

  /**
   * Respawn and re-validate ownership after a lost child. Runs as an exclusive
   * section. Mirrors the startup ownership guard: a generation is bound ONLY
   * once the child WE spawned is confirmed to be the process answering on the
   * port. If another process grabbed the port during the downtime, the
   * respawned child dies on bind and we keep retrying with no live generation
   * — so the agent's store queries surface honest errors rather than silently
   * hitting a foreign SPARQL server.
   */
  const reviveLocked = async (): Promise<void> => {
    // `ready` here means a concurrent path already restored the store; a
    // second respawn would kill a healthy child for nothing.
    if (terminating || state === 'closed' || state === 'ready') return;
    // Entering a revive is itself a liveness loss for anything still holding
    // the previous generation: even if the respawn succeeds immediately, the
    // generation it binds is a NEW one and the old lease must not survive.
    ownership.invalidate('child-revive');
    markStoreDown();
    // Reap a child that is alive but not proven-owned (ownership lost, or a
    // caller-driven recovery) before spawning again — otherwise the two fight
    // over the port and we inflict EADDRINUSE on ourselves. Its exit event is
    // ignored by the `c !== child` guard once we replace `child` below.
    signalTrackedChild('SIGKILL');
    child = spawnChild();

    const reviveDeadline = Date.now() + readyTimeoutMs;
    while (Date.now() < reviveDeadline) {
      if (terminating) return;
      // Respawned child died (its own exit handler stays out of the way
      // because we are not in the `ready` phase). Retry with backoff; never
      // adopt whatever may now be answering on the port.
      if (!childAlive()) break;
      const listenerPid = await probeReady();
      if (listenerPid !== null && childAlive()) {
        const generation = bindProvenGeneration(child!, listenerPid);
        log(`[oxigraph] server restarted and healthy on ${bind} (generation ${generation}).`);
        return;
      }
      await sleep(readyIntervalMs);
    }
    if (terminating) return;
    // Timed out with the child still running but unresponsive. Kill it
    // before respawning — otherwise each retry stacks another live
    // `oxigraph serve`, and they fight over the port (self-inflicted
    // EADDRINUSE). Its exit handler won't restart (we are not `ready`).
    signalTrackedChild('SIGKILL');
    scheduleRevive(`respawned server did not become ready on ${bind}`);
  };

  /**
   * In-flight caller-driven recovery, so every holder that observed the SAME
   * broken generation shares one respawn instead of queueing N of them behind
   * the mutex. Cleared when the shared promise settles.
   */
  let inFlightRecovery: { expected: string; promise: Promise<string> } | null = null;

  const recoverLocked = async (expectedGeneration: string): Promise<string> => {
    if (terminating || state === 'closed') {
      throw new Error(
        `Managed Oxigraph supervisor is shutting down; generation ${expectedGeneration} ` +
          'cannot be recovered',
      );
    }
    const before = ownership.snapshot();
    if (before.terminal) {
      throw new Error(
        `Managed Oxigraph ownership is terminal (${before.lastInvalidation}); ` +
          `generation ${expectedGeneration} cannot be recovered`,
      );
    }
    // Re-check under the lock. A backoff revive may have completed while this
    // call waited its turn, in which case a newer proven generation already
    // exists and restarting again would be pure churn — the same stampede the
    // stale-generation fast path avoids, just discovered later.
    if (before.childGeneration !== expectedGeneration || before.ready) {
      return before.childGeneration;
    }
    // A lane handoff retired the child and owns the replacement. Reviving here
    // would bind a generation the lane did not ask for, over the port it is
    // about to start into — refuse rather than race it.
    if (handoffPhase === 'retired') {
      throw new Error(
        `Managed Oxigraph is mid clean-generation handoff; generation ` +
          `${expectedGeneration} cannot be recovered until the replacement binds`,
      );
    }
    state = 'recovering';
    // Take over from any armed backoff: the restart happens now, and the
    // superseded timer is disarmed so it cannot spawn a second child behind us.
    clearReviveTimer();
    await reviveLocked();
    const after = ownership.snapshot();
    if (!after.ready || after.childGeneration === expectedGeneration) {
      throw new Error(
        `Managed Oxigraph could not bind a child generation newer than ` +
          `${expectedGeneration} on ${bind}`,
      );
    }
    return after.childGeneration;
  };

  const recoverGeneration = (expectedGeneration: string): Promise<string> => {
    let expected: bigint;
    try {
      expected = parseGeneration(expectedGeneration);
    } catch (err) {
      return Promise.reject(err as Error);
    }
    const snapshot = ownership.snapshot();
    if (snapshot.terminal) {
      return Promise.reject(new Error(
        `Managed Oxigraph ownership is terminal (${snapshot.lastInvalidation}); ` +
          `generation ${expectedGeneration} cannot be recovered`,
      ));
    }
    const current = BigInt(snapshot.childGeneration);
    // A generation we never minted cannot be recovered TO: fail closed rather
    // than restart on a caller's bad bookkeeping.
    if (expected > current) {
      return Promise.reject(new Error(
        `Managed Oxigraph child generation ${expectedGeneration} was never bound ` +
          `(current generation is ${snapshot.childGeneration})`,
      ));
    }
    // STALE. A newer generation already exists, so this caller's outage has
    // already been recovered by someone else. Restarting here would destroy a
    // healthy child and revoke the very generation the newer holders are
    // using — a recovery stampede that gets worse with each holder. Hand back
    // the current generation; whether IT is live is a question the lease
    // answers, not this call.
    if (expected < current) return Promise.resolve(snapshot.childGeneration);
    // Same generation and still live: the caller's view was stale, not the
    // child. Nothing to restart.
    if (snapshot.ready) return Promise.resolve(snapshot.childGeneration);
    const existing = inFlightRecovery;
    if (existing !== null && existing.expected === expectedGeneration) return existing.promise;
    const promise = runExclusive(() => recoverLocked(expectedGeneration)).finally(() => {
      // Only clear our own entry: a later recovery for a different generation
      // may already have taken the slot.
      if (inFlightRecovery?.promise === promise) inFlightRecovery = null;
    });
    inFlightRecovery = { expected: expectedGeneration, promise };
    return promise;
  };

  // ---------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------

  /**
   * Prove the bind is free again after our child exited.
   *
   * A stopped supervisor must be able to say whether the port it owned was
   * genuinely released. If something still serves SPARQL there, we cannot
   * distinguish "our child leaked a descendant that still holds the socket"
   * from "a foreign server took the bind over" — `findListenOwnerPid` fails
   * closed on an exited child, so it can no longer attribute the listener to
   * us. Either way the answer is the same and it is not "released": the lease
   * goes TERMINAL with `port-release-unproven` rather than merely `shutdown`,
   * so managed-store capability can never be revived against a socket we do
   * not own.
   *
   * We only ever PROBE here. No pid observed on the port is ever signalled —
   * every kill in this module goes through the tracked `ChildProcess`.
   */
  const proveManagedPortRelease = async (exited: ChildProcess | null): Promise<boolean> => {
    const interval = Math.max(1, Math.floor(stopGraceMs / PORT_RELEASE_PROBE_ATTEMPTS));
    for (let attempt = 1; attempt <= PORT_RELEASE_PROBE_ATTEMPTS; attempt += 1) {
      // Nothing serves SPARQL on our bind any more: released, proven.
      if (!(await endpointAnswers())) return true;
      if (attempt === PORT_RELEASE_PROBE_ATTEMPTS) break;
      await sleep(interval);
    }
    const owner = exited === null ? null : await resolveListenOwner(exited);
    log(
      `[oxigraph] ${bind} is still served after the managed child exited ` +
        `(${owner === null
          ? 'listener is NOT attributable to a process we spawned'
          : `listener still owned by pid ${owner}`}). ` +
        'Port release could not be proven; managed-store ownership is now terminal.',
    );
    ownership.invalidate('port-release-unproven');
    return false;
  };

  /** SIGTERM, escalating to SIGKILL after `stopGraceMs`, resolving on exit. */
  const awaitChildExit = async (c: ChildProcess): Promise<void> => {
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
  };

  /**
   * Eager, pre-lock half of shutdown: disarm restarts NOW so nothing spawns
   * while the exclusive stop section queues behind an in-flight revive.
   */
  const beginTermination = (): void => {
    terminating = true;
    clearReviveTimer();
  };

  const stopLocked = async (): Promise<void> => {
    if (state === 'closed') return; // idempotent
    state = 'stopping';
    ownership.invalidate('stop');
    markStoreDown();
    clearReviveTimer();
    const c = child;
    child = null;
    // Only a child we actually proved ownership of gives us a port to account
    // for. A startup that never bound a generation (bind failure: the port was
    // someone else's from the first probe) has no release to prove, and
    // charging it `stopGraceMs` of probing would just slow every failed boot.
    const provedOwnership = ownership.snapshot().childGeneration !== UNBOUND_GENERATION;
    if (c && c.exitCode === null && c.signalCode === null) {
      await awaitChildExit(c);
      log('[oxigraph] server stopped');
    }
    // Unlike the lane handoff below, `stop()` does not THROW on an unproven
    // release. It is called from `finally` blocks and process teardown, where a
    // rejection would mask the original error; the terminal lease and the log
    // above are the signal. Nothing can bind a replacement after close anyway.
    if (provedOwnership) await proveManagedPortRelease(c);
    // `shutdown` must not paper over a more specific terminal reason:
    // `port-release-unproven` is the one an operator needs to see, and both
    // are equally terminal, so the first one wins.
    if (!ownership.snapshot().terminal) ownership.invalidate('shutdown');
    state = 'closed';
  };

  const stop = async (): Promise<void> => {
    beginTermination();
    await runExclusive(stopLocked);
  };

  /**
   * Synchronous best-effort kill for process-exit handlers (which can't
   * await): signals the child so a fatal `process.exit()` elsewhere in boot
   * doesn't orphan the server.
   *
   * Marks the supervisor terminating but NOT closed, so a later `stop()` still
   * runs its full section — awaiting the exit, escalating to SIGKILL, and
   * proving port release. The retired single-`stopping`-flag version made
   * `stop()` return at its idempotency guard instead, silently disarming the
   * escalation this call cannot perform itself.
   */
  const killSync = (): void => {
    beginTermination();
    markStoreDown();
    if (!ownership.snapshot().terminal) ownership.invalidate('stop');
    signalTrackedChild('SIGTERM');
  };

  // ---------------------------------------------------------------------
  // Clean-generation handoff for the system-record lane (#2052 B2)
  // ---------------------------------------------------------------------

  /**
   * Retire the owned child so a replacement can be bound cleanly.
   *
   * This is NOT `stop()`. `stop()` closes the supervisor for good; this leaves
   * it open and expects `startCleanGenerationLocked()` to follow. The critical
   * difference is the failure mode: an unproven port release here REJECTS,
   * because the caller is about to bind a replacement and doing that over a
   * listener we cannot account for is exactly the adoption hazard the lease
   * exists to prevent. Resolving quietly would let the lane proceed against a
   * foreign server.
   */
  const retireOwnedChildLocked = async (): Promise<void> => {
    if (terminating || state === 'closed') {
      throw new Error(
        'Managed Oxigraph supervisor is shutting down; the owned child cannot be retired',
      );
    }
    const before = ownership.snapshot();
    if (before.terminal) {
      throw new Error(
        `Managed Oxigraph ownership is terminal (${before.lastInvalidation}); ` +
          'the owned child cannot be retired for a clean generation',
      );
    }
    state = 'recovering';
    // Disarm automatic supervision for the WHOLE handoff window. The lane owns
    // the replacement; a backoff firing between the two halves would bind a
    // generation nobody asked for, against a port the lane believes is free.
    clearReviveTimer();
    ownership.invalidate('stop');
    markStoreDown();
    const c = child;
    // Detach FIRST so the exit we are about to cause cannot be read as a crash
    // and schedule a restart behind us.
    child = null;
    if (c && c.exitCode === null && c.signalCode === null) {
      await awaitChildExit(c);
    }
    if (!(await proveManagedPortRelease(c))) {
      throw new Error(
        `Managed Oxigraph could not prove ${bind} was released after retiring the child; ` +
          'managed-store capability is now terminal',
      );
    }
    handoffPhase = 'retired';
  };

  /**
   * Bind a replacement generation after a proven-dead predecessor.
   *
   * Refuses unless a retire actually completed: without that proof the lane
   * would be starting a child over a socket whose previous owner is unaccounted
   * for, which is the one thing the whole handoff exists to rule out.
   */
  const startCleanGenerationLocked = async (): Promise<void> => {
    if (terminating || state === 'closed') {
      throw new Error(
        'Managed Oxigraph supervisor is shutting down; no clean generation can be bound',
      );
    }
    const before = ownership.snapshot();
    if (before.terminal) {
      throw new Error(
        `Managed Oxigraph ownership is terminal (${before.lastInvalidation}); ` +
          'no clean generation can be bound',
      );
    }
    if (handoffPhase !== 'retired') {
      throw new Error(
        'Managed Oxigraph clean-generation start requires a proven-dead predecessor; ' +
          'stopAndProveOwnedChildDead() has not completed',
      );
    }
    state = 'recovering';
    child = spawnChild();
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (terminating) break;
      if (!childAlive()) break;
      const listenerPid = await probeReady();
      if (listenerPid !== null && childAlive()) {
        handoffPhase = 'none';
        const generation = bindProvenGeneration(child!, listenerPid);
        log(`[oxigraph] clean child generation ${generation} bound on ${bind}.`);
        return;
      }
      await sleep(readyIntervalMs);
    }
    // The lane's replacement could not be proven. Reap the unproven child and
    // hand the node back to ORDINARY supervision: a lane that abandons the
    // handoff here must not leave the store permanently childless. The backoff
    // may later bind a generation of its own, which the lane observes as the
    // ordinary stale-generation case.
    signalTrackedChild('SIGKILL');
    handoffPhase = 'none';
    scheduleRevive(`clean-generation start did not become ready on ${bind}`);
    throw new Error(
      `Managed Oxigraph could not prove a clean child generation on ${bind} ` +
        `within ${readyTimeoutMs}ms`,
    );
  };

  /**
   * The supervisor's half of the lane handoff.
   *
   * Deliberately NOT part of {@link OxigraphServerOwnershipV1}: that view is
   * read-only by design, while this can kill and replace the child. It is handed
   * to exactly one consumer — the managed store composition — and travels to the
   * adapter under a symbol key, so it can never be persisted or reconstructed
   * from config.
   */
  const supervisorHandoff: ManagedOxigraphSupervisorHandoffV1 = Object.freeze({
    stopAndProveOwnedChildDead: () => runExclusive(retireOwnedChildLocked),
    startAndProveCleanGeneration: () => runExclusive(startCleanGenerationLocked),
  });

  // ---------------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------------

  const startupLocked = async (): Promise<void> => {
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
          const generation = bindProvenGeneration(child!, listenerPid);
          log(
            `Oxigraph server ready on ${bind} after ${attempt} probe(s) ` +
              `(generation ${generation}).`,
          );
          return;
        }
        childDied = true;
        break;
      }
      await sleep(readyIntervalMs);
    }

    // Never became ready — stop the child so we don't leak it, then throw.
    // Runs the stop section INLINE: we already hold the mutex, so going
    // through `stop()` would deadlock behind ourselves.
    beginTermination();
    await stopLocked();
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
  };

  await runExclusive(startupLocked);

  const ownershipView: OxigraphServerOwnershipV1 = Object.freeze({
    lease: ownership.lease,
    snapshot: () => ownership.snapshot(),
    recoverGeneration,
  });

  return {
    host,
    port,
    queryEndpoint,
    updateEndpoint,
    ownership: ownershipView,
    supervisorHandoff,
    stop,
    killSync,
  };
}
