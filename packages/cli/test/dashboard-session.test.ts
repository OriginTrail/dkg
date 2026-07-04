import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  DASHBOARD_SESSION_COOKIE,
  DashboardSessionStore,
  createDashboardSessionAuthSource,
  getDashboardSessionCookie,
  handleDashboardSessionRequest,
  isAllowedLoopbackHostname,
  isLoopbackAddress,
  verifyDashboardCsrf,
} from '../src/daemon/dashboard-session.js';
import { setDashboardSessionCookie } from '../src/daemon/dashboard-session-cookie.js';
import { handleRequest } from '../src/daemon/handle-request.js';
import { getRequestAuthContext, httpAuthGuard, type RequestAuthPrincipal } from '../src/auth.js';

const VALID_TOKEN = 'dashboard-backed-token';
const ROTATED_TOKEN = 'dashboard-rotated-token';
const AGENT_TOKEN = 'dkg_at_agent-token';
const DEFAULT_AGENT_ADDRESS = 'did:dkg:agent:default';
const TOKEN_AGENT_ADDRESS = 'did:dkg:agent:token';

describe('dashboard session trust policy helpers', () => {
  it('recognizes the loopback address forms accepted for browser bootstrap', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.10.20.30')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
  });

  it('keeps loopback hostnames narrow for browser-origin proof', () => {
    expect(isAllowedLoopbackHostname('localhost')).toBe(true);
    expect(isAllowedLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isAllowedLoopbackHostname('[::1]')).toBe(true);
    expect(isAllowedLoopbackHostname('example.com')).toBe(false);
  });
});

function loopbackBootstrapInit(baseUrl: string): RequestInit {
  return {
    method: 'POST',
    headers: { Origin: baseUrl, Authorization: `Bearer ${VALID_TOKEN}` },
  };
}

function cookieFrom(res: Response): string {
  const setCookie = res.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  return setCookie!.split(';')[0];
}

