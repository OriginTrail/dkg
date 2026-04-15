import { describe, it, expect, vi, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import { handleNodeUIRequest } from '../src/api.js';

function createMockReq(opts: {
  method: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
}): { req: IncomingMessage; url: URL } {
  const stream = Readable.from(opts.body != null ? [Buffer.from(opts.body, 'utf8')] : []);
  const req = stream as unknown as IncomingMessage & {
    method: string;
    headers: Record<string, string>;
  };
  req.method = opts.method;
  req.headers = opts.headers ?? {};
  return {
    req: req as IncomingMessage,
    url: new URL(`http://localhost${opts.path}`),
  };
}

function createMockRes(): {
  res: ServerResponse;
  state: {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
  };
  finished: Promise<void>;
} {
  const chunks: Buffer[] = [];
  const state = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
  };

  let resolveFinished: () => void;
  const finished = new Promise<void>((r) => { resolveFinished = r; });

  const writable = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
    final(cb) {
      state.body = Buffer.concat(chunks).toString('utf8');
      resolveFinished();
      cb();
    },
  });

  const res = Object.assign(writable, {
    headersSent: false,
    statusCode: 200,
    writeHead(code: number, headers?: Record<string, string>) {
      state.statusCode = code;
      state.headers = headers ?? {};
      (res as any).headersSent = true;
      return res;
    },
    end(chunk?: Buffer | string) {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
      }
      state.body = Buffer.concat(chunks).toString('utf8');
      writable.destroy();
      resolveFinished();
      return res;
    },
  });

  return { res: res as unknown as ServerResponse, state, finished };
}

function parseJsonBody(body: string): any {
  return body ? JSON.parse(body) : {};
}

