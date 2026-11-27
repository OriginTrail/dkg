import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Logger, createAsyncAdmissionDiagnosticTrace } from '@origintrail-official/dkg-core';
import { ShareStoreHold } from '../src/share-store-timing.js';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('splits contention from actual HTTP work, preserving queue failure and private inputs', async () => {
  vi.stubEnv('DKG_ASYNC_PROMOTE_ADMISSION_TRACE', '1');
  const scheduler = new StorePriorityScheduler({ maxConcurrent: 1, controlId: 'store-control-share', queueWaitTimeoutMs: 2000 });
  let headersObserved!: () => void;
  const clientHeaders = new Promise<void>(resolve => { headersObserved = resolve; });
  // Keep a generous pause for busy runners, and start the body interval only
  // after the client has observed the headers.
  const server = createServer(async (_req, res) => {
    await delay(80);
    res.writeHead(200);
    res.write('yes');
    await clientHeaders;
    await delay(80);
    res.end();
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const hold = new ShareStoreHold();
  let free!: () => void;
  const gate = new Promise<void>(resolve => { free = resolve; });
  const owner = scheduler.run('normal', 'publisher.asyncPromote.stats', () => gate);
  try {
    const waiter = hold.run(() => scheduler.run('normal', 'private-source-value', async () => {
      const res = await fetch('http://127.0.0.1:' + (server.address() as AddressInfo).port + '/private-path');
      headersObserved();
      return res.text();
    }, undefined, { storeOperation: 'query' }));
    const initial = hold.snapshot();
    expect(initial.pending[0]).toMatchObject({ source: 'other', lane: 'store-control-share', operation: 'query', outcome: 'pending' });
    expect(JSON.stringify(initial.pending[0].pressure)).toContain('publisher.asyncPromote.stats');
    await delay(25); free(); await owner;
    await expect(waiter).resolves.toBe('yes');
    const report = hold.snapshot();
    expect(report.pending).toHaveLength(0);
    const row = report.slowest[0];
    expect(row.queueMs).toBeGreaterThanOrEqual(15);
    expect(row.runningMs).toBeGreaterThanOrEqual(30);
    expect(row.httpCount).toBe(1);
    expect(row.lastHttp!.headersAtUnixMs! - row.lastHttp!.sendHeadersAtUnixMs!).toBeGreaterThanOrEqual(15);
    expect(row.lastHttp!.bodyReceivedAtUnixMs! - row.lastHttp!.headersAtUnixMs!).toBeGreaterThanOrEqual(15);
    expect(JSON.stringify(report)).not.toContain('private-');
  } finally { headersObserved();free();server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('retains stats on a queue timeout and bounds the store operations retained per holder', async () => {
  vi.stubEnv('DKG_ASYNC_PROMOTE_ADMISSION_TRACE', '1');
  const hold = new ShareStoreHold();
  const scheduler = new StorePriorityScheduler({ maxConcurrent: 1, controlId: 'store-control-share', queueWaitTimeoutMs: 35 });
  let free!: () => void;
  const gate = new Promise<void>(resolve => { free = resolve; });
  const owner = scheduler.run('normal','publisher.asyncPromote.stats',() => gate);
  try {
    await expect(hold.run(() => scheduler.run('normal','private', async () => 1))).rejects.toMatchObject({ reason: 'queue_wait_timeout' });
    expect(hold.snapshot().slowest[0]).toMatchObject({ outcome: 'queue_wait_timeout', httpCount: 0, runningMs: 0 });
  } finally { free();await owner; }
  for (let i = 0; i < 8; i++) await hold.run(() => scheduler.run('normal','private',async () => i));
  expect(hold.snapshot().storeCalls).toBe(9);
  expect(hold.snapshot().slowest).toHaveLength(4);
});

it('links preflight work outside the lock and keeps its ordinary result if the sink fails', async () => {
  vi.stubEnv('DKG_ASYNC_PROMOTE_ADMISSION_TRACE', '1');
  const log = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => { throw new Error('unavailable'); });
  const scheduler = new StorePriorityScheduler({ maxConcurrent: 1 });
  const trace = createAsyncAdmissionDiagnosticTrace('share_async');
  await expect(trace.run('write_preflight', () => scheduler.run('normal','private',async () => 9))).resolves.toBe(9);
  expect(log.mock.calls.some(([, msg]) => msg.includes(trace.requestId) && msg.includes('async_share_store_timing'))).toBe(true);
});


it('links a late physical settlement to the original holder after its caller leaves', async () => {
  vi.stubEnv('DKG_ASYNC_PROMOTE_ADMISSION_TRACE', '1');
  const log = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
  const scheduler = new StorePriorityScheduler({ maxConcurrent: 1 });
  const hold = new ShareStoreHold();
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const work = hold.run(() => scheduler.run('normal','private',() => gate));
  hold.active = false;
  finish();
  await work;
  expect(log.mock.calls.map(([,text]) => JSON.parse(text))).toContainEqual(expect.objectContaining({
    event: 'async_share_store_late_settlement', holdId: hold.id, outcome: 'ok',
  }));
});
