import type { DkgConfig } from './config.js';

// Kept in sync with @origintrail-official/dkg-node-ui's constructor guard.
// This resolver lives in the CLI package so config errors are reported before
// daemon lifecycle constructs the collector.
export const DEFAULT_METRICS_COLLECTION_INTERVAL_MS = 30_000;
export const DEFAULT_STORE_METRICS_COLLECTION_INTERVAL_MS = 43_200_000;
export const MIN_METRICS_COLLECTION_INTERVAL_MS = 1_000;
export const MAX_METRICS_COLLECTION_INTERVAL_MS = 2_147_483_647;

export interface ResolvedMetricsCollectorConfig {
  enabled: boolean;
  collectionIntervalMs: number;
  storeCollectionIntervalMs: number;
}

function resolveEnabled(configValue: unknown, envValue: string | undefined): boolean {
  if (envValue !== undefined) {
    const normalized = envValue.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true') return true;
    if (normalized === '0' || normalized === 'false') return false;
    throw new Error(
      'DKG_METRICS_COLLECTION_ENABLED must be one of 1, 0, true, or false ' +
      `(received ${JSON.stringify(envValue)})`,
    );
  }
  if (configValue === undefined) return true;
  if (typeof configValue !== 'boolean') {
    throw new Error(
      'telemetry.metrics.collectionEnabled must be a boolean ' +
      `(received ${JSON.stringify(configValue)})`,
    );
  }
  return configValue;
}

function resolveInterval(
  field: string,
  envName: string,
  envValue: string | undefined,
  configValue: unknown,
  defaultValue: number,
): number {
  const candidate = envValue !== undefined ? Number(envValue) : (configValue ?? defaultValue);
  if (
    typeof candidate !== 'number' ||
    !Number.isFinite(candidate) ||
    !Number.isInteger(candidate) ||
    candidate < MIN_METRICS_COLLECTION_INTERVAL_MS ||
    candidate > MAX_METRICS_COLLECTION_INTERVAL_MS
  ) {
    const source = envValue !== undefined ? envName : field;
    throw new Error(
      `${source}: ${field} must be a finite integer between ` +
      `${MIN_METRICS_COLLECTION_INTERVAL_MS} and ${MAX_METRICS_COLLECTION_INTERVAL_MS} ms ` +
      `(received ${String(candidate)})`,
    );
  }
  return candidate;
}

/**
 * Resolve local Node UI snapshot collection independently from OTLP export.
 * Dedicated DKG_* environment variables win over config values; invalid env
 * values fail startup rather than silently falling back to config.
 */
export function resolveMetricsCollectorConfig(
  config: Pick<DkgConfig, 'telemetry'> | null | undefined,
  env: Record<string, string | undefined> = process.env,
): ResolvedMetricsCollectorConfig {
  const metrics = config?.telemetry?.metrics;
  return {
    enabled: resolveEnabled(
      metrics?.collectionEnabled,
      env.DKG_METRICS_COLLECTION_ENABLED,
    ),
    collectionIntervalMs: resolveInterval(
      'telemetry.metrics.collectionIntervalMs',
      'DKG_METRICS_COLLECTION_INTERVAL_MS',
      env.DKG_METRICS_COLLECTION_INTERVAL_MS,
      metrics?.collectionIntervalMs,
      DEFAULT_METRICS_COLLECTION_INTERVAL_MS,
    ),
    storeCollectionIntervalMs: resolveInterval(
      'telemetry.metrics.storeCollectionIntervalMs',
      'DKG_STORE_METRICS_COLLECTION_INTERVAL_MS',
      env.DKG_STORE_METRICS_COLLECTION_INTERVAL_MS,
      metrics?.storeCollectionIntervalMs,
      DEFAULT_STORE_METRICS_COLLECTION_INTERVAL_MS,
    ),
  };
}

/** Startup line used by daemon lifecycle and pinned by unit tests. */
export function formatMetricsCollectorStartupLog(
  resolved: ResolvedMetricsCollectorConfig,
): string {
  if (!resolved.enabled) return 'Metrics collector disabled';
  return (
    'Metrics collector started ' +
    `(systemIntervalMs=${resolved.collectionIntervalMs}, ` +
    `storeIntervalMs=${resolved.storeCollectionIntervalMs}, immediateInitialCollection=true)`
  );
}
