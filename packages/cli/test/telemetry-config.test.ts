import { describe, it, expect } from 'vitest';
import { resolveOtelSignals, resolveLogExporterMode, isUnknownLogExporter } from '../src/telemetry-config.js';

/**
 * Daemon telemetry-routing resolution (the logic lifecycle.ts uses to pick the
 * log exporter and to register OTLP traces/metrics). Verifies env precedence,
 * the no-TBD-prod-default rule, and per-signal gating.
 */

describe('resolveLogExporterMode', () => {
  it('defaults to syslog when unset (preserves prior behaviour)', () => {
    expect(resolveLogExporterMode(undefined)).toBe('syslog');
    expect(resolveLogExporterMode({ enabled: true })).toBe('syslog');
  });
  it('honors an explicit exporter', () => {
    expect(resolveLogExporterMode({ enabled: true, logs: { exporter: 'otlp' } })).toBe('otlp');
    expect(resolveLogExporterMode({ enabled: true, logs: { exporter: 'none' } })).toBe('none');
    expect(resolveLogExporterMode({ enabled: true, logs: { exporter: 'syslog' } })).toBe('syslog');
  });
  it('FAILS CLOSED to none for an unknown/typo exporter (never silently syslog → off-node)', () => {
    // Config is user JSON/YAML — the TS union does not guard this at runtime.
    for (const bad of ['none ', 'otpl', 'syslogg', 'disabled', 'OTLP', '']) {
      expect(resolveLogExporterMode({ enabled: true, logs: { exporter: bad } } as any)).toBe('none');
      expect(isUnknownLogExporter({ enabled: true, logs: { exporter: bad } } as any)).toBe(true);
    }
    // Known values + unset are NOT flagged as unknown.
    expect(isUnknownLogExporter({ enabled: true, logs: { exporter: 'otlp' } })).toBe(false);
    expect(isUnknownLogExporter({ enabled: true })).toBe(false);
    expect(isUnknownLogExporter(undefined)).toBe(false);
  });
});

describe('resolveOtelSignals', () => {
  it('is OFF when no endpoint resolves — never a guessed prod default', () => {
    const r = resolveOtelSignals({ enabled: true }, {});
    expect(r.tracesOn).toBe(false);
    expect(r.metricsOn).toBe(false);
    expect(r.tracesEndpoint).toBeUndefined();
    expect(r.metricsEndpoint).toBeUndefined();
  });

  it('uses per-signal config endpoints', () => {
    const r = resolveOtelSignals(
      { enabled: true, traces: { endpoint: 'http://c/v1/traces' }, metrics: { endpoint: 'http://c/v1/metrics' } },
      {},
    );
    expect(r.tracesOn).toBe(true);
    expect(r.tracesEndpoint).toBe('http://c/v1/traces');
    expect(r.metricsOn).toBe(true);
    expect(r.metricsEndpoint).toBe('http://c/v1/metrics');
  });

  it('derives per-signal paths from OTEL_EXPORTER_OTLP_ENDPOINT (base, trailing slash trimmed)', () => {
    const r = resolveOtelSignals({ enabled: true }, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://base:4318/' });
    expect(r.tracesEndpoint).toBe('http://base:4318/v1/traces');
    expect(r.metricsEndpoint).toBe('http://base:4318/v1/metrics');
    expect(r.tracesOn).toBe(true);
    expect(r.metricsOn).toBe(true);
  });

  it('precedence: signal-specific env > base env > config', () => {
    const r = resolveOtelSignals(
      { enabled: true, metrics: { endpoint: 'http://cfg/v1/metrics' } },
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://base:4318',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://specific/v1/metrics',
      },
    );
    expect(r.metricsEndpoint).toBe('http://specific/v1/metrics');
  });

  it('a signal explicitly disabled stays OFF even with an endpoint', () => {
    const r = resolveOtelSignals(
      { enabled: true, traces: { endpoint: 'http://c/v1/traces', enabled: false } },
      {},
    );
    expect(r.tracesEndpoint).toBe('http://c/v1/traces');
    expect(r.tracesOn).toBe(false);
  });
});
