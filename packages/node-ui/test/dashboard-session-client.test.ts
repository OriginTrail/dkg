// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiFetch,
  __setDashboardSessionForTesting,
} from '../src/ui/dashboardSessionClient.js';

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
    __setDashboardSessionForTesting({
      authenticated: true,
      source: 'test',
      csrfToken: 'csrf-test',
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
  });

  it('refreshes a stale browser session and retries once after a protected API 401', async () => {
    const calls: Array<{ url: string; method: string; headers?: HeadersInit }> = [];
    let protectedCalls = 0;
    __setDashboardSessionForTesting({
      authenticated: true,
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
        return new Response(JSON.stringify({ authenticated: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/dashboard/session/loopback') {
        return new Response(JSON.stringify({
          authenticated: true,
          source: 'loopback',
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
      'POST /api/dashboard/session/loopback',
      'POST /api/protected',
    ]);
    expect(headerValue(calls[0]?.headers, 'X-DKG-CSRF')).toBe('csrf-old');
    expect(headerValue(calls[3]?.headers, 'X-DKG-CSRF')).toBe('csrf-new');
  });
});
