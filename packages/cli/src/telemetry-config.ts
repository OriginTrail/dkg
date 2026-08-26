import type { DkgConfig } from './config.js';

/**
 * Pure resolution of the daemon's telemetry routing — extracted from
 * `lifecycle.ts` so it is unit-testable (endpoint precedence, no-TBD-default,
 * per-signal gating, log-exporter selection).
 */

export type LogExporterMode = 'none' | 'otlp' | 'syslog';
export type ActiveLogExporterMode = Exclude<LogExporterMode, 'none'>;

/** Resolve OTLP logs with standard signal-specific > base > config precedence. */
export function resolveOtlpLogEndpoint(
  telemetry: DkgConfig['telemetry'],
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const envBase = env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/+$/, '');
  return env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
    || (envBase ? `${envBase}/v1/logs` : undefined)
    || telemetry?.logs?.endpoint;
}

/**
 * Which log exporter the daemon should start. Only consulted when
 * `telemetry.enabled`. UNSET defaults to 'syslog' (preserves prior behaviour),
 * but the config is user-provided JSON/YAML so the TS union does NOT protect
 * this boundary: an unknown/typo'd value (e.g. "none " / "otpl" / "disabled")
 * must FAIL CLOSED to 'none' — never silently fall through to syslog and ship
 * logs off-node against the operator's intent. Returns null `mode` info via the
 * second tuple element so the caller can warn on an unrecognized value.
 */
export function resolveLogExporterMode(telemetry: DkgConfig['telemetry']): LogExporterMode {
  const raw = telemetry?.logs?.exporter;
  if (raw === undefined || raw === null) return 'syslog'; // documented default when UNSET
  if (raw === 'none' || raw === 'otlp' || raw === 'syslog') return raw;
  return 'none'; // unknown/typo → fail closed (local-only, never off-node)
}

/** True when `telemetry.logs.exporter` is set to a value outside the known enum. */
export function isUnknownLogExporter(telemetry: DkgConfig['telemetry']): boolean {
  const raw = telemetry?.logs?.exporter;
  return raw !== undefined && raw !== null && raw !== 'none' && raw !== 'otlp' && raw !== 'syslog';
}

export interface ResolvedOtelSignals {
  tracesEndpoint?: string;
  metricsEndpoint?: string;
  /** Register traces only when an endpoint resolves AND not explicitly disabled. */
  tracesOn: boolean;
  metricsOn: boolean;
}

/**
 * Resolve OTLP traces/metrics endpoints env-first (standard `OTEL_EXPORTER_OTLP_*`
 * names) then config. A signal is "on" only when an endpoint resolves and it is
 * not explicitly disabled — there is NO guessed/TBD production default.
 */
export function resolveOtelSignals(
  telemetry: DkgConfig['telemetry'],
  env: Record<string, string | undefined> = process.env,
): ResolvedOtelSignals {
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/$/, '');
  const tracesEndpoint =
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
    (base ? `${base}/v1/traces` : undefined) ||
    telemetry?.traces?.endpoint;
  const metricsEndpoint =
    env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ||
    (base ? `${base}/v1/metrics` : undefined) ||
    telemetry?.metrics?.endpoint;
  return {
    tracesEndpoint,
    metricsEndpoint,
    tracesOn: !!tracesEndpoint && telemetry?.traces?.enabled !== false,
    metricsOn: !!metricsEndpoint && telemetry?.metrics?.enabled !== false,
  };
}
