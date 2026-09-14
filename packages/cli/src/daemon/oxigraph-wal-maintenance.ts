import { formatWalBytes } from './oxigraph-wal.js';

export const DEFAULT_WAL_RESTART_THRESHOLD_BYTES = 4 * 1024 ** 3;
const DEFAULT_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1_000;

type IntervalHandle = ReturnType<typeof setInterval>;

export interface OxigraphWalMaintenanceOptions {
  location: string;
  thresholdBytes?: number;
  checkIntervalMs?: number;
  idleMs?: number;
  cooldownMs?: number;
  measureRetainedWalBytes: (location: string) => number;
  requestRestart: (reason: string) => boolean;
  log: (message: string) => void;
  now?: () => number;
  schedule?: (callback: () => void, intervalMs: number) => IntervalHandle;
  cancel?: (handle: IntervalHandle) => void;
}

export interface OxigraphWalMaintenanceCoordinator {
  reportActivity(activeOperations: number): void;
  serverReady(): void;
  serverUnavailable(): void;
  stop(): void;
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
  const thresholdBytes = positiveInteger(
    options.thresholdBytes,
    DEFAULT_WAL_RESTART_THRESHOLD_BYTES,
  );
  const checkIntervalMs = positiveInteger(options.checkIntervalMs, DEFAULT_CHECK_INTERVAL_MS);
  const idleMs = positiveInteger(options.idleMs, DEFAULT_IDLE_MS);
  const cooldownMs = positiveInteger(options.cooldownMs, DEFAULT_COOLDOWN_MS);
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? setInterval;
  const cancel = options.cancel ?? clearInterval;
  let activeOperations = 0;
  let available = false;
  let idleSince: number | null = null;
  let lastRestartAt = Number.NEGATIVE_INFINITY;
  let timer: IntervalHandle | undefined;

  const evaluate = (): void => {
    const observedAt = now();
    if (
      !available
      || activeOperations !== 0
      || idleSince === null
      || observedAt - idleSince < idleMs
      || observedAt - lastRestartAt < cooldownMs
    ) return;
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
    const accepted = options.requestRestart(
      `${formatWalBytes(walBytes)} retained WAL reached the `
      + `${formatWalBytes(thresholdBytes)} maintenance threshold `
      + `after ${Math.round((observedAt - idleSince) / 1_000)}s idle`,
    );
    if (accepted) {
      lastRestartAt = observedAt;
      available = false;
      idleSince = null;
    }
  };

  return {
    reportActivity(active: number): void {
      if (!Number.isSafeInteger(active) || active < 0) return;
      activeOperations = active;
      if (active > 0) idleSince = null;
      else if (available && idleSince === null) idleSince = now();
    },
    serverReady(): void {
      available = true;
      idleSince = activeOperations === 0 ? now() : null;
      if (timer) return;
      timer = schedule(evaluate, checkIntervalMs);
      timer.unref?.();
    },
    serverUnavailable(): void {
      available = false;
      idleSince = null;
    },
    stop(): void {
      available = false;
      idleSince = null;
      if (timer) cancel(timer);
      timer = undefined;
    },
  };
}
