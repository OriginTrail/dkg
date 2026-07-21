import { describe, expect, it } from 'vitest';
import {
  formatMetricsCollectorStartupLog,
  resolveMetricsCollectorConfig,
} from '../src/metrics-collector-config.js';

describe('resolveMetricsCollectorConfig', () => {
  it('keeps local metric collection enabled by default', () => {
    expect(resolveMetricsCollectorConfig(undefined, {})).toEqual({ enabled: true });
  });

  it('disables local collection without changing OTLP metrics.enabled', () => {
    expect(resolveMetricsCollectorConfig({
      telemetry: { metrics: { enabled: true, collectionEnabled: false } },
    }, {})).toEqual({ enabled: false });
  });

  it.each([
    ['1', true],
    ['true', true],
    ['0', false],
    ['false', false],
  ])('accepts environment toggle %j', (value, enabled) => {
    expect(resolveMetricsCollectorConfig(undefined, {
      DKG_METRICS_COLLECTION_ENABLED: value,
    })).toEqual({ enabled });
  });

  it('gives the environment override precedence over config', () => {
    expect(resolveMetricsCollectorConfig({
      telemetry: { metrics: { collectionEnabled: false } },
    }, { DKG_METRICS_COLLECTION_ENABLED: '1' })).toEqual({ enabled: true });
  });

  it('rejects invalid environment values', () => {
    expect(() => resolveMetricsCollectorConfig(undefined, {
      DKG_METRICS_COLLECTION_ENABLED: 'yes',
    })).toThrow(/DKG_METRICS_COLLECTION_ENABLED/);
  });

  it('rejects non-boolean config values', () => {
    expect(() => resolveMetricsCollectorConfig({
      telemetry: { metrics: { collectionEnabled: 'yes' } },
    } as never, {})).toThrow(/telemetry\.metrics\.collectionEnabled/);
  });
});

describe('formatMetricsCollectorStartupLog', () => {
  it('preserves the enabled startup log', () => {
    expect(formatMetricsCollectorStartupLog({ enabled: true }))
      .toBe('Metrics collector started (30s interval)');
  });

  it('reports when local collection is disabled', () => {
    expect(formatMetricsCollectorStartupLog({ enabled: false }))
      .toBe('Metrics collector disabled');
  });
});
