import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiClient } from '../src/api-client.js';

const PORT = 8899;

interface FetchCall {
  url: string;
  opts: RequestInit;
}

function mockFetchOk(body: unknown): typeof globalThis.fetch & { _calls: [string | URL | Request, RequestInit | undefined][] } {
  const _calls: [string | URL | Request, RequestInit | undefined][] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    _calls.push([url, init]);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
      headers: new Headers(),
    } as unknown as Response;
  }) as typeof globalThis.fetch & { _calls: typeof _calls };
  fn._calls = _calls;
  return fn;
}

function mockFetchError(status: number, body: unknown): typeof globalThis.fetch {
  const { fetch } = createTrackingFetch({ ok: false, status, body });
  return fetch;
}

function createTrackingFetch(response: { ok: boolean; status: number; statusText?: string; body: unknown; jsonThrows?: boolean }): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), opts: init as RequestInit });
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText ?? (response.ok ? 'OK' : `HTTP ${response.status}`),
      json: response.jsonThrows
        ? () => Promise.reject(new Error('no json'))
        : () => Promise.resolve(response.body),
      text: () => Promise.resolve(JSON.stringify(response.body)),
      headers: new Headers(),
    } as unknown as Response;
  };
  return { fetch: fn as typeof globalThis.fetch, calls };
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
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;
      const result = await client.status();

      expect(result).toEqual(body);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/api/status`);
      expect((calls[0].opts.headers as any).Authorization).toBe('Bearer test-token');
    });

    it('agents() calls /api/agents', async () => {
      const body = { agents: [{ agentUri: 'urn:a', name: 'A', peerId: 'p1' }] };
      const { fetch } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;
      const result = await client.agents();
      expect(result.agents).toHaveLength(1);
    });

    it('skills() calls /api/skills', async () => {
      const body = { skills: [] };
      const { fetch } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;
      const result = await client.skills();
      expect(result.skills).toEqual([]);
    });

    it('listContextGraphs() calls /api/context-graph/list', async () => {
      const body = { contextGraphs: [{ id: 'p1', uri: 'urn:p1', name: 'Test', isSystem: false }] };
      const { fetch } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;
      const result = await client.listContextGraphs();
      expect(result.contextGraphs).toHaveLength(1);
    });

    it('contextGraphExists() calls correct URL with encoded id', async () => {
      const body = { id: 'my paranet', exists: true };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;
      await client.contextGraphExists('my paranet');

      expect(calls[0].url).toContain('my%20paranet');
    });

    it('listCclPolicies() builds query string from filters', async () => {
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body: { policies: [] } });
      globalThis.fetch = fetch;
      await client.listCclPolicies({ contextGraphId: 'ops', name: 'incident', contextType: 'review', includeBody: true });

      const url = calls[0].url;
      expect(url).toContain('/api/ccl/policy/list?');
      expect(url).toContain('contextGraphId=ops');
      expect(url).toContain('name=incident');
      expect(url).toContain('contextType=review');
      expect(url).toContain('includeBody=true');
    });
  });

  describe('POST endpoints', () => {
    it('sendChat() sends correct body', async () => {
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body: { delivered: true } });
      globalThis.fetch = fetch;
      const result = await client.sendChat('peer1', 'hello');
      expect(result.delivered).toBe(true);

      expect(calls[0].opts.method).toBe('POST');
      expect((calls[0].opts.headers as any)['Content-Type']).toBe('application/json');
      const body = JSON.parse(calls[0].opts.body as string);
      expect(body).toEqual({ to: 'peer1', text: 'hello' });
    });

    it('publish() sends context graph id and quads', async () => {
      const expected = { kcId: 'kc1', status: 'tentative', kas: [] };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body: expected });
      globalThis.fetch = fetch;
      const quads = [{ subject: 'urn:s', predicate: 'urn:p', object: '"v"', graph: 'urn:g' }];
      const result = await client.publish('test-paranet', quads);
      expect(result.kcId).toBe('kc1');

      const body = JSON.parse(calls[0].opts.body as string);
      expect(body.contextGraphId).toBe('test-paranet');
      expect(body.quads).toHaveLength(1);
    });

    it('query() sends sparql and optional context graph id', async () => {
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body: { result: [] } });
      globalThis.fetch = fetch;
      await client.query('SELECT * { ?s ?p ?o }', 'my-paranet');

      const body = JSON.parse(calls[0].opts.body as string);
      expect(body.sparql).toBe('SELECT * { ?s ?p ?o }');
      expect(body.contextGraphId).toBe('my-paranet');
    });

    it('createContextGraph() includes private and participant identity options when provided', async () => {
      globalThis.fetch = mockFetchOk({ created: 'GuardianTest', uri: 'did:dkg:context-graph:GuardianTest' });
      await client.createContextGraph('GuardianTest', 'Guardian Test', 'private graph', {
        private: true,
        participantIdentityIds: [11n, '12', 13],
        requiredSignatures: 1,
      });

      const [url, opts] = (globalThis.fetch as any)._calls[0];
      expect(url).toBe(`http://127.0.0.1:${PORT}/api/context-graph/create`);
      const body = JSON.parse(opts.body);
      expect(body).toEqual({
        id: 'GuardianTest',
        name: 'Guardian Test',
        description: 'private graph',
        private: true,
        participantIdentityIds: ['11', '12', '13'],
        requiredSignatures: 1,
      });
    });

    it('publishCclPolicy() posts policy payload', async () => {
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body: { policyUri: 'urn:policy', hash: 'sha256:abc', status: 'proposed' } });
      globalThis.fetch = fetch;
      await client.publishCclPolicy({ contextGraphId: 'ops', name: 'incident', version: '0.1.0', content: 'rules: []' });

      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/api/ccl/policy/publish`);
      const body = JSON.parse(calls[0].opts.body as string);
      expect(body.contextGraphId).toBe('ops');
      expect(body.name).toBe('incident');
    });

    it('approveCclPolicy() posts approval payload', async () => {
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body: { policyUri: 'urn:policy', bindingUri: 'urn:binding', approvedAt: 'now' } });
      globalThis.fetch = fetch;
      await client.approveCclPolicy({ contextGraphId: 'ops', policyUri: 'urn:policy', contextType: 'incident_review' });

      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/api/ccl/policy/approve`);
      const body = JSON.parse(calls[0].opts.body as string);
      expect(body.contextType).toBe('incident_review');
    });

    it('revokeCclPolicy() posts revocation payload', async () => {
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body: { policyUri: 'urn:policy', bindingUri: 'urn:binding', revokedAt: 'now', status: 'revoked' } });
      globalThis.fetch = fetch;
      await client.revokeCclPolicy({ contextGraphId: 'ops', policyUri: 'urn:policy', contextType: 'incident_review' });

      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/api/ccl/policy/revoke`);
      const body = JSON.parse(calls[0].opts.body as string);
      expect(body.contextType).toBe('incident_review');
    });

    it('evaluateCclPolicy() posts evaluation payload', async () => {
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body: { policy: { name: 'incident' }, factSetHash: 'sha256:abc', result: { derived: {}, decisions: {} } } });
      globalThis.fetch = fetch;
      await client.evaluateCclPolicy({ contextGraphId: 'ops', name: 'incident', facts: [['claim', 'c1']], snapshotId: 'snap-1', publishResult: true });

      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/api/ccl/eval`);
      const body = JSON.parse(calls[0].opts.body as string);
      expect(body.facts).toEqual([['claim', 'c1']]);
      expect(body.snapshotId).toBe('snap-1');
      expect(body.publishResult).toBe(true);
    });

    it('listCclEvaluations() builds result query string', async () => {
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body: { evaluations: [] } });
      globalThis.fetch = fetch;
      await client.listCclEvaluations({ contextGraphId: 'ops', snapshotId: 'snap-2', resultKind: 'decision', resultName: 'propose_accept' });

      const url = calls[0].url;
      expect(url).toContain('/api/ccl/results?');
      expect(url).toContain('contextGraphId=ops');
      expect(url).toContain('snapshotId=snap-2');
      expect(url).toContain('resultKind=decision');
      expect(url).toContain('resultName=propose_accept');
    });
  });

  describe('messages() query string building', () => {
    it('builds query string from opts', async () => {
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body: { messages: [] } });
      globalThis.fetch = fetch;
      await client.messages({ peer: 'p1', since: 100, limit: 50 });

      const url = calls[0].url;
      expect(url).toContain('peer=p1');
      expect(url).toContain('since=100');
      expect(url).toContain('limit=50');
    });

    it('omits query string when no opts', async () => {
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body: { messages: [] } });
      globalThis.fetch = fetch;
      await client.messages();

      expect(calls[0].url).not.toContain('?');
    });
  });

  describe('auth headers', () => {
    it('includes Bearer token when set', async () => {
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body: {} });
      globalThis.fetch = fetch;
      await client.status();

      expect((calls[0].opts.headers as any).Authorization).toBe('Bearer test-token');
    });

    it('omits Authorization header when no token', async () => {
      const noTokenClient = new ApiClient(PORT);
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body: {} });
      globalThis.fetch = fetch;
      await noTokenClient.status();

      expect(calls[0].opts.headers).not.toHaveProperty('Authorization');
    });
  });

  describe('error handling', () => {
    it('throws error message from response body', async () => {
      const { fetch } = createTrackingFetch({ ok: false, status: 400, body: { error: 'Bad request: missing contextGraphId' } });
      globalThis.fetch = fetch;
      await expect(client.status()).rejects.toThrow('Bad request: missing contextGraphId');
    });

    it('falls back to HTTP status text when body has no error', async () => {
      const { fetch } = createTrackingFetch({ ok: false, status: 500, statusText: 'Internal Server Error', body: {}, jsonThrows: true });
      globalThis.fetch = fetch;
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
      globalThis.fetch = (async () => { throw new Error('connection reset'); }) as any;
      await expect(client.shutdown()).resolves.toBeUndefined();
    });
  });
});
