import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
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

describe('dashboard session cookie attributes', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
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

});
