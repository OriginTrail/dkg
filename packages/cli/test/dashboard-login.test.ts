import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';
import {
  DashboardLoginAttemptLimiter,
  type DashboardLoginVerification,
} from '../src/daemon/dashboard-session.js';
import {
  DEFAULT_AGENT_ADDRESS,
  VALID_TOKEN,
  cookieFrom,
  startDashboardSessionServer as startServer,
} from './dashboard-session-test-harness.js';

describe('dashboard username/password login sessions', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
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
    const protectedBody = await res.json();
    expect(protectedBody).toMatchObject({
      ok: true,
      authorization: null,
      requestAuth: {
        source: 'dashboard-session',
        internalCredentialToken: VALID_TOKEN,
        principal: { kind: 'node-admin', agentAddress: DEFAULT_AGENT_ADDRESS },
        dashboardSession: { source: 'login' },
      },
    });
    expect(protectedBody.requestAuth.dashboardSession)
      .not.toHaveProperty('credentialFingerprint');
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

  it.each([
    ['missing' as const, 'Dashboard credentials are not configured'],
    ['invalid' as const, 'Dashboard credentials are unavailable'],
  ])('reports %s dashboard credentials without setting a cookie', async (reason, message) => {
    const verifyCredentials = vi.fn(async () => ({ ok: false as const, reason }));
    let now = 1_000;
    const started = await startServer({
      dashboardLogin: {
        verifyCredentials,
        selectCompatToken: () => VALID_TOKEN,
        attemptLimiter: new DashboardLoginAttemptLimiter({
          maxFailures: 1,
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
      body: JSON.stringify({ username: 'node-admin', password: 'secret-password' }),
    });

    const first = await request();
    now += 1_000;
    const second = await request();
    for (const exchange of [first, second]) {
      expect(exchange.status).toBe(503);
      expect(exchange.headers.get('set-cookie')).toBeNull();
      const body = await exchange.json() as { error: string };
      expect(body.error).toContain(message);
      expect(body.error).toContain('reset-password');
    }
    expect(verifyCredentials).toHaveBeenCalledTimes(2);
  });

  it('does not set a cookie when password login has no node-admin backing token', async () => {
    const verifyCredentials = vi.fn(async () => ({ ok: true as const, credentialFingerprint: 'credential-a' }));
    const started = await startServer({
      dashboardLogin: {
        verifyCredentials,
        selectCompatToken: () => undefined,
      },
    });
    server = started.server;

    const exchange = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'node-admin', password: 'secret-password' }),
    });
    expect(exchange.status).toBe(503);
    expect(exchange.headers.get('set-cookie')).toBeNull();
    await expect(exchange.json()).resolves.toMatchObject({
      error: 'Dashboard login is unavailable until an API token is configured',
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

});
