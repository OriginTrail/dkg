import type { ManagedOxigraphRecoveryHandleV1 } from '@origintrail-official/dkg-storage';
import { formatWalBytes } from './oxigraph-wal.js';

/**
 * Retained WAL size at which a node whose maintenance reopen is off starts
 * to report the log. It was the reopen's threshold while the reopen was on by
 * default; the reopen is opt-in now (see `resolveWalRestartThresholdBytes`).
 */
export const WAL_GROWTH_NOTICE_BYTES = 4 * 1024 ** 3;
const DEFAULT_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1_000;

type IntervalHandle = ReturnType<typeof setInterval>;

export interface OxigraphWalMaintenanceOptions {
  location: string;
  /** Undefined: the maintenance reopen is off and the retained WAL is only reported. */
  thresholdBytes: number | undefined;
  checkIntervalMs?: number;
  idleMs?: number;
  cooldownMs?: number;
  measureRetainedWalBytes: (location: string) => number;
  requestRecovery: (reason: string) => ManagedOxigraphRecoveryHandleV1 | undefined;
  serverAvailable: () => boolean;
  log: (message: string) => void;
  now?: () => number;
  schedule?: (callback: () => void, intervalMs: number) => IntervalHandle;
  cancel?: (handle: IntervalHandle) => void;
}

export interface OxigraphWalMaintenanceActivityLease {
  report(busy: boolean): void;
  dispose(): void;
}

export interface OxigraphWalMaintenanceCoordinator {
  registerActivity(): OxigraphWalMaintenanceActivityLease;
  admissionsPaused(): boolean;
  serverLifecycleChanged(completion?: 'confirmed-reopen'): void;
  stop(): void;
}

/**
 * The maintenance reopen is opt-in. A cycle refuses every store operation for
 * one to two minutes, and how often it comes depends on how fast the node
 * writes, so a node reopens its store for this reason only when its operator
 * names a size. Anything but a positive safe integer leaves the reopen off.
 */
