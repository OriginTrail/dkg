// SPDX-License-Identifier: Apache-2.0
/**
 * Review coverage gap (PR #1317): the sync responder must record an outcome on
 * EVERY path, including the early return for a malformed request (missing
 * contextGraphId) that short-circuits before the limiter promise where the
 * ok/error outcome was recorded. This drives the real registered handler and
 * asserts dkg.sync.response.total{outcome:'invalid'} is emitted.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { metrics } from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { rebuildMetrics } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { registerSyncHandler } from '../src/sync/responder/sync-handler.js';
import type { SyncResponderSnapshotBudgetOptions } from '../src/sync/responder/snapshot-budget.js';

const noop = () => {};

function captureHandler(options: {
  store?: OxigraphStore;
  snapshotBudget?: SyncResponderSnapshotBudgetOptions;
} = {}): (data: Uint8Array, peerId: string) => Promise<Uint8Array> {
  let captured: ((data: Uint8Array, peerId: string, options?: { signal?: AbortSignal }) => Promise<Uint8Array>) | null = null;
  registerSyncHandler({
    register: (_proto: string, handler: any) => { captured = handler; },
    protocolSync: '/origintrail/dkg/sync/1.0.0',
    syncDeniedResponse: 'sync-denied',
    syncPageSize: 500,
    sharedMemoryTtlMs: 0,
    store: options.store ?? ({} as any), // untouched on malformed-request paths
    peerId: 'self-peer',
    parseSyncRequest: (data: Uint8Array) => JSON.parse(new TextDecoder().decode(data)),
    authorizeSyncRequest: async () => true,
    logWarn: noop,
    logDebug: noop,
    snapshotBudget: options.snapshotBudget,
  } as any);
  if (!captured) throw new Error('handler not registered');
  return (data, peerId) => captured!(data, peerId, {});
}

describe('sync responder metrics — every path records an outcome', () => {
  let mp: MeterProvider | null = null;
  let exporter: InMemoryMetricExporter;

  afterEach(async () => {
    if (mp) { await mp.forceFlush().catch(() => {}); await mp.shutdown().catch(() => {}); mp = null; }
    metrics.disable();
    rebuildMetrics();
  });

  it('records outcome=invalid for a request with no contextGraphId (early return)', async () => {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    mp = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })] });
    metrics.setGlobalMeterProvider(mp);
    rebuildMetrics();

    const invoke = captureHandler();
    // No contextGraphId → the handler short-circuits at the guard.
    const res = await invoke(new TextEncoder().encode(JSON.stringify({ offset: 0, limit: 10 })), 'remote-peer');
    expect(new TextDecoder().decode(res)).toBe(''); // empty response

    await mp.forceFlush();
    const counts: Record<string, number> = {};
    for (const rm of exporter.getMetrics())
      for (const sm of rm.scopeMetrics)
        for (const m of sm.metrics)
          if (m.descriptor.name === 'dkg.sync.response.total')
            for (const dp of m.dataPoints as Array<{ attributes: Record<string, unknown>; value: number }>)
              counts[String(dp.attributes.outcome)] = (counts[String(dp.attributes.outcome)] ?? 0) + dp.value;

    expect(counts['invalid'] ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('records outcome=invalid for MALFORMED request bytes (parseSyncRequest throws)', async () => {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    mp = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })] });
    metrics.setGlobalMeterProvider(mp);
    rebuildMetrics();

    const invoke = captureHandler();
    // Non-JSON bytes → parseSyncRequest (JSON.parse) throws BEFORE the
    // missing-contextGraphId guard and before limiter.run. The handler must
    // still count it and re-throw (stream reset preserved).
    await expect(invoke(new TextEncoder().encode('{not-json'), 'remote-peer')).rejects.toBeTruthy();

    await mp.forceFlush();
    const counts: Record<string, number> = {};
    for (const rm of exporter.getMetrics())
      for (const sm of rm.scopeMetrics)
        for (const m of sm.metrics)
          if (m.descriptor.name === 'dkg.sync.response.total')
            for (const dp of m.dataPoints as Array<{ attributes: Record<string, unknown>; value: number }>)
              counts[String(dp.attributes.outcome)] = (counts[String(dp.attributes.outcome)] ?? 0) + dp.value;
    expect(counts['invalid'] ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('keeps budget pressure on the quiet retryable limit path across same-token retries', async () => {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    mp = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })] });
    metrics.setGlobalMeterProvider(mp);
    rebuildMetrics();

    const store = new OxigraphStore();
    const contextGraphId = 'budget-limit-metrics';
    await store.insert([{
      subject: 'urn:budget:s',
      predicate: 'urn:budget:p',
      object: '"budget"',
      graph: `did:dkg:context-graph:${contextGraphId}/data`,
    }]);
    const invoke = captureHandler({
      store,
      snapshotBudget: {
        maxRows: 0,
        maxBytesEstimate: Number.MAX_SAFE_INTEGER,
        maxSnapshotRows: 10,
        maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
      },
    });
    const request = new TextEncoder().encode(JSON.stringify({
      contextGraphId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 10,
      syncSessionId: 'same-budget-token',
    }));

    await expect(invoke(request, 'remote-peer')).rejects.toMatchObject({
      name: 'QuietRetryableHandlerError',
    });
    await expect(invoke(request, 'remote-peer')).rejects.toMatchObject({
      name: 'QuietRetryableHandlerError',
    });

    await mp.forceFlush();
    let limitCount = 0;
    for (const rm of exporter.getMetrics())
      for (const sm of rm.scopeMetrics)
        for (const metric of sm.metrics)
          if (metric.descriptor.name === 'dkg.sync.response.total')
            for (const point of metric.dataPoints as Array<{ attributes: Record<string, unknown>; value: number }>)
              if (point.attributes.outcome === 'limit') limitCount += point.value;
    expect(limitCount).toBeGreaterThanOrEqual(2);
  });
});
