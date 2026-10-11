import type { ManagedOxigraphRecoveryHandleV1 } from '@origintrail-official/dkg-storage';
import { formatWalBytes } from './oxigraph-wal.js';

export const DEFAULT_WAL_RESTART_THRESHOLD_BYTES = 4 * 1024 ** 3;
const DEFAULT_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1_000;

type IntervalHandle = ReturnType<typeof setInterval>;

export interface OxigraphWalMaintenanceOptions {
  location: string;
  thresholdBytes: number;
  checkIntervalMs?: number;
  idleMs?: number;
  cooldownMs?: number;
  measureRetainedWalBytes: (location: string) => number;
  requestRestart: (reason: string) => boolean;
  requestRecovery?: (reason: string) => ManagedOxigraphRecoveryHandleV1 | undefined;
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
  serverLifecycleChanged(): void;
  restartCompleted(): void;
  stop(): void;
}

export function resolveWalRestartThresholdBytes(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_WAL_RESTART_THRESHOLD_BYTES;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

/** Owns the idle, threshold, cooldown, timer, and measurement policy for WAL reopening. */
export function createOxigraphWalMaintenanceCoordinator(
  options: OxigraphWalMaintenanceOptions,
): OxigraphWalMaintenanceCoordinator {
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
  // Real supervision owns recovery progress; the boolean serves legacy callbacks only.
  let restartRequested = false;
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
    if (!options.serverAvailable() || restartRequested || recoverySubscription) return;

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
    if (options.requestRecovery) {
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
    } else if (options.requestRestart(reason)) {
      restartRequested = true;
      refreshIdleClock(true);
    }

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
    // Legacy notification-only restarts observe readiness here. Real recovery
    // cancellation and reopen arrive through the generation-bound handle.
    serverLifecycleChanged(): void {
      if (stopped) return;
      if (options.serverAvailable()) restartRequested = false;
      refreshIdleClock(true);
    },
    restartCompleted(): void {
      if (stopped || !maintenancePending) return;
      lastRestartAt = now();
      maintenancePending = false;
      restartRequested = false;
      refreshIdleClock(true);
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      maintenancePending = false;
      restartRequested = false;
      recoverySubscription?.(); recoverySubscription = undefined;
      activitySources.clear();
      refreshIdleClock();
      cancel(timer);
    },
  };
}