export function resolveWalRestartThresholdBytes(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

/**
 * The coordinator of a node whose maintenance reopen is off. It never pauses
 * admission and never asks for a reopen. It samples the retained WAL on the
 * same schedule and says so when the log is large, once at the notice size
 * and again each time the log has doubled, so that growth without a bound is
 * visible in the node's log before it shows on the disk.
 */
function createWalGrowthObserver(
  options: OxigraphWalMaintenanceOptions,
): OxigraphWalMaintenanceCoordinator {
  const checkIntervalMs = positiveInteger(options.checkIntervalMs, DEFAULT_CHECK_INTERVAL_MS);
  const schedule = options.schedule ?? setInterval;
  const cancel = options.cancel ?? clearInterval;
  let nextNoticeBytes = WAL_GROWTH_NOTICE_BYTES;
  let measurementFailing = false;
  let stopped = false;

  const observe = (): void => {
    if (stopped || !options.serverAvailable()) return;
    let walBytes: number;
    try {
      walBytes = options.measureRetainedWalBytes(options.location);
    } catch (error) {
      // This samples once a minute for the life of the server: one line per
      // run of failures, not one per sample.
      if (!measurementFailing) {
        measurementFailing = true;
        options.log(
          `[oxigraph] retained WAL measurement failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    measurementFailing = false;
    // Any reopen of the store (a node restart, a crash or deadline recovery)
    // replays and truncates the log, so the notices start over.
    if (walBytes < WAL_GROWTH_NOTICE_BYTES) {
      nextNoticeBytes = WAL_GROWTH_NOTICE_BYTES;
      return;
    }
    if (walBytes < nextNoticeBytes) return;
    nextNoticeBytes = walBytes * 2;
    options.log(
      `[oxigraph] ${formatWalBytes(walBytes)} of write-ahead log is retained and it grows until the store is reopened; `
      + `the maintenance reopen is off. A restart of the node reclaims it. `
      + `Set store.options.walRestartThresholdBytes to have the node reopen the store at a size you choose.`,
    );
  };

  const timer = schedule(observe, checkIntervalMs);
  timer.unref?.();
  const inertLease: OxigraphWalMaintenanceActivityLease = { report(): void {}, dispose(): void {} };

  return {
    registerActivity: () => inertLease,
    admissionsPaused: () => false,
    serverLifecycleChanged(): void {},
    stop(): void {
      if (stopped) return;
      stopped = true;
      cancel(timer);
    },
  };
}

/** Owns the idle, threshold, cooldown, timer, and measurement policy for WAL reopening. */
export function createOxigraphWalMaintenanceCoordinator(
  options: OxigraphWalMaintenanceOptions,
): OxigraphWalMaintenanceCoordinator {
  if (options.thresholdBytes === undefined) return createWalGrowthObserver(options);
  const thresholdBytes = options.thresholdBytes;
  const checkIntervalMs = positiveInteger(options.checkIntervalMs, DEFAULT_CHECK_INTERVAL_MS);
  const idleMs = positiveInteger(options.idleMs, DEFAULT_IDLE_MS);
  const cooldownMs = positiveInteger(options.cooldownMs, DEFAULT_COOLDOWN_MS);
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? setInterval;
  const cancel = options.cancel ?? clearInterval;
  const activitySources = new Map<symbol, boolean>();
  let idleSince: number | null = null;
  let lastRestartAt = Number.NEGATIVE_INFINITY;
  let maintenancePending = false;
  let recoverySubscription: (() => void) | undefined;
  let stopped = false;

  const anyStoreBusy = (): boolean => [...activitySources.values()].some(Boolean);

  // One owner derives idle eligibility after activity and lifecycle changes.
  const refreshIdleClock = (reset = false): void => {
    if (stopped || !options.serverAvailable() || anyStoreBusy()) {
      idleSince = null;
    } else if (reset || idleSince === null) {
      idleSince = now();
    }
  };

  const evaluate = (): void => {
    if (stopped) return;
    refreshIdleClock();
    const observedAt = now();
    const busy = anyStoreBusy();
    if (!options.serverAvailable() || recoverySubscription) return;

    // Measure while the server is busy. Waiting to observe an idle tick before
    // looking at disk means a continuously loaded node can grow past the
    // threshold forever. Once the threshold is crossed, close admission and
    // let already-admitted operations drain before opening the idle window.
    if (!maintenancePending && observedAt - lastRestartAt >= cooldownMs) {
      let walBytes: number;
      try {
        walBytes = options.measureRetainedWalBytes(options.location);
      } catch (error) {
        options.log(
          `[oxigraph] retained WAL maintenance measurement failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      if (walBytes < thresholdBytes) return;
      maintenancePending = true;
      options.log(
        `[oxigraph] ${formatWalBytes(walBytes)} retained WAL reached the `
        + `${formatWalBytes(thresholdBytes)} maintenance threshold; `
        + `pausing new store work until busy stores drain`,
      );
    }

    if (busy || idleSince === null) return;
    if (!maintenancePending) return;
    if (observedAt - idleSince < idleMs) return;
    const reason = `retained WAL reached the ${formatWalBytes(thresholdBytes)} maintenance threshold `
      + `after ${Math.round((observedAt - idleSince) / 1_000)}s idle`;
    const recovery = options.requestRecovery(reason);
    if (!recovery) return;
    let ended = false;
    const dispose = recovery.subscribe(phase => {
      if (stopped) return;
      if (phase === 'reopened') {
        lastRestartAt = now(); maintenancePending = false;
      } else if (phase !== 'cancelled' && phase !== 'stopped') return;
      ended = true;
      recoverySubscription?.(); recoverySubscription = undefined;
      refreshIdleClock(true);
    });
    if (ended) dispose(); else recoverySubscription = dispose;

  };

  const timer = schedule(evaluate, checkIntervalMs);
  timer.unref?.();

  return {
    registerActivity(): OxigraphWalMaintenanceActivityLease {
      const key = Symbol('oxigraph-store-activity');
      activitySources.set(key, false);
      let disposed = false;
      return {
        report(busy: boolean): void {
          if (stopped || disposed) return;
          if (typeof busy !== 'boolean') return;
          activitySources.set(key, busy);
          refreshIdleClock();
        },
        dispose(): void {
          if (disposed) return;
          disposed = true;
          activitySources.delete(key);
          refreshIdleClock();
        },
      };
    },
    admissionsPaused(): boolean {
      return !stopped && maintenancePending;
    },
    // Cancellation and reopen arrive through the generation-bound handle.
    serverLifecycleChanged(completion?: 'confirmed-reopen'): void {
      if (stopped) return;
      // Any confirmed supervised reopen has reclaimed the retained WAL,
      // including a crash or client-timeout recovery during maintenance drain.
      if (completion === 'confirmed-reopen') {
        lastRestartAt = now(); maintenancePending = false;
        recoverySubscription?.(); recoverySubscription = undefined;
      }
      refreshIdleClock(true);
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      maintenancePending = false;
      recoverySubscription?.(); recoverySubscription = undefined;
      activitySources.clear();
      refreshIdleClock();
      cancel(timer);
    },
  };
}
