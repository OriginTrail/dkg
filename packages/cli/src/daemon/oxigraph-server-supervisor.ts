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
import { performance } from 'node:perf_hooks';
import type { ManagedOxigraphSupervisorHandoffV1 } from '@origintrail-official/dkg-storage';
import { findListenOwnerPid } from './oxigraph-listen-port.js';
import { createOxigraphLaunchStrategy } from './oxigraph-launch-strategy.js';
import { invalidateExternalStoreQuadsCache } from './routes/status.js';
import {
  readCgroupOomSnapshot,
  readCgroupOomKill,
} from './oxigraph-memory.js';
import type {
  OxigraphServerHandle,
  OxigraphServerIo,
  StartOxigraphServerOptions,
} from './oxigraph-server-contract.js';
import {
  boundedOxigraphPhaseDelayMsV1,
  normalizePositiveOxigraphIntegerV1,
  OxigraphSupervisorTimersV1,
  parseOxigraphGenerationV1,
  SerializedOxigraphLifecycleV1,
  sleepOxigraphSupervisorV1,
  type OxigraphLifecycleStateV1,
} from './oxigraph-supervisor-lifecycle.js';
import { OxigraphSupervisorProbesV1 } from './oxigraph-supervisor-probes.js';
import { OxigraphSupervisorChildV1 } from './oxigraph-supervisor-child.js';
import { OxigraphSupervisorReviveBackoffV1 } from './oxigraph-supervisor-revive.js';
import {
  createOxigraphServerOwnershipViewV1,
  createOxigraphSupervisorOwnershipV1,
} from './oxigraph-supervisor-ownership.js';

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
/** Sentinel for "no generation has ever been bound on this lease". */
const UNBOUND_GENERATION = '0';

/**
 * Spawn and health-check a local Oxigraph server. Resolves once the
 * server answers an `ASK` probe AND the child we spawned is proven to own
 * the listen socket; rejects if that never happens within `readyTimeoutMs`
 * (the child is killed first so we don't leak it).
 */
