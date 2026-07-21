import { describe, expect, it } from 'vitest';
import {
  formatMetricsCollectorStartupLog,
  resolveMetricsCollectorConfig,
} from '../src/metrics-collector-config.js';

describe('resolveMetricsCollectorConfig', () => {
  it('keeps the 30-second cheap default and uses the conservative 12-hour store default', () => {
    expect(resolveMetricsCollectorConfig(undefined, {})).toEqual({
      enabled: true,
      collectionIntervalMs: 30_000,
      storeCollectionIntervalMs: 43_200_000,
    });
  });

  it('accepts a configured 12-hour collection interval', () => {
    expect(resolveMetricsCollectorConfig({
      telemetry: { metrics: { collectionIntervalMs: 43_200_000 } },
    }, {}).collectionIntervalMs).toBe(43_200_000);
  });

  it('environment overrides take precedence over config', () => {
    const resolved = resolveMetricsCollectorConfig({
      telemetry: {
        metrics: {
          collectionEnabled: false,
          collectionIntervalMs: 60_000,
          storeCollectionIntervalMs: 120_000,
        },
      },
    }, {
      DKG_METRICS_COLLECTION_ENABLED: '1',
      DKG_METRICS_COLLECTION_INTERVAL_MS: '43200000',
      DKG_STORE_METRICS_COLLECTION_INTERVAL_MS: '86400000',
    });
    expect(resolved).toEqual({
      enabled: true,
      collectionIntervalMs: 43_200_000,
      storeCollectionIntervalMs: 86_400_000,
    });
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 30_000.5],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['below the safe minimum', 999],
    ['above the Node timer maximum', 2_147_483_648],
  ])('rejects %s config intervals', (_label, value) => {
    expect(() => resolveMetricsCollectorConfig({
      telemetry: { metrics: { collectionIntervalMs: value } },
    }, {})).toThrow(/telemetry\.metrics\.collectionIntervalMs/);
  });

  it.each(['0', '-1', '1.5', 'NaN', 'Infinity', '999', '2147483648', ''])
    ('rejects invalid environment interval %j without falling back to config', value => {
      expect(() => resolveMetricsCollectorConfig({
        telemetry: { metrics: { collectionIntervalMs: 60_000 } },
      }, { DKG_METRICS_COLLECTION_INTERVAL_MS: value })).toThrow(
        /DKG_METRICS_COLLECTION_INTERVAL_MS/,
      );
    });

  it('validates the independently configured store interval', () => {
    expect(() => resolveMetricsCollectorConfig({
      telemetry: { metrics: { storeCollectionIntervalMs: Number.NaN } },
    }, {})).toThrow(/telemetry\.metrics\.storeCollectionIntervalMs/);
  });

  it('supports the local collection toggle without changing OTLP metrics.enabled', () => {
    expect(resolveMetricsCollectorConfig({
      telemetry: { metrics: { enabled: true, collectionEnabled: false } },
    }, {}).enabled).toBe(false);
  });
});

describe('formatMetricsCollectorStartupLog', () => {
  it('reports the actual resolved system and store intervals', () => {
    expect(formatMetricsCollectorStartupLog({
      enabled: true,
      collectionIntervalMs: 60_000,
      storeCollectionIntervalMs: 43_200_000,
    })).toBe(
      'Metrics collector started ' +
      '(systemIntervalMs=60000, storeIntervalMs=43200000, immediateInitialCollection=true)',
    );
  });

  it('reports when local collection is disabled', () => {
    expect(formatMetricsCollectorStartupLog({
      enabled: false,
      collectionIntervalMs: 30_000,
      storeCollectionIntervalMs: 43_200_000,
    })).toBe('Metrics collector disabled');
  });
});
