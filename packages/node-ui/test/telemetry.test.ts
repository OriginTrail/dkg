import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { trace, metrics, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { withSpan, getMetrics, rebuildMetrics, currentTraceIds, Logger, type OperationContext } from '@origintrail-official/dkg-core';
import {
  initTelemetry,
  isTelemetryConfigured,
  shutdownTelemetry,
  flushTelemetry,
  TERMINAL_FLUSH_BUDGET_MS,
} from '../src/telemetry.js';

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

  /**
   * The `provider === null` conjuncts in `tracesOn`/`metricsOn` are what make a
   * repeat `initTelemetry` idempotent. Drop either and that signal is
   * CONSTRUCTED a second time — but the OTel API refuses a duplicate global
   * registration, so the module's stored provider silently diverges from the
   * globally registered one. `shutdownTelemetry()` then tears down the stored
   * provider while the registered one keeps exporting, unshut, for the life of
   * the process.
   *
   * The assertions therefore target that divergence directly rather than
   * `isTelemetryConfigured()`, which stays `true` either way and cannot see it.
   */
  it('a repeat init does NOT construct a second provider behind the registered one', async () => {
    const cfg = {
      enabled: true,
      metrics: { endpoint: 'http://127.0.0.1:1/v1/metrics', exportIntervalMs: 600_000 },
      traces: { endpoint: 'http://127.0.0.1:1/v1/traces' },
    };
    let meterShutdownTarget: unknown;
    const meterShutdownSpy = vi
      .spyOn(MeterProvider.prototype, 'shutdown')
      .mockImplementation(async function (this: unknown) {
        meterShutdownTarget = this;
      } as any);
    const registerSpy = vi.spyOn(NodeTracerProvider.prototype, 'register');
    try {
      await initTelemetry(cfg);
      const registeredMeter = metrics.getMeterProvider();
      // Precondition: the first init really did register, so a "no second
      // provider" result cannot come from nothing having happened at all.
      expect(registeredMeter.constructor.name).toBe('MeterProvider');
      expect(registerSpy).toHaveBeenCalledTimes(1);

      await initTelemetry(cfg); // must be a total no-op
      await shutdownTelemetry();

      // Metrics: the provider we shut down is the one that is globally
      // registered. A second construction makes these two different objects.
      expect(meterShutdownSpy).toHaveBeenCalledTimes(1);
      expect(meterShutdownTarget).toBe(registeredMeter);
      // Traces: `register()` is called once per constructed provider.
      expect(registerSpy).toHaveBeenCalledTimes(1);
    } finally {
      meterShutdownSpy.mockRestore();
      registerSpy.mockRestore();
    }
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
    m.processHeapUsedBytes.record(1024, { phase: 'durable_data', boundary: 'requester_phase_start' });
    m.processHeapTotalBytes.record(2048, { phase: 'durable_data', boundary: 'requester_phase_start' });
    m.processHeapLimitBytes.record(4096, { phase: 'durable_data', boundary: 'requester_phase_start' });
    m.processRssBytes.record(8192, { phase: 'durable_data', boundary: 'requester_phase_start' });
    m.processExternalBytes.record(512, { phase: 'durable_data', boundary: 'requester_phase_start' });
    m.processArrayBuffersBytes.record(256, { phase: 'durable_data', boundary: 'requester_phase_start' });
    m.syncResponderSnapshots.add(1, { phase: 'durable_data' });
    m.syncResponderSnapshotRows.add(2, { phase: 'durable_data' });
    m.syncResponderSnapshotBytesEstimate.add(1024, { phase: 'durable_data' });
    m.syncResponderSnapshotEvictionsTotal.add(1, { phase: 'durable_data', reason: 'lru' });
    m.syncResponderSnapshotLoadDurationMs.record(5, { phase: 'durable_data', outcome: 'completed' });
    m.syncRequesterAccumulatedQuads.record(2, { phase: 'durable_data', outcome: 'completed' });
    m.syncRequesterAccumulatedBytes.record(1024, { phase: 'durable_data', outcome: 'completed' });
    m.syncRequesterPageCount.record(1, { phase: 'durable_data', outcome: 'completed' });
    m.syncRequesterPhaseDurationMs.record(10, { phase: 'durable_data', outcome: 'completed' });

    // W1 sync-measurement instruments (I1–I9). Every attribute the record
    // sites can emit appears here, so a new label that escapes the closed
    // vocabularies fails the allow-list rather than reaching an exporter.
    m.syncAttemptTotal.add(1, {
      transport: 'legacy', plane: 'durable', phase: 'data',
      source: 'catchup-foreground', outcome: 'response',
    });
    m.syncAttemptRequestBytes.add(512, {
      transport: 'changelog', plane: 'shared-memory', phase: 'delta', source: 'on-connect',
    });
    m.syncAttemptResponseBytes.add(2048, {
      transport: 'legacy', plane: 'durable', phase: 'meta',
      source: 'reconcile', outcome: 'validation_rejected',
    });
    m.syncOperationDurationMs.record(4200, {
      lane: 'durable', source: 'vm-recovery', outcome: 'resolved',
    });
    m.syncOperationRejectedTotal.add(1, {
      lane: 'changelog', source: 'catchup-background', reason: 'queue_full',
    });
    m.syncSingleflightJoinsTotal.add(1, {
      scope: 'context-graph', owner_source: 'on-connect', joiner_source: 'catchup-foreground',
    });
    m.contextGraphCatchupRequestsTotal.add(1, {
      result: 'shutting_down', include_shared_memory: true,
    });
    m.contextGraphCatchupJobsTotal.add(1, { status: 'done', admission: 'walk' });
    m.contextGraphCatchupJobDurationMs.record(305_000, { admission: 'walk' });

    await mp.forceFlush();

    const keys = new Set<string>();
    for (const rm of exporter.getMetrics())
      for (const sm of rm.scopeMetrics)
        for (const metric of sm.metrics)
          for (const dp of metric.dataPoints) for (const k of Object.keys(dp.attributes)) keys.add(k);

    const ALLOWED = new Set([
      'outcome', 'source', 'chain_id', 'rpc_method', 'retryable', 'result',
      'decline_code', 'protocol_id', 'method', 'module', 'role', 'reason', 'error_type',
      'phase', 'boundary',
      // W1 (I1–I9). All closed vocabularies clamped at the record site.
      'transport', 'plane', 'lane', 'scope', 'owner_source', 'joiner_source',
      'include_shared_memory', 'status', 'admission',
    ]);
    expect([...keys].filter((k) => !ALLOWED.has(k))).toEqual([]);
    // high-cardinality keys must never be metric labels
    for (const bad of ['peer_id', 'context_graph_id', 'tx_hash', 'operation_id', 'assertion_id', 'kaId', 'rpc_url']) {
      expect(keys.has(bad)).toBe(false);
    }
  });
});

