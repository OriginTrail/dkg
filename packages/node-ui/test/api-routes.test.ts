import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import { handleNodeUIRequest } from '../src/api.js';

/**
 * Boots a real Node `http.Server` whose request handler delegates to
 * `handleNodeUIRequest`. Tests then make real `fetch` calls into it — no
 * fake req/res objects, no mocks of node:http.
 *
 * The handler arguments after the request triple are configured per request
 * via the `configure` callback so each test can supply its own `memoryManager`,
 * `dataDir`, `corsOrigin`, etc.
 */
function makeHarness() {
  type HandlerArgs = Parameters<typeof handleNodeUIRequest>;
  type Tail = [
    HandlerArgs[3], // db
    HandlerArgs[4], // staticRoot
    HandlerArgs[5], HandlerArgs[6], HandlerArgs[7], HandlerArgs[8], HandlerArgs[9],
    HandlerArgs[10]?, HandlerArgs[11]?, HandlerArgs[12]?,
  ];
  let nextArgs: Tail = [
    {} as any, '.', undefined, undefined, undefined, undefined, undefined,
  ] as Tail;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    handleNodeUIRequest(req, res, url, ...nextArgs).then((handled) => {
      if (!handled && !res.headersSent) {
        res.statusCode = 404;
        res.end('Not Found');
      }
    }).catch((err) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(String(err));
      }
    });
  });

  return {
    server,
    listen: (): Promise<number> => new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        resolve(addr.port);
      });
    }),
    close: (): Promise<void> => new Promise((resolve) => server.close(() => resolve())),
    setArgs: (tail: Tail) => { nextArgs = tail; },
  };
}

let harness: ReturnType<typeof makeHarness>;
let baseUrl: string;

beforeAll(async () => {
  harness = makeHarness();
  const port = await harness.listen();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await harness.close();
});

/** Stable test double that records calls; not a vi.fn so we can read from it directly. */
function recorder<T>(impl: (...args: any[]) => T | Promise<T>) {
  const calls: any[][] = [];
  const fn = async (...args: any[]) => {
    calls.push(args);
    return impl(...args);
  };
  return { fn, calls };
}