export async function createOxigraphServerSupervisorV1(
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
  // Generous by default: the gap between the two handoff halves legitimately
  // includes draining every in-flight request issued over the retired pool, so
  // a tight bound would cut off healthy handoffs. Only an ABANDONED one should
  // ever reach it.
  const handoffAbandonMs = normalizePositiveOxigraphIntegerV1(opts.handoffAbandonMs)
    ?? Math.max(readyTimeoutMs, DEFAULT_STOP_GRACE_MS) * 2;
  const queryTimeoutS = normalizePositiveOxigraphIntegerV1(opts.queryTimeoutS);

  /**
   * Mutation authority for the ownership lease. Created here and NEVER handed
   * out: consumers get {@link OxigraphServerOwnershipV1}, which can read the
   * lease but not mint one.
   */
  // Only the exact production listener spelling may mint the endpoint-bound
  // B3 capability. `host` remains overridable for tests and compatible local
  // callers; those servers retain the B2 diagnostic lifecycle lease, but that
  // endpoint-less lease can never satisfy the atomic materializer's endpoint
  // identity check.
  const ownership = createOxigraphSupervisorOwnershipV1({
    endpointBound: host === DEFAULT_HOST,
    queryEndpoint,
    updateEndpoint,
  });

  let state: OxigraphLifecycleStateV1 = 'starting';
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
  const reviveBackoff = new OxigraphSupervisorReviveBackoffV1(restartBase, restartMax);

  // ---------------------------------------------------------------------
  // Lifecycle mutex
  // ---------------------------------------------------------------------

  /**
   * One promise chain serialises every exclusive section. Sections are chained
   * on SETTLE rather than on success: a rejected startup or recovery must not
   * deadlock every later `stop()` behind it.
   */
  const lifecycle = new SerializedOxigraphLifecycleV1();
  const runExclusive = <T>(section: () => Promise<T>): Promise<T> =>
    lifecycle.run(section);

  // ---------------------------------------------------------------------
  // Restart timer (single, always cancellable)
  // ---------------------------------------------------------------------

  // The retired implementation dropped this handle on the floor, so an armed
  // backoff could never be cancelled — only talked out of running. Tracking it
  // lets `stop()` and a controlled recovery genuinely disarm the restart.
  const timers = new OxigraphSupervisorTimersV1();
  const clearReviveTimer = (): void => timers.clearRevive();

  /**
   * Backstop for a lane that retires the child and never binds the replacement.
   *
   * The `retired` phase suspends ordinary supervision, so an abandoned handoff
   * leaves the daemon's triple store childless indefinitely. That is not
   * hypothetical: a lane SHUTDOWN legitimately retires without a replacement.
   *
   * The resolution is to resume ordinary supervision, NOT to go terminal. This
   * child is the daemon's whole triple store — every consumer's store, not the
   * system-record lane's private one — so letting one consumer's teardown
   * permanently kill it would be a far worse failure than the one being fixed.
   * A lane that comes back late finds the phase cleared and is refused, which
   * is fail-closed for the lane and alive for everyone else.
   */
  const clearHandoffAbandonBackstop = (): void => timers.clearHandoffAbandon();
  const armHandoffAbandonBackstop = (): void => {
    timers.armHandoffAbandon(handoffAbandonMs, () => {
      if (handoffPhase !== 'retired' || terminating || state === 'closed') return;
      log(
        `[oxigraph] no clean generation was bound within ${handoffAbandonMs}ms of retiring ` +
          `the child on ${bind}; resuming ordinary supervision.`,
      );
      // Clear BEFORE reviving so the revive is an ordinary one; the lane's
      // second half, if it ever arrives, is then correctly refused.
      handoffPhase = 'none';
      void runExclusive(reviveLocked).catch((err: unknown) => {
        log(`[oxigraph] abandoned-handoff recovery failed: ${(err as Error).message}`);
      });
    });
  };

  // ---------------------------------------------------------------------
  // Child process primitives
  // ---------------------------------------------------------------------

  const childOwner = new OxigraphSupervisorChildV1({
    binaryPath: opts.binaryPath,
    location: opts.location,
    bind,
    queryTimeoutS,
    stopGraceMs,
    io,
    launchStrategy,
    log,
    maySpawn: () => !terminating && state !== 'closed',
    onCurrentExit: (exited, code, signal) => {
      // Shutdown already owns this exit; stale exits are filtered by the child
      // owner before this callback is invoked.
      if (terminating) return;
      if (!childOwner.consumeHandoffRetiring(exited)) ownership.invalidate('child-exit');
      // Startup and in-progress revive loops own their failure handling and
      // must not double-schedule here.
      if (state !== 'ready') return;
      state = 'reviving';
      markStoreDown();
      const oomNote = childOwner.classifyOomExit(exited, code, signal)
        ? ', OOM-killed by cgroup memory cap (or host OOM)'
        : '';
      scheduleRevive(
        `server exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}${oomNote})`,
      );
    },
  });
  const childAlive = (): boolean => childOwner.alive();
  const signalTrackedChild = (signal: NodeJS.Signals): void => childOwner.signal(signal);
  const spawnChild = (): ChildProcess => childOwner.spawn();

  // ---------------------------------------------------------------------
  // Readiness / ownership probes
  // ---------------------------------------------------------------------

  const probes = new OxigraphSupervisorProbesV1({
    host,
    port,
    queryEndpoint,
    readyIntervalMs,
    stopGraceMs,
    io,
    launchStrategy,
    currentChild: () => childOwner.current(),
    childAlive,
  });
  const probeReady = (absoluteDeadlineMs?: number): Promise<number | null> =>
    probes.probeReady(absoluteDeadlineMs);

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
    childOwner.captureOomSnapshot(c, listenerPid);
    state = 'ready';
    reviveBackoff.reset();
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
    // Never arm a restart once shutdown has begun.
    //
    // There is deliberately NO `handoffPhase` clause here. Every caller of this
    // function is unreachable while the phase is `retired` — the exit handler
    // requires `state === 'ready'`, the retire itself transitions away from it
    // and disarms the timer, and both recovery tails clear the phase before
    // calling — so the clause could never fire. An inert guard is worse than no
    // guard: it reads as protection and invites a later refactor to delete the
    // real one. The phase is enforced where it can actually be violated, in
    // `recoverLocked()` and `startCleanGenerationLocked()`.
    if (terminating || state === 'closed') return;
    const { attempt, delayMs } = reviveBackoff.next();
    log(`[oxigraph] ${reason}; restart #${attempt} in ${delayMs}ms`);
    state = 'reviving';
    timers.armRevive(delayMs, () => {
      // The timer owner re-checks callback identity before calling us. Keep the
      // shutdown guard here as the final no-new-child boundary.
      if (terminating || state === 'closed') return;
      void runExclusive(reviveLocked).catch((err: unknown) => {
        log(`[oxigraph] restart attempt failed: ${(err as Error).message}`);
      });
    });
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
    spawnChild();

    const reviveDeadline = Date.now() + readyTimeoutMs;
    while (Date.now() < reviveDeadline) {
      if (terminating) return;
      // Respawned child died (its own exit handler stays out of the way
      // because we are not in the `ready` phase). Retry with backoff; never
      // adopt whatever may now be answering on the port.
      if (!childAlive()) break;
      const listenerPid = await probeReady();
      if (listenerPid !== null && childAlive()) {
        const generation = bindProvenGeneration(childOwner.current()!, listenerPid);
        log(`[oxigraph] server restarted and healthy on ${bind} (generation ${generation}).`);
        return;
      }
      await sleepOxigraphSupervisorV1(readyIntervalMs);
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
      expected = parseOxigraphGenerationV1(expectedGeneration);
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
   * Release is proven ONLY by a refused connection. A probe that times out or
   * fails in transport establishes nothing, and treating it as release would
   * be fail-open on exactly the boundary this function exists to defend: the
   * caller may bind a replacement over whatever is still listening. So the
   * loop retries until it sees a refusal and returns false if it never does —
   * "no evidence" and "evidence of absence" are not the same answer.
   *
   * We only ever PROBE here. No pid observed on the port is ever signalled —
   * every kill in this module goes through the tracked `ChildProcess`.
   */
  const proveManagedPortRelease = async (
    exited: ChildProcess | null,
    absoluteDeadlineMs?: number,
  ): Promise<boolean> => {
    const result = await probes.provePortRelease(exited, absoluteDeadlineMs);
    if (result.released) return true;
    log(
      `[oxigraph] ${bind} release could not be proven after the managed child exited ` +
        `(last probe: ${result.last}).`,
    );
    log(
      `[oxigraph] ${bind} is still served after the managed child exited ` +
        `(${result.owner === null
          ? 'listener is NOT attributable to a process we spawned'
          : `listener still owned by pid ${result.owner}`}). ` +
        'Port release could not be proven; managed-store ownership is now terminal.',
    );
    ownership.invalidate('port-release-unproven');
    return false;
  };

  /**
   * Eager, pre-lock half of shutdown: disarm restarts NOW so nothing spawns
   * while the exclusive stop section queues behind an in-flight revive.
   */
  const beginTermination = (): void => {
    terminating = true;
    clearReviveTimer();
    clearHandoffAbandonBackstop();
  };

  const stopLocked = async (): Promise<void> => {
    if (state === 'closed') return; // idempotent
    state = 'stopping';
    ownership.invalidate('stop');
    markStoreDown();
    clearReviveTimer();
    const c = childOwner.current();
    if (c) childOwner.detach(c);
    // Only a child we actually proved ownership of gives us a port to account
    // for. A startup that never bound a generation (bind failure: the port was
    // someone else's from the first probe) has no release to prove, and
    // charging it `stopGraceMs` of probing would just slow every failed boot.
    const provedOwnership = ownership.snapshot().childGeneration !== UNBOUND_GENERATION;
    if (c && c.exitCode === null && c.signalCode === null) {
      await childOwner.awaitExit(c);
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
  const retireOwnedChildLocked = async (absoluteDeadlineMs?: number): Promise<void> => {
    boundedOxigraphPhaseDelayMsV1(1, absoluteDeadlineMs);
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
    const c = childOwner.current();
    // Keep the process TRACKED until exit is proven. `state === 'recovering'`
    // already prevents its exit handler from scheduling a revive, while
    // clearing `child` before a recovery deadline would orphan a late SIGKILL
    // exit from every subsequent stop/retry path.
    if (c && c.exitCode === null && c.signalCode === null) {
      childOwner.markHandoffRetiring(c);
      await childOwner.awaitExit(c, absoluteDeadlineMs);
    }
    if (c) childOwner.detach(c);
    if (!(await proveManagedPortRelease(c, absoluteDeadlineMs))) {
      // We have no child and cannot account for whatever is still on the bind.
      // Leaving the supervisor merely "open and childless" would keep it in a
      // state where a later path could still spawn against that listener, so
      // close it outright: this supervisor is finished, and only a restart of
      // the node can make the port trustworthy again.
      //
      // NOTE for operators, and the split is deliberate:
      //
      // - Ordinary MUTATIONS are refused at dispatch. The adapter reads this
      //   lease before every update and rejects with
      //   `ManagedOxigraphBackendUnownedError` and zero I/O, so nothing is
      //   written into whatever is on that bind.
      // - READS still route to the endpoint. Refusing them would take the
      //   node's whole store down, and a read against a dead port fails at the
      //   transport anyway — but against a FOREIGN listener a read can return
      //   data that is not ours. That is the residual exposure here.
      // - The lease is terminal, so no generation can ever be rebound in this
      //   process: only a restart makes the port trustworthy again.
      beginTermination();
      state = 'closed';
      log(
        `[oxigraph] FATAL: could not prove ${bind} was released after retiring the managed ` +
          'child. The supervisor is now closed and will never start another child. Writes to ' +
          'that endpoint are refused from here on, but READS are still routed to it and may ' +
          'reach a listener this node cannot account for — restart the node.',
      );
      throw new Error(
        `Managed Oxigraph could not prove ${bind} was released after retiring the child; ` +
          'managed-store capability is now terminal',
      );
    }
    handoffPhase = 'retired';
    // Bound the window. The lane is expected to bind the replacement, but a
    // caller that never returns — a lane shutdown, an exception between the two
    // halves, a crashed consumer — must not park the daemon's triple store
    // childless for the life of the process.
    armHandoffAbandonBackstop();
  };

  /**
   * Bind a replacement generation after a proven-dead predecessor.
   *
   * Refuses unless a retire actually completed: without that proof the lane
   * would be starting a child over a socket whose previous owner is unaccounted
   * for, which is the one thing the whole handoff exists to rule out.
   */
  const startCleanGenerationLocked = async (absoluteDeadlineMs?: number): Promise<void> => {
    boundedOxigraphPhaseDelayMsV1(1, absoluteDeadlineMs);
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
    clearHandoffAbandonBackstop();
    // EVERYTHING from here runs inside the recovery tail, because more than the
    // ready loop can fail. `child_process.spawn` raises EACCES / EFTYPE / E2BIG
    // / EINVAL SYNCHRONOUSLY — the `error` event only ever carries the async
    // failures — and `spawnChild()`'s own shutdown assertion throws
    // synchronously too. Either would escape past the tail and strand
    // `handoffPhase` at 'retired' for the life of the process: no replacement,
    // no automatic revive, and a lease reporting "momentarily not ready"
    // forever instead of failing closed. `bindProvenGeneration()` can throw as
    // well (terminal lease), which is the same class.
    try {
      spawnChild();
      const deadline = Math.min(
        performance.now() + readyTimeoutMs,
        absoluteDeadlineMs ?? Number.POSITIVE_INFINITY,
      );
      while (performance.now() < deadline) {
        if (terminating) break;
        if (!childAlive()) break;
        const listenerPid = await probeReady(absoluteDeadlineMs);
        if (listenerPid !== null && childAlive()) {
          // Bind FIRST: clearing the phase before a call that can throw would
          // leave the supervisor claiming a completed handoff it never made.
          const generation = bindProvenGeneration(childOwner.current()!, listenerPid);
          handoffPhase = 'none';
          log(`[oxigraph] clean child generation ${generation} bound on ${bind}.`);
          return;
        }
        await sleepOxigraphSupervisorV1(boundedOxigraphPhaseDelayMsV1(readyIntervalMs, deadline));
      }
      throw new Error(
        `Managed Oxigraph could not prove a clean child generation on ${bind} ` +
          'before the clean-generation recovery deadline',
      );
    } catch (err) {
      // The lane's replacement could not be proven. Reap the unproven child and
      // hand the node back to ORDINARY supervision: a lane that abandons the
      // handoff here must not leave the daemon's triple store childless. The
      // backoff may later bind a generation of its own, which the lane observes
      // as the ordinary stale-generation case.
      signalTrackedChild('SIGKILL');
      handoffPhase = 'none';
      scheduleRevive(`clean-generation start failed on ${bind}`);
      throw err;
    }
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
    stopAndProveOwnedChildDead: (absoluteDeadlineMs?: number) =>
      runExclusive(() => retireOwnedChildLocked(absoluteDeadlineMs)),
    startAndProveCleanGeneration: (absoluteDeadlineMs?: number) =>
      runExclusive(() => startCleanGenerationLocked(absoluteDeadlineMs)),
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
    spawnChild();

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
          const generation = bindProvenGeneration(childOwner.current()!, listenerPid);
          log(
            `Oxigraph server ready on ${bind} after ${attempt} probe(s) ` +
              `(generation ${generation}).`,
          );
          return;
        }
        childDied = true;
        break;
      }
      await sleepOxigraphSupervisorV1(readyIntervalMs);
    }

    // Never became ready — stop the child so we don't leak it, then throw.
    // Runs the stop section INLINE: we already hold the mutex, so going
    // through `stop()` would deadlock behind ourselves.
    beginTermination();
    await stopLocked();
    const stderrHint = childOwner.stderrTail().trim()
      ? ` Last server output:\n${childOwner.stderrTail().trim()}`
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

  const ownershipView = createOxigraphServerOwnershipViewV1(ownership, recoverGeneration);

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
