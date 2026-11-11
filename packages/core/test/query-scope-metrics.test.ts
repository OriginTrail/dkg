import { afterEach, expect, it } from 'vitest';
import { metrics as otelMetrics } from '@opentelemetry/api';
import { rebuildMetrics } from '../src/telemetry-api.js';

afterEach(() => {
  otelMetrics.disable();
  rebuildMetrics();
});

it('declares the query scope meters with dotted names, millisecond store time and graph-count buckets', () => {
  const declared = new Map<string, { kind: string; options: Record<string, unknown> }>();
  const instrument = (kind: string) => (name: string, options: Record<string, unknown> = {}) => {
    declared.set(name, { kind, options });
    return { add() {}, record() {} };
  };
  otelMetrics.setGlobalMeterProvider({
    getMeter: () => ({
      createCounter: instrument('counter'),
      createHistogram: instrument('histogram'),
      createGauge: instrument('gauge'),
      createUpDownCounter: instrument('up-down-counter'),
    }),
  } as never);
  rebuildMetrics();

  expect(declared.get('dkg.query.scope_requests_total')).toMatchObject({ kind: 'counter' });
  expect(declared.get('dkg.query.scope_over_limit_total')).toMatchObject({ kind: 'counter' });
  expect(declared.get('dkg.query.scope_slice_graphs')).toMatchObject({
    kind: 'histogram',
    options: { advice: { explicitBucketBoundaries: [1, 10, 100, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000] } },
  });
  const storeTime = declared.get('dkg.query.scope_store_ms');
  expect(storeTime).toMatchObject({ kind: 'histogram', options: { unit: 'ms' } });
  const bounds = (storeTime!.options.advice as { explicitBucketBoundaries: number[] }).explicitBucketBoundaries;
  // From quick in-memory reads to reads that run for minutes, every bound finite.
  expect(bounds[0]).toBeLessThanOrEqual(10);
  expect(bounds[bounds.length - 1]).toBeGreaterThanOrEqual(120_000);
});