/**
 * A collector that accepts the connection, reads the whole request, and then
 * holds it open without answering. That is a REAL never-settling exporter —
 * the OTLP exporters' own request timeout is 10 s, five times the 2 s
 * terminal-flush reserve — so these tests bound the actual SDK rather than a
 * mock of it.
 *
 * `'answering'` mode is the same server replying 200 immediately, used as the
 * NON-hanging signal in the asymmetric tests below.
 *
 * `received` records the signal paths that actually arrived. That is the
 * precondition check the tracer test cannot do without:
 * `BatchSpanProcessor.forceFlush()` batches
 * `ceil(finishedSpans.length / maxExportBatchSize)` times, which for an empty
 * queue is ZERO — it resolves instantly and never touches the exporter. A
 * tracer test with no ended span therefore passes identically with and without
 * the race, recording a kill for a mutant that survived. Asserting the export
 * was received proves the unbounded path was reached at all.
 *
 * Teardown is two steps, and both matter. `release()` starts answering 200 —
 * held requests and any new ones — so the abandoned export settles and the
 * teardown flush that follows is fast; the OTLP exporters RETRY a refused
 * connection with backoff for the whole 10 s export timeout, so simply closing
 * the port would hand `afterEach` the wait the test had just escaped. `stop()`
 * closes the listener once telemetry is down.
 */