async function startServer(options: {
  validTokens?: Set<string>;
  refreshValidTokens?: () => void;
  resolvePrincipal?: (token: string) => RequestAuthPrincipal;
  onSessionRevoked?: (sessionId: string) => void;
} = {}): Promise<{ server: Server; baseUrl: string }> {
  const validTokens = options.validTokens ?? new Set([VALID_TOKEN, AGENT_TOKEN]);
  const sessions = new DashboardSessionStore();
  const resolvePrincipal = options.resolvePrincipal ?? ((token: string): RequestAuthPrincipal => token === AGENT_TOKEN
    ? { kind: 'agent', agentAddress: TOKEN_AGENT_ADDRESS }
    : { kind: 'node-admin', agentAddress: DEFAULT_AGENT_ADDRESS });
  const agent = {
    resolveAgentByToken: (token: string | undefined) => token === AGENT_TOKEN ? TOKEN_AGENT_ADDRESS : undefined,
    resolveAgentAddress: (token: string | undefined) => token === AGENT_TOKEN ? TOKEN_AGENT_ADDRESS : DEFAULT_AGENT_ADDRESS,
    listLocalAgents: () => [
      { agentAddress: DEFAULT_AGENT_ADDRESS, name: 'Default Agent', framework: 'node' },
      { agentAddress: TOKEN_AGENT_ADDRESS, name: 'Token Agent', framework: 'test' },
    ],
    nodeName: 'Default Agent',
    nodeFramework: 'node',
    peerId: '12D3KooWDashboardSessionTest',
    publisher: { getIdentityId: () => 1n },
  };
  const dashboardAuthSource = createDashboardSessionAuthSource({
    authenticate: (request) => sessions.authenticateSessionId(getDashboardSessionCookie(request)),
    resolvePrincipal,
    verifyCsrf: (request, session) => verifyDashboardCsrf(request, session),
  });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (await handleDashboardSessionRequest(req, res, url, sessions, {
      authEnabled: true,
      validTokens,
      refreshValidTokens: options.refreshValidTokens,
      onSessionRevoked: options.onSessionRevoked,
    })) {
      return;
    }
    if (!(await httpAuthGuard(req, res, true, validTokens, null, {
      resolvePrincipal,
      authSources: [dashboardAuthSource],
    }))) {
      return;
    }
    if (url.pathname === '/api/agent/identity') {
      await handleRequest(
        req,
        res,
        agent as any,
        {} as any,
        null,
        { auth: { enabled: true } } as any,
        Date.now(),
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        undefined,
        'test-version',
        'test-commit',
        {} as any,
        {} as any,
        new Map(),
        new Map(),
        {} as any,
        null,
        validTokens,
        '127.0.0.1',
        { value: 0 },
        [],
        {} as any,
      );
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

    const res = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('dkg_ui_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie.toLowerCase()).not.toContain('domain=');
    await expect(res.json()).resolves.toMatchObject({ authenticated: true, source: 'loopback' });
  });

  it('refreshes valid tokens before authorizing loopback bootstrap tokens', async () => {
    const validTokens = new Set([VALID_TOKEN]);
    const refreshValidTokens = vi.fn(() => {
      validTokens.delete(VALID_TOKEN);
      validTokens.add(ROTATED_TOKEN);
    });
    const started = await startServer({
      validTokens,
      refreshValidTokens,
    });
    server = started.server;

    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, {
      method: 'POST',
      headers: { Origin: started.baseUrl, Authorization: `Bearer ${ROTATED_TOKEN}` },
    });
    expect(bootstrap.status).toBe(200);
    expect(refreshValidTokens).toHaveBeenCalledTimes(1);

    const res = await fetch(`${started.baseUrl}/api/protected`, {
      headers: { Cookie: cookieFrom(bootstrap) },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      requestAuth: {
        source: 'dashboard-session',
        internalCredentialToken: ROTATED_TOKEN,
        principal: { kind: 'node-admin', agentAddress: DEFAULT_AGENT_ADDRESS },
      },
    });
  });

  it('rejects tokenless loopback bootstrap even with forgeable local browser headers', async () => {
    const started = await startServer();
    server = started.server;

    const res = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, {
      method: 'POST',
      headers: { Origin: started.baseUrl },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    await expect(res.json()).resolves.toMatchObject({
      error: 'Valid API token required for loopback dashboard session',
    });
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

  it('rejects loopback bootstrap without local browser origin proof even with localhost upstream Host', async () => {
    const started = await startServer();
    server = started.server;

    const url = new URL(started.baseUrl);
    const res = await rawRequest(started.baseUrl, '/api/dashboard/session/loopback', {
      method: 'POST',
      headers: { Host: `${url.hostname}:${url.port}` },
    });
    expect(res.status).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('authenticates protected GETs with the dashboard cookie and no Authorization header from the browser', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
    const cookie = cookieFrom(bootstrap);

    const res = await fetch(`${started.baseUrl}/api/protected`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      authorization: null,
      requestAuth: {
        source: 'dashboard-session',
        internalCredentialToken: VALID_TOKEN,
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
        internalCredentialToken: VALID_TOKEN,
        principal: { kind: 'node-admin', agentAddress: DEFAULT_AGENT_ADDRESS },
        dashboardSession: { source: 'exchange' },
      },
    });
  });

  it('marks dashboard session cookies Secure when forwarded protocol is https', async () => {
    const started = await startServer();
    server = started.server;

    const exchange = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ token: VALID_TOKEN }),
    });
    expect(exchange.status).toBe(200);
    const setCookie = exchange.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('dkg_ui_session=');
    expect(setCookie).toContain('Secure');
  });

  it('marks dashboard session cookies Secure when standard Forwarded proto is https', async () => {
    const started = await startServer();
    server = started.server;

    const exchange = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Forwarded: 'for=203.0.113.20;proto="https";host=node.example',
      },
      body: JSON.stringify({ token: VALID_TOKEN }),
    });
    expect(exchange.status).toBe(200);
    const setCookie = exchange.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('dkg_ui_session=');
    expect(setCookie).toContain('Secure');
  });

  it('ignores spoofed forwarding protocol headers from non-loopback peers when setting cookies', () => {
    const req = {
      headers: {
        'x-forwarded-proto': 'https',
        forwarded: 'for=203.0.113.20;proto=https;host=node.example',
      },
      socket: { remoteAddress: '203.0.113.20' },
    } as IncomingMessage;
    const headers: Record<string, string | string[]> = {};
    const res = {
      getHeader: (name: string) => headers[name],
      setHeader: (name: string, value: string | string[]) => { headers[name] = value; },
    } as ServerResponse;

    setDashboardSessionCookie(req, res, 'spoofed-forwarded-session');

    expect(headers['Set-Cookie']).toContain('dkg_ui_session=');
    expect(String(headers['Set-Cookie'])).not.toContain('Secure');
  });

  it('resolves a deterministic principal when exchanging an agent-scoped token', async () => {
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
        internalCredentialToken: AGENT_TOKEN,
        principal: { kind: 'agent', agentAddress: TOKEN_AGENT_ADDRESS },
        dashboardSession: { source: 'exchange' },
      },
    });
  });

  it('resolves the dashboard principal from the backing token for each protected request', async () => {
    let agentAddress = TOKEN_AGENT_ADDRESS;
    const started = await startServer({
      resolvePrincipal: (token) => token === AGENT_TOKEN
        ? { kind: 'agent', agentAddress }
        : { kind: 'node-admin', agentAddress: DEFAULT_AGENT_ADDRESS },
    });
    server = started.server;

    const exchange = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: AGENT_TOKEN }),
    });
    expect(exchange.status).toBe(200);
    const cookie = cookieFrom(exchange);
    agentAddress = 'did:dkg:agent:rotated';

    const res = await fetch(`${started.baseUrl}/api/protected`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      requestAuth: {
        source: 'dashboard-session',
        internalCredentialToken: AGENT_TOKEN,
        principal: { kind: 'agent', agentAddress: 'did:dkg:agent:rotated' },
      },
    });
  });

  it('serves the CSRF endpoint only for a live dashboard session', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
    const cookie = cookieFrom(bootstrap);
    const body = await bootstrap.json() as { csrfToken: string; expiresAt: number };

    const csrf = await fetch(`${started.baseUrl}/api/dashboard/session/csrf`, {
      headers: { Cookie: cookie },
    });
    expect(csrf.status).toBe(200);
    await expect(csrf.json()).resolves.toMatchObject({
      csrfToken: body.csrfToken,
      expiresAt: body.expiresAt,
    });

    const missingCookie = await fetch(`${started.baseUrl}/api/dashboard/session/csrf`);
    expect(missingCookie.status).toBe(401);
    await expect(missingCookie.json()).resolves.toMatchObject({
      error: 'Dashboard session required',
    });
  });

  it('rejects the CSRF endpoint after the backing session token is invalidated', async () => {
    const validTokens = new Set([VALID_TOKEN, AGENT_TOKEN]);
    const started = await startServer({ validTokens });
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
    const cookie = cookieFrom(bootstrap);
    validTokens.delete(VALID_TOKEN);

    const csrf = await fetch(`${started.baseUrl}/api/dashboard/session/csrf`, {
      headers: { Cookie: cookie },
    });
    expect(csrf.status).toBe(401);
    await expect(csrf.json()).resolves.toMatchObject({
      error: 'Dashboard session required',
    });
  });

  it('rejects protected dashboard-cookie requests after the backing token is invalidated', async () => {
    const validTokens = new Set([VALID_TOKEN, AGENT_TOKEN]);
    const started = await startServer({ validTokens });
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
    const cookie = cookieFrom(bootstrap);
    validTokens.delete(VALID_TOKEN);

    const res = await fetch(`${started.baseUrl}/api/protected`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('Unauthorized'),
    });
  });

  it('routes dashboard-cookie agent sessions through requestAgentAddress for agent identity', async () => {
    const started = await startServer();
    server = started.server;

    const exchange = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: AGENT_TOKEN }),
    });
    expect(exchange.status).toBe(200);

    const identity = await fetch(`${started.baseUrl}/api/agent/identity`, {
      headers: { Cookie: cookieFrom(exchange) },
    });
    expect(identity.status).toBe(200);
    await expect(identity.json()).resolves.toMatchObject({
      agentAddress: TOKEN_AGENT_ADDRESS,
      agentDid: `did:dkg:agent:${TOKEN_AGENT_ADDRESS}`,
      name: 'Token Agent',
      framework: 'test',
      peerId: '12D3KooWDashboardSessionTest',
      nodeIdentityId: '1',
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

  it('rejects and prunes expired dashboard session cookies', () => {
    const store = new DashboardSessionStore();
    const issuedAt = 1_000;
    const created = store.create(VALID_TOKEN, 'loopback', issuedAt);
    const req = {
      headers: {
        cookie: `${DASHBOARD_SESSION_COOKIE}=${encodeURIComponent(created.sessionId)}`,
      },
    } as IncomingMessage;

    expect(store.authenticateSessionId(getDashboardSessionCookie(req), created.record.expiresAt - 1)).toMatchObject({
      sessionId: created.sessionId,
      compatToken: VALID_TOKEN,
    });
    expect(store.authenticateSessionId(getDashboardSessionCookie(req), created.record.expiresAt + 1)).toBeNull();
    expect(store.authenticateSessionId(getDashboardSessionCookie(req), created.record.expiresAt + 2)).toBeNull();
  });

  it('rejects unsafe session-authenticated requests without CSRF', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
    const cookie = cookieFrom(bootstrap);

    const res = await fetch(`${started.baseUrl}/api/protected`, { method: 'POST', headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('requires CSRF for dashboard-session %s requests', async (method) => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
    const cookie = cookieFrom(bootstrap);

    const res = await fetch(`${started.baseUrl}/api/protected`, { method, headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: 'Invalid or missing dashboard CSRF token',
    });
  });

  it('rejects unsafe session-authenticated requests with an incorrect CSRF token', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
    const cookie = cookieFrom(bootstrap);

    const res = await fetch(`${started.baseUrl}/api/protected`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-DKG-CSRF': 'wrong-token' },
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: 'Invalid or missing dashboard CSRF token',
    });
  });

  it('allows unsafe session-authenticated requests with CSRF', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
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
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
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

  it('allows unsafe session-authenticated requests from a loopback dev-server origin', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
    const cookie = cookieFrom(bootstrap);
    const body = await bootstrap.json() as { csrfToken: string };

    const res = await fetch(`${started.baseUrl}/api/protected`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://localhost:5173',
        'X-DKG-CSRF': body.csrfToken,
      },
    });
    expect(res.status).toBe(200);
  });

  it('rejects unsafe session-authenticated requests with valid CSRF but hostile Origin', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
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

  it('rejects unsafe session-authenticated requests with valid CSRF but hostile Referer', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
    const cookie = cookieFrom(bootstrap);
    const body = await bootstrap.json() as { csrfToken: string };

    const res = await fetch(`${started.baseUrl}/api/protected`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Referer: 'https://attacker.example/page',
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
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
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
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
    const cookie = cookieFrom(bootstrap);

    const res = await fetch(`${started.baseUrl}/api/protected`, {
      headers: { Cookie: cookie, Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('logout revokes the cookie-backed session', async () => {
    const started = await startServer();
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
    const cookie = cookieFrom(bootstrap);
    const body = await bootstrap.json() as { csrfToken: string };

    const logout = await fetch(`${started.baseUrl}/api/dashboard/session/logout`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-DKG-CSRF': body.csrfToken },
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');

    const res = await fetch(`${started.baseUrl}/api/protected`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(401);
  });

  it('rejects logout without CSRF and leaves the live session usable', async () => {
    const onSessionRevoked = vi.fn();
    const started = await startServer({ onSessionRevoked });
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
    const cookie = cookieFrom(bootstrap);

    const logout = await fetch(`${started.baseUrl}/api/dashboard/session/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(logout.status).toBe(403);
    await expect(logout.json()).resolves.toMatchObject({
      error: 'Invalid or missing dashboard CSRF token',
    });
    expect(onSessionRevoked).not.toHaveBeenCalled();

    const res = await fetch(`${started.baseUrl}/api/protected`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
  });

  it('rejects logout with valid CSRF but hostile Origin', async () => {
    const onSessionRevoked = vi.fn();
    const started = await startServer({ onSessionRevoked });
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
    const cookie = cookieFrom(bootstrap);
    const body = await bootstrap.json() as { csrfToken: string };

    const logout = await fetch(`${started.baseUrl}/api/dashboard/session/logout`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'https://attacker.example',
        'X-DKG-CSRF': body.csrfToken,
      },
    });
    expect(logout.status).toBe(403);
    await expect(logout.json()).resolves.toMatchObject({
      error: 'Untrusted dashboard request origin',
    });
    expect(onSessionRevoked).not.toHaveBeenCalled();

    const res = await fetch(`${started.baseUrl}/api/protected`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
  });

  it('notifies when logout revokes a dashboard session', async () => {
    const onSessionRevoked = vi.fn();
    const started = await startServer({ onSessionRevoked });
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
    const cookie = cookieFrom(bootstrap);
    const body = await bootstrap.json() as { csrfToken: string };

    const logout = await fetch(`${started.baseUrl}/api/dashboard/session/logout`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-DKG-CSRF': body.csrfToken },
    });
    expect(logout.status).toBe(200);
    expect(onSessionRevoked).toHaveBeenCalledTimes(1);
    expect(onSessionRevoked).toHaveBeenCalledWith(decodeURIComponent(cookie.split('=')[1]!));
  });
});
