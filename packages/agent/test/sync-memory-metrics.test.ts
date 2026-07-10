import { afterEach, describe, expect, it } from 'vitest';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { rebuildMetrics } from '@origintrail-official/dkg-core';
import {
  createResponderSyncRowListMemo,
  type SyncRow,
} from '../src/sync/responder/graph-plan.js';
import { createSyncResponderSnapshotBudget } from '../src/sync/responder/snapshot-budget.js';
import { MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { fetchSyncPages } from '../src/sync/requester/page-fetch.js';

function createMetricsHarness() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
  });
  metrics.setGlobalMeterProvider(provider);
  rebuildMetrics();
  return { exporter, provider };
}

function metricPoints(exporter: InMemoryMetricExporter, name: string) {
  return exporter.getMetrics().flatMap((resourceMetric) =>
    resourceMetric.scopeMetrics.flatMap((scopeMetric) =>
      scopeMetric.metrics
        .filter((metric) => metric.descriptor.name === name)
        .flatMap((metric) => metric.dataPoints),
    ),
  );
}

let provider: MeterProvider | undefined;

afterEach(async () => {
  if (provider) await provider.shutdown().catch(() => {});
  provider = undefined;
  metrics.disable();
  rebuildMetrics();
});

describe('sync memory attribution metrics', () => {
  it('exports bounded responder ownership, load, eviction, and process-memory series', async () => {
    const harness = createMetricsHarness();
    provider = harness.provider;
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 2,
      maxBytesEstimate: Number.MAX_SAFE_INTEGER,
      maxSnapshotRows: 2,
      maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
    });
    const dataMemo = createResponderSyncRowListMemo(10_000, 10, {
      phase: 'durable_data',
      budget,
    });
    const metaMemo = createResponderSyncRowListMemo(10_000, 10, {
      phase: 'durable_meta',
      budget,
    });
    const rows = (scope: string): SyncRow[] => [0, 1].map((index) => ({
      s: `urn:${scope}:${index}`,
      p: 'urn:label',
      o: `"${scope}-${index}"`,
      g: `urn:${scope}:graph`,
    }));

    await dataMemo.get('data', async () => rows('data'));
    await metaMemo.get('meta', async () => rows('meta'));
    await provider.forceFlush();

    expect(metricPoints(harness.exporter, 'dkg.sync.responder.snapshots').length).toBeGreaterThan(0);
    expect(metricPoints(harness.exporter, 'dkg.sync.responder.snapshot_rows').length).toBeGreaterThan(0);
    expect(metricPoints(harness.exporter, 'dkg.sync.responder.snapshot_bytes_estimate').length).toBeGreaterThan(0);
    expect(metricPoints(harness.exporter, 'dkg.sync.responder.snapshot_load_duration_ms').length).toBeGreaterThan(0);
    expect(metricPoints(harness.exporter, 'process.heap_used_bytes').some((point) =>
      point.attributes.phase === 'durable_data' &&
      point.attributes.boundary === 'responder_snapshot_after_load'
    )).toBe(true);
    expect(metricPoints(harness.exporter, 'process.rss_bytes').length).toBeGreaterThan(0);
    expect(metricPoints(harness.exporter, 'process.external_bytes').length).toBeGreaterThan(0);
    expect(metricPoints(harness.exporter, 'process.array_buffers_bytes').length).toBeGreaterThan(0);
    expect(metricPoints(harness.exporter, 'dkg.sync.responder.snapshot_evictions_total').some((point) =>
      point.attributes.phase === 'durable_data' && point.attributes.reason === 'lru'
    )).toBe(true);
  });

  it('exports requester phase accumulation without graph or peer labels', async () => {
    const harness = createMetricsHarness();
    provider = harness.provider;
    let sends = 0;
    const encoder = new TextEncoder();

    const result = await fetchSyncPages({
      ctx: { operationId: 'test', operationName: 'sync' },
      remotePeerId: 'peer-not-a-label',
      contextGraphId: 'graph-not-a-label',
      includeSharedMemory: false,
      phase: 'data',
      graphUri: 'urn:data',
      deadline: Date.now() + 10_000,
      syncPageTimeoutMs: 1_000,
      syncRouterAttempts: 1,
      syncPageRetryAttempts: 1,
      syncPageSize: 2,
      syncDeniedResponse: 'denied',
      debugSyncProgress: false,
      protocolSync: '/dkg/test/sync',
      checkpointStore: new MemorySyncCheckpointStore(),
      buildSyncRequest: async () => encoder.encode('request'),
      parseAndFilter: async () => ({
        quads: [
          { subject: 'urn:s:1', predicate: 'urn:p', object: '"one"', graph: 'urn:data' },
          { subject: 'urn:s:2', predicate: 'urn:p', object: '"two"', graph: 'urn:data' },
        ],
        totalQuads: 2,
      }),
      send: async () => {
        sends += 1;
        return sends === 1 ? encoder.encode('<urn:s> <urn:p> "o" <urn:data> .') : new Uint8Array();
      },
      logWarn: () => {},
      logInfo: () => {},
      logDebug: () => {},
    });

    expect(result.quads).toHaveLength(2);
    expect(sends).toBe(2);
    await provider.forceFlush();

    for (const name of [
      'dkg.sync.requester.accumulated_quads',
      'dkg.sync.requester.accumulated_bytes',
      'dkg.sync.requester.page_count',
      'dkg.sync.requester.phase_duration_ms',
    ]) {
      const points = metricPoints(harness.exporter, name);
      expect(points.length).toBeGreaterThan(0);
      expect(points.some((point) =>
        point.attributes.phase === 'durable_data' && point.attributes.outcome === 'completed'
      )).toBe(true);
      expect(points.every((point) =>
        !('peer_id' in point.attributes) && !('context_graph_id' in point.attributes)
      )).toBe(true);
    }
  });
});
