import { afterEach, describe, expect, it } from 'vitest';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  Logger,
  SyncAttemptObserver,
  rebuildMetrics,
  type LogRecord,
} from '@origintrail-official/dkg-core';

describe('SyncAttemptObserver', () => {
  let meterProvider: MeterProvider | undefined;

  afterEach(async () => {
    Logger.setSink(null);
    if (meterProvider) await meterProvider.shutdown().catch(() => undefined);
    meterProvider = undefined;
    metrics.disable();
    rebuildMetrics();
  });

  it('records one start and one terminal result per requested plane', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    meterProvider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 60_000,
      })],
    });
    metrics.setGlobalMeterProvider(meterProvider);
    rebuildMetrics();

    const logs: LogRecord[] = [];
    Logger.setSink((record) => logs.push(record));
    const times = [1_000, 16_000];
    const observer = new SyncAttemptObserver({
      logger: new Logger('sync-test'),
      context: { operationId: 'sync-op', operationName: 'sync' },
      contextGraphId: 'cg-test',
      trigger: 'subscription',
      planes: ['vm', 'swm'],
      now: () => times.shift() ?? 16_000,
    });

    expect(observer.finish('vm', 'success', { triplesSynced: 42 })).toBe(true);
    expect(observer.finish('vm', 'failed')).toBe(false);
    observer.finishRemaining('timeout');
    await meterProvider.forceFlush();

    const points = (metricName: string) => exporter.getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .filter((metric) => metric.descriptor.name === metricName)
      .flatMap((metric) => metric.dataPoints as Array<{
        attributes: Record<string, unknown>;
        value: number;
      }>);

    expect(points('dkg.sync.plane.started.total')).toHaveLength(2);
    expect(points('dkg.sync.plane.terminal.total')).toEqual(expect.arrayContaining([
      expect.objectContaining({ attributes: expect.objectContaining({ plane: 'vm', outcome: 'success' }), value: 1 }),
      expect.objectContaining({ attributes: expect.objectContaining({ plane: 'swm', outcome: 'timeout' }), value: 1 }),
    ]));
    expect(points('dkg.sync.plane.active').map((point) => point.value)).toEqual([0, 0]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({
      eventCode: 'sync.plane.terminal',
      syncPlane: 'vm',
      outcome: 'success',
      durationMs: 15_000,
      triplesSynced: 42,
    });
    expect(logs[1]).toMatchObject({
      syncPlane: 'swm',
      outcome: 'timeout',
      retryable: true,
      errorCode: 'SYNC_PLANE_TIMEOUT',
    });
  });
});
