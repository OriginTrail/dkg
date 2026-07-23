// SPDX-License-Identifier: Apache-2.0
/**
 * Review coverage gap (PR #1317): the OUTBOUND sync-request metric
 * (`dkg.sync.request.total`) was only exercised by hand-emitting the facade
 * instrument in telemetry.test.ts, not through the real `sendSyncRequest` path.
 * This drives the actual function (success + error) under an in-memory meter and
 * asserts the bounded {outcome, protocol_id} labels.
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
import { sendSyncRequest } from '../src/p2p/sync-transport.js';
import { isSyncTransportFailure } from '../src/sync/error-tags.js';

const PROTO = '/dkg/10.0.2/sync';

function baseParams(send: any) {
  return {
    remotePeerId: 'remote-peer',
    timeoutMs: 1000,
    retryAttempts: 1,
    contextGraphId: 'cg-1',
    offset: 0,
    requestFactory: async () => new Uint8Array([1, 2, 3]),
    send,
    protocolId: PROTO,
    onRetry: () => {},
  } as any;
}

describe('sync transport metrics — real sendSyncRequest emits dkg.sync.request.total', () => {
  let mp: MeterProvider | null = null;
  let exporter: InMemoryMetricExporter;

  function installMeter(): void {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    mp = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })] });
    metrics.setGlobalMeterProvider(mp);
    rebuildMetrics();
  }

  async function syncReqPoints(): Promise<Array<Record<string, unknown>>> {
    await mp!.forceFlush();
    const out: Array<Record<string, unknown>> = [];
    for (const rm of exporter.getMetrics())
      for (const sm of rm.scopeMetrics)
        for (const m of sm.metrics)
          if (m.descriptor.name === 'dkg.sync.request.total')
            for (const dp of m.dataPoints) out.push(dp.attributes as Record<string, unknown>);
    return out;
  }

  afterEach(async () => {
    if (mp) { await mp.forceFlush().catch(() => {}); await mp.shutdown().catch(() => {}); mp = null; }
    metrics.disable();
    rebuildMetrics();
  });

  it('SUCCESS: records outcome=ok with {protocol_id}', async () => {
    installMeter();
    const res = await sendSyncRequest(baseParams(async () => new Uint8Array([9])));
    expect(Array.from(res)).toEqual([9]);
    const pts = await syncReqPoints();
    expect(pts.some((a) => a.outcome === 'ok' && a.protocol_id === PROTO)).toBe(true);
    // Bounded labels only.
    const keys = new Set(pts.flatMap((a) => Object.keys(a)));
    expect([...keys].sort()).toEqual(['outcome', 'protocol_id']);
  });

  it('ERROR: a failing send records outcome=error and rethrows', async () => {
    installMeter();
    await expect(
      sendSyncRequest(baseParams(async () => { throw new Error('transport down'); })),
    ).rejects.toBeTruthy();
    const pts = await syncReqPoints();
    expect(pts.some((a) => a.outcome === 'error' && a.protocol_id === PROTO)).toBe(true);
  });

  it('does not retry or transport-tag a terminal responder-session error', async () => {
    installMeter();
    let sends = 0;
    let retries = 0;
    const params = {
      ...baseParams(async () => {
        sends += 1;
        throw new Error('Durable data sync session snapshot expired before page completion');
      }),
      retryAttempts: 3,
      onRetry: () => {
        retries += 1;
      },
    };

    let rejected: unknown;
    try {
      await sendSyncRequest(params);
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toContain('snapshot expired before page completion');
    expect(isSyncTransportFailure(rejected)).toBe(false);
    expect(sends).toBe(1);
    expect(retries).toBe(0);
    const pts = await syncReqPoints();
    expect(pts.some((a) => a.outcome === 'error' && a.protocol_id === PROTO)).toBe(true);
  });
});
