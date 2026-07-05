import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  DASHBOARD_SESSION_COOKIE,
  DashboardSessionStore,
  DashboardLoginAttemptLimiter,
  authenticateDashboardSessionRequest,
  createDashboardSessionAuthSource,
  getDashboardSessionCookie,
  handleDashboardSessionRequest,
  isAllowedLoopbackHostname,
  isLoopbackAddress,
  parseDashboardSessionExchange,
  selectDashboardLoginCompatToken,
  verifyDashboardCsrf,
  type DashboardLoginOptions,
  type DashboardLoginVerification,
} from '../src/daemon/dashboard-session.js';
import { setDashboardSessionCookie } from '../src/daemon/dashboard-session-cookie.js';
import { hasTrustedDashboardOrigin } from '../src/daemon/dashboard-session-policy.js';
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

  it('trusts HTTPS proxy origins from non-loopback peers only when browser metadata matches Host', () => {
    const matching = {
      headers: {
        host: 'node.example',
        origin: 'https://node.example',
        'x-forwarded-proto': 'https',
      },
      socket: { remoteAddress: '172.18.0.2' },
    } as IncomingMessage;
    expect(hasTrustedDashboardOrigin(matching)).toBe(true);

    const matchingReferer = {
      headers: {
        host: 'node.example',
        referer: 'https://node.example/dashboard',
        'x-forwarded-proto': 'https',
      },
      socket: { remoteAddress: '172.18.0.2' },
    } as IncomingMessage;
    expect(hasTrustedDashboardOrigin(matchingReferer)).toBe(true);

    const hostile = {
      headers: {
        host: 'node.example',
        origin: 'https://attacker.example',
        'x-forwarded-proto': 'https',
      },
      socket: { remoteAddress: '172.18.0.2' },
    } as IncomingMessage;
    expect(hasTrustedDashboardOrigin(hostile)).toBe(false);
  });
});

