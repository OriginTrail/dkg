import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../src/http.js';

describe('HttpClient transport and error mapping', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends auth/header data and parses JSON response', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-token');
      expect(headers['X-Test']).toBe('sdk');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpClient({
      baseUrl: 'http://127.0.0.1:9200/',
      token: 'test-token',
      headers: { 'X-Test': 'sdk' },
    });

    const out = await client.get<{ ok: boolean }>('/api/status');
    expect(out.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9200/api/status',
      expect.any(Object),
    );
  });

  it('maps HTTP JSON errors to DKGSDKError with status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }));

    const client = new HttpClient({ baseUrl: 'http://127.0.0.1:9200' });

    await expect(client.get('/api/status')).rejects.toMatchObject({
      name: 'DKGSDKError',
      message: 'Unauthorized',
      status: 401,
    });
  });

  it('maps timeout aborts to ETIMEDOUT', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }),
    );

    const client = new HttpClient({ baseUrl: 'http://127.0.0.1:9200', timeoutMs: 5 });

    await expect(client.get('/api/status')).rejects.toMatchObject({
      name: 'DKGSDKError',
      code: 'ETIMEDOUT',
    });
  });
});
