import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
type Engine = typeof import('../src/server/sim-engine.js');
let engine: Engine;
let fetchMock: ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>>;
let writes: { url: URL; init?: RequestInit; body: Record<string, any> }[];
let events: Record<string, any>[];
let stream: ReturnType<typeof response>;
let streamRequest: IncomingMessage;
let streamRequests: IncomingMessage[];
function response() {
  return { code: 0, headers: {} as Record<string, string>, body: '',
    writeHead: vi.fn(function (this: any, code: number, headers: Record<string, string>) { this.code = code; this.headers = headers; return this; }),
    write: vi.fn((data: string) => { if (data.startsWith('data: ')) events.push(JSON.parse(data.slice(6))); return true; }),
    end: vi.fn(function (this: any, body: string) { this.body = body; }),
  };
}
async function request(url: string | undefined, method = 'GET', body?: unknown) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { url, method }) as IncomingMessage;
  const res = response();
  await engine.handleSimRequest(req, res as unknown as ServerResponse);
  return { code: res.code, body: res.body ? JSON.parse(res.body) : undefined };
}
async function subscribe(runId?: string) {
  streamRequest = Object.assign(new EventEmitter(), { url: runId ? `/sim/events?runId=${runId}` : '/sim/events', method: 'GET' }) as IncomingMessage;
  streamRequests.push(streamRequest);
  stream = response();
  await engine.handleSimRequest(streamRequest, stream as unknown as ServerResponse);
}
async function start(op: string, options: Record<string, unknown> = {}, runId?: string) {
  const result = await request(runId ? `/sim/start?runId=${runId}` : '/sim/start', 'POST', { name: 'test', opCount: 1, opsPerSec: 100, concurrency: 1, kasPerPublish: 2, contextGraph: 'owner/team', enabledOps: [op], ...options });
  expect(result).toMatchObject({ code: 200, body: { started: true, name: 'test', runId: expect.any(String) } });
  await vi.advanceTimersByTimeAsync(501);
  return result.body.runId as string;
}
async function finish(ms = 1000) { await vi.advanceTimersByTimeAsync(ms); return events.filter(e => e.type === 'op'); }
function operations() { return writes.filter(w => !w.url.pathname.startsWith('/api/context-graph') && w.url.pathname !== '/api/status'); }

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01'));
  vi.spyOn(Math, 'random').mockReturnValue(0.25);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(readFile).mockReset().mockImplementation(async (path) => {
    if (String(path).includes('/node2/')) return '# comment\n\n token-node2\nignored';
    if (String(path).includes('/node3/')) return '# comment only\n';
    throw new Error('no token file');
  });
  writes = []; events = []; streamRequests = [];
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    writes.push({ url, init, body });
    if (url.pathname === '/api/context-graph/exists') return Response.json({ exists: true });
    if (url.pathname === '/api/status') return Response.json({ peerId: `peer-${url.port}` });
    if (url.pathname === '/api/query') return Response.json({ result: { bindings: [{ s: 'one' }, { s: 'two' }] }, phases: { query: 3 } });
    if (url.pathname === '/api/chat') return Response.json({ delivered: true, phases: { send: 2 } });
    if (url.pathname.endsWith('/vm/publish')) return Response.json({ kaId: '12345678901234567890', kas: [{}, {}], status: 'confirmed', phases: { chain: 5 } });
    return Response.json({ phases: { prepare: 2 } });
  });
  vi.stubGlobal('fetch', fetchMock);
  engine = await import('../src/server/sim-engine.js');
  await subscribe();
});
afterEach(async () => {
  await request('/sim/stop', 'POST');
  await vi.advanceTimersByTimeAsync(1000);
  streamRequests.forEach(req => req.emit('close'));
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('simulator operations through the request handler', () => {
  it('creates/seals/shares before publishing, with node-scoped auth and reported phases', async () => {
    await start('publish');
    const [event] = await finish();
    expect(event).toMatchObject({ opType: 'publish', nodeId: 2, success: true, detail: 'KC: 123456789012 (2 KAs) confirmed', phases: { chain: 5 } });
    const [create, publish] = operations();
    expect(create.url.pathname).toBe('/api/knowledge-assets');
    expect(create.body).toMatchObject({ contextGraphId: 'owner/team', finalize: true, alsoShareSwm: true });
    expect(create.body.quads).toHaveLength(2);
    expect(create.body.quads.every((q: any) => q.graph === 'did:dkg:context-graph:owner/team' && q.predicate === 'http://schema.org/name')).toBe(true);
    expect(publish.url.pathname).toBe(`/api/knowledge-assets/${encodeURIComponent(create.body.name)}/vm/publish`);
    expect(publish.body).toEqual({ contextGraphId: 'owner/team' });
    for (const op of operations()) expect(op.init?.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer token-node2' });
    expect(events.at(-1)).toMatchObject({ type: 'done', total: 1, completed: 1, errors: 0, byOp: { publish: { ok: 1, fail: 0, timeouts: 0 } } });
    expect((await request('/sim/status')).body.running).toBe(false);
  });
  it.each(['query', 'workspace', 'chat'])('executes %s with independently checked wire semantics', async op => {
    await start(op);
    const [event] = await finish();
    expect(event).toMatchObject({ opType: op, success: true, nodeId: 2 });
    const [wire] = operations();
    if (op === 'query') {
      expect(wire.body).toEqual({ sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 10', contextGraphId: 'owner/team' });
      expect(event.detail).toBe('2 bindings (LIMIT 10)');
      expect(event.phases).toEqual({ query: 3 });
    } else if (op === 'workspace') {
      expect(wire.body).toMatchObject({ contextGraphId: 'owner/team', alsoShareSwm: true, finalize: true });
      expect(wire.body.quads).toHaveLength(1);
      expect(event.detail).toBe(`ka: ${wire.body.name}`);
    } else {
      expect(wire.body).toEqual({ to: 'peer-9203', text: expect.stringMatching(/^sim-ping-/) });
      expect(event.detail).toBe('→ node 3');
    }
  });
  it.each([true, false])('does not publish after failed create, JSON diagnostics=%s', async json => {
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => new URL(url).pathname === '/api/knowledge-assets'
      ? (json ? Response.json({ error: 'seal failed' }, { status: 409 }) : new Response('invalid JSON', { status: 503 })) : fallback(url, init));
    await start('publish');
    expect((await finish())[0]).toMatchObject({ success: false, detail: `assertion create+finalize failed: ${json ? 'seal failed' : 'HTTP 503'}`, phases: {} });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/vm/publish'))).toBe(false);
  });
  it.each([
    [{}, 200, 'KC: 0 (2 KAs)'],
    [{ error: 'no gas' }, 500, 'no gas (0 KAs)'],
    [{}, 503, 'HTTP 503 (0 KAs)'],
  ])('reports publish response %j with status %i', async (body, status, detail) => {
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url.endsWith('/vm/publish') ? Response.json(body, { status }) : fallback(url, init));
    await start('publish');
    expect((await finish())[0]).toMatchObject({ success: status === 200, detail, phases: {} });
  });
  it.each(['publish', 'query', 'workspace', 'chat'])('records transport timeouts for %s without rejecting the run', async op => {
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!url.includes('/context-graph/') && !url.endsWith('/status')) throw new DOMException('expired', 'TimeoutError');
      return fallback(url, init);
    });
    await start(op);
    const [event] = await finish();
    expect(event).toMatchObject({ opType: op, success: false, detail: `timeout (${op === 'chat' ? 10 : op === 'query' ? 30 : 60}s)`, phases: {} });
    expect((await request('/sim/status')).body.byOp[op]).toMatchObject({ ok: 0, fail: 1, timeouts: 1, totalMs: 0 });
  });
  it.each([{ delivered: false, error: 'peer rejected' }, { delivered: false }])('reports chat delivery result %j', async body => {
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url.endsWith('/chat') ? Response.json(body) : fallback(url, init));
    await start('chat');
    expect((await finish())[0]).toMatchObject({ success: body.delivered !== false, detail: 'error' in body ? body.error : 'not delivered', phases: {} });
  });
  it('handles offline and unidentifiable peers without sending chat', async () => {
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/status')) {
        if (new URL(url).port === '9201') throw new Error('offline');
        return Response.json({}, { status: new URL(url).port === '9202' ? 503 : 200 });
      }
      return fallback(url, init);
    });
    await start('chat');
    expect((await finish())[0]).toMatchObject({ success: false, detail: 'No peers with known peerId', durationMs: 0 });
    expect(operations()).toEqual([]);
  });
  it('handles empty query results and workspace responses', async () => {
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => !url.includes('/context-graph/') ? Response.json({}) : fallback(url, init));
    await start('query');
    expect((await finish())[0]).toMatchObject({ detail: '0 bindings (LIMIT 10)', phases: {} });
    events.length = 0;
    await start('workspace');
    expect((await finish())[0]).toMatchObject({ success: true, phases: {} });
  });
});

