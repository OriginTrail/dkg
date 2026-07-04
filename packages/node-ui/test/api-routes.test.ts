import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import { handleNodeUIRequest, type HandleNodeUIRequestOptions } from '../src/api.js';
import { DashboardDB } from '../src/db.js';

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
  type HarnessArgs = {
    db: HandlerArgs[3];
    staticDir: HandlerArgs[4];
    options?: HandleNodeUIRequestOptions;
  };
  let nextArgs: HarnessArgs = { db: {} as any, staticDir: '.' };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    handleNodeUIRequest(req, res, url, nextArgs.db, nextArgs.staticDir, nextArgs.options).then((handled) => {
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
    setArgs: (args: HarnessArgs) => { nextArgs = args; },
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
    harness.setArgs({
      db: {} as any,
      staticDir: '.',
      options: { memoryManager: { getSessionGraphDelta: delta.fn } as any },
    });

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
    harness.setArgs({
      db: {} as any,
      staticDir: '.',
      options: { memoryManager: { getSessionGraphDelta: delta.fn } as any },
    });

    const res = await fetch(`${baseUrl}/api/memory/sessions/session-1/graph-delta?turnId=bad/turn`);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'Missing or invalid "turnId"' });
    expect(delta.calls).toHaveLength(0);
  });

  it('returns 400 for invalid baseTurnId in graph-delta route', async () => {
    const delta = recorder(() => undefined);
    harness.setArgs({
      db: {} as any,
      staticDir: '.',
      options: { memoryManager: { getSessionGraphDelta: delta.fn } as any },
    });

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
    harness.setArgs({
      db: {} as any,
      staticDir: '.',
      options: { memoryManager: { getSession: session.fn } as any },
    });

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
    harness.setArgs({
      db: {} as any,
      staticDir: '.',
      options: { memoryManager: { getSession: session.fn } as any },
    });

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
    harness.setArgs({
      db: {} as any,
      staticDir: '.',
      options: {
        memoryManager: { getSessionPublicationStatus: status.fn, publishSession: publish.fn } as any,
      },
    });

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
    harness.setArgs({
      db: {} as any,
      staticDir: '.',
      options: {
        memoryManager: { getSessionPublicationStatus: status.fn, publishSession: publish.fn } as any,
      },
    });

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
  // `POST /api/knowledge-assets/:name/wm/write` direct route. Mirrors the
  // B38 pattern for the session-publication routes above.
  it('returns 410 Gone for POST /api/memory/import with migration pointers (Codex B52)', async () => {
    harness.setArgs({ db: {} as any, staticDir: '.' });

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
    expect(replacementPaths.join(' ')).toMatch(/\/api\/knowledge-assets(?:\s|$)/);
    expect(replacementPaths.join(' ')).toMatch(/\/api\/knowledge-assets\/:name\/wm\/write/);
    const allNames = body.replacements.map((r: any) => r.name ?? '').join(' ');
    expect(allNames).not.toMatch(/dkg_memory_import/);
  });
});

// --- /api/logs compatibility route ---

