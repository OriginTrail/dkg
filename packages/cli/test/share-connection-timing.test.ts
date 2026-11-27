import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { constants, performance } from 'node:perf_hooks';
import { RecentShareGc } from '../src/daemon/share-gc-timing.js';
import type { Socket } from 'node:net';
import { Agent, createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { observeShareConnections, shareConnectionTiming, shareDispatchGc } from '../src/daemon/share-connection-timing.js';

afterEach(() => vi.unstubAllEnvs());

it('records first socket dispatch and excludes keep-alive age, including after an unrelated GET', async () => {
  vi.stubEnv('DKG_ASYNC_PROMOTE_ADMISSION_TRACE', '1');
  const observations: ReturnType<typeof shareConnectionTiming>[] = [];
  const server = createServer((req, res) => { observations.push(shareConnectionTiming(req)); res.end(); });
  observeShareConnections(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const send = (method: string, keepAlive: boolean) => new Promise<void>((resolve, reject) => {
    request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, method, agent: keepAlive ? agent : false },
      response => { response.on('error', reject); response.on('end', resolve); response.resume(); }).on('error', reject).end();
  });
  try {
    await send('POST', false);
    await send('GET', true);
    await send('POST', true);
    expect(observations[0]).toMatchObject({ connectionUse: 'first', connectionToRequestMs: expect.any(Number) });
    expect(observations[0]!.connectionObservedAtUnixMs).toBeLessThanOrEqual(observations[0]!.requestDispatchedAtUnixMs);
    expect(observations[1]).toBeUndefined();
    expect(observations[2]).toMatchObject({ connectionUse: 'reused', connectionPortHash: expect.stringMatching(/^[0-9a-f]{64}$/), loopAtDispatch: { windowMs: expect.any(Number) } });
    expect(observations[2]).not.toHaveProperty('connectionObservedAtUnixMs');
    expect(observations[2]).not.toHaveProperty('connectionToRequestMs');
  } finally {
    agent.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('does not install observers when disabled', () => {
  vi.stubEnv('DKG_ASYNC_PROMOTE_ADMISSION_TRACE', '0');
  const server = createServer();
  const counts = () => [server.listenerCount('connection'), server.listenerCount('request'), server.listenerCount('close')];
  const before = counts();
  observeShareConnections(server);
  expect(counts()).toEqual(before);
});


it('records stalls on either side of a delayed timer callback and accounts for idle time', () => {
  vi.stubEnv('DKG_ASYNC_PROMOTE_ADMISSION_TRACE', '1');
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const server = createServer();
  const listenerCounts = () => ['request', 'connection', 'close'].map(event => server.listenerCount(event));
  const counts = listenerCounts();
  let tick = { at: 0, active: 0, idle: 0 };
  observeShareConnections(server, () => tick);
  const sample = () => {
    const req = { method: 'POST', socket: {} } as IncomingMessage;
    server.emit('request', req);
    return shareConnectionTiming(req)!.loopAtDispatch;
  };
  try {
    for (let i = 1; i <= 45; i++) {
      tick = { at: i * 500, active: 0, idle: i * 500 };
      vi.advanceTimersByTime(500);
    }
    expect(sample()).toMatchObject({ windowMs: 20_000, utilization: 0, maxTimerOverdueMs: 0 });
    tick = { at: 30_000, active: 7_500, idle: 22_500 };
    const open = sample();
    expect(open).toMatchObject({ windowMs: 27_500, utilization: 0.273, maxTimerOverdueMs: 7_000, maxIntervalUtilization: 1, maxIntervalStillOpen: true });
    vi.advanceTimersByTime(500);
    tick = { at: 30_005, active: 7_500, idle: 22_505 };
    const complete = sample();
    expect(complete).toMatchObject({ maxTimerOverdueMs: 7_000, maxIntervalStillOpen: false, maxIntervalEndUnixMs: open.maxIntervalEndUnixMs });
    for (let i = 1; i <= 41; i++) {
      tick = { at: 30_000 + i * 500, active: 7_500, idle: 22_500 + i * 500 };
      vi.advanceTimersByTime(500);
    }
    expect(sample().maxTimerOverdueMs).toBe(0);
  } finally {
    server.emit('close');
    expect(vi.getTimerCount()).toBe(0);
    expect(listenerCounts()).toEqual(counts);
    vi.useRealTimers();
  }
});

it('hashes the decimal socket port only for a canonical local peer, including reused sockets', () => {
  vi.stubEnv('DKG_ASYNC_PROMOTE_ADMISSION_TRACE', '1');
  const server = new EventEmitter() as Server;
  observeShareConnections(server);
  try {
    for (const address of ['127.0.0.1', '127.0.0.7', '::1', '::ffff:127.0.0.1', '192.0.2.1', '127.not-an-address', undefined]) {
      const socket = { remoteAddress: address, remotePort: 41234 } as Socket;
      server.emit('connection', socket);
      for (const use of ['first', 'reused']) {
        const req = { method: 'POST', socket } as IncomingMessage;
        server.emit('request', req);
        const timing = shareConnectionTiming(req)!;
        expect(timing.connectionUse).toBe(use);
        if (address && ['127.0.0.1', '127.0.0.7', '::1', '::ffff:127.0.0.1'].includes(address)) {
          expect(timing.connectionPortHash).toBe(createHash('sha256').update('41234', 'ascii').digest('hex'));
        } else {
          expect(timing).not.toHaveProperty('connectionPortHash');
        }
        expect(timing).not.toHaveProperty('remotePort');
      }
    }
  } finally { server.emit('close'); }
});


it('clips GC to the earlier request window, unions nested intervals, and marks evicted evidence', () => {
  const gc = new RecentShareGc();
  const base = performance.timeOrigin;
  const window = { windowStart: base, dispatch: base + 90, intervalStart: base + 10, intervalEnd: base + 50 };
  gc.add([
    { startTime: 5, duration: 20, detail: { kind: constants.NODE_PERFORMANCE_GC_MINOR } },
    { startTime: 20, duration: 30, detail: { kind: constants.NODE_PERFORMANCE_GC_MAJOR } },
    { startTime: 85, duration: 100 },
    { startTime: 95, duration: 1 },
  ]);
  expect(gc.summarize(window)).toEqual({ observedCount: 3, retentionLimited: false, maxLoopIntervalOverlapMs: 40,
    longestKind: 'major', longestOverlapMs: 30 });
  gc.add(Array.from({ length: 65 }, (_, i) => ({ startTime: 200 + i, duration: 1 })));
  expect(gc.summarize(window)).toEqual({ observedCount: 0, retentionLimited: true, maxLoopIntervalOverlapMs: 0 });
});

it('summarizes pre-dispatch GC one turn after dispatch, before later GC can evict it', async () => {
  vi.stubEnv('DKG_ASYNC_PROMOTE_ADMISSION_TRACE', '1');
  const server = new EventEmitter() as Server;
  let evicted = false;
  const snapshots: unknown[] = [];
  const kept = { observedCount: 2, retentionLimited: false, maxLoopIntervalOverlapMs: 12 };
  observeShareConnections(server, undefined, () => ({
    snapshot: (window: unknown) => {
      snapshots.push(window);
      return evicted ? { observedCount: 0, retentionLimited: true, maxLoopIntervalOverlapMs: 0 } : kept;
    },
    close: () => {},
  }));
  try {
    const req = { method: 'POST', socket: {} } as IncomingMessage;
    server.emit('request', req);
    await new Promise(resolve => setImmediate(resolve));
    evicted = true;
    expect(shareDispatchGc(req)).toEqual(kept);
    expect(snapshots).toHaveLength(1);
    const early = { method: 'POST', socket: {} } as IncomingMessage;
    server.emit('request', early);
    // A response that closes before that turn still gets one summary, the same one later.
    const atClose = shareDispatchGc(early);
    await new Promise(resolve => setImmediate(resolve));
    expect(shareDispatchGc(early)).toBe(atClose);
    expect(snapshots).toHaveLength(2);
  } finally { server.emit('close'); }
});
