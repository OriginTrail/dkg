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
import {
  formatWalBytes,
  measureRetainedWalBytes,
  resolveWalAwareReadyTimeoutMs,
} from './oxigraph-wal.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { findListenOwnerPid } from './oxigraph-listen-port.js';
import {
  createOxigraphLaunchStrategy,
  type OxigraphLaunchHandle,
  type OxigraphMemoryLimits,
} from './oxigraph-launch-strategy.js';
import { invalidateExternalStoreQuadsCache } from './store-quads-cache.js';
import { OXIGRAPH_STOP_GRACE_MS } from './oxigraph-parent-watchdog.js';
import {
  oxigraphStoreArgs,
  type OxigraphStoreLaunch,
  type OxigraphStoreLaunchOutcome,
  type OxigraphStoreOwnership,
} from './oxigraph-store-launch.js';
import { describeStoreHold, type StoreHold } from './oxigraph-reclaim-policy.js';
import {
  createOxigraphStoreOwnership,
  type OxigraphStoreOwnershipInput,
} from './oxigraph-store-ownership.js';
import {
  readCgroupOomSnapshot,
  readCgroupOomKill,
  type CgroupOomSnapshot,
} from './oxigraph-memory.js';

export interface OxigraphServerIo {
  spawn: typeof spawn;
  fetch: typeof globalThis.fetch;
  /** Signal a listener PID after ownership has been re-verified. Injectable for safety tests. */
  killProcess: typeof process.kill;
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
  /**
   * Base of the automatic WAL-aware readiness deadline (GH#1400). Production
   * default is DEFAULT_READY_TIMEOUT_MS; exposed as a test seam. Deliberately
   * NOT read from `store.options` — operators configure `readyTimeoutMs`,
   * which overrides the automatic sizing entirely.
   */
  autoReadyBaseTimeoutMs?: number;
  /** Progress-log cadence while a retained WAL is opening. Test seam. */
  progressLogIntervalMs?: number;
  /** Base delay for restart backoff after an unexpected crash. */
  restartBackoffBaseMs?: number;
  /** Cap for restart backoff. */
  restartBackoffMaxMs?: number;
  /** Optional finite limits for an isolated systemd user scope (Linux only). */
  memoryLimits?: OxigraphMemoryLimits;
  /** Runtime platform. Injectable so command construction is portable in tests. */
  platform?: NodeJS.Platform;
  /**
   * Build the store ownership for this start: the orphan reclaim before each
   * spawn and the owner record of each launch. The default knows only
   * `binaryPath`; the managed layer builds one with the reclaim catalog of
   * the binary it resolved, and lifecycle tests supply their own.
   */
  storeOwnership?: (input: OxigraphStoreOwnershipInput) => OxigraphStoreOwnership;
  io?: Partial<OxigraphServerIo>;
}

export interface OxigraphServerHandle {
  readonly host: string;
  readonly port: number;
  readonly queryEndpoint: string;
  readonly updateEndpoint: string;
  /**
   * Terminate an unhealthy managed server and let the existing supervisor
   * respawn it. Returns false when shutdown/recovery is already in progress;
   * accepted requests re-verify listener ownership before sending a signal.
   */
  requestRestart(reason: string): boolean;
  /** Runtime-only recovery state consumed by the managed SPARQL adapter. */
  getRecoveryState(): OxigraphRecoveryState;
  /** Stop the server and prevent further restarts. Idempotent. */
  stop(): Promise<void>;
  /**
   * Synchronous best-effort SIGTERM for `process.on('exit')` handlers
   * (which cannot await). Prevents orphaning the server when boot hits a
   * fatal `process.exit()` after the server started. Idempotent.
   */
  killSync(): void;
}

