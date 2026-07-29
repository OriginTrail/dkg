import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { OtlpLogWorker, type OtlpLogWorkerOptions } from '../src/otlp-log-worker.js';
import type { LogRecord } from '@origintrail-official/dkg-core';

/**
 * Real end-to-end exercise of the OTLP/HTTP log exporter against a live local
 * HTTP server (no mocks) — proves the wire format, batching, level filtering,
 * buffer bounds, and retry/backoff behaviour.
 */

interface Captured {
  body: any;
  headers: Record<string, string | string[] | undefined>;
  /** Status the server RESPONDED with for this request — lets a test tell a
   *  failed (503) attempt apart from the successful (200) delivery. */
  status: number;
}

type Responder = (reqIndex: number) => { status: number; headers?: Record<string, string> };

function startServer(responder: Responder): Promise<{ url: string; received: Captured[]; close: () => Promise<void>; server: Server }> {
  const received: Captured[] = [];
  let reqIndex = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try { body = JSON.parse(raw); } catch { /* keep raw */ }
      const { status, headers } = responder(reqIndex++);
      received.push({ body, headers: req.headers, status });
      if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      res.statusCode = status;
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/v1/logs`,
        received,
        server,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function rec(over: Partial<LogRecord> = {}): LogRecord {
  return {
    level: 'info',
    operationName: 'publish',
    operationId: 'op-abc',
    module: 'publisher',
    message: 'published KC 42',
    ...over,
  };
}

function baseOpts(url: string, over: Partial<OtlpLogWorkerOptions> = {}): OtlpLogWorkerOptions {
  return {
    endpoint: url,
    network: 'devnet',
    peerId: '12D3KooWtest',
    nodeName: 'test-node',
    version: '10.0.0',
    commit: 'abc1234',
    role: 'core',
    chainId: 'base:8453',
    flushIntervalMs: 20,
    baseBackoffMs: 40,
    maxBackoffMs: 200,
    ...over,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(10);
  }
}

describe('OtlpLogWorker — OTLP/HTTP log export', () => {
  const workers: OtlpLogWorker[] = [];
  const servers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const w of workers.splice(0)) w.stop();
    for (const close of servers.splice(0)) await close();
  });

  it('ships a well-formed OTLP request with resource + record attributes and severity', async () => {
    const srv = await startServer(() => ({ status: 200 }));
    servers.push(srv.close);
    const w = new OtlpLogWorker(baseOpts(srv.url));
    workers.push(w);
    w.start();

    w.push(rec({
      level: 'error',
      message: 'boom',
      operationId: 'op-1',
      sourceOperationId: 'op-src',
      eventCode: 'rs.loop.tick-threw',
      component: 'random-sampling',
      outcome: 'failure',
      retryable: true,
      errorCode: 'STORE_SCHEDULER_BUSY',
    }));
    await waitFor(() => srv.received.length >= 1);

    const { body, headers } = srv.received[0];
    expect(headers['content-type']).toContain('application/json');
    const resourceLogs = body.resourceLogs;
    expect(Array.isArray(resourceLogs)).toBe(true);

    const resourceAttrs: any[] = resourceLogs[0].resource.attributes;
    const attrMap = Object.fromEntries(resourceAttrs.map((a) => [a.key, a.value.stringValue]));
    expect(attrMap['service.name']).toBe('dkg-node');
    expect(attrMap['dkg.network']).toBe('devnet');
    // Dotted OTel-style keys, matching the traces/metrics resource (telemetry.ts).
    expect(attrMap['dkg.node.role']).toBe('core');
    expect(attrMap['dkg.node.name']).toBe('test-node');
    expect(attrMap['dkg.chain']).toBe('base:8453');
    expect(attrMap['dkg.peer_id']).toBe('12D3KooWtest');
    // Label-promoted identity for the Grafana node selector.
    expect(attrMap['service.instance.id']).toBe('test-node'); // defaults to nodeName
    expect(attrMap['deployment.environment']).toBe('devnet'); // defaults to network

    const logRecord = resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(logRecord.severityNumber).toBe(17); // error
    expect(logRecord.severityText).toBe('ERROR');
    expect(logRecord.body.stringValue).toBe('boom');
    expect(typeof logRecord.timeUnixNano).toBe('string');
    const recAttrs = Object.fromEntries(logRecord.attributes.map((a: any) => [a.key, a.value.stringValue]));
    expect(recAttrs['dkg.operation_id']).toBe('op-1');
    expect(recAttrs['dkg.source_operation_id']).toBe('op-src');
    expect(recAttrs['dkg.module']).toBe('publisher');
    expect(recAttrs['dkg.event_code']).toBe('rs.loop.tick-threw');
    expect(recAttrs['dkg.component']).toBe('random-sampling');
    expect(recAttrs['dkg.outcome']).toBe('failure');
    expect(recAttrs['dkg.retryable']).toBe('true');
    expect(recAttrs['dkg.error_code']).toBe('STORE_SCHEDULER_BUSY');
  });

  it('batches multiple records into a single request', async () => {
    const srv = await startServer(() => ({ status: 200 }));
    servers.push(srv.close);
    const w = new OtlpLogWorker(baseOpts(srv.url));
    workers.push(w);
    w.start();
    for (let i = 0; i < 5; i++) w.push(rec({ message: `m${i}` }));
    await waitFor(() => srv.received.length >= 1);
    await sleep(60); // allow any stragglers
    const totalRecords = srv.received.reduce(
      (n, r) => n + r.body.resourceLogs[0].scopeLogs[0].logRecords.length,
      0,
    );
    expect(totalRecords).toBe(5);
    expect(srv.received.length).toBe(1); // one flush, one POST
  });

  it('filters records below minLevel (debug stays local)', async () => {
    const srv = await startServer(() => ({ status: 200 }));
    servers.push(srv.close);
    const w = new OtlpLogWorker(baseOpts(srv.url, { minLevel: 'info' }));
    workers.push(w);
    w.start();
    w.push(rec({ level: 'debug', message: 'noisy' }));
    w.push(rec({ level: 'info', message: 'kept' }));
    await waitFor(() => srv.received.length >= 1);
    await sleep(60);
    const bodies = srv.received.flatMap((r) =>
      r.body.resourceLogs[0].scopeLogs[0].logRecords.map((lr: any) => lr.body.stringValue),
    );
    expect(bodies).toContain('kept');
    expect(bodies).not.toContain('noisy');
  });

  it('sends Authorization bearer header when a token is configured', async () => {
    const srv = await startServer(() => ({ status: 200 }));
    servers.push(srv.close);
    const w = new OtlpLogWorker(baseOpts(srv.url, { token: 'sekret-token' }));
    workers.push(w);
    w.start();
    w.push(rec());
    await waitFor(() => srv.received.length >= 1);
    expect(srv.received[0].headers['authorization']).toBe('Bearer sekret-token');
  });

  it('on overflow keeps the NEWEST entries and drops the OLDEST (bounded memory)', async () => {
    const srv = await startServer(() => ({ status: 200 }));
    servers.push(srv.close);
    const w = new OtlpLogWorker(baseOpts(srv.url, { bufferMaxEntries: 3 }));
    workers.push(w);
    // Overflow the bound by 10→3 BEFORE starting, then flush and inspect which survived.
    for (let i = 0; i < 10; i++) w.push(rec({ message: `m${i}` }));
    expect(w.pending()).toBe(3); // capped
    w.start();
    await waitFor(() => srv.received.length >= 1);
    await sleep(60);
    const delivered = srv.received
      .flatMap((r) => r.body.resourceLogs[0].scopeLogs[0].logRecords.map((lr: any) => lr.body.stringValue))
      .sort();
    // drop-OLDEST ⇒ the survivors are the last three pushed (m7,m8,m9), NOT m0..m2.
    expect(delivered).toEqual(['m7', 'm8', 'm9']);
  });

  it('preserves W3C trace_id/span_id as top-level OTLP fields on the wire', async () => {
    const srv = await startServer(() => ({ status: 200 }));
    servers.push(srv.close);
    const w = new OtlpLogWorker(baseOpts(srv.url));
    workers.push(w);
    w.start();
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const spanId = 'b7ad6b7169203331';
    w.push(rec({ message: 'inside a span', traceId, spanId }));
    await waitFor(() => srv.received.length >= 1);

    const lr = srv.received[0].body.resourceLogs[0].scopeLogs[0].logRecords[0];
    // Correlation must ride the OTLP record as TOP-LEVEL fields (not attributes),
    // else the log stream loses trace↔log correlation even though the Logger attached them.
    expect(lr.traceId).toBe(traceId);
    expect(lr.spanId).toBe(spanId);
  });

  it('omits trace_id/span_id when the record was not emitted inside a span', async () => {
    const srv = await startServer(() => ({ status: 200 }));
    servers.push(srv.close);
    const w = new OtlpLogWorker(baseOpts(srv.url));
    workers.push(w);
    w.start();
    w.push(rec({ message: 'no span' })); // rec() sets no traceId/spanId
    await waitFor(() => srv.received.length >= 1);
    const lr = srv.received[0].body.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(lr.traceId).toBeUndefined();
    expect(lr.spanId).toBeUndefined();
  });

  it('retries on a retryable 503 then succeeds — the batch is preserved into the 200', async () => {
    let calls = 0;
    const srv = await startServer((i) => {
      calls = i + 1;
      return { status: i === 0 ? 503 : 200 };
    });
    servers.push(srv.close);
    const w = new OtlpLogWorker(baseOpts(srv.url));
    workers.push(w);
    w.start();
    w.push(rec({ message: 'must-arrive' }));
    // First attempt 503, then backoff (~40ms), then a 200.
    await waitFor(() => srv.received.length >= 2, 4000);
    const msgsOf = (r: Captured): string[] =>
      r.body.resourceLogs[0].scopeLogs[0].logRecords.map((lr: any) => lr.body.stringValue);
    // The 503 attempt must NOT be counted as delivery evidence: assert the
    // record arrived specifically on the SUCCESSFUL (200) request, proving the
    // requeued batch survived the retry rather than being lost or replaced.
    const okReq = srv.received.find((r) => r.status === 200);
    const failReq = srv.received.find((r) => r.status === 503);
    expect(failReq, 'expected a failed 503 attempt').toBeDefined();
    expect(okReq, 'expected a successful 200 retry').toBeDefined();
    expect(msgsOf(okReq!)).toContain('must-arrive');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('drops batch and reports once on a non-retryable 400 (no infinite retry)', async () => {
    const errors: string[] = [];
    const srv = await startServer(() => ({ status: 400 }));
    servers.push(srv.close);
    const w = new OtlpLogWorker(baseOpts(srv.url, { onError: (m) => errors.push(m) }));
    workers.push(w);
    w.start();
    w.push(rec({ message: 'bad' }));
    await waitFor(() => srv.received.length >= 1);
    await sleep(120); // give it time to (not) retry
    expect(srv.received.length).toBe(1); // dropped, not retried
    expect(w.pending()).toBe(0);
    expect(errors.length).toBe(1); // reported exactly once
  });
});