describe('handleNodeUIRequest /api/logs', () => {
  it('delegates to the DB-backed compatibility search surface', async () => {
    const calls: any[] = [];
    harness.setArgs({
      db: {
        searchLogs: (opts: any) => {
          calls.push(opts);
          return {
            total: 1,
            logs: [{ ts: 1234, level: 'info', module: 'Publisher', message: 'publish completed' }],
          };
        },
      } as any,
      staticDir: '.',
    });

    const res = await fetch(`${baseUrl}/api/logs?q=publish&level=info&module=Publisher&limit=5&offset=2`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.logs[0].message).toBe('publish completed');
    expect(calls[0]).toMatchObject({
      q: 'publish',
      level: 'info',
      module: 'Publisher',
      limit: 5,
      offset: 2,
    });
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

    harness.setArgs({ db: makeFakeDb(tmpDir), staticDir: '.' });

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

    harness.setArgs({ db: makeFakeDb(tmpDir), staticDir: '.' });

    const res = await fetch(`${baseUrl}/api/node-log`);
    const body = await res.json();
    expect(body.lines.length).toBeGreaterThan(0);
    expect(body.lines.length).toBeLessThanOrEqual(500);
  });

  it('clamps negative/invalid lines to 500 (returns valid response)', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dkg-log-test-'));
    writeFileSync(join(tmpDir, 'daemon.log'), 'single line\n');

    harness.setArgs({ db: makeFakeDb(tmpDir), staticDir: '.' });

    const res = await fetch(`${baseUrl}/api/node-log?lines=-10`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toBeDefined();
  });

  it('clamps lines > 5000 to 5000', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dkg-log-test-'));
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    writeFileSync(join(tmpDir, 'daemon.log'), lines.join('\n') + '\n');

    harness.setArgs({ db: makeFakeDb(tmpDir), staticDir: '.' });

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

    harness.setArgs({ db: makeFakeDb(tmpDir), staticDir: '.' });

    const res = await fetch(`${baseUrl}/api/node-log?q=publish`);
    const body = await res.json();
    expect(body.lines.every((l: string) => l.toLowerCase().includes('publish'))).toBe(true);
    expect(body.lines).toHaveLength(2);
  });

  it('returns empty lines when daemon.log does not exist', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dkg-log-test-'));

    harness.setArgs({ db: makeFakeDb(tmpDir), staticDir: '.' });

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
    harness.setArgs({ db: fakeDb(staticDir), staticDir });

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
    harness.setArgs({ db: fakeDb(staticDir), staticDir });

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
    harness.setArgs({ db: fakeDb(staticDir), staticDir });

    const res = await fetch(`${baseUrl}/ui/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<html>');
  });

  it('does not inject browser bearer tokens into /ui HTML', async () => {
    setup();
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
    harness.setArgs({ db: fakeDb(staticDir), staticDir });

    const res = await fetch(`${baseUrl}/ui/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('window.__DKG_TOKEN__');
    expect(body).not.toContain('sentinel-secret-token');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('content-security-policy')).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(res.headers.get('content-security-policy')).toContain("font-src 'self' https://fonts.gstatic.com");
    expect(res.headers.get('content-security-policy')).toContain("frame-src 'self' blob:");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('does not inject tokens into SPA fallback HTML', async () => {
    setup();
    harness.setArgs({ db: fakeDb(staticDir), staticDir });

    const res = await fetch(`${baseUrl}/ui/projects/example`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('window.__DKG_TOKEN__');
    expect(body).not.toContain('sentinel-secret-token');
  });

  it('serves assets without HTML security header injection', async () => {
    setup();
    harness.setArgs({ db: fakeDb(staticDir), staticDir });

    const res = await fetch(`${baseUrl}/ui/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/javascript');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('content-security-policy')).toBeNull();
    await expect(res.text()).resolves.toContain('console.log("ok")');
  });
});

describe('handleNodeUIRequest CORS origin handling', () => {
  it('omits Access-Control-Allow-Origin when corsOrigin is undefined', async () => {
    const fakeDb = { getMetrics: () => [], getErrorHotspots: () => [], getLatestSnapshot: () => ({}) } as any;
    harness.setArgs({ db: fakeDb, staticDir: '.' });

    const res = await fetch(`${baseUrl}/api/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('sets credentialed CORS headers when a specific corsOrigin is provided', async () => {
    const fakeDb = { getMetrics: () => [], getErrorHotspots: () => [], getLatestSnapshot: () => ({}) } as any;
    harness.setArgs({
      db: fakeDb,
      staticDir: '.',
      options: { corsOrigin: 'https://example.com' },
    });

    const res = await fetch(`${baseUrl}/api/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://example.com');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type, Authorization, X-DKG-CSRF');
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('omits Access-Control-Allow-Origin when corsOrigin is explicitly null (rejected origin)', async () => {
    const fakeDb = { getMetrics: () => [], getErrorHotspots: () => [], getLatestSnapshot: () => ({}) } as any;
    harness.setArgs({
      db: fakeDb,
      staticDir: '.',
      options: { corsOrigin: null },
    });

    const res = await fetch(`${baseUrl}/api/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('handleNodeUIRequest legacy positional tail compatibility', () => {
  let server: Server | undefined;
  let base: string;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  async function startLegacyServer(staticDir = '.'): Promise<void> {
    const metricsCollector = {
      collect: async () => ({ liveMetric: true }),
    } as any;
    const memoryManager = {
      getStats: async () => ({ initialized: true, sessionCount: 7 }),
    } as any;
    const relayStatsProvider = () => ({
      capacity: 10,
      reservationCount: 2,
      activeCircuits: 1,
      bytesIn: 3n,
      bytesOut: 4n,
      reservations: [],
    });
    const db = {
      getLatestSnapshot: () => ({ fallback: true }),
      getSnapshotHistory: () => [],
      getOperations: () => [],
      getErrors: () => [],
      getMetrics: () => [],
      getErrorHotspots: () => [],
    } as any;

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      void handleNodeUIRequest(
        req,
        res,
        url,
        db,
        staticDir,
        undefined,
        metricsCollector,
        'legacy-browser-token-must-be-ignored',
        memoryManager,
        undefined,
        undefined,
        'https://legacy.example',
        relayStatsProvider,
      ).then((handled) => {
        if (!handled && !res.headersSent) {
          res.statusCode = 404;
          res.end('Not Found');
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  }

  it('maps old positional metrics, memory, CORS, and relay arguments into options', async () => {
    await startLegacyServer();

    const metrics = await fetch(`${base}/api/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get('access-control-allow-origin')).toBe('https://legacy.example');
    await expect(metrics.json()).resolves.toMatchObject({ liveMetric: true });

    const memory = await fetch(`${base}/api/memory/stats`);
    expect(memory.status).toBe(200);
    await expect(memory.json()).resolves.toMatchObject({ initialized: true, sessionCount: 7 });

    const relay = await fetch(`${base}/api/relay/stats`);
    expect(relay.status).toBe(200);
    await expect(relay.json()).resolves.toMatchObject({
      capacity: 10,
      reservationCount: 2,
      activeCircuits: 1,
      bytesIn: '3',
      bytesOut: '4',
    });
  });

  it('serves legacy positional /ui HTML without injecting the old auth-token slot', async () => {
    const staticDir = mkdtempSync(join(tmpdir(), 'dkg-legacy-ui-'));
    try {
      writeFileSync(join(staticDir, 'index.html'), '<!doctype html><html><body>legacy ui</body></html>');
      await startLegacyServer(staticDir);

      const res = await fetch(`${base}/ui/`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('legacy ui');
      expect(body).not.toContain('window.__DKG_TOKEN__');
      expect(body).not.toContain('legacy-browser-token-must-be-ignored');
    } finally {
      rmSync(staticDir, { recursive: true, force: true });
    }
  });
});

describe('handleNodeUIRequest replication routes (Phase F)', () => {
  let db: DashboardDB;
  let dir: string;
  const now = Date.now();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dkg-repl-api-'));
    db = new DashboardDB({ dataDir: dir });
    db.upsertContextGraphSubscription({
      context_graph_id: 'mfacts', name: 'Monday Fun Facts', subscribed: 1, synced: 1,
      on_chain_id: '7', last_reconciled_ordinal: 2, sync_scoped: 1, updated_at: now,
    });
    db.insertReplicationEvent({ ts: now - 6000, context_graph_id: 'mfacts', on_chain_cg_id: '7', action: 'fetch', ual: 'urn:ka:1', ordinal: 1 });
    db.insertReplicationEvent({ ts: now - 3000, context_graph_id: 'mfacts', on_chain_cg_id: '7', action: 'promote', ual: 'urn:ka:1', ordinal: 1 });
    db.insertReplicationEvent({ ts: now - 2000, context_graph_id: 'mfacts', on_chain_cg_id: '7', action: 'cursor-advance', from_watermark: 1, to_watermark: 2, head: 4 });
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const args = () => ({ db: db as any, staticDir: '.' });

  it('GET /api/replication/summary returns KPIs', async () => {
    harness.setArgs(args());
    const res = await fetch(`${baseUrl}/api/replication/summary`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.promotes).toBe(1);
    expect(body.fetches).toBe(1);
    expect(body.latencyP50Ms).toBe(3000);
  });

  it('GET /api/replication/per-cg returns rows', async () => {
    harness.setArgs(args());
    const res = await fetch(`${baseUrl}/api/replication/per-cg`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows[0].context_graph_id).toBe('mfacts');
    expect(body.rows[0].last_watermark).toBe(2);
  });

  it('GET /api/replication/cursors joins subscription watermark with head', async () => {
    harness.setArgs(args());
    const res = await fetch(`${baseUrl}/api/replication/cursors`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const c = body.cursors.find((r: any) => r.context_graph_id === 'mfacts');
    expect(c.last_reconciled_ordinal).toBe(2);
    expect(c.last_head).toBe(4);
  });

  it('GET /api/replication/timeline buckets events', async () => {
    harness.setArgs(args());
    const res = await fetch(`${baseUrl}/api/replication/timeline?bucketMs=60000`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.buckets.reduce((s: number, b: any) => s + b.total, 0)).toBe(3);
  });

  it('GET /api/replication/events requires cg and returns the stream', async () => {
    harness.setArgs(args());
    const missing = await fetch(`${baseUrl}/api/replication/events`);
    expect(missing.status).toBe(400);

    const res = await fetch(`${baseUrl}/api/replication/events?cg=mfacts`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events.length).toBe(3);
    expect(body.events[0].action).toBe('cursor-advance'); // newest first
  });

  it('GET /api/replication/summary accepts a unit-suffixed period (e.g. 24h)', async () => {
    harness.setArgs(args());
    // Raw parseInt('24h') === 24 (24ms window → excludes everything). parsePeriodMs
    // must read this as 24 hours so the recent events stay in range.
    const res = await fetch(`${baseUrl}/api/replication/summary?periodMs=24h`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.promotes).toBe(1);
    expect(body.fetches).toBe(1);
  });

  it('GET /api/replication/events tolerates a non-numeric limit', async () => {
    harness.setArgs(args());
    // ?limit=foo previously bound `LIMIT NaN` and surfaced a SQLite 500.
    const res = await fetch(`${baseUrl}/api/replication/events?cg=mfacts&limit=foo`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events.length).toBe(3);
  });
});