export interface OxigraphRecoveryState {
  recovering: boolean;
  generation: number;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_READY_INTERVAL_MS = 500;
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
  // One host policy for the whole launch: the launch strategy and the store
  // ownership (reclaim, process probes, owner record) share it.
  const platform = opts.platform ?? process.platform;
  const launchStrategy = createOxigraphLaunchStrategy({
    memoryLimits: opts.memoryLimits,
    platform,
    parentPid: process.pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
  });
  const ioOverrides = opts.io ?? {};
  const io: OxigraphServerIo = {
    spawn: ioOverrides.spawn ?? spawn,
    fetch: ioOverrides.fetch ?? globalThis.fetch,
    killProcess: ioOverrides.killProcess ?? process.kill,
    findListenOwnerPid: ioOverrides.findListenOwnerPid ?? findListenOwnerPid,
    readCgroupOomSnapshot: ioOverrides.readCgroupOomSnapshot ?? readCgroupOomSnapshot,
    readCgroupOomKill: ioOverrides.readCgroupOomKill ?? readCgroupOomKill,
  };
  const markStoreDown = (): void => {
    invalidateExternalStoreQuadsCache();
  };
  const log = opts.log ?? (() => {});
  // Reclaims the store before each spawn and records each launch; stop()
  // closes it.
  const storeOwnership = (opts.storeOwnership ?? createOxigraphStoreOwnership)({
    location: opts.location,
    binaryPath: opts.binaryPath,
    platform,
    log,
  });
  const host = opts.host ?? DEFAULT_HOST;
  const { port } = opts;
  const bind = `${host}:${port}`;
  const base = `http://${host}:${port}`;
  const queryEndpoint = `${base}/query`;
  const updateEndpoint = `${base}/update`;
  // GH#1400 — `readyTimeoutMs` keeps its documented meaning: an explicit
  // maximum, used verbatim and never extended. When it is absent the daemon
  // sizes the deadline from the write-ahead log pending replay.
  const explicitReadyTimeoutMs = opts.readyTimeoutMs;
  const autoReadyBaseMs = opts.autoReadyBaseTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const nextReadyTimeout = (): { timeoutMs: number; walBytes: number } => {
    const walBytes = measureRetainedWalBytes(opts.location);
    if (explicitReadyTimeoutMs !== undefined) {
      const auto = resolveWalAwareReadyTimeoutMs({ baseMs: autoReadyBaseMs, walBytes });
      if (auto > explicitReadyTimeoutMs) {
        log(
          `[oxigraph] configured readyTimeoutMs=${explicitReadyTimeoutMs}ms is below the ~${auto}ms ` +
            `estimated to replay ${formatWalBytes(walBytes)} of retained write-ahead log; ` +
            `remove the setting to let the daemon size the deadline automatically.`,
        );
      }
      return { timeoutMs: explicitReadyTimeoutMs, walBytes };
    }
    return {
      timeoutMs: resolveWalAwareReadyTimeoutMs({ baseMs: autoReadyBaseMs, walBytes }),
      walBytes,
    };
  };
  const readyIntervalMs = opts.readyIntervalMs ?? DEFAULT_READY_INTERVAL_MS;
  const progressLogIntervalMs = normalizePositiveInteger(opts.progressLogIntervalMs) ?? 10_000;
  const stopGraceMs = opts.stopGraceMs ?? OXIGRAPH_STOP_GRACE_MS;
  const restartBase = opts.restartBackoffBaseMs ?? DEFAULT_RESTART_BASE_MS;
  const restartMax = opts.restartBackoffMaxMs ?? DEFAULT_RESTART_MAX_MS;
  const queryTimeoutS = normalizePositiveInteger(opts.queryTimeoutS);

  // `oxigraph` is the current launch: its child and how to signal it.
  type LifecycleState =
    | { phase: 'starting'; oxigraph: OxigraphLaunchHandle | null; generation: number }
    | { phase: 'ready'; oxigraph: OxigraphLaunchHandle; listenerPid: number; generation: number }
    | { phase: 'restart-verifying'; oxigraph: OxigraphLaunchHandle; listenerPid: number; reason: string; generation: number }
    | { phase: 'restart-signalled'; oxigraph: OxigraphLaunchHandle; listenerPid: number; reason: string; generation: number }
    | { phase: 'recovering'; oxigraph: OxigraphLaunchHandle | null; reason: string; generation: number }
    | { phase: 'stopping'; oxigraph: OxigraphLaunchHandle | null; generation: number };

