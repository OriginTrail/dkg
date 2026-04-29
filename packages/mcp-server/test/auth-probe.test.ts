/**
 * mcp-server / auth-probe — behavioural coverage for the two probes
 * that back the `mcp_auth status` tool output.
 *
 * The earlier single probe hit `/api/status` (a public-allowlist
 * endpoint on the DKG daemon), so `mcp_auth status` could report OK
 * for an invalid credential. We now expose two independent probes:
 *
 *   - probeStatus → hits /api/status (liveness only)
 *   - probeAuth   → hits /api/agents (auth-gated; fails closed if the
 *                   bearer token is missing/invalid)
 *
 * These tests pin the behaviour against a real http.Server so a
 * regression that re-collapses the two probes (or silently swallows a
 * 401 on the authenticated probe) fails here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { probeStatus, probeAuth } from '../src/auth-probe.js';

const GOOD_TOKEN = 'good-token-123456';

function makeServer(): Promise<{ server: Server; port: number; seen: IncomingMessage[] }> {
  const seen: IncomingMessage[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      seen.push(req);
      // Drain body so the client's fetch resolves cleanly even when
      // nothing is expected.
      req.on('data', () => {});
      req.on('end', () => {
        if (req.url === '/api/status' && req.method === 'GET') {
          // Public / unauth on the real daemon.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ name: 'probe-test', uptimeMs: 1 }));
          return;
        }
        if (req.url === '/api/agents' && req.method === 'GET') {
          const auth = String(req.headers['authorization'] ?? '');
          if (auth !== `Bearer ${GOOD_TOKEN}`) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing or invalid auth' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ agents: [] }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port, seen });
    });
  });
}

describe('auth-probe — probeStatus (liveness only)', () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  beforeEach(async () => {
    ctx = await makeServer();
  });
  afterEach(async () => {
    await new Promise<void>((r) => ctx.server.close(() => r()));
  });

  it('returns OK against /api/status regardless of credential validity', async () => {
    const ok = await probeStatus(`http://127.0.0.1:${ctx.port}`, 'anything-nonsense');
    expect(ok.ok).toBe(true);
    expect(ok.code).toBe(200);
    // Server received the public-path request (no auth required).
    expect(ctx.seen.some((r) => r.url === '/api/status')).toBe(true);
  });

  it('returns OK against /api/status even with NO credential at all', async () => {
    const ok = await probeStatus(`http://127.0.0.1:${ctx.port}`, '');
    expect(ok.ok).toBe(true);
    expect(ok.code).toBe(200);
  });

  it('reports FAILED on a dead port (network error surfaces, no silent hang)', async () => {
    // Port 1 is privileged and not listening as a daemon.
    const r = await probeStatus('http://127.0.0.1:1', 'anything');
    expect(r.ok).toBe(false);
    expect(typeof r.body === 'string' && r.body.length > 0).toBe(true);
  });
});

describe('auth-probe — probeAuth (bearer credential validation)', () => {
  let ctx: Awaited<ReturnType<typeof makeServer>>;
  beforeEach(async () => {
    ctx = await makeServer();
  });
  afterEach(async () => {
    await new Promise<void>((r) => ctx.server.close(() => r()));
  });

  it('returns OK ONLY when the bearer token is accepted (2xx)', async () => {
    const r = await probeAuth(`http://127.0.0.1:${ctx.port}`, GOOD_TOKEN);
    expect(r.ok).toBe(true);
    expect(r.code).toBe(200);
  });

  it('returns FAILED (401) for an invalid bearer token', async () => {
    const r = await probeAuth(`http://127.0.0.1:${ctx.port}`, 'wrong-token');
    expect(r.ok).toBe(false);
    expect(r.code).toBe(401);
  });

  // An empty token is
  // NOT a hard failure: if the daemon runs with `auth.enabled=false`
  // the unauthenticated probe returns 200 and every MCP request would
  // succeed. We report that as `authDisabled` so the host can render
  // a distinct state. When auth IS enabled the probe still 401s and
  // we still report FAILED — the old invariant is preserved.
  it('surfaces auth-disabled daemon as {ok:true, authDisabled:true} when no credential is configured', async () => {
    // Swap in a server that accepts the unauthenticated probe.
    await new Promise<void>((r) => ctx.server.close(() => r()));
    const openServer = http.createServer((req, res) => {
      ctx.seen.push(req);
      req.on('data', () => {});
      req.on('end', () => {
        if (req.url === '/api/agents' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ agents: [] }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((r) => openServer.listen(0, '127.0.0.1', r));
    const port = (openServer.address() as AddressInfo).port;
    try {
      const r = await probeAuth(`http://127.0.0.1:${port}`, '');
      expect(r.ok).toBe(true);
      expect(r.authDisabled).toBe(true);
      expect(r.code).toBe(200);
      const lastReq = ctx.seen[ctx.seen.length - 1];
      expect(String(lastReq.headers['authorization'] ?? '')).toBe('');
    } finally {
      await new Promise<void>((r) => openServer.close(() => r()));
    }
  });

  it('reports FAILED (401) with NO authDisabled flag when daemon requires auth and no credential is configured', async () => {
    const r = await probeAuth(`http://127.0.0.1:${ctx.port}`, '');
    expect(r.ok).toBe(false);
    expect(r.code).toBe(401);
    expect(r.authDisabled).toBeUndefined();
  });

  it('hits an auth-GATED path (/api/agents), NOT /api/status (the public allowlist)', async () => {
    // Probing /api/status would succeed even with a broken
    // credential. Pin the path so a future refactor that reverts to
    // /api/status fails here.
    await probeAuth(`http://127.0.0.1:${ctx.port}`, GOOD_TOKEN);
    const paths = ctx.seen.map((r) => r.url);
    expect(paths).toContain('/api/agents');
    expect(paths).not.toContain('/api/status');
  });

  it('sends the configured bearer in the Authorization header', async () => {
    await probeAuth(`http://127.0.0.1:${ctx.port}`, GOOD_TOKEN);
    const agentsReq = ctx.seen.find((r) => r.url === '/api/agents');
    expect(String(agentsReq?.headers['authorization'] ?? '')).toBe(`Bearer ${GOOD_TOKEN}`);
  });
});
