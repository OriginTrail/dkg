import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiClient } from '../src/api-client.js';
import type { KnowledgeAssetFinalizedPublishOptions } from '../src/api-client.js';

const PORT = 8899;
const originalDkgHome = process.env.DKG_HOME;
const originalDkgApiPort = process.env.DKG_API_PORT;
const originalDkgAuthToken = process.env.DKG_AUTH_TOKEN;

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

function createRejectingFetch(error: Error): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), opts: init as RequestInit });
    throw error;
  };
  return { fetch: fn as typeof globalThis.fetch, calls };
}

describe('ApiClient', () => {
  let client: ApiClient;
  const originalFetch = globalThis.fetch;
  let tempDir: string;

  it('keeps finalized publish option types importable from api-client', () => {
    const options: KnowledgeAssetFinalizedPublishOptions = {
      clearAfter: true,
      publishEpochs: 1,
      publisherNodeIdentityIdOverride: 0n,
    };

    expect(options).toMatchObject({
      clearAfter: true,
      publishEpochs: 1,
      publisherNodeIdentityIdOverride: 0n,
    });
  });

  beforeEach(async () => {
    client = new ApiClient(PORT, 'test-token');
    tempDir = await mkdtemp(join(tmpdir(), 'api-client-test-'));
    delete process.env.DKG_AUTH_TOKEN;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalDkgHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = originalDkgHome;
    if (originalDkgApiPort === undefined) delete process.env.DKG_API_PORT;
    else process.env.DKG_API_PORT = originalDkgApiPort;
    if (originalDkgAuthToken === undefined) delete process.env.DKG_AUTH_TOKEN;
    else process.env.DKG_AUTH_TOKEN = originalDkgAuthToken;
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('GET endpoints', () => {
    it('status() calls public /api/status without auth header', async () => {
      const body = { name: 'test', peerId: 'peer1', uptimeMs: 1000, connectedPeers: 2, relayConnected: true, multiaddrs: [] };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;
      const result = await client.status();

      expect(result).toEqual(body);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/api/status`);
      expect((calls[0].opts.headers as any).Authorization).toBeUndefined();
    });

    it('normalizes catch-up jobStatus from a pre-field daemon response', async () => {
      globalThis.fetch = mockFetchOk({
        jobId: 'legacy-job',
        contextGraphId: 'cg-legacy',
        includeWorkspace: true,
        status: 'unreachable',
        queuedAt: 1,
      });

      const result = await client.catchupStatus('cg-legacy');

      expect(result.status).toBe('unreachable');
      expect(result.jobStatus).toBe('unreachable');
      expect(result.includeSharedMemory).toBe(true);
    });

    it('preserves the precise catch-up jobStatus from an upgraded daemon', async () => {
      globalThis.fetch = mockFetchOk({
        jobId: 'partial-job',
        contextGraphId: 'cg-partial',
        includeWorkspace: true,
        status: 'unreachable',
        jobStatus: 'partial',
        queuedAt: 1,
      });

      const result = await client.catchupStatus('cg-partial');

      expect(result.status).toBe('unreachable');
      expect(result.jobStatus).toBe('partial');
    });

    it('connect() gives DKG_AUTH_TOKEN precedence over the selected home token file', async () => {
      process.env.DKG_HOME = tempDir;
      process.env.DKG_API_PORT = String(PORT);
      process.env.DKG_AUTH_TOKEN = 'environment-token';
      await writeFile(join(tempDir, 'auth.token'), 'file-token\n', 'utf8');
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body: { agents: [] } });
      globalThis.fetch = fetch;

      const connected = await ApiClient.connect();
      await connected.agents();

      expect((calls[0].opts.headers as any).Authorization).toBe('Bearer environment-token');
    });

    it('connect() can use the selected home config for status when control-plane files are missing', async () => {
      process.env.DKG_HOME = tempDir;
      delete process.env.DKG_API_PORT;
      await writeFile(join(tempDir, 'config.json'), JSON.stringify({ name: 'isolated', apiPort: 9317 }));
      await writeFile(join(tempDir, 'auth.token'), 'local-token\n', 'utf8');
      const body = { name: 'isolated', peerId: 'peer1', uptimeMs: 1000, connectedPeers: 2, relayConnected: true, multiaddrs: [] };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;

      const connected = await ApiClient.connect({ allowConfigFallback: true });
      const result = await connected.status();

      expect(result).toEqual(body);
      expect(connected.controlPlaneWarning).toContain('api.port');
      expect(connected.controlPlaneWarning).toContain('daemon.pid');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://127.0.0.1:9317/api/status');
      expect((calls[0].opts.headers as any).Authorization).toBeUndefined();
      expect(existsSync(join(tempDir, 'api.port'))).toBe(false);
      expect(existsSync(join(tempDir, 'daemon.pid'))).toBe(false);
    });

    it('connect() respects configured apiHost when using the persisted API port', async () => {
      process.env.DKG_HOME = tempDir;
      delete process.env.DKG_API_PORT;
      await writeFile(
        join(tempDir, 'config.json'),
        JSON.stringify({ name: 'remote-bound', apiHost: '100.65.228.120', apiPort: 9200 }),
      );
      await writeFile(join(tempDir, 'api.port'), '9317\n', 'utf8');
      await writeFile(join(tempDir, 'auth.token'), 'local-token\n', 'utf8');
      const body = { name: 'remote-bound', peerId: 'peer1', uptimeMs: 1000, connectedPeers: 2, relayConnected: true, multiaddrs: [] };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;

      const connected = await ApiClient.connect();
      const result = await connected.status();

      expect(result).toEqual(body);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://100.65.228.120:9317/api/status');
    });

    it.each([
      ['0.0.0.0', 'http://127.0.0.1:9317/api/status'],
      ['::', 'http://[::1]:9317/api/status'],
      ['::1', 'http://[::1]:9317/api/status'],
    ])('connect() normalizes configured apiHost %s when using the persisted API port', async (apiHost, expectedUrl) => {
      process.env.DKG_HOME = tempDir;
      delete process.env.DKG_API_PORT;
      await writeFile(
        join(tempDir, 'config.json'),
        JSON.stringify({ name: 'bound-node', apiHost, apiPort: 9200 }),
      );
      await writeFile(join(tempDir, 'api.port'), '9317\n', 'utf8');
      await writeFile(join(tempDir, 'auth.token'), 'local-token\n', 'utf8');
      const body = { name: 'bound-node', peerId: 'peer1', uptimeMs: 1000, connectedPeers: 2, relayConnected: true, multiaddrs: [] };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;

      const connected = await ApiClient.connect();
      const result = await connected.status();

      expect(result).toEqual(body);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(expectedUrl);
    });

    it('connect() keeps using the persisted API port when config parsing fails', async () => {
      process.env.DKG_HOME = tempDir;
      delete process.env.DKG_API_PORT;
      await writeFile(join(tempDir, 'config.json'), '{ bad json', 'utf8');
      await writeFile(join(tempDir, 'api.port'), '9317\n', 'utf8');
      await writeFile(join(tempDir, 'auth.token'), 'local-token\n', 'utf8');
      const body = { name: 'running-node', peerId: 'peer1', uptimeMs: 1000, connectedPeers: 2, relayConnected: true, multiaddrs: [] };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;

      const connected = await ApiClient.connect();
      const result = await connected.status();

      expect(result).toEqual(body);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://127.0.0.1:9317/api/status');
    });

    it('connect() respects configured apiHost when falling back to the configured API port', async () => {
      process.env.DKG_HOME = tempDir;
      delete process.env.DKG_API_PORT;
      await writeFile(
        join(tempDir, 'config.json'),
        JSON.stringify({ name: 'remote-bound', apiHost: '100.65.228.120', apiPort: 9317 }),
      );
      await writeFile(join(tempDir, 'auth.token'), 'local-token\n', 'utf8');
      const body = { name: 'remote-bound', peerId: 'peer1', uptimeMs: 1000, connectedPeers: 2, relayConnected: true, multiaddrs: [] };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;

      const connected = await ApiClient.connect({ allowConfigFallback: true });
      const result = await connected.status();

      expect(result).toEqual(body);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://100.65.228.120:9317/api/status');
    });

    it('connect() can use a yaml-only selected home config for status when control-plane files are missing', async () => {
      process.env.DKG_HOME = tempDir;
      delete process.env.DKG_API_PORT;
      await writeFile(join(tempDir, 'config.yaml'), 'name: isolated\napiPort: 9317\n', 'utf8');
      await writeFile(join(tempDir, 'auth.token'), 'local-token\n', 'utf8');
      const body = { name: 'isolated', peerId: 'peer1', uptimeMs: 1000, connectedPeers: 2, relayConnected: true, multiaddrs: [] };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;

      const connected = await ApiClient.connect({ allowConfigFallback: true });
      const result = await connected.status();

      expect(result).toEqual(body);
      expect(connected.controlPlaneWarning).toContain('api.port');
      expect(connected.controlPlaneWarning).toContain('daemon.pid');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://127.0.0.1:9317/api/status');
      expect((calls[0].opts.headers as any).Authorization).toBeUndefined();
      expect(existsSync(join(tempDir, 'api.port'))).toBe(false);
      expect(existsSync(join(tempDir, 'daemon.pid'))).toBe(false);
    });

    it('connect() refuses config fallback when selected home has the default node name', async () => {
      process.env.DKG_HOME = tempDir;
      delete process.env.DKG_API_PORT;
      await writeFile(join(tempDir, 'config.json'), JSON.stringify({ name: 'dkg-node', apiPort: 9317 }));
      await writeFile(join(tempDir, 'auth.token'), 'local-token\n', 'utf8');
      const body = { name: 'dkg-node', peerId: 'peer1', uptimeMs: 1000, connectedPeers: 2, relayConnected: true, multiaddrs: [] };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;

      await expect(ApiClient.connect({ allowConfigFallback: true }))
        .rejects.toThrow('Daemon is not running. Start it with: dkg start');
      expect(calls).toHaveLength(0);
      expect(existsSync(join(tempDir, 'api.port'))).toBe(false);
      expect(existsSync(join(tempDir, 'daemon.pid'))).toBe(false);
    });

    it('connect() rejects selected home config fallback when status belongs to a different node', async () => {
      process.env.DKG_HOME = tempDir;
      delete process.env.DKG_API_PORT;
      await writeFile(join(tempDir, 'config.json'), JSON.stringify({ name: 'isolated', apiPort: 9317 }));
      await writeFile(join(tempDir, 'auth.token'), 'local-token\n', 'utf8');
      const body = { name: 'other-node', peerId: 'peer1', uptimeMs: 1000, connectedPeers: 2, relayConnected: true, multiaddrs: [] };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;

      const connected = await ApiClient.connect({ allowConfigFallback: true });

      await expect(connected.status()).rejects.toThrow('expected selected home node "isolated"');
      expect(calls).toHaveLength(1);
      expect((calls[0].opts.headers as any).Authorization).toBeUndefined();
    });

    it('connect() reports daemon not running when selected home config fallback port is unreachable', async () => {
      process.env.DKG_HOME = tempDir;
      delete process.env.DKG_API_PORT;
      await writeFile(join(tempDir, 'config.json'), JSON.stringify({ name: 'isolated', apiPort: 9317 }));
      await writeFile(join(tempDir, 'auth.token'), 'local-token\n', 'utf8');
      const { fetch, calls } = createRejectingFetch(new TypeError('fetch failed'));
      globalThis.fetch = fetch;

      const connected = await ApiClient.connect({ allowConfigFallback: true });

      await expect(connected.status()).rejects.toThrow('Daemon is not running. Start it with: dkg start');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://127.0.0.1:9317/api/status');
      expect((calls[0].opts.headers as any).Authorization).toBeUndefined();
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

    it('getContextGraphJoinPolicy() GETs the encoded per-CG endpoint', async () => {
      const body = {
        contextGraphId: '0xOwner/private graph',
        mode: 'open',
        maxMembers: 50,
        maxApprovalsPerHour: 20,
        updatedAt: 1_752_490_123_456,
      };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;

      const result = await client.getContextGraphJoinPolicy('0xOwner/private graph');
      const updatedAt: number | null | undefined = result.updatedAt;
      expect(result).toEqual(body);
      expect(updatedAt).toBe(1_752_490_123_456);
      expect(calls[0].url).toBe(
        `http://127.0.0.1:${PORT}/api/context-graph/0xOwner%2Fprivate%20graph/join-policy`,
      );
      expect(calls[0].opts.method).toBeUndefined();
    });

    it('contextGraphExists() calls correct URL with encoded id', async () => {
      const body = { id: 'my contextGraph', exists: true };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;
      await client.contextGraphExists('my contextGraph');

      expect(calls[0].url).toContain('my%20contextGraph');
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

    // #1828 (otReviewAgent): the recovery-lookup client wrapper is the public
    // surface callers use — assert endpoint spelling, param encoding, optional
    // forwarding, and response passthrough at the client boundary.
    it('publisherJobByIntent() GETs /api/publisher/job-by-intent with all facts encoded', async () => {
      const body = { result: 'active', job: { jobId: 'job-1' }, superseded: [] };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;

      const result = await client.publisherJobByIntent({
        contextGraphId: 'music social',
        name: 'albums/2026',
        subGraphName: 'research',
        agentAddress: '0x1111111111111111111111111111111111111111',
        intentKey: `sha256:${'ab'.repeat(32)}`,
      });

      expect(result).toEqual(body);
      expect(calls).toHaveLength(1);
      const url = calls[0].url;
      expect(url.startsWith(`http://127.0.0.1:${PORT}/api/publisher/job-by-intent?`)).toBe(true);
      expect(url).toContain('contextGraphId=music+social');
      expect(url).toContain('name=albums%2F2026');
      expect(url).toContain('subGraphName=research');
      expect(url).toContain('agentAddress=0x1111111111111111111111111111111111111111');
      expect(url).toContain(`intentKey=sha256%3A${'ab'.repeat(32)}`);
    });

    it('publisherJobByIntent() omits optional facts when not provided', async () => {
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body: { result: 'none' } });
      globalThis.fetch = fetch;
      await client.publisherJobByIntent({ contextGraphId: 'cg', name: 'albums' });

      const url = calls[0].url;
      expect(url).toContain('contextGraphId=cg');
      expect(url).toContain('name=albums');
      expect(url).not.toContain('subGraphName=');
      expect(url).not.toContain('agentAddress=');
      expect(url).not.toContain('intentKey=');
    });
  });

  describe('PUT endpoints', () => {
    it('setContextGraphJoinPolicy() enables bounded open enrollment with explicit acknowledgement', async () => {
      const response = {
        contextGraphId: 'private/cg',
        mode: 'open',
        maxMembers: 12,
        maxApprovalsPerHour: 4,
      };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body: response });
      globalThis.fetch = fetch;

      await client.setContextGraphJoinPolicy('private/cg', {
        mode: 'open',
        maxMembers: 12,
        maxApprovalsPerHour: 4,
        acknowledgeOpenEnrollment: true,
      });

      expect(calls[0].url).toBe(
        `http://127.0.0.1:${PORT}/api/context-graph/private%2Fcg/join-policy`,
      );
      expect(calls[0].opts.method).toBe('PUT');
      expect((calls[0].opts.headers as any).Authorization).toBe('Bearer test-token');
      expect(JSON.parse(calls[0].opts.body as string)).toEqual({
        mode: 'open',
        maxMembers: 12,
        maxApprovalsPerHour: 4,
        acknowledgeOpenEnrollment: true,
      });
    });

    it('setContextGraphJoinPolicy() sends only manual mode when disabling open enrollment', async () => {
      const { fetch, calls } = createTrackingFetch({
        ok: true,
        status: 200,
        body: { contextGraphId: 'private/cg', mode: 'manual' },
      });
      globalThis.fetch = fetch;

      await client.setContextGraphJoinPolicy('private/cg', { mode: 'manual' });

      expect(calls[0].opts.method).toBe('PUT');
      expect(JSON.parse(calls[0].opts.body as string)).toEqual({ mode: 'manual' });
    });
  });

  describe('POST endpoints', () => {
    it('subscribeToContextGraph() forwards explicit sync lifetime', async () => {
      const { fetch, calls } = createTrackingFetch({
        ok: true,
        status: 200,
        body: { subscribed: 'cg-selected', syncMode: 'on-demand' },
      });
      globalThis.fetch = fetch;

      await client.subscribeToContextGraph('cg-selected', {
        includeSharedMemory: true,
        syncMode: 'on-demand',
        forceCatchup: true,
      });

      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/api/context-graph/subscribe`);
      expect(JSON.parse(calls[0].opts.body as string)).toEqual({
        contextGraphId: 'cg-selected',
        includeWorkspace: true,
        syncMode: 'on-demand',
        forceCatchup: true,
      });
    });

    it('subscribeToContextGraph() preserves the omitted-options legacy contract', async () => {
      const { fetch, calls } = createTrackingFetch({
        ok: true,
        status: 200,
        body: { subscribed: 'cg-legacy-direct', syncMode: 'always-on' },
      });
      globalThis.fetch = fetch;

      await client.subscribeToContextGraph('cg-legacy-direct');

      expect(JSON.parse(calls[0].opts.body as string)).toEqual({
        contextGraphId: 'cg-legacy-direct',
        syncMode: 'always-on',
      });
    });

    it('subscribe() keeps the legacy restart-durable lifetime explicit', async () => {
      const { fetch, calls } = createTrackingFetch({
        ok: true,
        status: 200,
        body: { subscribed: 'cg-legacy', syncMode: 'always-on' },
      });
      globalThis.fetch = fetch;

      await client.subscribe('cg-legacy', { includeWorkspace: true });

      expect(JSON.parse(calls[0].opts.body as string)).toEqual({
        contextGraphId: 'cg-legacy',
        includeWorkspace: true,
        syncMode: 'always-on',
      });
    });

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

    it('does not expose the retired direct explicit-quads publish helper', () => {
      expect((client as any).publish).toBeUndefined();
    });

    it('createKnowledgeAsset() forwards finalize:false for a draft-only write', async () => {
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 201, body: { name: 'draft', written: 1, status: 'draft-open' } });
      globalThis.fetch = fetch;
      await client.createKnowledgeAsset('cg-1', 'draft', {
        finalize: false,
        quads: [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o', graph: 'urn:g' }],
      });

      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/api/knowledge-assets`);
      const body = JSON.parse(calls[0].opts.body as string);
      expect(body).toMatchObject({ contextGraphId: 'cg-1', name: 'draft', finalize: false });
      expect(body.quads).toHaveLength(1);
    });

    it('createKnowledgeAsset() omits finalize when unspecified (server default seals)', async () => {
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 201, body: { name: 'draft', status: 'wm-sealed' } });
      globalThis.fetch = fetch;
      await client.createKnowledgeAsset('cg-1', 'draft', {
        quads: [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o', graph: 'urn:g' }],
      });

      const body = JSON.parse(calls[0].opts.body as string);
      expect(body).not.toHaveProperty('finalize');
    });

    it('query() sends sparql, optional context graph id, and partition opt-in', async () => {
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body: { result: [] } });
      globalThis.fetch = fetch;
      await client.query('SELECT * { ?s ?p ?o }', 'my-contextGraph', {
        includeContextGraphPartitions: true,
      });

      const body = JSON.parse(calls[0].opts.body as string);
      expect(body.sparql).toBe('SELECT * { ?s ?p ?o }');
      expect(body.contextGraphId).toBe('my-contextGraph');
      expect(body.includeContextGraphPartitions).toBe(true);
    });

    // LU-2 (SPEC_CG_MEMORY_MODEL): the legacy participantIdentityIds /
    // requiredSignatures body surface is removed. The HTTP-client now
    // forwards only `private` (plus accessPolicy / allowedAgents / etc.).
    it('createContextGraph() forwards private flag', async () => {
      globalThis.fetch = mockFetchOk({ created: 'GuardianTest', uri: 'did:dkg:context-graph:GuardianTest' });
      await client.createContextGraph('GuardianTest', 'Guardian Test', 'private graph', {
        private: true,
      });

      const [url, opts] = (globalThis.fetch as any)._calls[0];
      expect(url).toBe(`http://127.0.0.1:${PORT}/api/context-graph/create`);
      const body = JSON.parse(opts.body);
      expect(body).toEqual({
        id: 'GuardianTest',
        name: 'Guardian Test',
        description: 'private graph',
        private: true,
      });
    });

    it('createSubGraph() posts context graph id and sub-graph name', async () => {
      const { fetch, calls } = createTrackingFetch({
        ok: true,
        status: 200,
        body: { created: 'lab', contextGraphId: 'research' },
      });
      globalThis.fetch = fetch;

      const result = await client.createSubGraph('research', 'lab');

      expect(result).toEqual({ created: 'lab', contextGraphId: 'research' });
      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/api/sub-graph/create`);
      expect(calls[0].opts.method).toBe('POST');
      expect(JSON.parse(calls[0].opts.body as string)).toEqual({
        contextGraphId: 'research',
        subGraphName: 'lab',
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

  describe('PCA V10 endpoints', () => {
    it('registerPcaAgent() POSTs the V10 agent route and NORMALIZES a current response into { registered, advisory }', async () => {
      const body = {
        accountId: '7',
        agent: '0x1111111111111111111111111111111111111111',
        registered: true,
        verified: true,
        adapterSupported: true,
        txHash: '0xabc',
        blockNumber: 42,
      };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;

      const result = await client.registerPcaAgent('7', '0x1111111111111111111111111111111111111111');

      // R15 — the client is the version-skew boundary: it normalizes the wire
      // response into a stable { registered, advisory } (no raw verified/adapterSupported).
      expect(result).toEqual({
        accountId: '7',
        agent: '0x1111111111111111111111111111111111111111',
        registered: true,
        advisory: 'confirmed',
        txHash: '0xabc',
        blockNumber: 42,
      });
      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/api/pca/7/agent`);
      expect(calls[0].opts.method).toBe('POST');
      expect(JSON.parse(calls[0].opts.body as string)).toEqual({
        agent: '0x1111111111111111111111111111111111111111',
      });
    });

    it('registerPcaAgent() does NOT report a legacy registered:false response as registered (R14/R15)', async () => {
      // pre-#1346 daemon: `verified` absent, registered:false (unconfirmed/failed tx).
      const body = {
        accountId: '7',
        agent: '0x1111111111111111111111111111111111111111',
        registered: false,
        adapterSupported: false,
        txHash: '0xabc',
        blockNumber: 42,
      };
      globalThis.fetch = createTrackingFetch({ ok: true, status: 200, body }).fetch;

      const result = await client.registerPcaAgent('7', '0x1111111111111111111111111111111111111111');

      expect(result.registered).toBe(false);
      expect(result.advisory).toBe('legacy-unverified');
    });

    it('deregisterPcaAgent() DELETEs the V10 agent-address route', async () => {
      const body = {
        accountId: '7',
        agent: '0x2222222222222222222222222222222222222222',
        deregistered: true,
        txHash: '0xdef',
        blockNumber: 43,
      };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;

      const result = await client.deregisterPcaAgent('7', '0x2222222222222222222222222222222222222222');

      expect(result).toEqual(body);
      expect(calls[0].url).toBe(
        `http://127.0.0.1:${PORT}/api/pca/7/agent/0x2222222222222222222222222222222222222222`,
      );
      expect(calls[0].opts.method).toBe('DELETE');
    });

    it('settlePca() POSTs the V10 permissionless settle route', async () => {
      const body = { accountId: '7', settled: true, txHash: '0x999', blockNumber: 44 };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;

      const result = await client.settlePca('7');

      expect(result).toEqual(body);
      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/api/pca/7/settle`);
      expect(calls[0].opts.method).toBe('POST');
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
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body: { agents: [] } });
      globalThis.fetch = fetch;
      await client.agents();

      expect((calls[0].opts.headers as any).Authorization).toBe('Bearer test-token');
    });

    it('omits Authorization header when no token', async () => {
      const noTokenClient = new ApiClient(PORT);
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body: { agents: [] } });
      globalThis.fetch = fetch;
      await noTokenClient.agents();

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

  describe('Admin: operational wallets + PCA list/primary-node + agent keys', () => {
    it('listOperationalWallets() GETs /api/operational-wallets', async () => {
      const body = { identityId: '5', hasProfile: true, adminKeyConfigured: true, canManage: true, wallets: [] };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;
      const result = await client.listOperationalWallets();
      expect(result).toEqual(body);
      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/api/operational-wallets`);
      expect(calls[0].opts.method ?? 'GET').toBe('GET');
    });

    it('addOperationalWallet() POSTs the address', async () => {
      const body = { address: '0x' + '1'.repeat(40), added: true, txHash: '0xabc', blockNumber: 1 };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;
      const result = await client.addOperationalWallet('0x' + '1'.repeat(40));
      expect(result).toEqual(body);
      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/api/operational-wallets`);
      expect(calls[0].opts.method).toBe('POST');
      expect(JSON.parse(calls[0].opts.body as string)).toEqual({ address: '0x' + '1'.repeat(40) });
    });

    it('removeOperationalWallet() DELETEs the address route', async () => {
      const addr = '0x' + '2'.repeat(40);
      const body = { address: addr, removed: true, txHash: '0xdef', blockNumber: 2 };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;
      const result = await client.removeOperationalWallet(addr);
      expect(result).toEqual(body);
      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/api/operational-wallets/${addr}`);
      expect(calls[0].opts.method).toBe('DELETE');
    });

    it('listPcas() GETs /api/pca', async () => {
      const body = { accounts: [] };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;
      const result = await client.listPcas();
      expect(result).toEqual(body);
      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/api/pca`);
    });

    it('setPcaPrimaryNode() POSTs { node } to the primary-node route', async () => {
      const body = { accountId: '7', primaryNode: '42', txHash: '0xabc', blockNumber: 3 };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;
      const result = await client.setPcaPrimaryNode('7', '42');
      expect(result).toEqual(body);
      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/api/pca/7/primary-node`);
      expect(calls[0].opts.method).toBe('POST');
      expect(JSON.parse(calls[0].opts.body as string)).toEqual({ node: '42' });
    });

    it('getAgentEncryptionKeys() GETs the agent keys route', async () => {
      const addr = '0x' + 'a'.repeat(40);
      const body = { agentAddress: addr, agentDid: `did:dkg:agent:${addr}`, keys: [] };
      const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
      globalThis.fetch = fetch;
      const result = await client.getAgentEncryptionKeys(addr);
      expect(result).toEqual(body);
      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/api/agent/${addr}/encryption-keys`);
    });
  });
});

describe('ApiClient — GitHub-shaped knowledge-assets SDK (OT-RFC-43 §10.5)', () => {
  const originalFetch = globalThis.fetch;
  let client: ApiClient;
  const base = `http://127.0.0.1:${PORT}`;
  beforeEach(() => { client = new ApiClient(PORT, 'test-token'); });
  afterEach(() => { globalThis.fetch = originalFetch; });

  function track(body: unknown = { ok: true }) {
    const { fetch, calls } = createTrackingFetch({ ok: true, status: 200, body });
    globalThis.fetch = fetch;
    return calls;
  }

  it('createKnowledgeAsset POSTs to /api/knowledge-assets', async () => {
    const calls = track({ name: 'f', status: 'wm-sealed' });
    await client.createKnowledgeAsset('cg', 'f', { quads: [{ subject: 's', predicate: 'p', object: 'o', graph: '' }], alsoShareSwm: true });
    expect(calls[0].url).toBe(`${base}/api/knowledge-assets`);
    expect(calls[0].opts.method).toBe('POST');
    const sent = JSON.parse(calls[0].opts.body as string);
    expect(sent).toMatchObject({ contextGraphId: 'cg', name: 'f', alsoShareSwm: true });
    expect(sent.quads).toHaveLength(1);
  });

  it('createAssertion delegates to the canonical KA create serializer', async () => {
    const calls = track({ assertionUri: 'did:dkg:context-graph:cg/assertion/legacy' });
    const result = await client.createAssertion('cg', 'legacy', {
      subGraphName: 'notes',
      quads: [{ subject: 's', predicate: 'p', object: 'o', graph: '' }],
      finalize: true,
      alsoShareSwm: true,
      authorAgentAddress: '0x1111111111111111111111111111111111111111',
      schemeVersion: 2,
    });
    expect(result.assertionUri).toBe('did:dkg:context-graph:cg/assertion/legacy');
    expect(calls[0].url).toBe(`${base}/api/knowledge-assets`);
    const sent = JSON.parse(calls[0].opts.body as string);
    expect(sent).toMatchObject({
      contextGraphId: 'cg',
      name: 'legacy',
      subGraphName: 'notes',
      finalize: true,
      alsoShareSwm: true,
      authorAgentAddress: '0x1111111111111111111111111111111111111111',
      schemeVersion: 2,
    });
    expect(sent.quads).toHaveLength(1);
    expect(sent.alsoPublishVm).toBeUndefined();
  });

  it('createAssertion validates the legacy assertionUri response contract', async () => {
    const calls = track({ name: 'legacy', status: 'wm-sealed' });
    await expect(client.createAssertion('cg', 'legacy')).rejects
      .toThrow('Knowledge asset create response missing assertionUri for assertion compatibility');
    expect(calls[0].url).toBe(`${base}/api/knowledge-assets`);
  });

  it('createKnowledgeAsset normalizes finalized publish and author seal options', async () => {
    const calls = track({ name: 'f', status: 'vm-confirmed' });
    const preSignedAuthorAttestation = {
      address: '0x1111111111111111111111111111111111111111',
      reservedKaId: ((BigInt('0x1111111111111111111111111111111111111111') << 96n) | 1n).toString(),
      signature: { r: `0x${'22'.repeat(32)}`, vs: `0x${'33'.repeat(32)}` },
    };
    await client.createKnowledgeAsset('cg', 'f', {
      quads: [{ subject: 's', predicate: 'p', object: 'o', graph: '' }],
      preSignedAuthorAttestation,
      schemeVersion: 2,
      alsoPublishVm: {
        clearAfter: false,
        publishEpochs: 9,
        publisherNodeIdentityIdOverride: 7n,
      },
    });
    const sent = JSON.parse(calls[0].opts.body as string);
    expect(sent).toMatchObject({
      contextGraphId: 'cg',
      name: 'f',
      preSignedAuthorAttestation,
      schemeVersion: 2,
      alsoPublishVm: {
        clearSharedMemoryAfter: false,
        publishEpochs: 9,
        publisherNodeIdentityIdOverride: '7',
      },
    });
    expect(sent.alsoPublishVm).not.toHaveProperty('epochs');
    expect(sent.alsoPublishVm).not.toHaveProperty('tokenAmount');
  });

  it('createKnowledgeAsset treats empty alsoPublishVm options as default publish', async () => {
    const calls = track({ name: 'f', status: 'vm-confirmed' });
    await client.createKnowledgeAsset('cg', 'f', { alsoPublishVm: {} });
    const sent = JSON.parse(calls[0].opts.body as string);
    expect(sent.alsoPublishVm).toEqual({});
  });

  it('createKnowledgeAsset rejects unsupported alsoPublishVm options before HTTP serialization', async () => {
    const calls = track({ ok: true });
    await expect(client.createKnowledgeAsset('cg', 'f', {
      alsoPublishVm: { publishEpoch: 3 },
    } as any)).rejects.toThrow('Unsupported finalized publish option(s): publishEpoch');
    expect(calls).toHaveLength(0);
  });

  it('createKnowledgeAsset rejects daemon-only alsoPublishVm aliases before HTTP serialization', async () => {
    const calls = track({ ok: true });
    await expect(client.createKnowledgeAsset('cg', 'f', {
      alsoPublishVm: { epochs: 3 },
    } as any)).rejects.toThrow('Unsupported finalized publish option(s): epochs');
    await expect(client.createKnowledgeAsset('cg', 'f', {
      alsoPublishVm: { clearSharedMemoryAfter: true },
    } as any)).rejects.toThrow('Unsupported finalized publish option(s): clearSharedMemoryAfter');
    expect(calls).toHaveLength(0);
  });

  it('createKnowledgeAsset rejects array alsoPublishVm before HTTP serialization', async () => {
    const calls = track({ ok: true });
    await expect(client.createKnowledgeAsset('cg', 'f', {
      alsoPublishVm: [],
    } as any)).rejects.toThrow('alsoPublishVm must be a boolean or publish-options object');
    expect(calls).toHaveLength(0);
  });

  it('knowledgeAssetWrite POSTs to .../:name/wm/write (name URL-encoded)', async () => {
    const calls = track({ written: 1 });
    await client.knowledgeAssetWrite('cg', 'meeting notes', [{ subject: 's', predicate: 'p', object: 'o', graph: '' }]);
    expect(calls[0].url).toBe(`${base}/api/knowledge-assets/meeting%20notes/wm/write`);
    expect(JSON.parse(calls[0].opts.body as string)).toMatchObject({ contextGraphId: 'cg' });
  });

  it('knowledgeAssetFinalize sends pre-signed author attestation and scheme version', async () => {
    const calls = track({ merkleRoot: '0xabc', eip712Digest: '0xdig' });
    const preSignedAuthorAttestation = {
      address: '0x1111111111111111111111111111111111111111',
      reservedKaId: ((BigInt('0x1111111111111111111111111111111111111111') << 96n) | 1n).toString(),
      signature: { r: `0x${'22'.repeat(32)}`, vs: `0x${'33'.repeat(32)}` },
    };
    await client.knowledgeAssetFinalize('cg', 'f', {
      preSignedAuthorAttestation,
      schemeVersion: 2,
    });
    expect(calls[0].url).toBe(`${base}/api/knowledge-assets/f/wm/finalize`);
    expect(JSON.parse(calls[0].opts.body as string)).toMatchObject({
      contextGraphId: 'cg',
      preSignedAuthorAttestation,
      schemeVersion: 2,
    });
  });

  it('knowledgeAssetFinalize rejects self-sign + external-signer conflict before HTTP serialization', async () => {
    const calls = track({ merkleRoot: '0xabc', eip712Digest: '0xdig' });
    await expect(
      client.knowledgeAssetFinalize('cg', 'f', {
        authorAgentAddress: '0x1111111111111111111111111111111111111111',
        preSignedAuthorAttestation: {
          address: '0x2222222222222222222222222222222222222222',
          reservedKaId: '1',
          signature: { r: `0x${'22'.repeat(32)}`, vs: `0x${'33'.repeat(32)}` },
        },
      }),
    ).rejects.toThrow('authorAgentAddress and preSignedAuthorAttestation are mutually exclusive');
    expect(calls).toHaveLength(0);
  });

  it('knowledgeAssetShare → swm/share, knowledgeAssetPublish → vm/publish', async () => {
    let calls = track({ swmShared: true, promotedCount: 2 });
    await client.knowledgeAssetShare('cg', 'f', {
      subGraphName: 'notes',
      awaitCuratorAck: true,
    });
    expect(calls[0].url).toBe(`${base}/api/knowledge-assets/f/swm/share`);
    expect(JSON.parse(calls[0].opts.body as string)).toMatchObject({
      contextGraphId: 'cg',
      subGraphName: 'notes',
      awaitCuratorAck: true,
    });

    calls = track({ kaId: '7', status: 'confirmed' });
    await client.knowledgeAssetPublish('cg', 'f', {
      subGraphName: 'notes',
      clearAfter: true,
      publishEpochs: 12,
      publisherNodeIdentityIdOverride: 123n,
    });
    expect(calls[0].url).toBe(`${base}/api/knowledge-assets/f/vm/publish`);
    const publishBody = JSON.parse(calls[0].opts.body as string);
    expect(publishBody).toMatchObject({
      contextGraphId: 'cg',
      subGraphName: 'notes',
      options: {
        clearSharedMemoryAfter: true,
        publishEpochs: 12,
        publisherNodeIdentityIdOverride: '123',
      },
    });
    expect(publishBody.options).not.toHaveProperty('subGraphName');

    calls = track({ jobId: 'job-1', status: 'accepted' });
    await client.knowledgeAssetPublishAsync('cg', 'f', {
      subGraphName: 'notes',
      clearAfter: true,
      publishEpochs: 12,
      publisherNodeIdentityIdOverride: 123n,
    });
    expect(calls[0].url).toBe(`${base}/api/knowledge-assets/f/vm/publish-async`);
    const publishAsyncBody = JSON.parse(calls[0].opts.body as string);
    expect(publishAsyncBody).toMatchObject({
      contextGraphId: 'cg',
      subGraphName: 'notes',
      options: {
        clearSharedMemoryAfter: true,
        publishEpochs: 12,
        publisherNodeIdentityIdOverride: '123',
      },
    });
    expect(publishAsyncBody.options).not.toHaveProperty('subGraphName');
  });

  // GH#1786 — the selector must be serialized TOP-LEVEL and must never end up inside
  // `options`: `parseHttpFinalizedPublishOptions` ignores unknown nested keys, so a
  // nested selector would be silently dropped and publish a different author.
  it('serializes selectedAuthorAgentAddress top-level on both publish lanes', async () => {
    const selected = '0x00000000000000000000000000000000000000b7';

    let calls = track({ kaId: '7', status: 'confirmed' });
    await client.knowledgeAssetPublish('cg', 'f', {
      selectedAuthorAgentAddress: selected,
      publishEpochs: 12,
    });
    let body = JSON.parse(calls[0].opts.body as string);
    expect(body).toMatchObject({
      contextGraphId: 'cg',
      selectedAuthorAgentAddress: selected,
      options: { publishEpochs: 12 },
    });
    expect(body.options).not.toHaveProperty('selectedAuthorAgentAddress');

    calls = track({ jobId: 'job-1', status: 'accepted' });
    await client.knowledgeAssetPublishAsync('cg', 'f', {
      selectedAuthorAgentAddress: selected,
      publishEpochs: 12,
    });
    body = JSON.parse(calls[0].opts.body as string);
    expect(body).toMatchObject({
      contextGraphId: 'cg',
      selectedAuthorAgentAddress: selected,
      options: { publishEpochs: 12 },
    });
    expect(body.options).not.toHaveProperty('selectedAuthorAgentAddress');
  });

  // GH#1786 — the OLDER public wrapper over the same endpoint must expose the selector too:
  // a typed SDK caller holding only `publishFromFinalizedAssertion` would otherwise have to
  // cast to `any` to send the very field the AMBIGUOUS_ASSERTION_AUTHOR 409 tells it to
  // retry with. Be precise about what this test can and cannot prove: no tsconfig in this
  // repo includes `test/` (every package is `include: ["src"]`), so nothing HERE guards the
  // TYPE. That is structural instead — all three public entry points take their selector
  // from the one `KnowledgeAssetPublishAuthorSelection` contract, so it cannot go missing
  // from one of them, and deleting it outright fails the package typecheck at the
  // destructures. What this DOES pin is the forwarding: the wrapper currently passes
  // `options` straight through, but the sibling `publishAssertion` builds its downstream
  // options from an explicit key-by-key spread, and a refactor of this wrapper into that
  // shape would silently drop the selector and publish a different author with a 200.
  it('publishFromFinalizedAssertion forwards the selector top-level, like knowledgeAssetPublish', async () => {
    const selected = '0x00000000000000000000000000000000000000b7';
    const calls = track({ kaId: '7', status: 'confirmed' });

    await client.publishFromFinalizedAssertion('cg', 'f', {
      selectedAuthorAgentAddress: selected,
      subGraphName: 'notes',
      publishEpochs: 12,
    });

    expect(calls[0].url).toBe(`${base}/api/knowledge-assets/f/vm/publish`);
    const body = JSON.parse(calls[0].opts.body as string);
    expect(body).toMatchObject({
      contextGraphId: 'cg',
      subGraphName: 'notes',
      selectedAuthorAgentAddress: selected,
      options: { publishEpochs: 12 },
    });
    // Same nesting hazard as the direct lane: a selector inside `options` is silently
    // ignored by parseHttpFinalizedPublishOptions and would publish a different author.
    expect(body.options).not.toHaveProperty('selectedAuthorAgentAddress');
  });

  it('forwards an explicitly empty selector so the daemon can reject it, and omits it when absent', async () => {
    // Presence, not truthiness: silently dropping a malformed selector client-side
    // would let normal author resolution publish a DIFFERENT author with 200 instead
    // of the daemon's 400.
    let calls = track({ kaId: '7', status: 'confirmed' });
    await client.knowledgeAssetPublish('cg', 'f', { selectedAuthorAgentAddress: '' });
    expect(JSON.parse(calls[0].opts.body as string)).toHaveProperty('selectedAuthorAgentAddress', '');

    calls = track({ jobId: 'job-1', status: 'accepted' });
    await client.knowledgeAssetPublishAsync('cg', 'f', { selectedAuthorAgentAddress: '' });
    expect(JSON.parse(calls[0].opts.body as string)).toHaveProperty('selectedAuthorAgentAddress', '');

    calls = track({ kaId: '7', status: 'confirmed' });
    await client.knowledgeAssetPublish('cg', 'f', {});
    expect(JSON.parse(calls[0].opts.body as string)).not.toHaveProperty('selectedAuthorAgentAddress');
  });

  it('knowledgeAssetShare rejects root selection and unsealed sharing before HTTP serialization', async () => {
    const calls = track({ swmShared: true, promotedCount: 1 });
    await expect(client.knowledgeAssetShare('cg', 'f', {
      entities: ['urn:entity:1'],
    })).rejects.toThrow('Knowledge Assets are shared atomically');
    await expect(client.knowledgeAssetShare('cg', 'f', {
      skipSeal: true,
    })).rejects.toThrow('always seal-before-share');
    expect(calls).toHaveLength(0);
  });

  it('knowledgeAssetFinalize rejects the legacy SWM write bridge before HTTP serialization', async () => {
    const calls = track({ merkleRoot: '0xabc', eip712Digest: '0xdig' });
    await expect(
      client.knowledgeAssetFinalize('cg', 'f', { layer: 'swm', subGraphName: 'notes' }),
    ).rejects.toMatchObject({ code: 'LEGACY_KA_READ_ONLY' });
    expect(calls).toHaveLength(0);
  });

  it('knowledgeAssetShareAsync and share job helpers use lifecycle routes', async () => {
    let calls = track({ jobId: 'share-job-1', state: 'queued' });
    await client.knowledgeAssetShareAsync('cg', 'f', {
      subGraphName: 'notes',
    });
    expect(calls[0].url).toBe(`${base}/api/knowledge-assets/f/swm/share-async`);
    expect(JSON.parse(calls[0].opts.body as string)).toMatchObject({
      contextGraphId: 'cg',
      subGraphName: 'notes',
    });

    calls = track({ jobs: [] });
    await client.knowledgeAssetShareJobs({
      contextGraphId: 'cg',
      state: ['queued', 'failed_retrying'],
      limit: 5,
    });
    expect(calls[0].url).toBe(`${base}/api/knowledge-assets/swm/share-jobs?contextGraphId=cg&state=queued%2Cfailed_retrying&limit=5`);

    calls = track({ jobId: 'share-job-1', state: 'queued' });
    await client.knowledgeAssetShareJob('share/job 1');
    expect(calls[0].url).toBe(`${base}/api/knowledge-assets/swm/share-jobs/share%2Fjob%201`);

    calls = track({ jobId: 'share-job-1', state: 'failed' });
    await client.knowledgeAssetCancelShareJob('share/job 1');
    expect(calls[0].url).toBe(`${base}/api/knowledge-assets/swm/share-jobs/share%2Fjob%201`);
    expect(calls[0].opts.method).toBe('DELETE');

    calls = track({ jobId: 'share-job-1', state: 'queued' });
    await client.knowledgeAssetRecoverShareJob('share/job 1');
    expect(calls[0].url).toBe(`${base}/api/knowledge-assets/swm/share-jobs/share%2Fjob%201/recover`);
    expect(calls[0].opts.method).toBe('POST');
  });

  it('#1837 clear-job helpers POST the terminal-clear routes with correct encoding and body', async () => {
    // SWM share-job clear: jobId is percent-encoded in the path, empty JSON body.
    let calls = track({ outcome: 'cleared', jobId: 'share/job 1' });
    await client.knowledgeAssetClearShareJob('share/job 1');
    expect(calls[0].url).toBe(`${base}/api/knowledge-assets/swm/share-jobs/share%2Fjob%201/clear`);
    expect(calls[0].opts.method).toBe('POST');
    expect(JSON.parse(calls[0].opts.body as string)).toEqual({});

    // Publisher clear-job: jobId travels in the body, not the path.
    calls = track({ outcome: 'already_absent', jobId: 'lift job 7' });
    await client.publisherClearJob('lift job 7');
    expect(calls[0].url).toBe(`${base}/api/publisher/clear-job`);
    expect(calls[0].opts.method).toBe('POST');
    expect(JSON.parse(calls[0].opts.body as string)).toEqual({ jobId: 'lift job 7' });
  });

  it('publisherRetryJob serializes an exact job selection and rejects an empty id before HTTP', async () => {
    const calls = track({ retried: 1, blockedPendingRecovery: 0, skipped: 0 });
    await client.publisherRetryJob('lift job 7');
    expect(calls[0].url).toBe(`${base}/api/publisher/retry`);
    expect(calls[0].opts.method).toBe('POST');
    expect(JSON.parse(calls[0].opts.body as string)).toEqual({ status: 'failed', jobId: 'lift job 7' });

    await expect(client.publisherRetryJob('')).rejects.toThrow('jobId must be a non-empty string');
    expect(calls).toHaveLength(1);
  });

  // GH#2270 follow-up (🟡 3824484894) — the escape-hatch option is the CHANGED public behaviour,
  // and only the unchanged default was covered. Removing or inverting the conditional spread would
  // have sent the plain body while every existing row stayed green — and the plain body is exactly
  // what cannot clear a held job.
  it('publisherClearJob serializes the pending-transaction override only when asked', async () => {
    const calls = track({ outcome: 'cleared', jobId: 'lift job 7' });
    await client.publisherClearJob('lift job 7', { allowPendingTransaction: true });
    expect(JSON.parse(calls[0].opts.body as string))
      .toEqual({ jobId: 'lift job 7', allowPendingTransaction: true });

    // The discriminating half: an explicit false must not opt in, so a caller cannot request the
    // destructive override by passing the option around with a falsy value.
    await client.publisherClearJob('lift job 7', { allowPendingTransaction: false });
    expect(JSON.parse(calls[1].opts.body as string)).toEqual({ jobId: 'lift job 7' });
  });

  it('knowledgeAssetShareAsync rejects unsupported sync-only options before HTTP serialization', async () => {
    const calls = track({ jobId: 'should-not-reach', state: 'queued' });
    await expect(client.knowledgeAssetShareAsync('cg', 'f', {
      skipSeal: true,
    } as any)).rejects.toThrow('skipSeal is not supported');
    await expect(client.knowledgeAssetShareAsync('cg', 'f', {
      entities: ['urn:entity:1'],
    })).rejects.toThrow('Knowledge Assets are shared atomically');
    await expect(client.knowledgeAssetShareAsync('cg', 'f', {
      awaitCuratorAck: true,
    } as any)).rejects.toThrow('awaitCuratorAck is not supported for async share');
    expect(calls).toHaveLength(0);
  });

  it('knowledgeAssetPublish rejects unsupported option keys before HTTP serialization', async () => {
    const calls = track({ ok: true });
    await expect(client.knowledgeAssetPublish('cg', 'f', {
      publishEpoch: 3,
    } as any)).rejects.toThrow('Unsupported finalized publish option(s): publishEpoch');
    expect(calls).toHaveLength(0);
  });

  it('knowledgeAssetPublish rejects daemon-only option aliases before HTTP serialization', async () => {
    const calls = track({ ok: true });
    await expect(client.knowledgeAssetPublish('cg', 'f', {
      epochs: 3,
    } as any)).rejects.toThrow('Unsupported finalized publish option(s): epochs');
    await expect(client.knowledgeAssetPublishAsync('cg', 'f', {
      clearSharedMemoryAfter: true,
    } as any)).rejects.toThrow('Unsupported finalized publish option(s): clearSharedMemoryAfter');
    expect(calls).toHaveLength(0);
  });

  it('knowledgeAssetPublish rejects publisher identity overrides above uint72 before HTTP serialization', async () => {
    const calls = track({ ok: true });
    await expect(client.knowledgeAssetPublish('cg', 'f', {
      publisherNodeIdentityIdOverride: 4722366482869645213696n,
    })).rejects.toThrow('publisherNodeIdentityIdOverride');
    expect(calls).toHaveLength(0);
  });

  it('knowledgeAssetPullFrom sends layer + onConflict', async () => {
    const calls = track({ wmDraft: 'open' });
    await client.knowledgeAssetPullFrom('cg', 'f', 'vm', { onConflict: 'replace' });
    expect(calls[0].url).toBe(`${base}/api/knowledge-assets/f/wm/pull-from`);
    expect(JSON.parse(calls[0].opts.body as string)).toMatchObject({ contextGraphId: 'cg', layer: 'vm', onConflict: 'replace' });
  });

  it('getKnowledgeAsset GETs .../:name?contextGraphId=', async () => {
    const calls = track({ state: 'created' });
    await client.getKnowledgeAsset('cg', 'f', 'notes', '0x1111111111111111111111111111111111111111');
    expect(calls[0].url).toBe(`${base}/api/knowledge-assets/f?contextGraphId=cg&subGraphName=notes&agentAddress=0x1111111111111111111111111111111111111111`);
  });

  // #1087 migration guard: the compatibility wrapper used by `dkg shared-memory
  // publish`/`dkg index`/benchmarks must POST the per-KA vm/publish route and
  // translate `clearAfter` → `options.clearSharedMemoryAfter` (a typo/drop here
  // would leave the higher-level validation green while breaking CLI/bench callers).
  it('publishFromFinalizedAssertion POSTs /:name/vm/publish and translates clearAfter → options.clearSharedMemoryAfter', async () => {
    const calls = track({ kaId: '1', status: 'confirmed', kas: [] });
    await client.publishFromFinalizedAssertion('cg', 'my-asset', { clearAfter: true, subGraphName: 'sg1' });
    expect(calls[0].opts.method).toBe('POST');
    expect(calls[0].url).toBe(`${base}/api/knowledge-assets/my-asset/vm/publish`);
    const sent = JSON.parse(calls[0].opts.body as string);
    expect(sent.contextGraphId).toBe('cg');
    expect(sent.subGraphName).toBe('sg1');
    expect(sent.options).toEqual({ clearSharedMemoryAfter: true });
    expect(sent.clearAfter).toBeUndefined();
  });

  it('publishFromFinalizedAssertion omits the options object when no finalized-publish flags are set', async () => {
    const calls = track({ kaId: '1', status: 'confirmed', kas: [] });
    await client.publishFromFinalizedAssertion('cg', 'plain');
    expect(calls[0].url).toBe(`${base}/api/knowledge-assets/plain/vm/publish`);
    expect(JSON.parse(calls[0].opts.body as string)).toEqual({ contextGraphId: 'cg' });
  });

  it('publishAssertion runs the create → per-KA /vm/publish two-call sequence', async () => {
    const calls = track({ kaId: '1', status: 'confirmed', kas: [], assertionUri: 'urn:a' });
    await client.publishAssertion(
      'cg',
      'asset2',
      [{ subject: 'urn:s', predicate: 'urn:p', object: '"o"', graph: '' }],
      { clearAfter: false, subGraphName: 'sg2' },
    );
    // 1st call creates (finalize+share to SWM); the sequence ENDS at the per-KA vm/publish route
    expect(calls[0].url).toBe(`${base}/api/knowledge-assets`);
    expect(JSON.parse(calls[0].opts.body as string)).toMatchObject({
      contextGraphId: 'cg',
      name: 'asset2',
      finalize: true,
      alsoShareSwm: true,
    });
    const last = calls[calls.length - 1];
    expect(last.url).toBe(`${base}/api/knowledge-assets/asset2/vm/publish`);
    expect(last.opts.method).toBe('POST');
    const published = JSON.parse(last.opts.body as string);
    expect(published.subGraphName).toBe('sg2');
    expect(published.options).toEqual({ clearSharedMemoryAfter: false });
  });
});
