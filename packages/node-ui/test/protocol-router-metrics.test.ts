// SPDX-License-Identifier: Apache-2.0
/**
 * Review coverage gap (PR #1317): ProtocolRouter.send wraps sendInner with the
 * outbound P2P telemetry (`dkg.protocol_router.send.total/.duration`), but no
 * test proved the REAL send() path emits it. This drives router.send() (success
 * + forced failure) under an in-memory meter — overriding only the lower-level
 * sendInner — and asserts the counter with its bounded {outcome, protocol_id}
 * labels. (Lives in node-ui because it has the OTel SDK; ProtocolRouter is core.)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { metrics } from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { ProtocolRouter, rebuildMetrics } from '@origintrail-official/dkg-core';

const PROTO = '/dkg/10.0.2/sync';

describe('ProtocolRouter send metrics — real send() path', () => {
  let mp: MeterProvider | null = null;
  let exporter: InMemoryMetricExporter;

  function installMeter(): void {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    mp = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })] });
    metrics.setGlobalMeterProvider(mp);
    rebuildMetrics();
  }

  async function points(name: string): Promise<Array<Record<string, unknown>>> {
    await mp!.forceFlush();
    const out: Array<Record<string, unknown>> = [];
    for (const rm of exporter.getMetrics())
      for (const sm of rm.scopeMetrics)
        for (const m of sm.metrics)
          if (m.descriptor.name === name)
            for (const dp of m.dataPoints) out.push(dp.attributes as Record<string, unknown>);
    return out;
  }

  afterEach(async () => {
    if (mp) { await mp.forceFlush().catch(() => {}); await mp.shutdown().catch(() => {}); mp = null; }
    metrics.disable();
    rebuildMetrics();
  });

  it('SUCCESS: records protocolSendTotal{outcome:ok, protocol_id} with bounded labels', async () => {
    installMeter();
    const router: any = new ProtocolRouter({} as any); // node unused — sendInner is overridden
    router.sendInner = async () => new Uint8Array([1, 2]);
    const res = await router.send('peerABCDEF0123', PROTO, new Uint8Array([0]));
    expect(Array.from(res)).toEqual([1, 2]);
    const pts = await points('dkg.protocol_router.send.total');
    expect(pts.some((a) => a.outcome === 'ok' && a.protocol_id === PROTO)).toBe(true);
    const keys = new Set(pts.flatMap((a) => Object.keys(a)));
    expect([...keys].sort()).toEqual(['outcome', 'protocol_id']);
  });

  it('ERROR: a thrown sendInner records protocolSendTotal{outcome:error} and rethrows', async () => {
    installMeter();
    const router: any = new ProtocolRouter({} as any);
    router.sendInner = async () => { throw new Error('dial failed'); };
    await expect(router.send('peerABCDEF0123', PROTO, new Uint8Array([0]))).rejects.toBeTruthy();
    const pts = await points('dkg.protocol_router.send.total');
    expect(pts.some((a) => a.outcome === 'error' && a.protocol_id === PROTO)).toBe(true);
  });
});
