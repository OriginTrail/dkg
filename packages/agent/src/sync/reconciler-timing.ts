import {
  SYNC_BACKOFF_BASE_MS,
  SYNC_BACKOFF_JITTER,
  SYNC_BACKOFF_MAX_MS,
  SYNC_RECONCILER_INTERVAL_MS,
  SYNC_STALENESS_THRESHOLD_MS,
} from '../dkg-agent-constants.js';

export interface SyncReconcilerTimingConfig {
  syncReconcilerIntervalMs?: number;
  syncStalenessThresholdMs?: number;
  syncBackoffBaseMs?: number;
  syncBackoffMaxMs?: number;
  syncBackoffJitter?: number;
}

export interface SyncReconcilerTiming {
  intervalMs: number;
  stalenessThresholdMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  backoffJitter: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function unitInterval(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

/** Resolve node-owner sync timing without allowing zero, negative, or unbounded jitter. */
export function resolveSyncReconcilerTiming(
  config: SyncReconcilerTimingConfig,
): SyncReconcilerTiming {
  const intervalMs = positiveInteger(
    config.syncReconcilerIntervalMs,
    SYNC_RECONCILER_INTERVAL_MS,
  );
  const stalenessThresholdMs = positiveInteger(
    config.syncStalenessThresholdMs,
    SYNC_STALENESS_THRESHOLD_MS,
  );
  const backoffBaseMs = positiveInteger(config.syncBackoffBaseMs, SYNC_BACKOFF_BASE_MS);
  const configuredMaxMs = positiveInteger(config.syncBackoffMaxMs, SYNC_BACKOFF_MAX_MS);
  return {
    intervalMs,
    stalenessThresholdMs,
    backoffBaseMs,
    backoffMaxMs: Math.max(backoffBaseMs, configuredMaxMs),
    backoffJitter: unitInterval(config.syncBackoffJitter, SYNC_BACKOFF_JITTER),
  };
}