interface TestCollector {
  port: number;
  /** Signal paths this collector actually received, e.g. `/v1/metrics`. */
  received: string[];
  release: () => Promise<void>;
  stop: () => Promise<void>;
}

async function startCollector(mode: 'black-hole' | 'answering'): Promise<TestCollector> {
  const sockets = new Set<Socket>();
  const held = new Set<ServerResponse>();
  const received: string[] = [];
  let releasing = mode === 'answering';
  const answer = (res: ServerResponse) => {
    res.statusCode = 200;
    res.end();
  };
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      received.push(req.url ?? '');
      if (releasing) answer(res);
      else held.add(res);
    });
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    release: async () => {
      releasing = true;
      for (const res of held) answer(res);
      held.clear();
      await sleep(50); // let the responses reach the exporter
    },
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const startBlackHoleCollector = () => startCollector('black-hole');
const startAnsweringCollector = () => startCollector('answering');

describe('flushTelemetry — bounded terminal flush that leaves the provider live', () => {
  /**
   * Both signals registered in BOTH cases, with only ONE of them hanging.
   *
   * A single "everything hangs" case would give M14 and M15 identical kill
   * sets — it would prove a bound exists somewhere, not that each leg carries
   * its own. Hanging one leg while the other answers normally also proves the
   * fast leg cannot mask the slow one, and pairs each leg to its own bounding
   * mechanism: `{timeoutMillis}` for the meter, `Promise.race` for the tracer.
   */
  async function flushWithOneHangingSignal(hanging: 'metrics' | 'traces') {
    const blackHole = await startBlackHoleCollector();
    const answering = await startAnsweringCollector();
    const metricsPort = hanging === 'metrics' ? blackHole.port : answering.port;
    const tracesPort = hanging === 'traces' ? blackHole.port : answering.port;
    await initTelemetry({
      enabled: true,
      // 600 s so the periodic reader never fires; `forceFlush` is the trigger.
      metrics: { endpoint: `http://127.0.0.1:${metricsPort}/v1/metrics`, exportIntervalMs: 600_000 },
      traces: { endpoint: `http://127.0.0.1:${tracesPort}/v1/traces` },
    });
    // BOTH signals need queued data or their flush short-circuits without ever
    // reaching an exporter — see the collector docblock.
    getMetrics().publishTotal.add(1, { outcome: 'completed', source: 'direct' });
    await withSpan('chain.tx_send', () => 'done');

    const started = Date.now();
    let threw: unknown;
    await flushTelemetry({ log: () => {} }).catch((err: unknown) => {
      threw = err;
    });
    const elapsedMs = Date.now() - started;

    return {
      elapsedMs,
      threw,
      blackHole,
      answering,
      cleanup: async () => {
        await blackHole.release();
        await shutdownTelemetry();
        await blackHole.stop();
        await answering.stop();
      },
    };
  }

  it('returns within the budget when only the METRICS exporter never settles', async () => {
    // Kills "drop `timeoutMillis` from the meter flush": without the argument
    // `MetricReader.forceFlush()` applies no timeout at all, and this waits on
    // the exporter's own 10 s deadline instead of the 2 s reserve.
    const run = await flushWithOneHangingSignal('metrics');
    try {
      expect(run.threw).toBeUndefined();
      expect(run.elapsedMs).toBeLessThan(TERMINAL_FLUSH_BUDGET_MS + 1_000);
      // Precondition: the unbounded path was actually reached, and the other
      // leg really did complete rather than being skipped.
      expect(run.blackHole.received).toContain('/v1/metrics');
      expect(run.answering.received).toContain('/v1/traces');

      // A13/A26: the provider must survive the flush. Everything after this
      // point in daemon shutdown — notably `agent.stop()` quiescing
      // parent-side sync — still emits, and would emit into nothing if the
      // flush had disabled or rebound the global meter.
      expect(isTelemetryConfigured()).toBe(true);
      expect(metrics.getMeterProvider().constructor.name).toBe('MeterProvider');
      expect(trace.getTracerProvider().constructor.name).not.toBe('NoopTracerProvider');
      expect(() =>
        getMetrics().publishTotal.add(1, { outcome: 'completed', source: 'direct' }),
      ).not.toThrow();
    } finally {
      await run.cleanup();
    }
  }, 20_000);

  it('returns within the budget when only the TRACES exporter never settles', async () => {
    // Kills "drop the tracer `Promise.race`": `BasicTracerProvider.forceFlush()`
    // takes no arguments and reads the ctor's `forceFlushTimeoutMillis`
    // (default 30 000), so the race is the ONLY thing bounding this leg.
    const run = await flushWithOneHangingSignal('traces');
    try {
      expect(run.threw).toBeUndefined();
      expect(run.elapsedMs).toBeLessThan(TERMINAL_FLUSH_BUDGET_MS + 1_000);
      // THE precondition for this test. An empty span queue makes
      // `BatchSpanProcessor.forceFlush()` resolve in 0 ms without calling the
      // exporter, and the test would then pass with or without the race.
      expect(run.blackHole.received).toContain('/v1/traces');
      expect(run.answering.received).toContain('/v1/metrics');

      expect(isTelemetryConfigured()).toBe(true);
      expect(metrics.getMeterProvider().constructor.name).toBe('MeterProvider');
      expect(trace.getTracerProvider().constructor.name).not.toBe('NoopTracerProvider');
    } finally {
      await run.cleanup();
    }
  }, 20_000);

  it('lets the shutdown sequence CONTINUE when the bounded flush times out', async () => {
    // `callWithTimeout` REJECTS with `TimeoutError('Operation timed out.')` —
    // it does not resolve. Drop the `.catch` around the bounded meter flush and
    // `Promise.all(legs)` propagates that, so `flushTelemetry()` itself rejects;
    // in the daemon that escapes `runProducerQuiescentTeardown`, is swallowed by
    // `cleanup`'s own `.catch`, and SKIPS the rest of shutdown — the catch-up
    // runner is never closed, `agent.stop()` never runs, telemetry never shuts
    // down. The flush merely returning is NOT the property under test; the
    // continuation running is.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    const collector = await startBlackHoleCollector();
    // Stand-in for §6.7 steps 6-9. node-ui cannot import the daemon — it is a
    // dependency OF the cli, not the reverse — so the continuation is modelled;
    // what is real is that a rejecting flush prevents it from running at all.
    const completed: string[] = [];
    let abortedBy: unknown;
    try {
      await initTelemetry({
        enabled: true,
        metrics: {
          endpoint: `http://127.0.0.1:${collector.port}/v1/metrics`,
          exportIntervalMs: 600_000,
        },
      });
      getMetrics().publishTotal.add(1, { outcome: 'completed', source: 'direct' });

      try {
        await flushTelemetry({ log: () => {} });
        completed.push('flush');
        completed.push('workers.stop');
        completed.push('agent.stop');
        await collector.release();
        await shutdownTelemetry();
        completed.push('telemetry.stop');
      } catch (err) {
        // Mirrors `cleanup`'s `.catch(...)` in lifecycle.ts: everything below
        // the throw is skipped.
        abortedBy = err;
      }
    } finally {
      await collector.release();
      await collector.stop();
      // Give a pending rejection a turn to surface before we stop listening.
      await sleep(50);
      process.off('unhandledRejection', onUnhandled);
    }

    expect(abortedBy).toBeUndefined();
    expect(completed).toEqual(['flush', 'workers.stop', 'agent.stop', 'telemetry.stop']);
    // Covers the variant where the legs are awaited with `allSettled`: the
    // rejection would leak instead of propagating, and the runner may swallow
    // it silently.
    expect(unhandled).toEqual([]);
  }, 20_000);

  it('is a no-op when nothing was ever registered', async () => {
    await expect(flushTelemetry({ log: () => {} })).resolves.toBeUndefined();
  });

  it('logs and continues instead of throwing when a flush rejects', async () => {
    const logged: string[] = [];
    const flushSpy = vi
      .spyOn(MeterProvider.prototype, 'forceFlush')
      .mockRejectedValue(new Error('exporter exploded'));
    try {
      await initTelemetry({
        enabled: true,
        metrics: { endpoint: 'http://127.0.0.1:1/v1/metrics', exportIntervalMs: 600_000 },
      });
      await expect(flushTelemetry({ log: (m) => logged.push(m) })).resolves.toBeUndefined();
      expect(logged.join('\n')).toContain('exporter exploded');
    } finally {
      flushSpy.mockRestore();
    }
  });
});

