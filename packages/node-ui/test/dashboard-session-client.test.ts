// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../src/ui/dashboardSessionClient.js';
import { resetDashboardSession, useAuthenticatedDashboardSession } from './helpers/dashboard-session.js';

function headerValue(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1];
  }
  return (headers as Record<string, string>)[name];
}

describe('dashboard session client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetDashboardSession();
  });

  it('rejects absolute cross-origin inputs before bootstrapping credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('https://example.invalid/rpc')).rejects.toThrow(
      'daemonFetch only accepts same-origin daemon paths',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not bootstrap a session for ordinary transport calls', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ synced: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiFetch('/api/status');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ synced: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/status');
  });

  it('refreshes a stale browser session and retries once after a protected API 401', async () => {
    const calls: Array<{ url: string; method: string; headers?: HeadersInit }> = [];
    let protectedCalls = 0;
    useAuthenticatedDashboardSession({
      source: 'loopback',
      csrfToken: 'csrf-old',
      expiresAt: Date.now() + 60_000,
    });

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers });
      if (url === '/api/protected') {
        protectedCalls += 1;
        if (protectedCalls === 1) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/dashboard/session/status') {
        return new Response(JSON.stringify({
          authenticated: true,
          source: 'exchange',
          csrfToken: 'csrf-new',
          expiresAt: Date.now() + 60_000,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });

    const res = await apiFetch('/api/protected', { method: 'POST' });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /api/protected',
      'GET /api/dashboard/session/status',
      'POST /api/protected',
    ]);
    expect(headerValue(calls[0]?.headers, 'X-DKG-CSRF')).toBe('csrf-old');
    expect(headerValue(calls[2]?.headers, 'X-DKG-CSRF')).toBe('csrf-new');
  });

  it('refreshes stale CSRF and retries once after an unsafe protected API 403', async () => {
    const calls: Array<{ url: string; method: string; headers?: HeadersInit; body?: BodyInit | null }> = [];
    let protectedCalls = 0;
    useAuthenticatedDashboardSession({
      source: 'loopback',
      csrfToken: 'csrf-tab-stale',
      expiresAt: Date.now() + 60_000,
    });

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers, body: init?.body });
      if (url === '/api/protected') {
        protectedCalls += 1;
        if (protectedCalls === 1) {
          return new Response(JSON.stringify({ error: 'Invalid or missing dashboard CSRF token' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/dashboard/session/status') {
        return new Response(JSON.stringify({
          authenticated: true,
          source: 'loopback',
          csrfToken: 'csrf-cookie-current',
          expiresAt: Date.now() + 60_000,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });

    const body = JSON.stringify({ contextGraphId: 'cg-1', name: 'memory' });
    const res = await apiFetch('/api/protected', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DKG-Client': 'node-ui',
      },
      body,
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /api/protected',
      'GET /api/dashboard/session/status',
      'POST /api/protected',
    ]);
    expect(headerValue(calls[0]?.headers, 'X-DKG-CSRF')).toBe('csrf-tab-stale');
    expect(headerValue(calls[2]?.headers, 'X-DKG-CSRF')).toBe('csrf-cookie-current');
    expect(headerValue(calls[2]?.headers, 'Content-Type')).toBe('application/json');
    expect(headerValue(calls[2]?.headers, 'X-DKG-Client')).toBe('node-ui');
    expect(calls[0]?.body).toBe(body);
    expect(calls[2]?.body).toBe(body);
  });

  it('does not refresh or retry generic unsafe 403 responses', async () => {
    const calls: Array<{ url: string; method: string; headers?: HeadersInit }> = [];
    useAuthenticatedDashboardSession({
      source: 'loopback',
      csrfToken: 'csrf-current',
      expiresAt: Date.now() + 60_000,
    });

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers });
      return new Response(JSON.stringify({ error: 'NotAccountOwner' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const res = await apiFetch('/api/protected', { method: 'DELETE' });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'NotAccountOwner' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'DELETE /api/protected',
    ]);
    expect(headerValue(calls[0]?.headers, 'X-DKG-CSRF')).toBe('csrf-current');
  });
});