describe('handleNodeUIRequest Stage 5 memory/publication routes', () => {
  it('returns session graph delta for valid session/turn parameters', async () => {
    const memoryManager = {
      getSessionGraphDelta: vi.fn().mockResolvedValue({
        mode: 'delta',
        sessionId: 'session-1',
        turnId: 'turn-2',
        watermark: {
          baseTurnId: 'turn-1',
          previousTurnId: 'turn-1',
          appliedTurnId: 'turn-2',
          latestTurnId: 'turn-2',
          turnIndex: 2,
          turnCount: 2,
        },
        triples: [{ subject: 's', predicate: 'p', object: 'o' }],
      }),
    } as any;

    const { req, url } = createMockReq({
      method: 'GET',
      path: '/api/memory/sessions/session-1/graph-delta?turnId=turn-2&baseTurnId=turn-1',
    });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(
      req,
      res,
      url,
      {} as any,
      '.',
      undefined,
      undefined,
      undefined,
      memoryManager,
      undefined,
    );

    expect(handled).toBe(true);
    expect(state.statusCode).toBe(200);
    expect(memoryManager.getSessionGraphDelta).toHaveBeenCalledWith('session-1', 'turn-2', { baseTurnId: 'turn-1' });
    expect(parseJsonBody(state.body)).toMatchObject({ mode: 'delta', turnId: 'turn-2' });
  });

  it('returns 400 for invalid turn id in graph-delta route', async () => {
    const memoryManager = {
      getSessionGraphDelta: vi.fn(),
    } as any;

    const { req, url } = createMockReq({
      method: 'GET',
      path: '/api/memory/sessions/session-1/graph-delta?turnId=bad/turn',
    });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(
      req,
      res,
      url,
      {} as any,
      '.',
      undefined,
      undefined,
      undefined,
      memoryManager,
      undefined,
    );

    expect(handled).toBe(true);
    expect(state.statusCode).toBe(400);
    expect(parseJsonBody(state.body)).toMatchObject({ error: 'Missing or invalid "turnId"' });
    expect(memoryManager.getSessionGraphDelta).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid baseTurnId in graph-delta route', async () => {
    const memoryManager = {
      getSessionGraphDelta: vi.fn(),
    } as any;

    const { req, url } = createMockReq({
      method: 'GET',
      path: '/api/memory/sessions/session-1/graph-delta?turnId=turn-2&baseTurnId=bad/base',
    });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(
      req,
      res,
      url,
      {} as any,
      '.',
      undefined,
      undefined,
      undefined,
      memoryManager,
      undefined,
    );

    expect(handled).toBe(true);
    expect(state.statusCode).toBe(400);
    expect(parseJsonBody(state.body)).toMatchObject({ error: 'Invalid "baseTurnId" format' });
    expect(memoryManager.getSessionGraphDelta).not.toHaveBeenCalled();
  });

  it('passes session history limit and descending ordering through to memoryManager.getSession() without reordering the backend result', async () => {
    const memoryManager = {
      getSession: vi.fn().mockResolvedValue({
        session: 'session-1',
        messages: [
          {
            uri: 'urn:dkg:chat:msg:agent-2',
            author: 'agent',
            text: 'newest',
            ts: '2026-04-14T08:00:01Z',
          },
          {
            uri: 'urn:dkg:chat:msg:user-1',
            author: 'user',
            text: 'older',
            ts: '2026-04-14T08:00:00Z',
            failureReason: 'timeout',
          },
        ],
      }),
    } as any;

    const { req, url } = createMockReq({
      method: 'GET',
      path: '/api/memory/sessions/session-1?limit=25&order=desc',
    });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(
      req,
      res,
      url,
      {} as any,
      '.',
      undefined,
      undefined,
      undefined,
      memoryManager,
      undefined,
    );

    expect(handled).toBe(true);
    expect(state.statusCode).toBe(200);
    expect(memoryManager.getSession).toHaveBeenCalledWith('session-1', { limit: 25, order: 'desc' });
    expect(parseJsonBody(state.body)).toMatchObject({
      session: 'session-1',
      messages: [
        { uri: 'urn:dkg:chat:msg:agent-2', text: 'newest' },
        { uri: 'urn:dkg:chat:msg:user-1', failureReason: 'timeout' },
      ],
    });
  });

  it('returns 400 for invalid session query parameters', async () => {
    const memoryManager = {
      getSession: vi.fn(),
    } as any;

    const invalidCases = [
      '/api/memory/sessions/session-1?limit=0',
      '/api/memory/sessions/session-1?limit=25xyz',
      '/api/memory/sessions/session-1?order=sideways',
    ];

    for (const path of invalidCases) {
      const { req, url } = createMockReq({ method: 'GET', path });
      const { res, state } = createMockRes();

      const handled = await handleNodeUIRequest(
        req,
        res,
        url,
        {} as any,
        '.',
        undefined,
        undefined,
        undefined,
        memoryManager,
        undefined,
      );

      expect(handled).toBe(true);
      expect(state.statusCode).toBe(400);
    }

    expect(memoryManager.getSession).not.toHaveBeenCalled();
  });

  // Codex Bug B38: the session-publication routes are no-ops in v1
  // because chat turns now live in Working Memory assertions rather
  // than in shared memory — the old SWM-based publication flow has
  // nothing to read. The routes short-circuit to HTTP 501 with a
  // stable error code and a pointer at the v2 follow-up; chat-memory
  // manager methods are never invoked. See api.ts for the handler
  // and chat-memory.ts:1218-1224 for the TODO that tracks the v2
  // promotion-based reimplementation.

  it('returns 501 Not Implemented for GET /api/memory/sessions/:id/publication (Codex B38)', async () => {
    const memoryManager = {
      // These methods still exist on the class but v1 routes never
      // invoke them — asserting below that they were not called.
      getSessionPublicationStatus: vi.fn(),
      publishSession: vi.fn(),
    } as any;

    const { req, url } = createMockReq({
      method: 'GET',
      path: '/api/memory/sessions/session-1/publication',
    });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(
      req,
      res,
      url,
      {} as any,
      '.',
      undefined,
      undefined,
      undefined,
      memoryManager,
      undefined,
    );

    expect(handled).toBe(true);
    expect(state.statusCode).toBe(501);
    const body = parseJsonBody(state.body);
    expect(body).toMatchObject({
      error: 'Session publication is not implemented in v1',
      errorCode: 'session_publication_not_implemented_v1',
    });
    expect(body.reason).toMatch(/Working Memory assertions|chat-turns/i);
    expect(memoryManager.getSessionPublicationStatus).not.toHaveBeenCalled();
  });

  it('returns 501 Not Implemented for POST /api/memory/sessions/:id/publish (Codex B38)', async () => {
    const memoryManager = {
      getSessionPublicationStatus: vi.fn(),
      publishSession: vi.fn(),
    } as any;

    const { req, url } = createMockReq({
      method: 'POST',
      path: '/api/memory/sessions/session-1/publish',
      body: JSON.stringify({
        rootEntities: ['urn:dkg:chat:msg:m-1'],
        clearAfter: true,
      }),
      headers: { 'content-type': 'application/json' },
    });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(
      req,
      res,
      url,
      {} as any,
      '.',
      undefined,
      undefined,
      undefined,
      memoryManager,
      undefined,
    );

    expect(handled).toBe(true);
    expect(state.statusCode).toBe(501);
    const body = parseJsonBody(state.body);
    expect(body).toMatchObject({
      error: 'Session publication is not implemented in v1',
      errorCode: 'session_publication_not_implemented_v1',
    });
    expect(body.reason).toMatch(/Working Memory assertions|chat-turns/i);
    expect(memoryManager.publishSession).not.toHaveBeenCalled();
  });

  // Codex Bug B52: the legacy `/api/memory/import` endpoint was retired
  // in the openclaw-dkg-primary-memory workstream. Rather than let
  // external callers fall through to the generic 404 (wire-level
  // contract break with no migration signal), the route serves a 410
  // Gone stub that names the two replacements — the adapter's
  // `dkg_memory_import` tool and the daemon's
  // `POST /api/assertion/:name/write` direct route. Mirrors the B38
  // pattern for the session-publication routes above.
  it('returns 410 Gone for POST /api/memory/import with migration pointers (Codex B52)', async () => {
    const { req, url } = createMockReq({
      method: 'POST',
      path: '/api/memory/import',
      body: JSON.stringify({ text: 'anything', source: 'claude' }),
      headers: { 'content-type': 'application/json' },
    });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(
      req,
      res,
      url,
      {} as any,
      '.',
      undefined,
      undefined,
      undefined,
      undefined, // memoryManager intentionally undefined — the stub doesn't need it
      undefined,
    );

    expect(handled).toBe(true);
    expect(state.statusCode).toBe(410);
    const body = parseJsonBody(state.body);
    expect(body).toMatchObject({
      error: 'POST /api/memory/import is retired in v1',
      errorCode: 'memory_import_endpoint_retired_v1',
    });
    expect(body.reason).toMatch(/V9 relic|LLM API keys|sidecar graph/i);
    expect(Array.isArray(body.replacements)).toBe(true);
    expect(body.replacements.length).toBeGreaterThanOrEqual(2);
    // Both replacement surfaces must be named explicitly.
    const replacementNames = body.replacements.map((r: any) => r.name ?? r.path ?? '');
    expect(replacementNames.join(' ')).toMatch(/dkg_memory_import/);
    expect(replacementNames.join(' ')).toMatch(/\/api\/assertion\/:name\/write/);
  });
});

