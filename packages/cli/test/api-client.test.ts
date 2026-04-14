import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  let tempDir: string;

  beforeEach(async () => {
    client = new ApiClient(PORT, 'test-token');
    tempDir = await mkdtemp(join(tmpdir(), 'api-client-test-'));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
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

    it('listContextGraphs() calls /api/context-graph/list', async () => {
      const body = { contextGraphs: [{ id: 'p1', uri: 'urn:p1', name: 'Test', isSystem: false }] };
      globalThis.fetch = mockFetchOk(body);
      const result = await client.listContextGraphs();
      expect(result.contextGraphs).toHaveLength(1);
    });

    it('contextGraphExists() calls correct URL with encoded id', async () => {
      const body = { id: 'my paranet', exists: true };
      globalThis.fetch = mockFetchOk(body);
      await client.contextGraphExists('my paranet');

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('my%20paranet');
    });

    it('listCclPolicies() builds query string from filters', async () => {
      globalThis.fetch = mockFetchOk({ policies: [] });
      await client.listCclPolicies({ contextGraphId: 'ops', name: 'incident', contextType: 'review', includeBody: true });

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('/api/ccl/policy/list?');
      expect(url).toContain('contextGraphId=ops');
      expect(url).toContain('name=incident');
      expect(url).toContain('contextType=review');
      expect(url).toContain('includeBody=true');
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

    it('publish() sends context graph id and quads', async () => {
      const expected = { kcId: 'kc1', status: 'tentative', kas: [] };
      globalThis.fetch = mockFetchOk(expected);
      const quads = [{ subject: 'urn:s', predicate: 'urn:p', object: '"v"', graph: 'urn:g' }];
      const result = await client.publish('test-paranet', quads);
      expect(result.kcId).toBe('kc1');

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.contextGraphId).toBe('test-paranet');
      expect(body.quads).toHaveLength(1);
    });

    it('query() sends sparql and optional context graph id', async () => {
      globalThis.fetch = mockFetchOk({ result: [] });
      await client.query('SELECT * { ?s ?p ?o }', 'my-paranet');

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.sparql).toBe('SELECT * { ?s ?p ?o }');
      expect(body.contextGraphId).toBe('my-paranet');
    });

    it('publishCclPolicy() posts policy payload', async () => {
      globalThis.fetch = mockFetchOk({ policyUri: 'urn:policy', hash: 'sha256:abc', status: 'proposed' });
      await client.publishCclPolicy({ contextGraphId: 'ops', name: 'incident', version: '0.1.0', content: 'rules: []' });

      const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe(`http://127.0.0.1:${PORT}/api/ccl/policy/publish`);
      const body = JSON.parse(opts.body);
      expect(body.contextGraphId).toBe('ops');
      expect(body.name).toBe('incident');
    });

    it('approveCclPolicy() posts approval payload', async () => {
      globalThis.fetch = mockFetchOk({ policyUri: 'urn:policy', bindingUri: 'urn:binding', approvedAt: 'now' });
      await client.approveCclPolicy({ contextGraphId: 'ops', policyUri: 'urn:policy', contextType: 'incident_review' });

      const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe(`http://127.0.0.1:${PORT}/api/ccl/policy/approve`);
      const body = JSON.parse(opts.body);
      expect(body.contextType).toBe('incident_review');
    });

    it('revokeCclPolicy() posts revocation payload', async () => {
      globalThis.fetch = mockFetchOk({ policyUri: 'urn:policy', bindingUri: 'urn:binding', revokedAt: 'now', status: 'revoked' });
      await client.revokeCclPolicy({ contextGraphId: 'ops', policyUri: 'urn:policy', contextType: 'incident_review' });

      const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe(`http://127.0.0.1:${PORT}/api/ccl/policy/revoke`);
      const body = JSON.parse(opts.body);
      expect(body.contextType).toBe('incident_review');
    });

    it('evaluateCclPolicy() posts evaluation payload', async () => {
      globalThis.fetch = mockFetchOk({ policy: { name: 'incident' }, factSetHash: 'sha256:abc', result: { derived: {}, decisions: {} } });
      await client.evaluateCclPolicy({ contextGraphId: 'ops', name: 'incident', facts: [['claim', 'c1']], snapshotId: 'snap-1', publishResult: true });

      const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe(`http://127.0.0.1:${PORT}/api/ccl/eval`);
      const body = JSON.parse(opts.body);
      expect(body.facts).toEqual([['claim', 'c1']]);
      expect(body.snapshotId).toBe('snap-1');
      expect(body.publishResult).toBe(true);
    });

    it('listCclEvaluations() builds result query string', async () => {
      globalThis.fetch = mockFetchOk({ evaluations: [] });
      await client.listCclEvaluations({ contextGraphId: 'ops', snapshotId: 'snap-2', resultKind: 'decision', resultName: 'propose_accept' });

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('/api/ccl/results?');
      expect(url).toContain('contextGraphId=ops');
      expect(url).toContain('snapshotId=snap-2');
      expect(url).toContain('resultKind=decision');
      expect(url).toContain('resultName=propose_accept');
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
      globalThis.fetch = mockFetchError(400, { error: 'Bad request: missing contextGraphId' });
      await expect(client.status()).rejects.toThrow('Bad request: missing contextGraphId');
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

    it('prefers extraction.error for multipart import failures and preserves the parsed body', async () => {
      const filePath = join(tempDir, 'sample.pdf');
      await writeFile(filePath, Buffer.from('%PDF-1.4\n', 'utf-8'));
      globalThis.fetch = mockFetchError(400, {
        assertionUri: 'did:dkg:context-graph:research/assertion/0xAgent/paper',
        extraction: {
          status: 'failed',
          error: 'PDF converter crashed',
        },
      });

      let thrown: unknown;
      try {
        await client.importAssertionFile('paper', { filePath, contextGraphId: 'research' });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('PDF converter crashed');
      expect((thrown as Error & { httpStatus: number }).httpStatus).toBe(400);
      expect((thrown as Error & { responseBody?: unknown }).responseBody).toEqual({
        assertionUri: 'did:dkg:context-graph:research/assertion/0xAgent/paper',
        extraction: {
          status: 'failed',
          error: 'PDF converter crashed',
        },
      });
    });
  });

  describe('shutdown', () => {
    it('does not throw even if connection closes', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection reset'));
      await expect(client.shutdown()).resolves.toBeUndefined();
    });
  });
});
