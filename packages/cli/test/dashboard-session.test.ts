import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';
import {
  AGENT_TOKEN,
  DEFAULT_AGENT_ADDRESS,
  ROTATED_TOKEN,
  VALID_TOKEN,
  cookieFrom,
  loopbackBootstrapInit,
  rawRequest,
  startDashboardSessionServer as startServer,
} from './dashboard-session-test-harness.js';

describe('dashboard session HTTP routes', () => {
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

  it('rejects hostile-origin JSON token exchange without setting a cookie', async () => {
    const started = await startServer();
    server = started.server;

    const res = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example',
      },
      body: JSON.stringify({ token: VALID_TOKEN }),
    });

    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
    await expect(res.json()).resolves.toMatchObject({
      error: 'Untrusted dashboard request origin',
    });
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