// --- /api/node-log tail behavior ---

describe('handleNodeUIRequest /api/node-log', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeFakeDb(dataDir: string) {
    return { dataDir } as any;
  }

  it('returns the last N lines from daemon.log', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dkg-log-test-'));
    const lines = Array.from({ length: 20 }, (_, i) => `log line ${i + 1}`);
    writeFileSync(join(tmpDir, 'daemon.log'), lines.join('\n') + '\n');

    const { req, url } = createMockReq({ method: 'GET', path: '/api/node-log?lines=5' });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(
      req, res, url, makeFakeDb(tmpDir), '.', undefined, undefined, undefined, undefined, undefined,
    );

    expect(handled).toBe(true);
    expect(state.statusCode).toBe(200);
    const body = parseJsonBody(state.body);
    const nonEmpty = body.lines.filter((l: string) => l.length > 0);
    expect(nonEmpty.length).toBeLessThanOrEqual(5);
    expect(nonEmpty[nonEmpty.length - 1]).toBe('log line 20');
  });

  it('defaults to 500 lines when lines param is missing', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dkg-log-test-'));
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    writeFileSync(join(tmpDir, 'daemon.log'), lines.join('\n') + '\n');

    const { req, url } = createMockReq({ method: 'GET', path: '/api/node-log' });
    const { res, state } = createMockRes();

    await handleNodeUIRequest(
      req, res, url, makeFakeDb(tmpDir), '.', undefined, undefined, undefined, undefined, undefined,
    );

    const body = parseJsonBody(state.body);
    expect(body.lines.length).toBeGreaterThan(0);
    expect(body.lines.length).toBeLessThanOrEqual(500);
  });

  it('clamps negative/invalid lines to 500 (returns valid response)', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dkg-log-test-'));
    writeFileSync(join(tmpDir, 'daemon.log'), 'single line\n');

    const { req, url } = createMockReq({ method: 'GET', path: '/api/node-log?lines=-10' });
    const { res, state } = createMockRes();

    await handleNodeUIRequest(
      req, res, url, makeFakeDb(tmpDir), '.', undefined, undefined, undefined, undefined, undefined,
    );

    expect(state.statusCode).toBe(200);
    const body = parseJsonBody(state.body);
    expect(body.lines).toBeDefined();
  });

  it('clamps lines > 5000 to 5000', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dkg-log-test-'));
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    writeFileSync(join(tmpDir, 'daemon.log'), lines.join('\n') + '\n');

    const { req, url } = createMockReq({ method: 'GET', path: '/api/node-log?lines=99999' });
    const { res, state } = createMockRes();

    await handleNodeUIRequest(
      req, res, url, makeFakeDb(tmpDir), '.', undefined, undefined, undefined, undefined, undefined,
    );

    expect(state.statusCode).toBe(200);
    const body = parseJsonBody(state.body);
    // File has 100 lines, but clamped request means we get all of them (< 5000)
    expect(body.lines.length).toBeGreaterThan(0);
  });

  it('filters lines by search query', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dkg-log-test-'));
    const content = [
      'INFO publish started',
      'DEBUG heartbeat',
      'INFO publish completed',
      'ERROR timeout',
    ].join('\n') + '\n';
    writeFileSync(join(tmpDir, 'daemon.log'), content);

    const { req, url } = createMockReq({ method: 'GET', path: '/api/node-log?q=publish' });
    const { res, state } = createMockRes();

    await handleNodeUIRequest(
      req, res, url, makeFakeDb(tmpDir), '.', undefined, undefined, undefined, undefined, undefined,
    );

    const body = parseJsonBody(state.body);
    expect(body.lines.every((l: string) => l.toLowerCase().includes('publish'))).toBe(true);
    expect(body.lines).toHaveLength(2);
  });

  it('returns empty lines when daemon.log does not exist', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dkg-log-test-'));
    // No daemon.log created

    const { req, url } = createMockReq({ method: 'GET', path: '/api/node-log' });
    const { res, state } = createMockRes();

    await handleNodeUIRequest(
      req, res, url, makeFakeDb(tmpDir), '.', undefined, undefined, undefined, undefined, undefined,
    );

    expect(state.statusCode).toBe(200);
    const body = parseJsonBody(state.body);
    expect(body.lines).toEqual([]);
    expect(body.totalSize).toBe(0);
  });
});