describe('simulation scheduling and event delivery', () => {
  it.each(['created', 'exists', 'bad-json', 'rejected', 'thrown'])('handles context graph provisioning: %s', async mode => {
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/context-graph/exists')) {
        expect(new URL(url).searchParams.get('id')).toBe('owner/team');
        if (mode === 'thrown') throw 'offline';
        return Response.json({ exists: false });
      }
      if (url.endsWith('/context-graph/create')) {
        expect(JSON.parse(String(init?.body))).toEqual({ id: 'owner/team', name: 'owner/team', description: 'Auto-created by sim engine' });
        if (mode === 'exists') return Response.json({ error: 'already exists' }, { status: 409 });
        if (mode === 'rejected') return Response.json({ error: 'forbidden' }, { status: 403 });
        if (mode === 'bad-json') return new Response('broken JSON', { status: 503 });
        return Response.json({ ok: true });
      }
      return fallback(url, init);
    });
    await start('query'); await finish();
    const messages = events.filter(e => e.type === 'error').map(e => e.message).join('\n');
    expect(messages).toContain(mode === 'created' || mode === 'exists' ? 'ready on all nodes' : 'setup failed');
    if (mode === 'bad-json') expect(messages).toContain('503');
    if (mode === 'rejected') expect(messages).toContain('forbidden');
    if (mode === 'thrown') expect(messages).toContain('offline');
    expect(events.at(-1)).toMatchObject({ type: 'done', completed: 1 });
  });
  it('enforces rate, concurrency, round-robin scheduling and exact operation cap', async () => {
    const pending: ((value: Response) => void)[] = [];
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/query')) return new Promise<Response>(resolve => pending.push(resolve));
      return fallback(url, init);
    });
    await start('query', { opCount: 3, opsPerSec: 2, concurrency: 2 });
    expect(pending).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(498); expect(pending).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(pending).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000); expect(pending).toHaveLength(2);
    const calls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/query'));
    expect(calls.map(([url]) => new URL(String(url)).port)).toEqual(['9202', '9203']);
    expect(calls[1][1]?.headers).toEqual({ 'Content-Type': 'application/json' });
    pending[0](Response.json({})); pending[1](Response.json({}));
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(3);
    expect((await request('/sim/status')).body).toMatchObject({ completed: 2, running: true, opsPerSec: 0 });
    await subscribe();
    expect(events.at(-1)).toMatchObject({ type: 'status', completed: 2 });
    await vi.advanceTimersByTimeAsync(500);
    expect(events.at(-1)).toMatchObject({ type: 'status', completed: 2, opsPerSec: 4 });
    pending[2](Response.json({})); await vi.advanceTimersByTimeAsync(0);
    expect(events.at(-1)).toMatchObject({ type: 'done', completed: 3, total: 3, errors: 0 });
    await vi.advanceTimersByTimeAsync(11000);
    expect((await request('/sim/status')).body.opsPerSec).toBe(0);
    expect(pending).toHaveLength(3);
  });
  it('keeps server work running after SSE disconnect, then reconnects and stops it with one terminal event', async () => {
    const fallback = fetchMock.getMockImplementation()!;
    let signal: AbortSignal;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/query')) {
        signal = init!.signal!;
        return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      return fallback(url, init);
    });
    await start('query', { opCount: 10 });
    expect(signal!.aborted).toBe(false);
    const disconnected = stream;
    streamRequest.emit('close');
    const writesAtDisconnect = disconnected.write.mock.calls.length;
    expect((await request('/sim/status')).body.running).toBe(true);
    expect(signal!.aborted).toBe(false);
    await subscribe();
    expect(events.at(-1)).toMatchObject({ type: 'status', completed: 0 });
    expect((await request('/sim/stop', 'POST')).body).toEqual({ stopped: true });
    expect(signal!.aborted).toBe(true);
    await finish();
    expect(disconnected.write).toHaveBeenCalledTimes(writesAtDisconnect);
    expect((await request('/sim/status')).body.running).toBe(false);
    expect(events.filter(e => e.type === 'done')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'done', completed: 0 }); // Late aborted operations cannot change terminal totals.
    expect((await request('/sim/stop', 'POST')).body.stopped).toBe(false);
  });
  it('drops failed/disconnected SSE clients and bounds error logging', async () => {
    const broken = stream;
    broken.write.mockImplementation(() => { throw new Error('socket closed'); });
    await subscribe();
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url.endsWith('/query') ? Response.json({}, { status: 500 }) : fallback(url, init));
    await start('query', { opCount: 23, opsPerSec: 1000 }); await finish();
    expect(broken.write).toHaveBeenCalledTimes(2); // initial handshake plus first failed event
    expect(vi.mocked(console.error).mock.calls.filter(([line]) => String(line).startsWith('[sim] error #'))).toHaveLength(20);
    expect(events.at(-1)).toMatchObject({ type: 'done', completed: 23, errors: 23 });
    const count = stream.write.mock.calls.length;
    streamRequest.emit('close');
    await start('query'); await finish();
    expect(stream.write).toHaveBeenCalledTimes(count);
  });
  it('handles request stream failures and absent URLs without starting a run', async () => {
    const req = Object.assign(new EventEmitter(), { url: '/sim/start', method: 'POST' }) as IncomingMessage;
    const res = response();
    const handling = engine.handleSimRequest(req, res as unknown as ServerResponse);
    req.emit('error', new Error('request disconnected')); await handling;
    expect(res.code).toBe(400); expect(JSON.parse(res.body).error).toBe('Invalid JSON body');
    expect((await request(undefined)).code).toBe(404);
    expect((await request('/sim/status')).body.running).toBe(false);
  });
  it('mounts only /sim/ routes in the Vite middleware', async () => {
    let middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
    const use = vi.fn(handler => { middleware = handler; });
    const configure = engine.simEngine().configureServer;
    expect(typeof configure).toBe('function');
    (configure as Function)({ middlewares: { use } });
    expect(use).toHaveBeenCalledTimes(1);
    const next = vi.fn();
    middleware!({ url: '/other' } as IncomingMessage, response() as unknown as ServerResponse, next);
    middleware!({} as IncomingMessage, response() as unknown as ServerResponse, next);
    expect(next).toHaveBeenCalledTimes(2);
    const res = response();
    middleware!({ url: '/sim/status', method: 'GET' } as IncomingMessage, res as unknown as ServerResponse, next);
    expect(res.code).toBe(200);
    expect(next).toHaveBeenCalledTimes(2);
  });
});


