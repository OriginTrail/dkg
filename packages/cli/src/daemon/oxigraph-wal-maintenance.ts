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
  serverAvailable: () => boolean;
  log: (message: string) => void;
  now?: () => number;
  schedule?: (callback: () => void, intervalMs: number) => IntervalHandle;
  cancel?: (handle: IntervalHandle) => void;
}

export interface OxigraphWalMaintenanceActivityLease {
  report(activeOperations: number): void;
  dispose(): void;
}

export interface OxigraphWalMaintenanceCoordinator {
  reportActivity(activeOperations: number): void;
  registerActivity(): OxigraphWalMaintenanceActivityLease;
  admissionsPaused(): boolean;
  serverLifecycleChanged(): void;
  restartCancelled(): void;
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
  let legacyActiveOperations = 0;
  const activitySources = new Map<symbol, number>();
  let idleSince: number | null = null;
  let lastRestartAt = Number.NEGATIVE_INFINITY;
  let maintenancePending = false;
  let stopped = false;

  const totalActiveOperations = (): number => legacyActiveOperations
    + [...activitySources.values()].reduce((sum, active) => sum + active, 0);

  const evaluate = (): void => {
    const observedAt = now();
    const activeOperations = totalActiveOperations();
    if (!options.serverAvailable()) {
      idleSince = null;
      return;
    }

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
        + `pausing new store work until ${activeOperations} active operation(s) drain`,
      );
    }

    if (!maintenancePending) {
      if (activeOperations !== 0) idleSince = null;
      else if (idleSince === null) idleSince = observedAt;
      return;
    }
    if (activeOperations !== 0) {
      idleSince = null;
      return;
    }
    if (idleSince === null) {
      idleSince = observedAt;
      return;
    }
    if (observedAt - idleSince < idleMs) return;
    const accepted = options.requestRestart(
      `retained WAL reached the ${formatWalBytes(thresholdBytes)} maintenance threshold `
      + `after ${Math.round((observedAt - idleSince) / 1_000)}s idle`,
    );
    if (accepted) {
      idleSince = null;
    }
  };

  const timer = schedule(evaluate, checkIntervalMs);
  timer.unref?.();

  const updateActivity = (activeOperations: number): void => {
    if (activeOperations > 0) idleSince = null;
    else if (options.serverAvailable() && idleSince === null) idleSince = now();
  };

  return {
    reportActivity(active: number): void {
      if (stopped) return;
      if (!Number.isSafeInteger(active) || active < 0) return;
      legacyActiveOperations = active;
      updateActivity(totalActiveOperations());
    },
    registerActivity(): OxigraphWalMaintenanceActivityLease {
      const key = Symbol('oxigraph-store-activity');
      activitySources.set(key, 0);
      let disposed = false;
      return {
        report(active: number): void {
          if (stopped || disposed) return;
          if (!Number.isSafeInteger(active) || active < 0) return;
          activitySources.set(key, active);
          updateActivity(totalActiveOperations());
        },
        dispose(): void {
          if (disposed) return;
          disposed = true;
          activitySources.delete(key);
          updateActivity(totalActiveOperations());
        },
      };
    },
    admissionsPaused(): boolean {
      return !stopped && maintenancePending;
    },
    serverLifecycleChanged(): void {
      if (stopped) return;
      idleSince = options.serverAvailable() && totalActiveOperations() === 0 ? now() : null;
    },
    restartCancelled(): void {
      if (stopped || !maintenancePending) return;
      idleSince = options.serverAvailable() && totalActiveOperations() === 0 ? now() : null;
    },
    restartCompleted(): void {
      if (stopped || !maintenancePending) return;
      lastRestartAt = now();
      maintenancePending = false;
      idleSince = null;
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      idleSince = null;
      maintenancePending = false;
      activitySources.clear();
      cancel(timer);
    },
  };
}
