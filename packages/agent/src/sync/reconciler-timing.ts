import {
  SYNC_BACKOFF_BASE_MS,
  SYNC_BACKOFF_JITTER,
  SYNC_BACKOFF_MAX_MS,
  SYNC_RECONCILER_INTERVAL_MS,
  SYNC_STALENESS_THRESHOLD_MS,
} from '../dkg-agent-constants.js';
import { RESOURCE_MAX, resourceInteger, type RejectedResourceSetting } from '../resource-limits.js';

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

function unitInterval(value: number | undefined, fallback: number, onRejected?: RejectedResourceSetting): number {
  if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)) {
    onRejected?.('syncBackoffJitter');
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

/** Resolve node-owner sync timing without allowing zero, negative, or unbounded jitter. */
export function resolveSyncReconcilerTiming(
  config: SyncReconcilerTimingConfig,
  onRejected?: RejectedResourceSetting,
): SyncReconcilerTiming {
  const positiveInteger = (value: number | undefined, fallback: number, name: string) =>
    resourceInteger(value, { min: 1, max: RESOURCE_MAX.timerMs }, name, onRejected) ?? fallback;
  const intervalMs = positiveInteger(
    config.syncReconcilerIntervalMs,
    SYNC_RECONCILER_INTERVAL_MS,
    'syncReconcilerIntervalMs',
  );
  const stalenessThresholdMs = positiveInteger(
    config.syncStalenessThresholdMs,
    SYNC_STALENESS_THRESHOLD_MS,
    'syncStalenessThresholdMs',
  );
  const backoffBaseMs = positiveInteger(config.syncBackoffBaseMs, SYNC_BACKOFF_BASE_MS, 'syncBackoffBaseMs');
  const configuredMaxMs = positiveInteger(config.syncBackoffMaxMs, SYNC_BACKOFF_MAX_MS, 'syncBackoffMaxMs');
  return {
    intervalMs,
    stalenessThresholdMs,
    backoffBaseMs,
    backoffMaxMs: Math.max(backoffBaseMs, configuredMaxMs),
    backoffJitter: unitInterval(config.syncBackoffJitter, SYNC_BACKOFF_JITTER, onRejected),
  };
}