describe('executor rejection recovery', () => {
  it('finishes and reports failures when an operation cannot allocate its requested batch', async () => {
    // Exceeds JavaScript's maximum array length and throws immediately, without allocating a huge array.
    await start('publish', { kasPerPublish: 2 ** 32, opCount: 2 });
    const failed = await finish(); expect(failed).toHaveLength(2);
    expect(failed.every(event => !event.success && event.detail === 'Unexpected executor error')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', completed: 2, errors: 2, byOp: { publish: { ok: 0, fail: 2, allMs: 0, totalMs: 0, phaseTotals: {}, phaseCounts: {} } } });
    expect((await request('/sim/status')).body.running).toBe(false);
  });
});


describe('run-scoped recovery and cancellation', () => {
  const messages = (res: ReturnType<typeof response>) => res.write.mock.calls
    .filter(([chunk]) => chunk.startsWith('data: ')).map(([chunk]) => JSON.parse(chunk.slice(6)));
  const config = { opCount: 1, opsPerSec: 1, enabledOps: ['query'] };

  it('replays the original terminal result after another run starts without accepting its events', async () => {
    const first = await start('query', { opCount: 2, opsPerSec: 1 }, 'first');
    streamRequest.emit('close');
    await finish(2000);
    const result = (await request(`/sim/status?runId=${first}`)).body;
    expect(result).toMatchObject({ runId: first, running: false, completed: 2, errors: 0 });
    await start('query', { opCount: 10, opsPerSec: 1 }, 'second');
    await subscribe(first);
    const recovered = stream;
    expect(messages(recovered)).toEqual([expect.objectContaining({ type: 'done', runId: first, completed: 2, errors: 0, elapsedMs: result.elapsedMs })]);
    await finish(2000);
    expect(messages(recovered)).toHaveLength(1);
    expect((await request(`/sim/status?runId=${first}`)).body).toEqual(result);
    expect((await request('/sim/status?runId=second')).body).toMatchObject({ running: true, completed: 3 });
  });

  it('sends running snapshots and operations only to subscribers of that run', async () => {
    const id = await start('query', { opCount: 3, opsPerSec: 1 }, 'scoped');
    await subscribe(id);
    const scoped = stream;
    expect(messages(scoped)[0]).toMatchObject({ type: 'status', runId: id, running: true, completed: 1 });
    await finish(2000);
    expect(messages(scoped).filter(event => event.type === 'op')).toHaveLength(2);
    expect(messages(scoped).at(-1)).toMatchObject({ type: 'done', completed: 3, runId: id });
    const count = scoped.write.mock.calls.length;
    await start('query', {}, 'later'); await finish();
    expect(scoped.write).toHaveBeenCalledTimes(count);
  });

  it('cancels its own pending start without cancelling an active different run', async () => {
    await start('query', { opCount: 10, opsPerSec: 1 }, 'active');
    expect((await request('/sim/stop?runId=not-accepted', 'POST')).body).toEqual({ stopped: true, runId: 'not-accepted' });
    expect((await request('/sim/status?runId=active')).body.running).toBe(true);
    await request('/sim/stop?runId=active', 'POST');
    expect((await request('/sim/start?runId=not-accepted', 'POST', config)).code).toBe(409);
    expect((await request('/sim/status')).body).toMatchObject({ runId: 'active', running: false });
  });

  it('honors cancellation received while the start body is still being read', async () => {
    const req = Object.assign(new EventEmitter(), { url: '/sim/start?runId=delayed-body', method: 'POST' }) as IncomingMessage;
    const res = response();
    const starting = engine.handleSimRequest(req, res as unknown as ServerResponse);
    await request('/sim/stop?runId=delayed-body', 'POST');
    req.emit('data', Buffer.from(JSON.stringify(config))); req.emit('end'); await starting;
    expect(res.code).toBe(409);
    await finish();
    expect(operations()).toEqual([]);
  });

  it('serializes concurrent start bodies before accepting a run', async () => {
    const delayed = Object.assign(new EventEmitter(), { url: '/sim/start?runId=loser', method: 'POST' }) as IncomingMessage;
    const res = response(); const pending = engine.handleSimRequest(delayed, res as unknown as ServerResponse);
    await start('query', { opCount: 10, opsPerSec: 1 }, 'winner');
    delayed.emit('data', Buffer.from(JSON.stringify(config))); delayed.emit('end'); await pending;
    expect(res.code).toBe(409);
    expect((await request('/sim/status')).body.runId).toBe('winner');
  });

  it('keeps terminal totals immutable when an aborted operation resolves after the next start', async () => {
    const fallback = fetchMock.getMockImplementation()!;
    let complete!: (response: Response) => void;
    fetchMock.mockImplementationOnce(fallback);
    fetchMock.mockImplementation((url, init) => url.endsWith('/query')
      ? new Promise<Response>(resolve => { complete = resolve; }) : fallback(url, init));
    await start('query', {}, 'old');
    const stopped = (await request('/sim/stop?runId=old', 'POST')).body;
    expect(stopped).toMatchObject({ stopped: true, runId: 'old', snapshot: { type: 'done', completed: 0 } });
    fetchMock.mockImplementation(fallback);
    await start('query', { opCount: 20, opsPerSec: 1 }, 'new');
    complete(Response.json({ result: { bindings: [] } })); await finish(1);
    expect((await request('/sim/status')).body).toMatchObject({ runId: 'new', running: true, completed: 1, errors: 0 });
    expect((await request('/sim/stop?runId=old', 'POST')).body).toEqual(stopped);
    expect((await request('/sim/status?runId=new')).body.running).toBe(true);
    expect((await request('/sim/status?runId=old')).body.completed).toBe(0);
  });

  it('does not reuse a completed run ID', async () => {
    await start('query', {}, 'once'); await finish();
    expect((await request('/sim/start?runId=once', 'POST', config)).code).toBe(409);
    expect((await request('/sim/status?runId=once')).body).toMatchObject({ running: false, completed: 1 });
  });

  it('retains a bounded history and explicitly reports missing results', async () => {
    for (let i = 0; i < 101; i++) {
      const id = `history-${i}`;
      expect((await request(`/sim/start?runId=${id}`, 'POST', config)).code).toBe(200);
      await request(`/sim/stop?runId=${id}`, 'POST');
    }
    expect((await request('/sim/status?runId=history-0')).code).toBe(404);
    expect((await request('/sim/status?runId=history-1')).body.running).toBe(false);
    await subscribe('history-0');
    expect(messages(stream)).toEqual([{ type: 'unavailable', runId: 'history-0', message: expect.stringContaining('no longer available') }]);
    expect(stream.end).toHaveBeenCalledOnce();
  });

  it('bounds pending cancellations without forgetting confirmations or blocking cancellation of accepted runs', async () => {
    for (let i = 0; i < 100; i++) expect((await request(`/sim/stop?runId=cancel-${i}`, 'POST')).body.stopped).toBe(true);
    expect((await request('/sim/stop?runId=overflow', 'POST')).body.stopped).toBe(false);
    expect((await request('/sim/stop?runId=cancel-0', 'POST')).body.stopped).toBe(true);
    expect((await request('/sim/start?runId=cancel-0', 'POST', config)).code).toBe(409);
    await start('query', { opCount: 10, opsPerSec: 1 }, 'accepted');
    expect((await request('/sim/stop?runId=accepted', 'POST')).body.stopped).toBe(true);
  });

  it('reclaims processed early-cancellation capacity while protecting unprocessed and retained IDs', async () => {
    expect((await request('/sim/stop?runId=still-delayed', 'POST')).body.stopped).toBe(true);
    for (let i = 0; i < 130; i++) {
      expect((await request(`/sim/stop?runId=processed-${i}`, 'POST')).body.stopped).toBe(true);
      expect((await request(`/sim/start?runId=processed-${i}`, 'POST', config)).code).toBe(409);
    }
    expect((await request('/sim/stop?runId=fresh', 'POST')).body).toEqual({ stopped: true, runId: 'fresh' });
    expect((await request('/sim/stop?runId=processed-129', 'POST')).body).toEqual({ stopped: true, runId: 'processed-129' });
    expect((await request('/sim/start?runId=processed-129', 'POST', config)).code).toBe(409);
    expect((await request('/sim/start?runId=still-delayed', 'POST', config)).code).toBe(409);
    expect((await request('/sim/start?runId=fresh', 'POST', config)).code).toBe(409);
    expect(operations()).toEqual([]);
    await start('query', { opCount: 10 }, 'active-during-rejection');
    await request('/sim/stop?runId=cancel-while-active', 'POST');
    expect((await request('/sim/start?runId=cancel-while-active', 'POST', config)).code).toBe(409);
    await request('/sim/stop?runId=active-during-rejection', 'POST');
    expect((await request('/sim/start?runId=cancel-while-active', 'POST', config)).code).toBe(409);
  });

  it('replays exact latency and phase totals for successful and failed operations', async () => {
    const fallback = fetchMock.getMockImplementation()!;
    let queries = 0;
    fetchMock.mockImplementation((url, init) => {
      if (!url.endsWith('/api/query')) return fallback(url, init);
      const first = ++queries === 1;
      return new Promise<Response>(resolve => setTimeout(() => resolve(Response.json(
        { result: { bindings: [] }, phases: { query: first ? 20 : 10 } },
        { status: first ? 200 : 500 },
      )), first ? 100 : 40));
    });
    await start('query', { opCount: 2, opsPerSec: 1, concurrency: 1 }, 'latency');
    await finish(2000);
    const snapshot = (await request('/sim/status?runId=latency')).body;
    const expected = { query: { ok: 1, fail: 1, timeouts: 0, totalMs: 100, allMs: 140,
      phaseTotals: { query: 30 }, phaseCounts: { query: 2 } } };
    expect(snapshot).toMatchObject({ running: false, completed: 2, errors: 1, byOp: expected });
    const statusEvents = events.filter(event => event.type === 'status' && event.completed === 1);
    expect(statusEvents.length).toBeGreaterThan(0);
    expect(statusEvents[0].byOp.query).toEqual({ ok: 1, fail: 0, timeouts: 0, totalMs: 100, allMs: 100,
      phaseTotals: { query: 20 }, phaseCounts: { query: 1 } });
    await subscribe('latency');
    expect(messages(stream)).toEqual([expect.objectContaining({ type: 'done', completed: 2, errors: 1, byOp: expected })]);
  });

  it('rejects an empty run ID without falling back to global cancellation', async () => {
    await start('query', { opCount: 10, opsPerSec: 1 }, 'still-running');
    expect((await request('/sim/stop?runId=', 'POST')).code).toBe(400);
    expect((await request('/sim/status?runId=still-running')).body.running).toBe(true);
  });

  it.each(['/sim/start', '/sim/stop', '/sim/events', '/sim/status'])('rejects malformed run IDs on %s', async path => {
    const result = await request(`${path}?runId=%20`, path.endsWith('start') || path.endsWith('stop') ? 'POST' : 'GET', config);
    expect(result).toEqual({ code: 400, body: { error: 'Invalid simulation run ID' } });
  });
});