describe('serveStatic path traversal prevention', () => {
  let staticDir: string;

  function fakeDb(dir: string) { return { dataDir: dir } as any; }

  afterEach(() => {
    if (staticDir) rmSync(staticDir, { recursive: true, force: true });
  });

  function setup(): void {
    staticDir = mkdtempSync(join(tmpdir(), 'dkg-static-'));
    writeFileSync(join(staticDir, 'index.html'), '<html></html>');
    mkdirSync(join(staticDir, 'assets'), { recursive: true });
    writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log("ok")');
  }

  it('URL normalization prevents ../ traversal at the HTTP layer', async () => {
    setup();
    const { req, url } = createMockReq({ method: 'GET', path: '/ui/../../etc/passwd' });
    const { res, state } = createMockRes();

    const handled = await handleNodeUIRequest(
      req, res, url, fakeDb(staticDir), staticDir, undefined, undefined, undefined, undefined, undefined,
    );

    // URL parser normalizes /ui/../../etc/passwd to /etc/passwd which doesn't match /ui
    expect(handled).toBe(false);
  });

  it('rejects ../ traversal if URL bypasses normalization (defense-in-depth)', async () => {
    setup();
    const { req } = createMockReq({ method: 'GET', path: '/ui/../../etc/passwd' });
    const { res, state } = createMockRes();
    const rawUrl = { pathname: '/ui/../../etc/passwd', searchParams: new URLSearchParams() } as unknown as URL;

    await handleNodeUIRequest(
      req, res, rawUrl, fakeDb(staticDir), staticDir, undefined, undefined, undefined, undefined, undefined,
    );

    expect(state.statusCode).toBe(403);
    expect(state.body).toContain('Forbidden');
  });

  it('rejects deeply nested traversal if URL bypasses normalization', async () => {
    setup();
    const { req } = createMockReq({ method: 'GET', path: '/ui/x' });
    const { res, state } = createMockRes();
    const rawUrl = { pathname: '/ui/assets/../../../etc/passwd', searchParams: new URLSearchParams() } as unknown as URL;

    await handleNodeUIRequest(
      req, res, rawUrl, fakeDb(staticDir), staticDir, undefined, undefined, undefined, undefined, undefined,
    );

    expect(state.statusCode).toBe(403);
    expect(state.body).toContain('Forbidden');
  });

  it('serves valid /ui/index.html normally', async () => {
    setup();
    const { req, url } = createMockReq({ method: 'GET', path: '/ui/index.html' });
    const { res, state, finished } = createMockRes();

    await handleNodeUIRequest(
      req, res, url, fakeDb(staticDir), staticDir, undefined, undefined, undefined, undefined, undefined,
    );
    await finished;

    expect(state.statusCode).toBe(200);
    expect(state.body).toContain('<html>');
  });

  it('allows filenames starting with .. that are not traversals', () => {
    const base = '/srv/static';
    const file = resolve(base, '..page.html');
    const r = relative(base, file);
    expect(r).toBe('..page.html');
    expect(r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)).toBe(false);
  });

  it('serves valid /ui/ root normally', async () => {
    setup();
    const { req, url } = createMockReq({ method: 'GET', path: '/ui/' });
    const { res, state, finished } = createMockRes();

    await handleNodeUIRequest(
      req, res, url, fakeDb(staticDir), staticDir, undefined, undefined, undefined, undefined, undefined,
    );
    await finished;

    expect(state.statusCode).toBe(200);
    expect(state.body).toContain('<html>');
  });
});

