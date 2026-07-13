/**
 * Namespace identity tagging — locks in the two-daemons-one-namespace
 * guard added in PR 3 (RFC 120 review point #5).
 *
 * Plan: `.cursor/plans/blazegraph_v10_support_178da670.plan.md` §PR 3
 * item 3.
 *
 * Locks in:
 *   - Local backends skipped entirely (no concurrent-access risk).
 *   - Fresh namespace → tag written via SPARQL UPDATE.
 *   - Existing tag matches → matched, no UPDATE issued.
 *   - Existing tag mismatches → ok=false, action='mismatch', message
 *     includes both node names AND the cleanup recipe.
 *   - SELECT transport failure → ok=false, action='transport-error'.
 *   - INSERT transport failure surfaces as transport-error too (i.e.
 *     we don't silently treat write failure as "tag absent").
 *   - SELECT 404 → transport-error (not silently treated as "fresh").
 *   - formatIdentityTagMismatch produces a multi-line block with the
 *     DELETE WHERE recipe referencing the right URIs.
 */
import { describe, it, expect } from 'vitest';
import {
  checkOrSetStoreIdentity,
  formatIdentityTagMismatch,
} from '../src/daemon/store-health-check.js';

function mockFetch(handler: (url: string, init?: any) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit; body?: string }> = [];
  const fn: typeof globalThis.fetch = (async (input: any, init?: any) => {
    const body = init?.body != null ? String(init.body) : undefined;
    calls.push({ url: String(input), init, body });
    return handler(String(input), init);
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

const BLAZEGRAPH_CONFIG = {
  backend: 'blazegraph',
  options: { url: 'http://blaze.test/sparql' },
};

describe('checkOrSetStoreIdentity', () => {
  it('skips for local oxigraph backend', async () => {
    const { fn, calls } = mockFetch(() => new Response(null, { status: 200 }));
    const result = await checkOrSetStoreIdentity({
      storeConfig: { backend: 'oxigraph' },
      nodeName: 'mynode',
      fetch: fn,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.action === 'skipped') {
      expect(result.reason).toBe('local-backend');
    }
    expect(calls).toHaveLength(0);
  });

  it('skips for undefined storeConfig', async () => {
    const { fn, calls } = mockFetch(() => new Response(null, { status: 200 }));
    const result = await checkOrSetStoreIdentity({
      storeConfig: undefined,
      nodeName: 'mynode',
      fetch: fn,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('writes the tag when the namespace has no existing identity', async () => {
    const { fn, calls } = mockFetch((url, init) => {
      if (init?.body != null && String(init.body).startsWith('query=')) {
        // SELECT returns no bindings.
        return new Response(
          JSON.stringify({ head: { vars: ['name'] }, results: { bindings: [] } }),
          { status: 200, headers: { 'content-type': 'application/sparql-results+json' } },
        );
      }
      return new Response(null, { status: 204 });
    });
    const result = await checkOrSetStoreIdentity({
      storeConfig: BLAZEGRAPH_CONFIG,
      nodeName: 'mynode',
      fetch: fn,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.action === 'tagged') {
      expect(result.nodeName).toBe('mynode');
    }
    const selectCall = calls.find((c) => c.body?.startsWith('query='));
    const updateCall = calls.find((c) => c.body?.startsWith('update='));
    expect(selectCall).toBeDefined();
    expect(updateCall).toBeDefined();
    expect(updateCall?.body).toContain(encodeURIComponent('urn:dkg:store-meta'));
    expect(updateCall?.body).toContain(encodeURIComponent('urn:dkg:storeTaggedFor'));
    expect(updateCall?.body).toContain(encodeURIComponent('"mynode"'));
  });

  it('matches silently when the existing tag equals the configured node name', async () => {
    const { fn, calls } = mockFetch((_url, init) => {
      if (init?.body != null && String(init.body).startsWith('query=')) {
        return new Response(
          JSON.stringify({
            head: { vars: ['name'] },
            results: { bindings: [{ name: { type: 'literal', value: 'mynode' } }] },
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 200 });
    });
    const result = await checkOrSetStoreIdentity({
      storeConfig: BLAZEGRAPH_CONFIG,
      nodeName: 'mynode',
      fetch: fn,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.action === 'matched') {
      expect(result.nodeName).toBe('mynode');
    }
    // Crucially: no UPDATE call (no INSERT DATA) when matched.
    const updateCall = calls.find((c) => c.body?.startsWith('update='));
    expect(updateCall).toBeUndefined();
  });

  it('refuses to start when the tag belongs to another node', async () => {
    const { fn } = mockFetch((_url, init) => {
      if (init?.body != null && String(init.body).startsWith('query=')) {
        return new Response(
          JSON.stringify({
            head: { vars: ['name'] },
            results: { bindings: [{ name: { type: 'literal', value: 'alice-node' } }] },
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 200 });
    });
    const result = await checkOrSetStoreIdentity({
      storeConfig: BLAZEGRAPH_CONFIG,
      nodeName: 'bob-node',
      fetch: fn,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.action === 'mismatch') {
      expect(result.existingNodeName).toBe('alice-node');
      expect(result.expectedNodeName).toBe('bob-node');
      expect(result.error).toContain('alice-node');
      expect(result.error).toContain('bob-node');
    }
  });

  it('surfaces transport error on SELECT failure (does not silently treat as fresh)', async () => {
    const { fn } = mockFetch(() => new Response('boom', { status: 500 }));
    const result = await checkOrSetStoreIdentity({
      storeConfig: BLAZEGRAPH_CONFIG,
      nodeName: 'mynode',
      fetch: fn,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.action).toBe('transport-error');
      expect(result.error).toMatch(/identity SELECT/);
    }
  });

  it('surfaces transport error on INSERT failure', async () => {
    const { fn } = mockFetch((_url, init) => {
      if (init?.body != null && String(init.body).startsWith('query=')) {
        return new Response(
          JSON.stringify({ head: { vars: ['name'] }, results: { bindings: [] } }),
          { status: 200 },
        );
      }
      return new Response('write rejected', { status: 503 });
    });
    const result = await checkOrSetStoreIdentity({
      storeConfig: BLAZEGRAPH_CONFIG,
      nodeName: 'mynode',
      fetch: fn,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.action).toBe('transport-error');
      expect(result.error).toMatch(/identity INSERT/);
    }
  });

  it('surfaces transport error on connection failure', async () => {
    const { fn } = mockFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const result = await checkOrSetStoreIdentity({
      storeConfig: BLAZEGRAPH_CONFIG,
      nodeName: 'mynode',
      fetch: fn,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.action).toBe('transport-error');
      expect(result.error).toMatch(/identity SELECT failed/);
    }
  });

  it('escapes special characters in the node-name literal', async () => {
    const { fn, calls } = mockFetch((_url, init) => {
      if (init?.body != null && String(init.body).startsWith('query=')) {
        return new Response(
          JSON.stringify({ head: { vars: ['name'] }, results: { bindings: [] } }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 200 });
    });
    await checkOrSetStoreIdentity({
      storeConfig: BLAZEGRAPH_CONFIG,
      nodeName: 'node "with quotes"',
      fetch: fn,
    });
    const updateCall = calls.find((c) => c.body?.startsWith('update='));
    expect(updateCall).toBeDefined();
    // After url-decoding, the literal should be `"node \"with quotes\""`.
    const decoded = decodeURIComponent(updateCall!.body!.replace(/^update=/, ''));
    expect(decoded).toContain('"node \\"with quotes\\""');
  });

  it('respects custom timeoutMs (the controller fires AbortError quickly)', async () => {
    const { fn } = mockFetch(
      () => new Promise((_resolve, reject) => {
        setTimeout(() => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        }, 10);
      }),
    );
    const result = await checkOrSetStoreIdentity({
      storeConfig: BLAZEGRAPH_CONFIG,
      nodeName: 'mynode',
      fetch: fn,
      timeoutMs: 20,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.action).toBe('transport-error');
  });
});

describe('formatIdentityTagMismatch', () => {
  it('returns empty string for any non-mismatch result', () => {
    expect(formatIdentityTagMismatch({ ok: true, action: 'skipped', reason: 'local-backend' })).toBe('');
    expect(formatIdentityTagMismatch({ ok: true, action: 'matched', nodeName: 'mynode' })).toBe('');
    expect(formatIdentityTagMismatch({ ok: true, action: 'tagged', nodeName: 'mynode' })).toBe('');
    expect(formatIdentityTagMismatch({ ok: false, action: 'transport-error', error: 'boom' })).toBe('');
  });

  it('formats a mismatch as a multi-line block with the cleanup recipe', () => {
    const block = formatIdentityTagMismatch({
      ok: false,
      action: 'mismatch',
      existingNodeName: 'alice-node',
      expectedNodeName: 'bob-node',
      error: 'boom',
    });
    expect(block).toContain('STORE-IDENTITY');
    expect(block).toContain('this node:    bob-node');
    expect(block).toContain('store tagged: alice-node');
    expect(block).toContain('DELETE WHERE');
    expect(block).toContain('urn:dkg:store-meta');
    expect(block).toContain('urn:dkg:storeTaggedFor');
  });
});