describe('dashboard session exchange helpers', () => {
  it('parses token, login, and mixed exchange requests explicitly', () => {
    expect(parseDashboardSessionExchange({ token: ' dashboard-token ' }, undefined)).toEqual({
      kind: 'token',
      token: 'dashboard-token',
    });
    expect(parseDashboardSessionExchange({}, 'Bearer header-token')).toEqual({
      kind: 'token',
      token: 'header-token',
    });
    expect(parseDashboardSessionExchange({ username: ' node-admin ', password: 'secret' }, undefined)).toEqual({
      kind: 'login',
      username: 'node-admin',
      password: 'secret',
    });
    expect(parseDashboardSessionExchange({ username: 'node-admin', token: 'dashboard-token' }, undefined)).toEqual({
      kind: 'invalid',
      status: 400,
      error: 'Dashboard session exchange accepts either token or username/password',
    });
  });

  it('selects a node-admin backing token for password-login sessions', () => {
    const validTokens = new Set(['agent-token-a', 'node-admin-token', 'bridge-token']);
    const resolveAgentByToken = (token: string) => token.startsWith('agent-token') ? TOKEN_AGENT_ADDRESS : undefined;
    const refreshValidTokens = vi.fn();

    expect(selectDashboardLoginCompatToken({
      validTokens,
      bridgeAuthToken: 'bridge-token',
      resolveAgentByToken,
      refreshValidTokens,
    })).toBe('bridge-token');
    expect(refreshValidTokens).toHaveBeenCalledTimes(1);

    expect(selectDashboardLoginCompatToken({
      validTokens,
      bridgeAuthToken: 'stale-bridge-token',
      resolveAgentByToken,
    })).toBe('node-admin-token');

    expect(selectDashboardLoginCompatToken({
      validTokens: new Set(['agent-token-a', 'agent-token-b']),
      resolveAgentByToken,
    })).toBeUndefined();
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
  corsOrigin?: string | null;
  signJoinRequest?: (contextGraphId: string, agentAddress: string) => Promise<unknown>;
  authEnabled?: boolean;
  dashboardLogin?: DashboardLoginOptions;
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
    signJoinRequest: options.signJoinRequest ?? (async (contextGraphId: string, agentAddress: string) =>
      ({ contextGraphId, agentAddress, signature: 'signed' })),
    peerId: '12D3KooWDashboardSessionTest',
    publisher: { getIdentityId: () => 1n },
  };
  const dashboardAuthSource = createDashboardSessionAuthSource({
    authenticate: (request) => authenticateDashboardSessionRequest(request, sessions, {
      ...(options.dashboardLogin ? { dashboardLogin: options.dashboardLogin } : {}),
      ...(options.onSessionRevoked ? { onSessionRevoked: options.onSessionRevoked } : {}),
    }),
    resolvePrincipal,
    verifyCsrf: (request, session) => verifyDashboardCsrf(request, session),
  });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (await handleDashboardSessionRequest(req, res, url, sessions, {
      authEnabled: options.authEnabled ?? true,
      validTokens,
      refreshValidTokens: options.refreshValidTokens,
      onSessionRevoked: options.onSessionRevoked,
      corsOrigin: options.corsOrigin,
      ...(options.dashboardLogin ? { dashboardLogin: options.dashboardLogin } : {}),
    })) {
      return;
    }
    if (!(await httpAuthGuard(req, res, true, validTokens, options.corsOrigin ?? null, {
      resolvePrincipal,
      authSources: [dashboardAuthSource],
    }))) {
      return;
    }
    if (
      url.pathname === '/api/agent/identity' ||
      /^\/api\/context-graph\/[^/]+\/sign-join$/.test(url.pathname)
    ) {
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

  it('reports authenticated dashboard status when API auth is disabled', async () => {
    const started = await startServer({ authEnabled: false });
    server = started.server;

    const res = await fetch(`${started.baseUrl}/api/dashboard/session/status`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      authenticated: true,
      authDisabled: true,
    });
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

  it('exchanges a valid bearer token for a usable dashboard session cookie', async () => {
    const started = await startServer();
    server = started.server;

    const exchange = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(exchange.status).toBe(200);
    const setCookie = exchange.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('dkg_ui_session=');
    await expect(exchange.json()).resolves.toMatchObject({ authenticated: true, source: 'exchange' });

    const res = await fetch(`${started.baseUrl}/api/protected`, {
      headers: { Cookie: setCookie.split(';')[0] },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      requestAuth: {
        source: 'dashboard-session',
        internalCredentialToken: VALID_TOKEN,
        principal: { kind: 'node-admin', agentAddress: DEFAULT_AGENT_ADDRESS },
      },
    });
  });

  it('exchanges dashboard username/password for a usable dashboard session cookie', async () => {
    const verifyCredentials = vi.fn(async (username: string, password: string) =>
      username === 'node-admin' && password === 'secret-password'
        ? { ok: true as const, credentialFingerprint: 'credential-a' }
        : { ok: false as const, reason: 'mismatch' as const });
    const selectCompatToken = vi.fn(() => VALID_TOKEN);
    const started = await startServer({
      dashboardLogin: { verifyCredentials, selectCompatToken },
    });
    server = started.server;

    const exchange = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'node-admin', password: 'secret-password' }),
    });
    expect(exchange.status).toBe(200);
    const setCookie = exchange.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('dkg_ui_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie.toLowerCase()).not.toContain('domain=');
    const body = await exchange.json() as { authenticated: boolean; source: string; csrfToken: string };
    expect(body).toMatchObject({ authenticated: true, source: 'login' });
    expect(body.csrfToken).toEqual(expect.any(String));
    expect(body.csrfToken.length).toBeGreaterThan(16);
    expect(verifyCredentials).toHaveBeenCalledWith('node-admin', 'secret-password');
    expect(selectCompatToken).toHaveBeenCalledTimes(1);

    const cookie = setCookie.split(';')[0];
    const rejectedPost = await fetch(`${started.baseUrl}/api/protected`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(rejectedPost.status).toBe(403);
    await expect(rejectedPost.json()).resolves.toMatchObject({
      error: 'Invalid or missing dashboard CSRF token',
    });

    const acceptedPost = await fetch(`${started.baseUrl}/api/protected`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-DKG-CSRF': body.csrfToken },
    });
    expect(acceptedPost.status).toBe(200);

    const res = await fetch(`${started.baseUrl}/api/protected`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      authorization: null,
      requestAuth: {
        source: 'dashboard-session',
        internalCredentialToken: VALID_TOKEN,
        principal: { kind: 'node-admin', agentAddress: DEFAULT_AGENT_ADDRESS },
        dashboardSession: { source: 'login' },
      },
    });
  });


  it('rejects wrong dashboard username/password without setting a cookie', async () => {
    const verifyCredentials = vi.fn(async () => ({ ok: false as const, reason: 'mismatch' as const }));
    const started = await startServer({
      dashboardLogin: {
        verifyCredentials,
        selectCompatToken: () => VALID_TOKEN,
      },
    });
    server = started.server;

    const exchange = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'node-admin', password: 'wrong-password' }),
    });
    expect(exchange.status).toBe(401);
    expect(exchange.headers.get('set-cookie')).toBeNull();
    await expect(exchange.json()).resolves.toMatchObject({
      error: 'Invalid dashboard username or password',
    });
  });

  it('rejects hostile dashboard login origins before credential verification', async () => {
    const verifyCredentials = vi.fn(async () => ({ ok: true as const, credentialFingerprint: 'credential-a' }));
    const started = await startServer({
      dashboardLogin: {
        verifyCredentials,
        selectCompatToken: () => VALID_TOKEN,
      },
    });
    server = started.server;

    const exchange = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ username: 'node-admin', password: 'secret-password' }),
    });
    expect(exchange.status).toBe(403);
    expect(exchange.headers.get('set-cookie')).toBeNull();
    expect(verifyCredentials).not.toHaveBeenCalled();
    await expect(exchange.json()).resolves.toMatchObject({ error: 'Untrusted dashboard request origin' });
  });

  it('rate-limits repeated dashboard login failures', async () => {
    let now = 1_000;
    const verifyCredentials = vi.fn(async () => ({ ok: false as const, reason: 'mismatch' as const }));
    const started = await startServer({
      dashboardLogin: {
        verifyCredentials,
        selectCompatToken: () => VALID_TOKEN,
        attemptLimiter: new DashboardLoginAttemptLimiter({
          maxFailures: 2,
          failureWindowMs: 60_000,
          lockoutMs: 60_000,
          now: () => now,
        }),
      },
    });
    server = started.server;
    const request = () => fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'node-admin', password: 'wrong-password' }),
    });

    expect((await request()).status).toBe(401);
    now += 1_000;
    expect((await request()).status).toBe(401);
    now += 1_000;
    const locked = await request();
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBe('59');
    await expect(locked.json()).resolves.toMatchObject({
      error: 'Too many dashboard sign-in attempts. Try again later.',
    });
    expect(verifyCredentials).toHaveBeenCalledTimes(2);
  });

  it('rate-limits varied dashboard usernames from the same remote address', async () => {
    let now = 1_000;
    const verifyCredentials = vi.fn(async () => ({ ok: false as const, reason: 'mismatch' as const }));
    const started = await startServer({
      dashboardLogin: {
        verifyCredentials,
        selectCompatToken: () => VALID_TOKEN,
        attemptLimiter: new DashboardLoginAttemptLimiter({
          maxFailures: 2,
          failureWindowMs: 60_000,
          lockoutMs: 60_000,
          now: () => now,
        }),
      },
    });
    server = started.server;
    const request = (username: string) => fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'wrong-password' }),
    });

    expect((await request('alice')).status).toBe(401);
    now += 1_000;
    expect((await request('bob')).status).toBe(401);
    now += 1_000;
    const locked = await request('carol');
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBe('59');
    expect(verifyCredentials).toHaveBeenCalledTimes(2);
  });

  it('bounds dashboard login attempt tracking for many unique usernames', () => {
    let now = 1_000;
    const limiter = new DashboardLoginAttemptLimiter({
      maxFailures: 2,
      failureWindowMs: 60_000,
      lockoutMs: 60_000,
      maxTrackedKeys: 3,
      now: () => now,
    });

    for (let i = 0; i < 20; i += 1) {
      limiter.recordFailure(`127.0.0.1:user-${i}`);
    }
    expect((limiter as any).attempts.size).toBeLessThanOrEqual(3);

    now += 60_001;
    expect(limiter.reserve('127.0.0.1:fresh-user')).toEqual({ ok: true });
    expect((limiter as any).attempts.size).toBe(1);
    limiter.releaseReservation('127.0.0.1:fresh-user');
    expect((limiter as any).attempts.size).toBe(0);

    expect(limiter.reserve('127.0.0.1:active-a')).toEqual({ ok: true });
    expect(limiter.reserve('127.0.0.1:active-b')).toEqual({ ok: true });
    expect(limiter.reserve('127.0.0.1:active-c')).toEqual({ ok: true });
    expect(limiter.reserve('127.0.0.1:active-d')).toEqual({ ok: false, retryAfterMs: 60_000 });
    expect((limiter as any).attempts.size).toBe(3);
  });

  it('counts concurrent dashboard login attempts before credential verification finishes', async () => {
    let now = 1_000;
    const pending: Array<(value: DashboardLoginVerification) => void> = [];
    const verifyCredentials = vi.fn(async () => new Promise<DashboardLoginVerification>((resolve) => {
      pending.push(resolve);
    }));
    const started = await startServer({
      dashboardLogin: {
        verifyCredentials,
        selectCompatToken: () => VALID_TOKEN,
        attemptLimiter: new DashboardLoginAttemptLimiter({
          maxFailures: 2,
          failureWindowMs: 60_000,
          lockoutMs: 60_000,
          now: () => now,
        }),
      },
    });
    server = started.server;
    const request = () => fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'node-admin', password: 'wrong-password' }),
    });

    const requests = Array.from({ length: 6 }, () => request());
    for (let i = 0; i < 20 && verifyCredentials.mock.calls.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(verifyCredentials).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(verifyCredentials).toHaveBeenCalledTimes(2);

    now += 1_000;
    for (const resolve of pending.splice(0)) {
      resolve({ ok: false, reason: 'mismatch' });
    }

    const responses = await Promise.all(requests);
    const statuses = responses.map((res) => res.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(2);
    expect(statuses.filter((status) => status === 429)).toHaveLength(4);
    const locked = responses.find((res) => res.status === 429);
    expect(locked?.headers.get('retry-after')).toBe('60');
  });

  it('invalidates password-login session status after the credential file fingerprint changes', async () => {
    let currentFingerprint = 'credential-a';
    const onSessionRevoked = vi.fn();
    const started = await startServer({
      onSessionRevoked,
      dashboardLogin: {
        verifyCredentials: async () => ({ ok: true as const, credentialFingerprint: currentFingerprint }),
        selectCompatToken: () => VALID_TOKEN,
        isCredentialFingerprintCurrent: (fingerprint) => fingerprint === currentFingerprint,
      },
    });
    server = started.server;

    const exchange = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'node-admin', password: 'secret-password' }),
    });
    expect(exchange.status).toBe(200);
    const cookie = cookieFrom(exchange);
    currentFingerprint = 'credential-b';

    const status = await fetch(`${started.baseUrl}/api/dashboard/session/status`, {
      headers: { Cookie: cookie },
    });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ authenticated: false });
    expect(onSessionRevoked).toHaveBeenCalledTimes(1);
  });

  it('rejects stale password-login sessions on protected APIs before status is checked', async () => {
    let currentFingerprint = 'credential-a';
    const onSessionRevoked = vi.fn();
    const started = await startServer({
      onSessionRevoked,
      dashboardLogin: {
        verifyCredentials: async () => ({ ok: true as const, credentialFingerprint: currentFingerprint }),
        selectCompatToken: () => VALID_TOKEN,
        isCredentialFingerprintCurrent: (fingerprint) => fingerprint === currentFingerprint,
      },
    });
    server = started.server;

    const exchange = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'node-admin', password: 'secret-password' }),
    });
    expect(exchange.status).toBe(200);
    const cookie = cookieFrom(exchange);
    currentFingerprint = 'credential-b';

    const protectedRes = await fetch(`${started.baseUrl}/api/protected`, { headers: { Cookie: cookie } });
    expect(protectedRes.status).toBe(401);
    expect(onSessionRevoked).toHaveBeenCalledTimes(1);

    const status = await fetch(`${started.baseUrl}/api/dashboard/session/status`, {
      headers: { Cookie: cookie },
    });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ authenticated: false });
    expect(onSessionRevoked).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid bearer-token dashboard exchange attempts without setting a cookie', async () => {
    const started = await startServer();
    server = started.server;

    const exchange = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(exchange.status).toBe(401);
    expect(exchange.headers.get('set-cookie')).toBeNull();
    await expect(exchange.json()).resolves.toMatchObject({
      error: 'Invalid dashboard session token',
    });
  });

  it('emits credentialed CORS headers and cross-site cookie attributes for configured dashboard origins', async () => {
    const dashboardOrigin = 'https://dashboard.example';
    const started = await startServer({ corsOrigin: dashboardOrigin });
    server = started.server;

    const exchange = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: dashboardOrigin,
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ token: VALID_TOKEN }),
    });
    expect(exchange.status).toBe(200);
    expect(exchange.headers.get('access-control-allow-origin')).toBe(dashboardOrigin);
    expect(exchange.headers.get('access-control-allow-credentials')).toBe('true');
    expect(exchange.headers.get('vary')).toBe('Origin');

    const setCookie = exchange.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('dkg_ui_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=None');
    expect(setCookie).toContain('Secure');

    const status = await fetch(`${started.baseUrl}/api/dashboard/session/status`, {
      headers: {
        Cookie: setCookie.split(';')[0],
        Origin: dashboardOrigin,
      },
    });
    expect(status.status).toBe(200);
    expect(status.headers.get('access-control-allow-credentials')).toBe('true');
    await expect(status.json()).resolves.toMatchObject({ authenticated: true });
  });

  it('allows same-origin HTTPS dashboards behind a TLS-terminating proxy', async () => {
    const externalOrigin = 'https://node.example';
    const started = await startServer();
    server = started.server;

    const exchange = await rawRequest(started.baseUrl, '/api/dashboard/session/exchange', {
      method: 'POST',
      headers: {
        Host: 'node.example',
        Origin: externalOrigin,
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ token: VALID_TOKEN }),
    });
    expect(exchange.status).toBe(200);
    const setCookie = Array.isArray(exchange.headers['set-cookie'])
      ? exchange.headers['set-cookie'][0]
      : exchange.headers['set-cookie'];
    expect(setCookie).toContain('dkg_ui_session=');
    expect(setCookie).toContain('Secure');
    const cookie = setCookie!.split(';')[0];
    const body = JSON.parse(exchange.body) as { csrfToken: string };

    const protectedPost = await rawRequest(started.baseUrl, '/api/protected', {
      method: 'POST',
      headers: {
        Host: 'node.example',
        Origin: externalOrigin,
        Cookie: cookie,
        'X-DKG-CSRF': body.csrfToken,
        'X-Forwarded-Proto': 'https',
      },
    });
    expect(protectedPost.status).toBe(200);
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

  it('marks non-loopback proxy cookies Secure when forwarded HTTPS matches the browser origin', () => {
    const req = {
      headers: {
        host: 'node.example',
        origin: 'https://node.example',
        'x-forwarded-proto': 'https',
      },
      socket: { remoteAddress: '172.18.0.2' },
    } as IncomingMessage;
    const headers: Record<string, string | string[]> = {};
    const res = {
      getHeader: (name: string) => headers[name],
      setHeader: (name: string, value: string | string[]) => { headers[name] = value; },
    } as ServerResponse;

    setDashboardSessionCookie(req, res, 'forwarded-https-session');

    expect(headers['Set-Cookie']).toContain('dkg_ui_session=');
    expect(String(headers['Set-Cookie'])).toContain('Secure');
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

  it('routes dashboard-cookie agent sessions through requestAgentAddress for sign-join', async () => {
    const signJoinRequest = vi.fn(async (contextGraphId: string, agentAddress: string) => ({
      contextGraphId,
      agentAddress,
      signature: 'signed-join',
    }));
    const started = await startServer({ signJoinRequest });
    server = started.server;

    const exchange = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: AGENT_TOKEN }),
    });
    expect(exchange.status).toBe(200);
    const cookie = cookieFrom(exchange);
    const body = await exchange.json() as { csrfToken: string };

    const signed = await fetch(`${started.baseUrl}/api/context-graph/cg-token/sign-join`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-DKG-CSRF': body.csrfToken, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(signed.status).toBe(200);
    expect(signJoinRequest).toHaveBeenCalledWith('cg-token', TOKEN_AGENT_ADDRESS);
    await expect(signed.json()).resolves.toMatchObject({ agentAddress: TOKEN_AGENT_ADDRESS });
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

  it('rejects cross-site dashboard session exchange attempts without setting a cookie', async () => {
    const started = await startServer();
    server = started.server;

    const res = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Origin: 'https://attacker.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ token: VALID_TOKEN }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
    await expect(res.json()).resolves.toMatchObject({ error: 'Untrusted dashboard request origin' });
  });

  it('rejects non-json dashboard session exchange bodies without setting a cookie', async () => {
    const started = await startServer();
    server = started.server;

    const res = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ token: VALID_TOKEN }),
    });
    expect(res.status).toBe(415);
    expect(res.headers.get('set-cookie')).toBeNull();
    await expect(res.json()).resolves.toMatchObject({
      error: 'Dashboard session exchange requires application/json',
    });
  });

  it('requires login sessions to carry a credential fingerprint', () => {
    const store = new DashboardSessionStore();
    const issuedAt = 1_000;
    if (false) {
      // @ts-expect-error Login sessions must be created with a fingerprint.
      store.create(VALID_TOKEN, 'login', issuedAt);
    }

    const created = store.createLoginSession(VALID_TOKEN, 'credential-a', issuedAt);
    const authenticated = store.authenticateSessionId(created.sessionId, issuedAt + 1);

    expect(created.record).toMatchObject({ source: 'login', credentialFingerprint: 'credential-a' });
    expect(authenticated).toMatchObject({ source: 'login', credentialFingerprint: 'credential-a' });
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
      code: 'DASHBOARD_CSRF_INVALID',
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

  it('allows unsafe session-authenticated requests from the configured dashboard CORS origin only', async () => {
    const dashboardOrigin = 'https://dashboard.example';
    const started = await startServer({ corsOrigin: dashboardOrigin });
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
    const cookie = cookieFrom(bootstrap);
    const body = await bootstrap.json() as { csrfToken: string };

    const allowed = await fetch(`${started.baseUrl}/api/protected`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: dashboardOrigin,
        'Sec-Fetch-Site': 'cross-site',
        'X-DKG-CSRF': body.csrfToken,
      },
    });
    expect(allowed.status).toBe(200);

    const rejected = await fetch(`${started.baseUrl}/api/protected`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'https://attacker.example',
        'Sec-Fetch-Site': 'cross-site',
        'X-DKG-CSRF': body.csrfToken,
      },
    });
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      error: 'Untrusted dashboard request origin',
    });
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

  it('revokes the server-side session on logout after the backing token rotates away', async () => {
    const validTokens = new Set([VALID_TOKEN]);
    const onSessionRevoked = vi.fn();
    const started = await startServer({ validTokens, onSessionRevoked });
    server = started.server;
    const bootstrap = await fetch(`${started.baseUrl}/api/dashboard/session/loopback`, loopbackBootstrapInit(started.baseUrl));
    const cookie = cookieFrom(bootstrap);
    const body = await bootstrap.json() as { csrfToken: string };
    validTokens.delete(VALID_TOKEN);

    const logout = await fetch(`${started.baseUrl}/api/dashboard/session/logout`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-DKG-CSRF': body.csrfToken },
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(onSessionRevoked).toHaveBeenCalledTimes(1);
    expect(onSessionRevoked).toHaveBeenCalledWith(decodeURIComponent(cookie.split('=')[1]!));

    const protectedRes = await fetch(`${started.baseUrl}/api/protected`, { headers: { Cookie: cookie } });
    expect(protectedRes.status).toBe(401);
  });
});
