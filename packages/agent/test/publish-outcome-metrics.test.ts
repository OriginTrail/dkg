// SPDX-License-Identifier: Apache-2.0
/**
 * Review coverage gap (PR #1317): publish telemetry must be proven through the
 * REAL publish entry points, not just hand-emitted at the facade. These drive
 * the actual `_publish` (source=direct) and `publishFromSharedMemory`
 * (source=swm) to a throw and assert `dkg.publish.total{outcome:"error", source}`
 * is recorded — so a regression that drops the `recordPublishOutcome(...)` call
 * from either path fails the build.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { metrics } from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { rebuildMetrics } from '@origintrail-official/dkg-core';
import { PublishMethods } from '../src/dkg-agent-publish.js';
import type { Quad } from '@origintrail-official/dkg-storage';

const OVERSIZED: Quad = {
  subject: 'http://example.org/root',
  predicate: 'http://schema.org/text',
  object: `"${'x'.repeat(60_000)}"`,
  graph: 'http://example.org/graph',
};

describe('publish outcome metrics — recorded by the real publish entry points', () => {
  let mp: MeterProvider | null = null;
  let exporter: InMemoryMetricExporter;

  function installMeter(): void {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    mp = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })] });
    metrics.setGlobalMeterProvider(mp);
    rebuildMetrics();
  }

  async function publishPoints(): Promise<Array<Record<string, unknown>>> {
    await mp!.forceFlush();
    const out: Array<Record<string, unknown>> = [];
    for (const rm of exporter.getMetrics())
      for (const sm of rm.scopeMetrics)
        for (const m of sm.metrics)
          if (m.descriptor.name === 'dkg.publish.total')
            for (const dp of m.dataPoints) out.push(dp.attributes as Record<string, unknown>);
    return out;
  }

  afterEach(async () => {
    if (mp) { await mp.forceFlush().catch(() => {}); await mp.shutdown().catch(() => {}); mp = null; }
    metrics.disable();
    rebuildMetrics();
  });

  it('direct _publish throwing records publishTotal{outcome:error, source:direct}', async () => {
    installMeter();
    await expect(
      PublishMethods.prototype._publish.call({ log: { info: vi.fn() } } as never, 'cg', [OVERSIZED]),
    ).rejects.toMatchObject({ code: 'OVERSIZED_RDF_LITERAL' });
    const pts = await publishPoints();
    expect(pts.some((a) => a.outcome === 'error' && a.source === 'direct')).toBe(true);
  });

  it('publishFromSharedMemory throwing records publishTotal{outcome:error, source:swm}', async () => {
    installMeter();
    // Bare stub → the early `this.getContextGraphOnChainId(...)` call throws
    // inside the try, exercising the swm catch → recordPublishOutcome('error','swm').
    await expect(
      PublishMethods.prototype.publishFromSharedMemory.call(
        { log: { info: vi.fn(), warn: vi.fn() } } as never, 'cg', 'all', {},
      ),
    ).rejects.toBeTruthy();
    const pts = await publishPoints();
    expect(pts.some((a) => a.outcome === 'error' && a.source === 'swm')).toBe(true);
  });
});
