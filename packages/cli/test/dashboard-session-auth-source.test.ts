import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';
import {
  DASHBOARD_SESSION_COOKIE,
  DashboardLoginAttemptLimiter,
  DashboardSessionStore,
  type DashboardLoginVerification,
} from '../src/daemon/dashboard-session.js';
import { setDashboardSessionCookie } from '../src/daemon/dashboard-session-cookie.js';
import {
  AGENT_TOKEN,
  DEFAULT_AGENT_ADDRESS,
  ROTATED_TOKEN,
  TOKEN_AGENT_ADDRESS,
  VALID_TOKEN,
  cookieFrom,
  loopbackBootstrapInit,
  rawRequest,
  startDashboardSessionServer as startServer,
} from './dashboard-session-test-harness.js';

describe('dashboard session auth source', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
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

});
