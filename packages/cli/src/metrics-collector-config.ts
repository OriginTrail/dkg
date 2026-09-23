import type { DkgConfig } from './config.js';
import { resolveBooleanEnvOverride } from './boolean-env-override.js';

export interface ResolvedMetricsCollectorConfig {
  enabled: boolean;
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
    enabled: resolveBooleanEnvOverride({
      envName: 'DKG_METRICS_COLLECTION_ENABLED',
      configName: 'telemetry.metrics.collectionEnabled',
      envValue: env.DKG_METRICS_COLLECTION_ENABLED,
      configValue: config?.telemetry?.metrics?.collectionEnabled,
      defaultValue: true,
    }),
  };
}

export function formatMetricsCollectorStartupLog(
  resolved: ResolvedMetricsCollectorConfig,
): string {
  return resolved.enabled
    ? 'Metrics collector started (30s interval)'
    : 'Metrics collector disabled';
}