describe('handleNodeUIRequest Stage 5 memory/publication routes', () => {
  it('returns session graph delta for valid session/turn parameters', async () => {
    const delta = recorder(() => ({
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
    }));
    harness.setArgs([
      {} as any, '.', undefined, undefined, undefined,
      { getSessionGraphDelta: delta.fn } as any, undefined,
    ] as any);

    const res = await fetch(
      `${baseUrl}/api/memory/sessions/session-1/graph-delta?turnId=turn-2&baseTurnId=turn-1`,
    );

    expect(res.status).toBe(200);
    expect(delta.calls[0]).toEqual(['session-1', 'turn-2', { baseTurnId: 'turn-1' }]);
    const body = await res.json();
    expect(body).toMatchObject({ mode: 'delta', turnId: 'turn-2' });
  });

  it('returns 400 for invalid turn id in graph-delta route', async () => {
    const delta = recorder(() => undefined);
    harness.setArgs([
      {} as any, '.', undefined, undefined, undefined,
      { getSessionGraphDelta: delta.fn } as any, undefined,
    ] as any);

    const res = await fetch(`${baseUrl}/api/memory/sessions/session-1/graph-delta?turnId=bad/turn`);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'Missing or invalid "turnId"' });
    expect(delta.calls).toHaveLength(0);
  });

  it('returns 400 for invalid baseTurnId in graph-delta route', async () => {
    const delta = recorder(() => undefined);
    harness.setArgs([
      {} as any, '.', undefined, undefined, undefined,
      { getSessionGraphDelta: delta.fn } as any, undefined,
    ] as any);

    const res = await fetch(
      `${baseUrl}/api/memory/sessions/session-1/graph-delta?turnId=turn-2&baseTurnId=bad/base`,
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'Invalid "baseTurnId" format' });
    expect(delta.calls).toHaveLength(0);
  });

  it('passes session history limit and descending ordering through to memoryManager.getSession() without reordering the backend result', async () => {
    const session = recorder(() => ({
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
    }));
    harness.setArgs([
      {} as any, '.', undefined, undefined, undefined,
      { getSession: session.fn } as any, undefined,
    ] as any);

    const res = await fetch(`${baseUrl}/api/memory/sessions/session-1?limit=25&order=desc`);

    expect(res.status).toBe(200);
    expect(session.calls[0]).toEqual(['session-1', { limit: 25, order: 'desc' }]);
    const body = await res.json();
    expect(body).toMatchObject({
      session: 'session-1',
      messages: [
        { uri: 'urn:dkg:chat:msg:agent-2', text: 'newest' },
        { uri: 'urn:dkg:chat:msg:user-1', failureReason: 'timeout' },
      ],
    });
  });

  it('returns 400 for invalid session query parameters', async () => {
    const session = recorder(() => undefined);
    harness.setArgs([
      {} as any, '.', undefined, undefined, undefined,
      { getSession: session.fn } as any, undefined,
    ] as any);

    const invalidPaths = [
      '/api/memory/sessions/session-1?limit=0',
      '/api/memory/sessions/session-1?limit=25xyz',
      '/api/memory/sessions/session-1?order=sideways',
    ];

    for (const path of invalidPaths) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(400);
    }

    expect(session.calls).toHaveLength(0);
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
    const status = recorder(() => undefined);
    const publish = recorder(() => undefined);
    harness.setArgs([
      {} as any, '.', undefined, undefined, undefined,
      { getSessionPublicationStatus: status.fn, publishSession: publish.fn } as any, undefined,
    ] as any);

    const res = await fetch(`${baseUrl}/api/memory/sessions/session-1/publication`);

    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body).toMatchObject({
      error: 'Session publication is not implemented in v1',
      errorCode: 'session_publication_not_implemented_v1',
    });
    expect(body.reason).toMatch(/Working Memory assertions|chat-turns/i);
    expect(status.calls).toHaveLength(0);
  });

  it('returns 501 Not Implemented for POST /api/memory/sessions/:id/publish (Codex B38)', async () => {
    const status = recorder(() => undefined);
    const publish = recorder(() => undefined);
    harness.setArgs([
      {} as any, '.', undefined, undefined, undefined,
      { getSessionPublicationStatus: status.fn, publishSession: publish.fn } as any, undefined,
    ] as any);

    const res = await fetch(`${baseUrl}/api/memory/sessions/session-1/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rootEntities: ['urn:dkg:chat:msg:m-1'],
        clearAfter: true,
      }),
    });

    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body).toMatchObject({
      error: 'Session publication is not implemented in v1',
      errorCode: 'session_publication_not_implemented_v1',
    });
    expect(body.reason).toMatch(/Working Memory assertions|chat-turns/i);
    expect(publish.calls).toHaveLength(0);
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
    harness.setArgs([
      {} as any, '.', undefined, undefined, undefined,
      undefined, undefined,
    ] as any);

    const res = await fetch(`${baseUrl}/api/memory/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'anything', source: 'claude' }),
    });

    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body).toMatchObject({
      error: 'POST /api/memory/import is retired in v1',
      errorCode: 'memory_import_endpoint_retired_v1',
    });
    expect(body.reason).toMatch(/LLM API keys|sidecar graph/i);
    expect(Array.isArray(body.replacements)).toBe(true);
    // Codex B64: the 410 migration pointer must list BOTH the create step
    // and the write step so callers bootstrapping a fresh project CG
    // don't hit a failing first write. The retired `dkg_memory_import`
    // adapter-tool replacement was dropped along with the tool itself
    // (eccbe19d) — non-OpenClaw callers now go directly through the two
    // daemon HTTP routes below.
    expect(body.replacements.length).toBeGreaterThanOrEqual(2);
    const replacementPaths = body.replacements.map((r: any) => r.path ?? r.name ?? '');
    expect(replacementPaths.join(' ')).toMatch(/\/api\/assertion\/create/);
    expect(replacementPaths.join(' ')).toMatch(/\/api\/assertion\/:name\/write/);
    const allNames = body.replacements.map((r: any) => r.name ?? '').join(' ');
    expect(allNames).not.toMatch(/dkg_memory_import/);
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

    harness.setArgs([
      makeFakeDb(tmpDir), '.', undefined, undefined, undefined, undefined, undefined,
    ] as any);

    const res = await fetch(`${baseUrl}/api/node-log?lines=5`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const nonEmpty = body.lines.filter((l: string) => l.length > 0);
    expect(nonEmpty.length).toBeLessThanOrEqual(5);
    expect(nonEmpty[nonEmpty.length - 1]).toBe('log line 20');
  });

  it('defaults to 500 lines when lines param is missing', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dkg-log-test-'));
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    writeFileSync(join(tmpDir, 'daemon.log'), lines.join('\n') + '\n');

    harness.setArgs([
      makeFakeDb(tmpDir), '.', undefined, undefined, undefined, undefined, undefined,
    ] as any);

    const res = await fetch(`${baseUrl}/api/node-log`);
    const body = await res.json();
    expect(body.lines.length).toBeGreaterThan(0);
    expect(body.lines.length).toBeLessThanOrEqual(500);
  });

  it('clamps negative/invalid lines to 500 (returns valid response)', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dkg-log-test-'));
    writeFileSync(join(tmpDir, 'daemon.log'), 'single line\n');

    harness.setArgs([
      makeFakeDb(tmpDir), '.', undefined, undefined, undefined, undefined, undefined,
    ] as any);

    const res = await fetch(`${baseUrl}/api/node-log?lines=-10`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toBeDefined();
  });

  it('clamps lines > 5000 to 5000', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dkg-log-test-'));
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    writeFileSync(join(tmpDir, 'daemon.log'), lines.join('\n') + '\n');

    harness.setArgs([
      makeFakeDb(tmpDir), '.', undefined, undefined, undefined, undefined, undefined,
    ] as any);

    const res = await fetch(`${baseUrl}/api/node-log?lines=99999`);
    expect(res.status).toBe(200);
    const body = await res.json();
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

    harness.setArgs([
      makeFakeDb(tmpDir), '.', undefined, undefined, undefined, undefined, undefined,
    ] as any);

    const res = await fetch(`${baseUrl}/api/node-log?q=publish`);
    const body = await res.json();
    expect(body.lines.every((l: string) => l.toLowerCase().includes('publish'))).toBe(true);
    expect(body.lines).toHaveLength(2);
  });

  it('returns empty lines when daemon.log does not exist', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dkg-log-test-'));

    harness.setArgs([
      makeFakeDb(tmpDir), '.', undefined, undefined, undefined, undefined, undefined,
    ] as any);

    const res = await fetch(`${baseUrl}/api/node-log`);
    expect(res.status).toBe(200);
    const body = await res.json();
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
    harness.setArgs([
      fakeDb(staticDir), staticDir, undefined, undefined, undefined, undefined, undefined,
    ] as any);

    // Real HTTP normalizes /ui/../../etc/passwd → /etc/passwd before it
    // reaches our handler, so the handler returns false (not its route)
    // and our harness emits a 404. That matches the original test's
    // assertion that `handled === false`.
    const res = await fetch(`${baseUrl}/ui/../../etc/passwd`);
    expect(res.status).toBe(404);
  });

  // The next two tests directly call handleNodeUIRequest with a hand-crafted
  // URL whose pathname bypasses normalization (defense-in-depth check). Since
  // we cannot send such a path through real HTTP without a custom client, we
  // exercise the handler directly here while still avoiding any req/res mocks
  // — we use a real http server, route the request through it, and let the
  // handler swap in the malicious URL via a small request middleware.
  it('rejects ../ traversal if URL bypasses normalization (defense-in-depth)', async () => {
    setup();
    const port = await new Promise<number>((resolve) => {
      const s = createServer((req, res) => {
        const rawUrl = { pathname: '/ui/../../etc/passwd', searchParams: new URLSearchParams() } as unknown as URL;
        handleNodeUIRequest(
          req, res, rawUrl, fakeDb(staticDir), staticDir,
          undefined, undefined, undefined, undefined, undefined,
        );
      });
      s.listen(0, '127.0.0.1', () => {
        const a = s.address() as AddressInfo;
        // Capture the server reference so we can close it after the request.
        (s as any).__port = a.port;
        resolve(a.port);
      });
      (globalThis as any).__lastTestServer = s;
    });

    const res = await fetch(`http://127.0.0.1:${port}/ui/x`);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('Forbidden');
    await new Promise<void>((r) => (globalThis as any).__lastTestServer.close(() => r()));
  });

  it('rejects deeply nested traversal if URL bypasses normalization', async () => {
    setup();
    const port = await new Promise<number>((resolve) => {
      const s = createServer((req, res) => {
        const rawUrl = { pathname: '/ui/assets/../../../etc/passwd', searchParams: new URLSearchParams() } as unknown as URL;
        handleNodeUIRequest(
          req, res, rawUrl, fakeDb(staticDir), staticDir,
          undefined, undefined, undefined, undefined, undefined,
        );
      });
      s.listen(0, '127.0.0.1', () => {
        const a = s.address() as AddressInfo;
        resolve(a.port);
      });
      (globalThis as any).__lastTestServer = s;
    });

    const res = await fetch(`http://127.0.0.1:${port}/ui/x`);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('Forbidden');
    await new Promise<void>((r) => (globalThis as any).__lastTestServer.close(() => r()));
  });

  it('serves valid /ui/index.html normally', async () => {
    setup();
    harness.setArgs([
      fakeDb(staticDir), staticDir, undefined, undefined, undefined, undefined, undefined,
    ] as any);

    const res = await fetch(`${baseUrl}/ui/index.html`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<html>');
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
    harness.setArgs([
      fakeDb(staticDir), staticDir, undefined, undefined, undefined, undefined, undefined,
    ] as any);

    const res = await fetch(`${baseUrl}/ui/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<html>');
  });
});

describe('handleNodeUIRequest CORS origin handling', () => {
  it('omits Access-Control-Allow-Origin when corsOrigin is undefined', async () => {
    const fakeDb = { getMetrics: () => [], getErrorHotspots: () => [], getLatestSnapshot: () => ({}) } as any;
    harness.setArgs([
      fakeDb, '.', undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    ] as any);

    const res = await fetch(`${baseUrl}/api/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('sets Access-Control-Allow-Origin when corsOrigin is provided', async () => {
    const fakeDb = { getMetrics: () => [], getErrorHotspots: () => [], getLatestSnapshot: () => ({}) } as any;
    harness.setArgs([
      fakeDb, '.', undefined, undefined, undefined, undefined, undefined, undefined, 'https://example.com',
    ] as any);

    const res = await fetch(`${baseUrl}/api/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://example.com');
  });

  it('omits Access-Control-Allow-Origin when corsOrigin is explicitly null (rejected origin)', async () => {
    const fakeDb = { getMetrics: () => [], getErrorHotspots: () => [], getLatestSnapshot: () => ({}) } as any;
    harness.setArgs([
      fakeDb, '.', undefined, undefined, undefined, undefined, undefined, undefined, null,
    ] as any);

    const res = await fetch(`${baseUrl}/api/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
