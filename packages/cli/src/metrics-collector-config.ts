import type { DkgConfig } from './config.js';

export interface ResolvedMetricsCollectorConfig {
  enabled: boolean;
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

/**
 * Resolve local Node UI snapshot collection independently from OTLP export.
 * The dedicated environment variable wins over config; invalid values fail
 * startup rather than silently enabling collection.
 */
export function resolveMetricsCollectorConfig(
  config: Pick<DkgConfig, 'telemetry'> | null | undefined,
  env: Record<string, string | undefined> = process.env,
): ResolvedMetricsCollectorConfig {
  return {
    enabled: resolveEnabled(
      config?.telemetry?.metrics?.collectionEnabled,
      env.DKG_METRICS_COLLECTION_ENABLED,
    ),
  };
}

export function formatMetricsCollectorStartupLog(
  resolved: ResolvedMetricsCollectorConfig,
): string {
  return resolved.enabled
    ? 'Metrics collector started (30s interval)'
    : 'Metrics collector disabled';
}
