import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { trace, metrics, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { withSpan, getMetrics, rebuildMetrics, currentTraceIds, Logger, type OperationContext } from '@origintrail-official/dkg-core';
import { initTelemetry, isTelemetryConfigured, shutdownTelemetry } from '../src/telemetry.js';

/**
 * Acceptance-criteria tests for the OTel observability foundation:
 * disabled ⇒ no-op, span error status, metric label cardinality, and
 * log↔trace correlation. Uses in-memory OTel exporters (no network).
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(20);
  }
}

function registerInMemoryTracer(): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
  return exporter;
}

afterEach(async () => {
  await shutdownTelemetry();
  trace.disable();
  metrics.disable();
  rebuildMetrics(); // rebind the facade metric cache to the (now no-op) global meter
  Logger.setSink(null);
});

describe('telemetry — disabled is a total no-op', () => {
  it('withSpan returns the body value with no provider registered', async () => {
    trace.disable();
    expect(await withSpan('agent.publish', () => 42)).toBe(42);
  });

  it('initTelemetry({enabled:false}) registers nothing', async () => {
    await initTelemetry({ enabled: false });
    expect(isTelemetryConfigured()).toBe(false);
  });

  it('initTelemetry with no endpoints registers nothing even when enabled', async () => {
    await initTelemetry({ enabled: true, resource: { serviceInstanceId: 'n1' } });
    expect(isTelemetryConfigured()).toBe(false);
  });

  it('accepts the legacy { metricsEndpoint } config shape (back-compat)', async () => {
    // Old callers passed a flat metricsEndpoint; it must map to metrics.endpoint.
    // No endpoint reachable here, but it must register (configured) without throwing.
    await initTelemetry({ enabled: true, metricsEndpoint: 'http://127.0.0.1:4318/v1/metrics', serviceName: 'legacy' } as any);
    expect(isTelemetryConfigured()).toBe(true);
  });

  it('traces + metrics are INDEPENDENT: a metrics-only init does NOT block a later traces init', async () => {
    // Regression for the single-`configured`-flag bug: registering metrics first
    // must not make a subsequent traces init silently no-op.
    await initTelemetry({ enabled: true, metrics: { endpoint: 'http://127.0.0.1:4318/v1/metrics', exportIntervalMs: 60_000 } });
    expect(isTelemetryConfigured()).toBe(true);
    // Second call, traces only — must register (it was the gated signal).
    await initTelemetry({ enabled: true, traces: { endpoint: 'http://127.0.0.1:4318/v1/traces' } });
    // A span now flows through a real (registered) tracer rather than the no-op.
    const tid = await withSpan('agent.publish', () => currentTraceIds().traceId);
    expect(tid).toMatch(/^[0-9a-f]{32}$/);
  });

  it('metric instruments are usable (no throw) when telemetry is off', () => {
    expect(() => getMetrics().publishTotal.add(1, { outcome: 'failed', source: 'direct' })).not.toThrow();
    expect(() => getMetrics().chainRpcDuration.record(12, { rpc_method: 'eth_call' })).not.toThrow();
  });
});

describe('withSpan — status + attributes + error recording', () => {
  it('success: returns value, records attributes, status not ERROR', async () => {
    const exporter = registerInMemoryTracer();
    const out = await withSpan(
      'agent.publish',
      (span) => {
        span.setAttribute('dkg.publish_status', 'tentative');
        return 'ok';
      },
      { attributes: { 'dkg.context_graph_id': 'cg-1' } },
    );
    expect(out).toBe('ok');
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('agent.publish');
    expect(spans[0].attributes['dkg.context_graph_id']).toBe('cg-1');
    expect(spans[0].attributes['dkg.publish_status']).toBe('tentative');
    expect(spans[0].status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('throw: sets ERROR status, records the exception, and rethrows', async () => {
    const exporter = registerInMemoryTracer();
    await expect(
      withSpan('publisher.ack_collect', () => {
        throw new Error('quorum unmet');
      }),
    ).rejects.toThrow('quorum unmet');
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0].events.some((e) => e.name === 'exception')).toBe(true);
  });
});

describe('initTelemetry — real OTLP exporter bootstrap exports traces + metrics', () => {
  // Proves the actual boot path (OTLP/proto exporters, BatchSpanProcessor,
  // tracerProvider.register(), setGlobalMeterProvider + rebuildMetrics) really
  // ships data — the prior suite only covered the disabled / no-endpoint cases
  // and manually-registered in-memory providers, so a regression that dropped
  // register()/rebuildMetrics() or the span processor went unnoticed.
  it('a withSpan + getMetrics emission reaches a local OTLP collector', async () => {
    const hits: Record<string, number> = { '/v1/traces': 0, '/v1/metrics': 0 };
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const path = req.url ?? '';
        if (path in hits && Buffer.concat(chunks).length > 0) hits[path] += 1;
        res.statusCode = 200;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      await initTelemetry({
        enabled: true,
        resource: { serviceInstanceId: 'n1', network: 'devnet', chainId: 'base:8453' },
        traces: { endpoint: `${base}/v1/traces` },
        metrics: { endpoint: `${base}/v1/metrics`, exportIntervalMs: 60_000 },
      });
      expect(isTelemetryConfigured()).toBe(true);

      // Emit through the SAME facade the production call sites use.
      await withSpan('chain.tx_send', () => 'done', {
        attributes: { 'rpc.method': 'eth_sendRawTransaction', 'dkg.chain_id': 'base:8453' },
      });
      getMetrics().chainRpcTotal.add(1, {
        rpc_method: 'eth_call', outcome: 'ok', retryable: false, chain_id: 'base:8453',
      });

      // shutdownTelemetry force-flushes the span batch + the metric reader.
      await shutdownTelemetry();

      await waitFor(() => hits['/v1/traces'] >= 1 && hits['/v1/metrics'] >= 1, 5000);
      expect(hits['/v1/traces']).toBeGreaterThanOrEqual(1);
      expect(hits['/v1/metrics']).toBeGreaterThanOrEqual(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('enable → disable → RE-enable re-registers the SDK and exports again', async () => {
    // Proves the master-gate lifecycle: shutdownTelemetry() clears the OTel API
    // globals (trace.disable()/metrics.disable()), so a later initTelemetry()
    // registers fresh providers instead of silently no-opping on the stale slot.
    const hits: Record<string, number> = { '/v1/metrics': 0 };
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const path = req.url ?? '';
        if (path in hits && Buffer.concat(chunks).length > 0) hits[path] += 1;
        res.statusCode = 200;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const metricsCfg = { enabled: true, metrics: { endpoint: `http://127.0.0.1:${port}/v1/metrics`, exportIntervalMs: 60_000 } };
    try {
      await initTelemetry(metricsCfg);
      expect(isTelemetryConfigured()).toBe(true);

      // Disable: must fully tear down + clear globals.
      await shutdownTelemetry();
      expect(isTelemetryConfigured()).toBe(false);

      // Re-enable: must register AGAIN (the bug this guards against = a re-enable
      // that no-ops because the global provider slot was never released).
      await initTelemetry(metricsCfg);
      expect(isTelemetryConfigured()).toBe(true);

      getMetrics().publishTotal.add(1, { outcome: 'completed', source: 'direct' });
      await shutdownTelemetry(); // force-flush the metric reader
      await waitFor(() => hits['/v1/metrics'] >= 1, 5000);
      expect(hits['/v1/metrics']).toBeGreaterThanOrEqual(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('metrics — bounded, low-cardinality attributes only', () => {
  // NOTE: the END-TO-END proof that a REAL instrumented call site emits bounded
  // labels lives in packages/chain/test/chain-rpc-telemetry.unit.test.ts (it
  // drives the actual contractReadWithFailover seam). This test pins the
  // allow-list contract at the facade level.
  it('emits counters/histograms with only allow-listed attribute keys', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const mp = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
    });
    metrics.setGlobalMeterProvider(mp);
    rebuildMetrics();

    const m = getMetrics();
    m.publishTotal.add(1, { outcome: 'failed', source: 'direct', chain_id: 'base:8453' });
    m.publishDuration.record(1234, { outcome: 'failed', source: 'direct', chain_id: 'base:8453' });
    m.chainRpcTotal.add(1, { rpc_method: 'eth_call', outcome: 'error', retryable: true, chain_id: 'base:8453' });
    m.ackPeerTotal.add(1, { result: 'decline', decline_code: 'NO_DATA_IN_SWM' });
    m.ackQuorumTotal.add(1, { outcome: 'timeout', chain_id: 'base:8453' });
    m.syncRequestTotal.add(1, { outcome: 'ok', protocol_id: '/dkg/10.0.2/sync' });
    m.protocolSendTotal.add(1, { outcome: 'ok', protocol_id: '/dkg/10.0.2/sync' });
    m.protocolSendDuration.record(5, { protocol_id: '/dkg/10.0.2/sync' });

    await mp.forceFlush();

    const keys = new Set<string>();
    for (const rm of exporter.getMetrics())
      for (const sm of rm.scopeMetrics)
        for (const metric of sm.metrics)
          for (const dp of metric.dataPoints) for (const k of Object.keys(dp.attributes)) keys.add(k);

    const ALLOWED = new Set([
      'outcome', 'source', 'chain_id', 'rpc_method', 'retryable', 'result',
      'decline_code', 'protocol_id', 'method', 'module', 'role', 'reason', 'error_type',
    ]);
    expect([...keys].filter((k) => !ALLOWED.has(k))).toEqual([]);
    // high-cardinality keys must never be metric labels
    for (const bad of ['peer_id', 'context_graph_id', 'tx_hash', 'operation_id', 'assertion_id', 'kaId', 'rpc_url']) {
      expect(keys.has(bad)).toBe(false);
    }
  });
});

describe('log ↔ trace correlation', () => {
  it('Logger attaches the active span trace_id/span_id to the record', async () => {
    const exporter = registerInMemoryTracer();
    const captured: Array<{ traceId?: string; spanId?: string }> = [];
    Logger.setSink((e) => captured.push(e));
    const logger = new Logger('test');
    const ctx: OperationContext = { operationId: 'op-1', operationName: 'publish' };

    await withSpan('agent.publish', () => {
      logger.info(ctx, 'inside the span');
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(captured[0].spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(captured[0].traceId).toBe(exporter.getFinishedSpans()[0].spanContext().traceId);
  });

  it('Logger emits no trace ids when no span is active', () => {
    trace.disable();
    const captured: Array<{ traceId?: string }> = [];
    Logger.setSink((e) => captured.push(e));
    new Logger('test').info({ operationId: 'op-2', operationName: 'query' }, 'no span here');
    expect(captured).toHaveLength(1);
    expect(captured[0].traceId).toBeUndefined();
  });
});