describe('handleNodeUIRequest CORS origin handling', () => {
  it('omits Access-Control-Allow-Origin when corsOrigin is undefined', async () => {
    const { req, url } = createMockReq({ method: 'GET', path: '/api/metrics' });
    const { res, state } = createMockRes();

    const fakeDb = { getMetrics: () => [], getErrorHotspots: () => [], getLatestSnapshot: () => ({}) } as any;

    await handleNodeUIRequest(req, res, url, fakeDb, '.', undefined, undefined, undefined, undefined, undefined, undefined, undefined);

    expect(state.statusCode).toBe(200);
    expect(state.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('sets Access-Control-Allow-Origin when corsOrigin is provided', async () => {
    const { req, url } = createMockReq({ method: 'GET', path: '/api/metrics' });
    const { res, state } = createMockRes();

    const fakeDb = { getMetrics: () => [], getErrorHotspots: () => [], getLatestSnapshot: () => ({}) } as any;

    await handleNodeUIRequest(req, res, url, fakeDb, '.', undefined, undefined, undefined, undefined, undefined, undefined, 'https://example.com');

    expect(state.statusCode).toBe(200);
    expect(state.headers['Access-Control-Allow-Origin']).toBe('https://example.com');
  });

  it('omits Access-Control-Allow-Origin when corsOrigin is explicitly null (rejected origin)', async () => {
    const { req, url } = createMockReq({ method: 'GET', path: '/api/metrics' });
    const { res, state } = createMockRes();

    const fakeDb = { getMetrics: () => [], getErrorHotspots: () => [], getLatestSnapshot: () => ({}) } as any;

    await handleNodeUIRequest(req, res, url, fakeDb, '.', undefined, undefined, undefined, undefined, undefined, undefined, null);

    expect(state.statusCode).toBe(200);
    expect(state.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });
});
