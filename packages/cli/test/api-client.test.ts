import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient } from '../src/api-client.js';

const PORT = 8899;

function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

function mockFetchError(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    json: () => Promise.resolve(body),
  });
}

describe('ApiClient', () => {
  let client: ApiClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    client = new ApiClient(PORT, 'test-token');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('GET endpoints', () => {
    it('status() calls /api/status with auth header', async () => {
      const body = { name: 'test', peerId: 'peer1', uptimeMs: 1000, connectedPeers: 2, relayConnected: true, multiaddrs: [] };
      globalThis.fetch = mockFetchOk(body);
      const result = await client.status();

      expect(result).toEqual(body);
      expect(globalThis.fetch).toHaveBeenCalledOnce();
      const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe(`http://127.0.0.1:${PORT}/api/status`);
      expect(opts.headers).toHaveProperty('Authorization', 'Bearer test-token');
    });

    it('agents() calls /api/agents', async () => {
      const body = { agents: [{ agentUri: 'urn:a', name: 'A', peerId: 'p1' }] };
      globalThis.fetch = mockFetchOk(body);
      const result = await client.agents();
      expect(result.agents).toHaveLength(1);
    });

    it('skills() calls /api/skills', async () => {
      const body = { skills: [] };
      globalThis.fetch = mockFetchOk(body);
      const result = await client.skills();
      expect(result.skills).toEqual([]);
    });

    it('listParanets() calls /api/paranet/list', async () => {
      const body = { paranets: [{ id: 'p1', uri: 'urn:p1', name: 'Test', isSystem: false }] };
      globalThis.fetch = mockFetchOk(body);
      const result = await client.listParanets();
      expect(result.paranets).toHaveLength(1);
    });

    it('paranetExists() calls correct URL with encoded id', async () => {
      const body = { id: 'my paranet', exists: true };
      globalThis.fetch = mockFetchOk(body);
      await client.paranetExists('my paranet');

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('my%20paranet');
    });
  });

  describe('POST endpoints', () => {
    it('sendChat() sends correct body', async () => {
      globalThis.fetch = mockFetchOk({ delivered: true });
      const result = await client.sendChat('peer1', 'hello');
      expect(result.delivered).toBe(true);

      const [, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(opts.body);
      expect(body).toEqual({ to: 'peer1', text: 'hello' });
    });

    it('publish() sends paranetId and quads', async () => {
      const expected = { kcId: 'kc1', status: 'tentative', kas: [] };
      globalThis.fetch = mockFetchOk(expected);
      const quads = [{ subject: 'urn:s', predicate: 'urn:p', object: '"v"', graph: 'urn:g' }];
      const result = await client.publish('test-paranet', quads);
      expect(result.kcId).toBe('kc1');

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.paranetId).toBe('test-paranet');
      expect(body.quads).toHaveLength(1);
    });

    it('query() sends sparql and optional paranetId', async () => {
      globalThis.fetch = mockFetchOk({ result: [] });
      await client.query('SELECT * { ?s ?p ?o }', 'my-paranet');

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.sparql).toBe('SELECT * { ?s ?p ?o }');
      expect(body.paranetId).toBe('my-paranet');
    });
  });

  describe('messages() query string building', () => {
    it('builds query string from opts', async () => {
      globalThis.fetch = mockFetchOk({ messages: [] });
      await client.messages({ peer: 'p1', since: 100, limit: 50 });

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('peer=p1');
      expect(url).toContain('since=100');
      expect(url).toContain('limit=50');
    });

    it('omits query string when no opts', async () => {
      globalThis.fetch = mockFetchOk({ messages: [] });
      await client.messages();

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).not.toContain('?');
    });
  });

  describe('auth headers', () => {
    it('includes Bearer token when set', async () => {
      globalThis.fetch = mockFetchOk({});
      await client.status();

      const [, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(opts.headers.Authorization).toBe('Bearer test-token');
    });

    it('omits Authorization header when no token', async () => {
      const noTokenClient = new ApiClient(PORT);
      globalThis.fetch = mockFetchOk({});
      await noTokenClient.status();

      const [, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(opts.headers).not.toHaveProperty('Authorization');
    });
  });

  describe('error handling', () => {
    it('throws error message from response body', async () => {
      globalThis.fetch = mockFetchError(400, { error: 'Bad request: missing paranetId' });
      await expect(client.status()).rejects.toThrow('Bad request: missing paranetId');
    });

    it('falls back to HTTP status text when body has no error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.reject(new Error('no json')),
      });
      await expect(client.status()).rejects.toThrow('Internal Server Error');
    });
  });

  describe('shutdown', () => {
    it('does not throw even if connection closes', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection reset'));
      await expect(client.shutdown()).resolves.toBeUndefined();
    });
  });
});