  let lifecycle: LifecycleState = { phase: 'starting', oxigraph: null, generation: 0 };
  let restarts = 0;
  // Tail of the child's stderr, surfaced in the startup error so a bind
  // failure (`Address already in use`) is visible to the operator.
  let lastStderr = '';
  const isStopping = (): boolean => lifecycle.phase === 'stopping';
  // A spawn error (ENOENT/EACCES/loader mismatch) counts as a dead child: the
  // launch handle tracks it, since `exitCode`/`signalCode` stay null then.
  const childAlive = (candidate: OxigraphLaunchHandle | null): candidate is OxigraphLaunchHandle =>
    candidate !== null && candidate.alive();

  const spawnChild = (): OxigraphLaunchHandle => {
    const args = [...oxigraphStoreArgs(opts.location), '--bind', bind];
    if (queryTimeoutS !== undefined) args.push('--timeout-s', String(queryTimeoutS));
    const oxigraph = launchStrategy.launch(io.spawn, opts.binaryPath, args, ['ignore', 'pipe', 'pipe']);
    const c = oxigraph.child;
    // Route a spawn failure through the normal startup/revive failure path
    // (the binary couldn't be executed), with the reason in the log.
    c.once('error', (err) => {
      lastStderr = `${lastStderr}spawn error: ${(err as Error).message}\n`.slice(-1_000);
      log(`[oxigraph] failed to launch binary: ${(err as Error).message}`);
    });
    c.stderr?.on('data', (b) => {
      const line = b.toString('utf-8').trim();
      if (line) {
        oxigraph.observeStderr(line);
        lastStderr = `${lastStderr}${line}\n`.slice(-1_000);
        log(`[oxigraph] ${line}`);
      }
    });
    c.once('exit', (code, signal) => {
      if (lifecycle.phase === 'stopping') return;
      if (lifecycle.oxigraph !== oxigraph) return;
      const requestedRecovery = lifecycle.phase === 'restart-verifying'
        || lifecycle.phase === 'restart-signalled'
        ? lifecycle
        : null;
      // Two cases land here outside ready/requested-recovery and must NOT (re)start:
      //   1. Startup-phase exit — usually a bind failure (the port is taken
      //      by another local SPARQL server). The ready loop observes the
      //      dead child and fails fast with the captured stderr.
      //   2. A respawned child that died while revive() was still
      //      re-validating ownership — revive() owns rescheduling in that
      //      window, so we must not double-schedule here.
      // Restarting on either would risk looping against a port we can't own,
      // and a foreign server answering there could be mistaken for ours.
      if (lifecycle.phase !== 'ready' && requestedRecovery === null) return;
      // We just lost a confirmed-healthy child. Enter recovery immediately so
      // nothing treats the (now foreign-or-dead) endpoint as ours, then hand
      // off to revive(), which respawns and re-proves ownership before
      // restoring `ready`.
      markStoreDown();
      const generation = lifecycle.generation
        + (lifecycle.phase === 'restart-signalled' ? 0 : 1);
      // Best-effort OOM classification: `oom_kill` is cgroup-scoped, not
      // per-PID, so use an increment only as supporting evidence for a
      // SIGKILL-compatible child death. This catches MemoryMax/host OOM kills
      // without labelling unrelated non-SIGKILL exits as OOM.
      let oomNote = '';
      if (oxigraph.classifyOomExit({ code, signal, readOomKill: io.readCgroupOomKill })) {
        oomNote = ', OOM-killed by cgroup memory cap (or host OOM)';
      }
      const recoveryReason = requestedRecovery === null
        ? `server exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}${oomNote})`
        : `server terminated for recovery (${requestedRecovery.reason}; signal=${signal ?? 'null'}${oomNote})`;
      lifecycle = { phase: 'recovering', oxigraph: null, reason: recoveryReason, generation };
      scheduleRevive(recoveryReason);
    });
    return oxigraph;
  };

