/**
 * Supervised local Oxigraph server (Release 2, phase 2b lifecycle; used
 * opt-in in 2a via `store.backend: 'oxigraph-server'`).
 *
 * The daemon owns one loopback-bound `oxigraph serve` child. Readiness is not
 * enough to mint ownership: the spawned child must also be proven as the
 * listener owner. Every lifecycle operation runs through one serialized lock,
 * while focused operation modules own startup, revive/recovery, shutdown, and
 * clean-generation handoff behavior.
 *
 * Oxigraph has no native authentication, so this managed mode is restricted
 * to loopback. Downstream mutation capabilities bind to the proven child
 * generation rather than a forgeable configuration flag.
 */
import { spawn } from 'node:child_process';

import { findListenOwnerPid } from './oxigraph-listen-port.js';
import { createOxigraphLaunchStrategy } from './oxigraph-launch-strategy.js';
import { readCgroupOomKill, readCgroupOomSnapshot } from './oxigraph-memory.js';
import type {
  OxigraphServerHandle,
  OxigraphServerIo,
  StartOxigraphServerOptions,
} from './oxigraph-server-contract.js';
import { OxigraphSupervisorChildV1 } from './oxigraph-supervisor-child.js';
import { OxigraphSupervisorHandoffOperationsV1 } from './oxigraph-supervisor-handoff-operations.js';
import { OxigraphSupervisorGenerationV1 } from './oxigraph-supervisor-generation.js';
import {
  normalizePositiveOxigraphIntegerV1,
  OxigraphSupervisorTimersV1,
  SerializedOxigraphLifecycleV1,
} from './oxigraph-supervisor-lifecycle.js';
import {
  createOxigraphServerOwnershipViewV1,
  createOxigraphSupervisorOwnershipV1,
} from './oxigraph-supervisor-ownership.js';
import { OxigraphSupervisorProbesV1 } from './oxigraph-supervisor-probes.js';
import { OxigraphSupervisorRecoveryOperationsV1 } from './oxigraph-supervisor-recovery-operations.js';
import { OxigraphSupervisorReviveBackoffV1 } from './oxigraph-supervisor-revive.js';
import { OxigraphSupervisorShutdownOperationsV1 } from './oxigraph-supervisor-shutdown-operations.js';
import { startOxigraphSupervisorV1 } from './oxigraph-supervisor-startup-operations.js';
import { OxigraphSupervisorStateV1 } from './oxigraph-supervisor-state.js';
import { invalidateExternalStoreQuadsCache } from './routes/status.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_READY_INTERVAL_MS = 500;
const DEFAULT_STOP_GRACE_MS = 5_000;
const DEFAULT_RESTART_BASE_MS = 1_000;
const DEFAULT_RESTART_MAX_MS = 30_000;

/** Compose and start one managed Oxigraph supervisor. */
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
  const handoffAbandonMs = normalizePositiveOxigraphIntegerV1(opts.handoffAbandonMs)
    ?? Math.max(readyTimeoutMs, DEFAULT_STOP_GRACE_MS) * 2;
  const queryTimeoutS = normalizePositiveOxigraphIntegerV1(opts.queryTimeoutS);

  const ownership = createOxigraphSupervisorOwnershipV1({
    endpointBound: host === DEFAULT_HOST,
    queryEndpoint,
    updateEndpoint,
  });
  const state = new OxigraphSupervisorStateV1();
  const reviveBackoff = new OxigraphSupervisorReviveBackoffV1(restartBase, restartMax);
  const lifecycle = new SerializedOxigraphLifecycleV1();
  const runExclusive = <T>(section: () => Promise<T>): Promise<T> =>
    lifecycle.run(section);
  const timers = new OxigraphSupervisorTimersV1();

  const child = new OxigraphSupervisorChildV1({
    binaryPath: opts.binaryPath,
    location: opts.location,
    bind,
    queryTimeoutS,
    stopGraceMs,
    io,
    launchStrategy,
    log,
    maySpawn: () => state.maySpawnChild(),
  });
  const probes = new OxigraphSupervisorProbesV1({
    host,
    port,
    queryEndpoint,
    readyIntervalMs,
    stopGraceMs,
    io,
    launchStrategy,
    currentChild: () => child.current(),
    childAlive: () => child.alive(),
  });
  const generation = new OxigraphSupervisorGenerationV1({
    state,
    ownership,
    child,
    probes,
    reviveBackoff,
    readyTimeoutMs,
    readyIntervalMs,
  });

  const recovery = new OxigraphSupervisorRecoveryOperationsV1({
    state,
    ownership,
    child,
    generation,
    timers,
    reviveBackoff,
    bind,
    log,
    markStoreDown,
    runExclusive,
  });
  child.registerCurrentExitHandler((exited, code, signal) => {
    if (!state.mayHandleChildExit()) return;
    if (!child.consumeHandoffRetiring(exited)) ownership.invalidate('child-exit');
    if (!state.shouldReviveExitedChild()) return;
    markStoreDown();
    const oomNote = child.classifyOomExit(exited, code, signal)
      ? ', OOM-killed by cgroup memory cap (or host OOM)'
      : '';
    recovery.scheduleRevive(
      `server exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}${oomNote})`,
    );
  });
  const shutdown = new OxigraphSupervisorShutdownOperationsV1({
    state,
    ownership,
    child,
    probes,
    timers,
    bind,
    log,
    markStoreDown,
    runExclusive,
  });
  const handoff = new OxigraphSupervisorHandoffOperationsV1({
    state,
    ownership,
    child,
    generation,
    timers,
    recovery,
    shutdown,
    abandonMs: handoffAbandonMs,
    bind,
    log,
    markStoreDown,
    runExclusive,
  });

  await runExclusive(() => startOxigraphSupervisorV1({
    shutdown,
    child,
    generation,
    bind,
    readyTimeoutMs,
    log,
    binaryPath: opts.binaryPath,
    location: opts.location,
    queryTimeoutS,
    launchSummary: launchStrategy.logSummary(),
  }));

  const ownershipView = createOxigraphServerOwnershipViewV1(
    ownership,
    (expectedGeneration) => recovery.recoverGeneration(expectedGeneration),
  );
  return {
    host,
    port,
    queryEndpoint,
    updateEndpoint,
    ownership: ownershipView,
    supervisorHandoff: handoff.publicView(),
    stop: () => shutdown.stop(),
    killSync: () => shutdown.killSync(),
  };
}
