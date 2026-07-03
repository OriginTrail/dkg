import { describe, it, expect, afterEach } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  DashboardSessionStore,
  handleDashboardSessionRequest,
  verifyDashboardCsrf,
} from '../src/daemon/dashboard-session.js';
import { getRequestAuthContext, httpAuthGuard } from '../src/auth.js';

const VALID_TOKEN = 'dashboard-backed-token';
const AGENT_TOKEN = 'dkg_at_agent-token';
const DEFAULT_AGENT_ADDRESS = 'did:dkg:agent:default';
const TOKEN_AGENT_ADDRESS = 'did:dkg:agent:token';

function cookieFrom(res: Response): string {
  const setCookie = res.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  return setCookie!.split(';')[0];
}

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const validTokens = new Set([VALID_TOKEN, AGENT_TOKEN]);
  const sessions = new DashboardSessionStore();
  const resolvePrincipal = (token: string) => token === AGENT_TOKEN
    ? { kind: 'agent' as const, agentAddress: TOKEN_AGENT_ADDRESS }
    : { kind: 'node-admin' as const, agentAddress: DEFAULT_AGENT_ADDRESS };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (await handleDashboardSessionRequest(req, res, url, sessions, {
      authEnabled: true,
      validTokens,
      loopbackToken: VALID_TOKEN,
      resolvePrincipal,
    })) {
      return;
    }
    if (!(await httpAuthGuard(req, res, true, validTokens, null, {
      resolvePrincipal,
      dashboardSession: {
        authenticate: (request) => sessions.authenticate(request),
        verifyCsrf: (request, session) => verifyDashboardCsrf(request, session),
      },
    }))) {
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      authorization: req.headers.authorization ?? null,
      requestAuth: getRequestAuthContext(req) ?? null,
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function rawRequest(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path,
      method: options.method ?? 'GET',
      headers: options.headers,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('dashboard browser sessions', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('reports unauthenticated before bootstrap', async () => {
    const started = await startServer();
    server = started.server;

    const res = await fetch(`${started.baseUrl}/api/dashboard/session/status`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ authenticated: false });
  });

  it('sets an HttpOnly SameSite session cookie on loopback bootstrap', async () => {
    const started = await startServer();
    server = started.server;

    const res = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, { method: 'POST' });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('dkg_ui_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie.toLowerCase()).not.toContain('domain=');
    await expect(res.json()).resolves.toMatchObject({ authenticated: true, source: 'loopback' });
  });

  it('rejects loopback bootstrap with a disallowed Host header', async () => {
    const started = await startServer();
    server = started.server;

    const res = await rawRequest(started.baseUrl, '/api/dashboard/session/loopback', {
      method: 'POST',
      headers: { Host: 'attacker.example' },
    });
    expect(res.status).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(JSON.parse(res.body)).toMatchObject({
      error: expect.stringContaining('localhost'),
    });
  });

  it('rejects loopback bootstrap when reverse-proxy forwarding metadata is present', async () => {
    const started = await startServer();
    server = started.server;

    const url = new URL(started.baseUrl);
    const res = await rawRequest(started.baseUrl, '/api/dashboard/session/loopback', {
      method: 'POST',
      headers: {
        Host: `${url.hostname}:${url.port}`,
        'X-Forwarded-For': '203.0.113.20',
        'X-Forwarded-Proto': 'https',
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(JSON.parse(res.body)).toMatchObject({
      error: expect.stringContaining('localhost'),
    });
  });

  it('authenticates protected GETs with the dashboard cookie and no Authorization header from the browser', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, { method: 'POST' });
    const cookie = cookieFrom(bootstrap);

    const res = await fetch(`${started.baseUrl}/api/protected`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      authorization: null,
      requestAuth: {
        source: 'dashboard-session',
        compatToken: VALID_TOKEN,
        principal: { kind: 'node-admin', agentAddress: DEFAULT_AGENT_ADDRESS },
        dashboardSession: { source: 'loopback' },
        csrf: { required: false, validated: false },
      },
    });
  });

  it('exchanges a valid JSON token for a usable dashboard session cookie', async () => {
    const started = await startServer();
    server = started.server;

    const exchange = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: VALID_TOKEN }),
    });
    expect(exchange.status).toBe(200);
    const setCookie = exchange.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('dkg_ui_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie.toLowerCase()).not.toContain('domain=');
    await expect(exchange.json()).resolves.toMatchObject({ authenticated: true, source: 'exchange' });

    const res = await fetch(`${started.baseUrl}/api/protected`, {
      headers: { Cookie: setCookie.split(';')[0] },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      authorization: null,
      requestAuth: {
        source: 'dashboard-session',
        compatToken: VALID_TOKEN,
        principal: { kind: 'node-admin', agentAddress: DEFAULT_AGENT_ADDRESS },
        dashboardSession: { source: 'exchange' },
      },
    });
  });

  it('stores a deterministic principal when exchanging an agent-scoped token', async () => {
    const started = await startServer();
    server = started.server;

    const exchange = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: AGENT_TOKEN }),
    });
    expect(exchange.status).toBe(200);

    const res = await fetch(`${started.baseUrl}/api/protected`, {
      headers: { Cookie: cookieFrom(exchange) },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      authorization: null,
      requestAuth: {
        source: 'dashboard-session',
        compatToken: AGENT_TOKEN,
        principal: { kind: 'agent', agentAddress: TOKEN_AGENT_ADDRESS },
        dashboardSession: { source: 'exchange' },
      },
    });
  });

  it('rejects invalid dashboard session exchange tokens without setting a cookie', async () => {
    const started = await startServer();
    server = started.server;

    const res = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    await expect(res.json()).resolves.toMatchObject({ error: 'Invalid dashboard session token' });
  });

  it('rejects unsafe session-authenticated requests without CSRF', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, { method: 'POST' });
    const cookie = cookieFrom(bootstrap);

    const res = await fetch(`${started.baseUrl}/api/protected`, { method: 'POST', headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
  });

  it('allows unsafe session-authenticated requests with CSRF', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, { method: 'POST' });
    const cookie = cookieFrom(bootstrap);
    const body = await bootstrap.json() as { csrfToken: string };

    const res = await fetch(`${started.baseUrl}/api/protected`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-DKG-CSRF': body.csrfToken },
    });
    expect(res.status).toBe(200);
  });

  it('allows unsafe session-authenticated requests with same-origin browser metadata', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, { method: 'POST' });
    const cookie = cookieFrom(bootstrap);
    const body = await bootstrap.json() as { csrfToken: string };

    const res = await fetch(`${started.baseUrl}/api/protected`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: started.baseUrl,
        'X-DKG-CSRF': body.csrfToken,
      },
    });
    expect(res.status).toBe(200);
  });

  it('rejects unsafe session-authenticated requests with valid CSRF but hostile Origin', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, { method: 'POST' });
    const cookie = cookieFrom(bootstrap);
    const body = await bootstrap.json() as { csrfToken: string };

    const res = await fetch(`${started.baseUrl}/api/protected`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'https://attacker.example',
        'X-DKG-CSRF': body.csrfToken,
      },
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: 'Untrusted dashboard request origin',
    });
  });

  it('rejects unsafe session-authenticated requests with valid CSRF but cross-site fetch metadata', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, { method: 'POST' });
    const cookie = cookieFrom(bootstrap);
    const body = await bootstrap.json() as { csrfToken: string };

    const res = await fetch(`${started.baseUrl}/api/protected`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Sec-Fetch-Site': 'cross-site',
        'X-DKG-CSRF': body.csrfToken,
      },
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: 'Untrusted dashboard request origin',
    });
  });

  it('keeps invalid explicit Authorization from falling back to a valid cookie', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, { method: 'POST' });
    const cookie = cookieFrom(bootstrap);

    const res = await fetch(`${started.baseUrl}/api/protected`, {
      headers: { Cookie: cookie, Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('logout revokes the cookie-backed session', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, { method: 'POST' });
    const cookie = cookieFrom(bootstrap);

    const logout = await fetch(`${started.baseUrl}/api/dashboard/session/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(logout.status).toBe(200);

    const res = await fetch(`${started.baseUrl}/api/protected`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(401);
  });
});