describe('shutdownTelemetry — flush completes before shutdown starts', () => {
  /**
   * `shutdownTelemetry()` has TWO independent per-provider branches, and an
   * earlier version of this test registered METRICS ONLY — so reverting just
   * the tracer branch to the concurrent `Promise.all` shape passed. Both
   * signals are registered here and each is asserted separately, so a revert of
   * either branch alone fails.
   *
   * `forceFlush`/`shutdown` live on `BasicTracerProvider.prototype`, which
   * `NodeTracerProvider` inherits; spying on the subclass prototype would not
   * intercept the inherited call, so the base prototype is reached via
   * `getPrototypeOf` rather than by taking a dependency on sdk-trace-base.
   */
  function watchProviderOrdering(prototype: object, label: string) {
    let flushResolved = false;
    const seen: { shutdownSawResolvedFlush?: boolean } = {};
    const flushSpy = vi.spyOn(prototype as any, 'forceFlush').mockImplementation((async () => {
      await sleep(30);
      flushResolved = true;
    }) as any);
    const shutdownSpy = vi.spyOn(prototype as any, 'shutdown').mockImplementation((async () => {
      seen.shutdownSawResolvedFlush = flushResolved;
    }) as any);
    return {
      label,
      flushSpy,
      shutdownSpy,
      seen,
      restore: () => {
        flushSpy.mockRestore();
        shutdownSpy.mockRestore();
      },
    };
  }

  /**
   * Registers BOTH signals and reports each provider's ordering separately.
   *
   * The two branches are asserted in two separate tests deliberately: one test
   * covering both would be killed by a revert of either branch, giving the two
   * mutants an identical kill set and no evidence that each branch is pinned
   * on its own. Split, a meter-only revert kills only the meter test and a
   * tracer-only revert kills only the tracer test.
   */
  async function observeShutdownOrdering() {
    const meter = watchProviderOrdering(MeterProvider.prototype, 'meter');
    const tracer = watchProviderOrdering(
      Object.getPrototypeOf(NodeTracerProvider.prototype),
      'tracer',
    );
    try {
      await initTelemetry({
        enabled: true,
        metrics: { endpoint: 'http://127.0.0.1:1/v1/metrics', exportIntervalMs: 600_000 },
        traces: { endpoint: 'http://127.0.0.1:1/v1/traces' },
      });
      await shutdownTelemetry();
      return {
        meter: { ...meter.seen, flushes: meter.flushSpy.mock.calls.length, shutdowns: meter.shutdownSpy.mock.calls.length },
        tracer: { ...tracer.seen, flushes: tracer.flushSpy.mock.calls.length, shutdowns: tracer.shutdownSpy.mock.calls.length },
      };
    } finally {
      meter.restore();
      tracer.restore();
    }
  }

  // `MeterProvider.forceFlush()` opens with
  // `if (this._shutdown) { diag.warn(…); return; }`, so starting both
  // concurrently made scheduling order decide whether the flush happened.
  //
  // Call ORDER cannot pin this: a concurrent `Promise.all` invokes both in the
  // same tick, in the same order. What discriminates is whether the flush had
  // already RESOLVED when shutdown began.
  it('does not shut the METER down until its own flush has resolved', async () => {
    const observed = await observeShutdownOrdering();
    // Preconditions: the branch ran at all. Without these an unregistered
    // provider leaves the flag undefined and the ordering assertion is
    // unreachable rather than satisfied — which is how the tracer branch went
    // uncovered in the first place.
    expect(observed.meter.flushes).toBe(1);
    expect(observed.meter.shutdowns).toBe(1);
    expect(observed.meter.shutdownSawResolvedFlush).toBe(true);
  });

  it('does not shut the TRACER down until its own flush has resolved', async () => {
    const observed = await observeShutdownOrdering();
    expect(observed.tracer.flushes).toBe(1);
    expect(observed.tracer.shutdowns).toBe(1);
    expect(observed.tracer.shutdownSawResolvedFlush).toBe(true);
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