  const probeReady = async (oxigraph: OxigraphLaunchHandle): Promise<number | null> => {
    if (!oxigraph.alive()) return null;
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
      const resolvedListenerPid = await oxigraph.resolveListenerPid(port, host, io.findListenOwnerPid);
      // A health response is not ownership proof. On macOS, lsof can briefly omit a new row.
      // Return null and let the existing readiness loop retry. Never replace a missing owner
      // with the child PID because a foreign service can answer while this child fails to bind.
      return resolvedListenerPid !== null && oxigraph.alive() ? resolvedListenerPid : null;
    } catch {
      return null;
    }
  };

  // Schedule a supervised restart with capped exponential backoff. Used both
  // for a healthy child that crashed and for a revive attempt that couldn't
  // re-establish ownership, so a crash-looping binary (or a permanently-taken
  // port) never pegs the CPU.
  const scheduleRevive = (reason: string): void => {
    if (lifecycle.phase === 'stopping') return;
    lifecycle = {
      phase: 'recovering',
      oxigraph: lifecycle.oxigraph,
      reason,
      generation: lifecycle.generation,
    };
    restarts += 1;
    const delay = Math.min(restartMax, restartBase * 2 ** (restarts - 1));
    log(`[oxigraph] ${reason}; restart #${restarts} in ${delay}ms`);
    setTimeout(() => {
      void revive();
    }, delay).unref?.();
  };

  // The ready budget (GH#1400) of one spawn — measured after the reclaim and
  // BEFORE the child starts, so the child cannot delete segments underneath
  // the scan — and how much retained WAL it covers.
  type ReadyBudget = { timeoutMs: number; walBytes: number };
  const sizeReadyBudget = (kind: 'boot' | 'restart'): ReadyBudget => {
    const ready = nextReadyTimeout();
    if (ready.walBytes > 0) {
      log(kind === 'boot'
        ? `[oxigraph] ${formatWalBytes(ready.walBytes)} of retained write-ahead log to replay; ` +
          `allowing up to ${Math.round(ready.timeoutMs / 1000)}s for the database to open.`
        : `[oxigraph] restart: ${formatWalBytes(ready.walBytes)} of retained write-ahead log ` +
          `to replay; allowing up to ${Math.round(ready.timeoutMs / 1000)}s.`);
    }
    return ready;
  };

  // Every spawn, boot and restart alike, is one store-ownership launch: it
  // frees the store lock (a worker or watchdog that died without stopping its
  // Oxigraph leaves it holding LOCK), spawns, and records the launch. The
  // spawned launch becomes the lifecycle's current one as soon as it exists,
  // so stop() reaches it while it is being recorded; one that cannot be
  // recorded is killed by the store ownership before the launch rejects.
  const launchOxigraph = async (
    kind: 'boot' | 'restart',
    current:
      | { phase: 'starting'; generation: number }
      | { phase: 'recovering'; reason: string; generation: number },
  ): Promise<
    | { kind: 'launched'; launch: OxigraphStoreLaunch; readyBudget: ReadyBudget }
    | Exclude<OxigraphStoreLaunchOutcome, { kind: 'launched' }>
  > => {
    // Sized inside `spawn`: after the reclaim, before the child starts.
    let readyBudget: ReadyBudget = { timeoutMs: 0, walBytes: 0 };
    const outcome = await storeOwnership.launch(() => {
      readyBudget = sizeReadyBudget(kind);
      const oxigraph = spawnChild();
      lifecycle = { ...current, oxigraph };
      return oxigraph;
    });
    return outcome.kind === 'launched' ? { ...outcome, readyBudget } : outcome;
  };

  const heldStore = (hold: StoreHold): string =>
    `${opts.location}/LOCK may still be held by this node's Oxigraph ` +
    `(${describeStoreHold(hold)}); not starting another over it`;

  type StoreOpenOutcome =
    | { outcome: 'ready'; listenerPid: number; probes: number }
    | { outcome: 'child-died' | 'timed-out' | 'superseded' };

  // Wait until the launch answers as the verified owner of the listener and
  // is recorded as the store's Oxigraph. Returns what happened and changes no
  // lifecycle state: boot and restart share it, and commit or fail the
  // launch themselves.
  const awaitStoreOpen = async (
    launch: OxigraphStoreLaunch,
    ready: ReadyBudget,
    attempt: {
      progress: (elapsedS: number, allowedS: number) => string;
      superseded?: () => boolean;
    },
  ): Promise<StoreOpenOutcome> => {
    const { oxigraph } = launch;
    const startedAt = Date.now();
    let lastProgressLog = startedAt;
    let probes = 0;
    while (Date.now() < startedAt + ready.timeoutMs) {
      // GH#1400 — RocksDB writes no progress records during replay, so this
      // daemon-side line is the only thing distinguishing "recovering" from
      // "hung" for an operator watching a multi-minute open.
      if (ready.walBytes > 0 && Date.now() - lastProgressLog >= progressLogIntervalMs) {
        lastProgressLog = Date.now();
        log(attempt.progress(
          Math.round((Date.now() - startedAt) / 1000),
          Math.round(ready.timeoutMs / 1000),
        ));
      }
      if (attempt.superseded?.()) return { outcome: 'superseded' };
      probes += 1;
      // Our child exited while opening — almost always a bind or lock
      // failure. Never adopt whatever may be answering on the port (it could
      // be a foreign SPARQL server).
      if (!oxigraph.alive()) return { outcome: 'child-died' };
      const listenerPid = await probeReady(oxigraph);
      if (listenerPid !== null) {
        // Only trust a 200 if the child WE spawned is still alive and bound —
        // guards the race where a foreign server answers while our child has
        // just died on EADDRINUSE.
        if (!oxigraph.alive()) return { outcome: 'child-died' };
        oxigraph.captureOomSnapshot(listenerPid, io.readCgroupOomSnapshot);
        // Record before declaring ready, then look again: a child that exits
        // during the write is a failed open, not a ready server whose exit
        // handler has already started recovery.
        await launch.ready(listenerPid);
        if (attempt.superseded?.()) return { outcome: 'superseded' };
        if (!oxigraph.alive()) return { outcome: 'child-died' };
        return { outcome: 'ready', listenerPid, probes };
      }
      await sleep(readyIntervalMs);
    }
    return { outcome: 'timed-out' };
  };

  // The one place a launch becomes the ready server. Callers commit right
  // after a `ready` outcome, with no await in between, so the checks
  // `awaitStoreOpen` made still hold. Keep the actual listener PID, not the
  // watchdog or systemd-run wrapper, so timeout recovery terminates
  // Oxigraph itself.
  const commitReady = (oxigraph: OxigraphLaunchHandle, listenerPid: number, generation: number): void => {
    lifecycle = { phase: 'ready', oxigraph, listenerPid, generation };
    restarts = 0;
    // A store count requested while the child was down failed and is cached
    // as unreachable; drop it now that the child is healthy, or /api/status
    // keeps reporting the store as unreachable.
    invalidateExternalStoreQuadsCache();
  };

  // Respawn and re-validate ownership after a steady-state crash. Mirrors
  // the startup ownership guard: `ready` is restored ONLY once the child WE
  // spawned is confirmed to be the process answering on the port. If another
  // process grabbed the port during the downtime, the respawned child dies on
  // bind and we keep retrying with `ready` false — so the agent's store
  // queries surface honest errors rather than silently hitting a foreign
  // SPARQL server.
  const revive = async (): Promise<void> => {
    if (isStopping()) return;
    const generation = lifecycle.generation;
    const reason = lifecycle.phase === 'recovering'
      ? lifecycle.reason
      : 'supervised recovery';
    // GH#1400 — size THIS attempt, not the one at boot. The WAL grows during
    // the session, so a mid-life respawn (onClientTimeout, a crashed child)
    // faces a larger replay than the daemon ever measured at startup. Reusing
    // the boot value re-arms the exact ratchet: kill a healthy replaying
    // child, leave the WAL, retry, kill it again.
    let failure = `respawned server did not become ready on ${bind}`;
    try {
      const attempt = await launchOxigraph('restart', { phase: 'recovering', reason, generation });
      // stop() closed the store ownership while it reclaimed the store.
      if (attempt.kind === 'closed') return;
      if (attempt.kind === 'blocked') {
        // Nothing was spawned; a later attempt reclaims the store again.
        failure = `restart deferred: ${heldStore(attempt.hold)}`;
      } else {
        const { oxigraph } = attempt.launch;
        const opened = await awaitStoreOpen(attempt.launch, attempt.readyBudget, {
          progress: (elapsedS, allowedS) =>
            `[oxigraph] restart still opening: ${elapsedS}s elapsed of ${allowedS}s allowed.`,
          superseded: () => lifecycle.phase !== 'recovering' || lifecycle.oxigraph !== oxigraph,
        });
        if (opened.outcome === 'ready') {
          commitReady(oxigraph, opened.listenerPid, generation);
          log(`[oxigraph] server restarted and healthy on ${bind}.`);
          return;
        }
      }
    } catch (error) {
      // A store-ownership step that rejected (a defect) fails this attempt
      // like a child that never became ready.
      failure = `restart attempt failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (isStopping() || lifecycle.phase !== 'recovering') return;
    // A respawned child that died or never answered is retried with backoff.
    // This attempt's launch, if it got that far, is the current one.
    const candidate = lifecycle.oxigraph;
    // Timed out with the child still running but unresponsive. Kill it
    // before respawning — otherwise each retry stacks another live
    // `oxigraph serve`, and they fight over the port (self-inflicted
    // EADDRINUSE). Its exit handler won't restart (ready is false).
    try {
      candidate?.terminate('SIGKILL');
    } catch {
      /* best-effort */
    }
    lifecycle = { phase: 'recovering', oxigraph: null, reason, generation };
    scheduleRevive(failure);
  };

  // Synchronous best-effort kill for process-exit handlers (which can't
  // await): signals the child so a fatal `process.exit()` elsewhere in
  // boot doesn't orphan the server. Safe to call alongside `stop()`. It
  // cannot reclaim a launch whose wrapper already exited (that needs process
  // probes); the next start's reclaim does, by the owner record.
  const killSync = (): void => {
    const candidate = lifecycle.oxigraph;
    lifecycle = {
      phase: 'stopping',
      oxigraph: candidate,
      generation: lifecycle.generation,
    };
    // No further launches: a restart still reclaiming the store must not
    // spawn after this.
    void storeOwnership.close();
    markStoreDown();
    try {
      candidate?.terminate('SIGTERM');
    } catch {
      /* best-effort */
    }
  };

  const terminateVerifiedListener = async (
    request: Extract<LifecycleState, { phase: 'restart-verifying' }>,
  ): Promise<void> => {
    let verifiedListenerPid: number | null = null;
    try {
      verifiedListenerPid = await request.oxigraph.resolveListenerPid(port, host, io.findListenOwnerPid);
    } catch {
      /* handled by the fail-closed branch below */
    }
    if (
      lifecycle !== request
      || !request.oxigraph.alive()
    ) return;
    if (verifiedListenerPid !== request.listenerPid) {
      log('[oxigraph] recovery restart cancelled: verified listener ownership changed');
      lifecycle = {
        phase: 'ready',
        oxigraph: request.oxigraph,
        listenerPid: request.listenerPid,
        generation: request.generation,
      };
      return;
    }
    try {
      const signalled = io.killProcess(request.listenerPid, 'SIGKILL');
      if (!signalled) throw new Error('process signal was not accepted');
      lifecycle = {
        phase: 'restart-signalled',
        oxigraph: request.oxigraph,
        listenerPid: request.listenerPid,
        reason: request.reason,
        generation: request.generation + 1,
      };
    } catch {
      log('[oxigraph] recovery restart could not signal the verified listener');
      lifecycle = {
        phase: 'ready',
        oxigraph: request.oxigraph,
        listenerPid: request.listenerPid,
        generation: request.generation,
      };
    }
  };

  const requestRestart = (reason: string): boolean => {
    if (
      lifecycle.phase !== 'ready'
      || !childAlive(lifecycle.oxigraph)
    ) return false;
    const normalizedReason = reason.trim().slice(0, 500) || 'unspecified health failure';
    const request: Extract<LifecycleState, { phase: 'restart-verifying' }> = {
      phase: 'restart-verifying',
      oxigraph: lifecycle.oxigraph,
      listenerPid: lifecycle.listenerPid,
      reason: normalizedReason,
      generation: lifecycle.generation,
    };
    lifecycle = request;
    markStoreDown();
    log(`[oxigraph] ${normalizedReason}; terminating server for supervised recovery`);
    void terminateVerifiedListener(request);
    return true;
  };

  const getRecoveryState = (): OxigraphRecoveryState => ({
    recovering: lifecycle.phase === 'recovering'
      || lifecycle.phase === 'stopping'
      || lifecycle.phase === 'restart-signalled',
    generation: lifecycle.generation,
  });

  const exitGuard = (): void => { killSync(); };

  const stop = async (): Promise<void> => {
    // Single release point for the process-exit reaper installed before the
    // spawn (GH#1400) — every stop path, successful or not, comes through
    // here, so no caller has to remember a handoff.
    process.removeListener('exit', exitGuard);
    if (lifecycle.phase === 'stopping') return;
    const candidate = lifecycle.oxigraph;
    lifecycle = {
      phase: 'stopping',
      oxigraph: candidate,
      generation: lifecycle.generation,
    };
    // No further launches or owner records. Resolves once a reclaim or
    // record in flight finishes, and, when the last launch's wrapper had
    // already exited on its own, once its possibly surviving Oxigraph is
    // reclaimed; so the store is quiet when stop() resolves.
    const ownershipClosed = storeOwnership.close();
    markStoreDown();
    if (!childAlive(candidate)) {
      await ownershipClosed;
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(giveUpTimer);
        resolve();
      };
      candidate.child.once('exit', done);
      candidate.terminate('SIGTERM');
      const killTimer = setTimeout(() => {
        if (candidate.alive()) {
          log('[oxigraph] did not exit on SIGTERM; sending SIGKILL');
          candidate.terminate('SIGKILL');
        }
      }, stopGraceMs);
      // A child that cannot be signalled must not hang shutdown: after a
      // second grace period, report it and stop waiting.
      const giveUpTimer = setTimeout(() => {
        if (candidate.alive()) {
          log(`[oxigraph] server pid ${candidate.child.pid} did not exit ${2 * stopGraceMs}ms after SIGTERM; not waiting any longer`);
        }
        done();
      }, 2 * stopGraceMs);
      killTimer.unref?.();
      giveUpTimer.unref?.();
    });
    await ownershipClosed;
    if (!candidate.alive()) log('[oxigraph] server stopped');
  };

  log(
    queryTimeoutS !== undefined
      ? `Starting Oxigraph server on ${bind} (location: ${opts.location}, query timeout: ${queryTimeoutS}s)…`
      : `Starting Oxigraph server on ${bind} (location: ${opts.location})…`,
  );
  const launchSummary = launchStrategy.logSummary();
  if (launchSummary) log(launchSummary);

  // GH#1400 — the caller (daemon/lifecycle.ts) does not register its
  // `process.once('exit', killSync)` until AFTER this function resolves, so
  // for the whole readiness window nothing would reap the child if the worker
  // exits. That window used to be <=30s; sizing it to the WAL makes it
  // minutes, which turns a rare orphan into a likely one — and an orphaned
  // server holding the port and the RocksDB LOCK presents as the very bug
  // being fixed.
  //
  // ONE owner, for the handle's whole lifetime: installed before the spawn and
  // removed by `stop()`. No handoff protocol with the caller — an exception
  // anywhere in readiness would otherwise skip a release and strand both the
  // child and a process-global listener. `killSync` is idempotent, so the
  // caller's own reaper remains harmless.
  process.on('exit', exitGuard);

  let bootReady: ReadyBudget;
  let opened: StoreOpenOutcome;
  try {
    const generation = lifecycle.generation;
    const attempt = await launchOxigraph('boot', { phase: 'starting', generation });
    // Only killSync (process exit) closes the store ownership during boot.
    if (attempt.kind === 'closed') throw new Error('Oxigraph server start was interrupted by process exit');
    if (attempt.kind === 'blocked') throw new Error(`Oxigraph server not started on ${bind}: ${heldStore(attempt.hold)}`);
    bootReady = attempt.readyBudget;
    const { oxigraph } = attempt.launch;
    opened = await awaitStoreOpen(attempt.launch, bootReady, {
      // Only an exit-time kill (process.exit) moves boot out of `starting`.
      superseded: () => lifecycle.phase !== 'starting' || lifecycle.oxigraph !== oxigraph,
      progress: (elapsedS, allowedS) =>
        `[oxigraph] still opening: ${elapsedS}s elapsed of ${allowedS}s allowed ` +
        `(${formatWalBytes(bootReady.walBytes)} of write-ahead log).`,
    });
    if (opened.outcome === 'ready') commitReady(oxigraph, opened.listenerPid, generation);
  } catch (error) {
    // A launch that failed (a store it found held, or a store-ownership step
    // that rejected) stops the child, which also releases the exit guard, and
    // surfaces the error.
    await stop();
    throw error;
  }
  if (opened.outcome === 'ready') {
    log(`Oxigraph server ready on ${bind} after ${opened.probes} probe(s).`);
    return {
      host,
      port,
      queryEndpoint,
      updateEndpoint,
      requestRestart,
      getRecoveryState,
      stop,
      killSync,
    };
  }
  const childDied = opened.outcome === 'child-died';
  const readyTimeoutMs = bootReady.timeoutMs;

  // Never became ready — stop the child so we don't leak it, then throw.
  // `stop()` removes the exit guard.
  await stop();
  const stderrHint = lastStderr.trim()
    ? ` Last server output:\n${lastStderr.trim()}`
    : '';
  throw new Error(
    childDied
      ? `Oxigraph server exited during startup on ${bind} ` +
        `(binary: ${opts.binaryPath}, location: ${opts.location}). ` +
        `The port may already be in use by another process.` +
        (bootReady.walBytes > 0
          // Every managed stop is a crash-stop to RocksDB, so some retained
          // WAL is the NORM on a production node — the OOM hypothesis is
          // additional context, never a replacement for the bind-failure one.
          ? ` It was also replaying ${formatWalBytes(bootReady.walBytes)} of retained ` +
            `write-ahead log, so an out-of-memory kill during recovery is possible too.`
          : ``) +
        `${stderrHint}`
      : `Oxigraph server did not become ready on ${bind} within ${readyTimeoutMs}ms ` +
        `(binary: ${opts.binaryPath}, location: ${opts.location}).${stderrHint}`,
  );
}
