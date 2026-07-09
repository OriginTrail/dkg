/**
 * Boot-time reachability probe for external SPARQL backends.
 *
 * Plan: `.cursor/plans/blazegraph_v10_support_178da670.plan.md` §PR 1 item 4.
 * Locks in:
 *   - local backends pass without I/O (no fetch issued).
 *   - external + reachable → ok with endpoint reported.
 *   - external + HTTP 500 → ok=false with the body snippet surfaced.
 *   - external + HTTP 404 → namespaceMissing=true + a hint that mentions
 *     creating the namespace (Blazegraph operators hit this when they
 *     point at a path before provisioning it).
 *   - external + transport error → ok=false, error contains the cause.
 *   - external + AbortController timeout → ok=false, error mentions ms.
 *   - sparql-http with auth header → Authorization passed through.
 *   - malformed config (external backend with no URL) → ok=false with a
 *     config-shape error, not a crashed probe.
 *   - formatHealthCheckFailure renders multi-line, contains endpoint
 *     and remediation hints; namespace-missing path mentions creating
 *     the namespace, not network checks.
 */
import { describe, it, expect } from 'vitest';
import {
  checkExternalStoreReachable,
  formatHealthCheckFailure,
} from '../src/daemon/store-health-check.js';

function mockFetch(handler: (input: any, init?: any) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn: typeof globalThis.fetch = (async (input: any, init?: any) => {
    calls.push({ url: String(input), init });
    return handler(input, init);
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

describe('checkExternalStoreReachable', () => {
  it('passes through with no I/O for local backends', async () => {
    const { fn, calls } = mockFetch(() => new Response(null, { status: 200 }));
    const result = await checkExternalStoreReachable({
      storeConfig: { backend: 'oxigraph' },
      fetch: fn,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('passes through when storeConfig is undefined (default deployment)', async () => {
    const result = await checkExternalStoreReachable({ storeConfig: undefined });
    expect(result.ok).toBe(true);
  });

  it('returns ok=true for a reachable Blazegraph endpoint', async () => {
    const { fn, calls } = mockFetch(
      () =>
        new Response(JSON.stringify({ head: { vars: [] }, boolean: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const result = await checkExternalStoreReachable({
      storeConfig: {
        backend: 'blazegraph',
        options: { url: 'http://blaze.test/sparql' },
      },
      fetch: fn,
    });
    expect(result.ok).toBe(true);
    expect(result.endpoint).toBe('http://blaze.test/sparql');
    expect(result.backend).toBe('blazegraph');
    expect(calls).toHaveLength(1);
    expect(String(calls[0].init?.body)).toContain('query=ASK');
  });

  it('returns ok=false with HTTP details on 500', async () => {
    const { fn } = mockFetch(
      () => new Response('boom', { status: 500, statusText: 'Server Error' }),
    );
    const result = await checkExternalStoreReachable({
      storeConfig: {
        backend: 'blazegraph',
        options: { url: 'http://broken.test/sparql' },
      },
      fetch: fn,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('500');
    expect(result.namespaceMissing).toBeUndefined();
  });

  it('returns namespaceMissing=true on HTTP 404 with actionable message', async () => {
    const { fn } = mockFetch(
      () => new Response('not found', { status: 404, statusText: 'Not Found' }),
    );
    const result = await checkExternalStoreReachable({
      storeConfig: {
        backend: 'blazegraph',
        options: { url: 'http://blaze.test/namespace/missing/sparql' },
      },
      fetch: fn,
    });
    expect(result.ok).toBe(false);
    expect(result.namespaceMissing).toBe(true);
    expect(result.error).toMatch(/namespace/i);
  });

  it('reports transport errors with the underlying message', async () => {
    const fn: typeof globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof globalThis.fetch;
    const result = await checkExternalStoreReachable({
      storeConfig: {
        backend: 'blazegraph',
        options: { url: 'http://nope.test/sparql' },
      },
      fetch: fn,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('reports timeout when the endpoint hangs past timeoutMs', async () => {
    const fn: typeof globalThis.fetch = (async (
      _input: any,
      init?: any,
    ) => {
      await new Promise((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (sig) sig.addEventListener('abort', () => reject(new Error('aborted')));
      });
      return new Response();
    }) as typeof globalThis.fetch;

    const result = await checkExternalStoreReachable({
      storeConfig: {
        backend: 'blazegraph',
        options: { url: 'http://slow.test/sparql' },
      },
      fetch: fn,
      timeoutMs: 30,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out after 30ms/);
  });

  it('threads the Authorization header for sparql-http with auth set', async () => {
    const { fn, calls } = mockFetch(
      () => new Response(JSON.stringify({ boolean: true }), { status: 200 }),
    );
    await checkExternalStoreReachable({
      storeConfig: {
        backend: 'sparql-http',
        options: {
          queryEndpoint: 'http://server.test/query',
          auth: 'Bearer t0ken',
        },
      },
      fetch: fn,
    });
    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer t0ken');
  });

  it('returns ok=false without throwing when storeConfig is malformed', async () => {
    const { fn, calls } = mockFetch(() => new Response(null, { status: 200 }));
    const result = await checkExternalStoreReachable({
      storeConfig: { backend: 'blazegraph', options: {} }, // url missing
      fetch: fn,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/options\.url/);
    expect(calls).toHaveLength(0);
  });
});

describe('formatHealthCheckFailure', () => {
  it('renders an empty string for ok=true', () => {
    expect(formatHealthCheckFailure({ ok: true })).toBe('');
  });

  it('renders endpoint + remediation for a generic failure', () => {
    const block = formatHealthCheckFailure({
      ok: false,
      backend: 'blazegraph',
      endpoint: 'http://blaze.test/sparql',
      error: 'HTTP 500',
    });
    expect(block).toMatch(/STORE-HEALTH/);
    expect(block).toMatch(/blazegraph/);
    expect(block).toMatch(/http:\/\/blaze\.test\/sparql/);
    expect(block).toMatch(/config\.json/);
    expect(block).toMatch(/firewall/i);
  });

  it('biases the hint toward namespace creation when namespaceMissing=true', () => {
    const block = formatHealthCheckFailure({
      ok: false,
      backend: 'blazegraph',
      endpoint: 'http://blaze.test/namespace/missing/sparql',
      error: 'HTTP 404 …',
      namespaceMissing: true,
    });
    expect(block).toMatch(/create the namespace/);
    expect(block).toMatch(/Docker/);
    expect(block).not.toMatch(/firewall/i);
  });
});
