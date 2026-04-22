import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DkgClient, extractPortFromUrl, normalizeBaseUrl, resolveDaemonEndpoint } from '../src/connection.js';

function jsonRes(data: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 422,
    statusText: ok ? 'OK' : 'Unprocessable',
    json: async () => data,
  } as Response;
}

interface FetchCall { url: string; init?: RequestInit }

function createTrackingFetch(responses: Array<Response | (() => Response)>) {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`No more fetch responses queued for: ${url}`);
    return typeof next === 'function' ? next() : next;
  };
  return { fn: fn as typeof globalThis.fetch, calls };
}

describe('DkgClient', () => {
  const originalFetch = globalThis.fetch;
  const originalDkgHome = process.env.DKG_HOME;
  const originalDkgApiPort = process.env.DKG_API_PORT;
  const originalDkgNodeToken = process.env.DKG_NODE_TOKEN;
  const originalDkgNodeUrl = process.env.DKG_NODE_URL;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dkg-conn-test-'));
    process.env.DKG_HOME = tempDir;
    delete process.env.DKG_API_PORT;
    delete process.env.DKG_NODE_TOKEN;
    delete process.env.DKG_NODE_URL;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalDkgHome !== undefined) {
      process.env.DKG_HOME = originalDkgHome;
    } else {
      delete process.env.DKG_HOME;
    }
    if (originalDkgApiPort !== undefined) {
      process.env.DKG_API_PORT = originalDkgApiPort;
    } else {
      delete process.env.DKG_API_PORT;
    }
    if (originalDkgNodeToken !== undefined) {
      process.env.DKG_NODE_TOKEN = originalDkgNodeToken;
    } else {
      delete process.env.DKG_NODE_TOKEN;
    }
    if (originalDkgNodeUrl !== undefined) {
      process.env.DKG_NODE_URL = originalDkgNodeUrl;
    } else {
      delete process.env.DKG_NODE_URL;
    }
    await rm(tempDir, { recursive: true }).catch(() => {});
  });

  describe('connect', () => {
    it('returns client when API port is available', async () => {
      process.env.DKG_API_PORT = '9201';
      await writeFile(join(tempDir, 'auth.token'), 'tok\n');
      const c = await DkgClient.connect();
      expect(c).toBeInstanceOf(DkgClient);
    });

    it('throws when daemon is not running', async () => {
      await expect(DkgClient.connect()).rejects.toThrow(/not running/);
    });

    it('throws when port unreadable but process alive', async () => {
      await writeFile(join(tempDir, 'daemon.pid'), String(process.pid));
      await expect(DkgClient.connect()).rejects.toThrow(/Cannot read API port/);
    });

    // PR #229 bot review round 9 (mcp-server/index.ts:441): `mcp_auth
    // set` mutates `process.env.DKG_NODE_TOKEN`, but the tool-call path
    // used to read ONLY from the on-disk auth.token file via
    // `loadAuthToken()`, so the rotation was invisible to real traffic.
    // `connect()` now prefers `DKG_NODE_TOKEN` when set.
    describe('mcp_auth override plumbing (bot review r9-2)', () => {
      it('connect honors DKG_NODE_TOKEN over on-disk auth.token', async () => {
        process.env.DKG_API_PORT = '9201';
        await writeFile(join(tempDir, 'auth.token'), 'file-token\n');
        process.env.DKG_NODE_TOKEN = 'env-override-token';

        const c = await DkgClient.connect();

        const { fn, calls } = createTrackingFetch([
          jsonRes({
            name: 'n', peerId: 'p', uptimeMs: 1,
            connectedPeers: 0, relayConnected: false, multiaddrs: [],
          }),
        ]);
        globalThis.fetch = fn;
        await c.status();
        expect(
          (calls[0].init?.headers as Record<string, string>)?.Authorization,
        ).toBe('Bearer env-override-token');
      });

      it('connect falls back to file token when DKG_NODE_TOKEN is unset', async () => {
        process.env.DKG_API_PORT = '9201';
        await writeFile(join(tempDir, 'auth.token'), 'file-token\n');

        const c = await DkgClient.connect();

        const { fn, calls } = createTrackingFetch([
          jsonRes({
            name: 'n', peerId: 'p', uptimeMs: 1,
            connectedPeers: 0, relayConnected: false, multiaddrs: [],
          }),
        ]);
        globalThis.fetch = fn;
        await c.status();
        expect(
          (calls[0].init?.headers as Record<string, string>)?.Authorization,
        ).toBe('Bearer file-token');
      });

      it('connect treats empty DKG_NODE_TOKEN as unset', async () => {
        process.env.DKG_API_PORT = '9201';
        await writeFile(join(tempDir, 'auth.token'), 'file-token\n');
        process.env.DKG_NODE_TOKEN = '   ';

        const c = await DkgClient.connect();

        const { fn, calls } = createTrackingFetch([
          jsonRes({
            name: 'n', peerId: 'p', uptimeMs: 1,
            connectedPeers: 0, relayConnected: false, multiaddrs: [],
          }),
        ]);
        globalThis.fetch = fn;
        await c.status();
        expect(
          (calls[0].init?.headers as Record<string, string>)?.Authorization,
        ).toBe('Bearer file-token');
      });

      it('connect honors DKG_NODE_URL port when valid', async () => {
        // No DKG_API_PORT, no auth.token — DKG_NODE_URL should route.
        process.env.DKG_NODE_URL = 'http://127.0.0.1:9999';
        const c = await DkgClient.connect();

        const { fn, calls } = createTrackingFetch([
          jsonRes({
            name: 'n', peerId: 'p', uptimeMs: 1,
            connectedPeers: 0, relayConnected: false, multiaddrs: [],
          }),
        ]);
        globalThis.fetch = fn;
        await c.status();
        expect(calls[0].url).toBe('http://127.0.0.1:9999/api/status');
      });

      it('connect ignores a malformed DKG_NODE_URL and falls back to file port', async () => {
        process.env.DKG_NODE_URL = 'not-a-url';
        process.env.DKG_API_PORT = '9201';
        await writeFile(join(tempDir, 'auth.token'), 'tok\n');
        const c = await DkgClient.connect();

        const { fn, calls } = createTrackingFetch([
          jsonRes({
            name: 'n', peerId: 'p', uptimeMs: 1,
            connectedPeers: 0, relayConnected: false, multiaddrs: [],
          }),
        ]);
        globalThis.fetch = fn;
        await c.status();
        expect(calls[0].url).toBe('http://127.0.0.1:9201/api/status');
      });
    });

    // PR #229 bot review round 10 (connection.ts:40). Until r10 the
    // env overrides collapsed `DKG_NODE_URL` to a port number and
    // hard-coded `http://127.0.0.1`, silently dropping remote hosts,
    // HTTPS, and base paths. These tests pin the fix: the full base
    // URL now routes through to the `fetch()` call site.
    describe('DKG_NODE_URL full base URL routing (bot review r10-2)', () => {
      it('routes to a remote HTTPS host with an explicit port and a base path', async () => {
        process.env.DKG_NODE_URL = 'https://remote.example:8443/api';
        const c = await DkgClient.connect();

        const { fn, calls } = createTrackingFetch([
          jsonRes({
            name: 'n', peerId: 'p', uptimeMs: 1,
            connectedPeers: 0, relayConnected: false, multiaddrs: [],
          }),
        ]);
        globalThis.fetch = fn;
        await c.status();
        expect(calls[0].url).toBe('https://remote.example:8443/api/api/status');
      });

      it('routes to a remote HTTP host when no port is specified (defaults to :80)', async () => {
        process.env.DKG_NODE_URL = 'http://remote.example';
        const c = await DkgClient.connect();

        const { fn, calls } = createTrackingFetch([
          jsonRes({
            name: 'n', peerId: 'p', uptimeMs: 1,
            connectedPeers: 0, relayConnected: false, multiaddrs: [],
          }),
        ]);
        globalThis.fetch = fn;
        await c.status();
        expect(calls[0].url).toBe('http://remote.example:80/api/status');
      });

      it('tolerates a trailing slash on the env URL (no `//` in concatenation)', async () => {
        process.env.DKG_NODE_URL = 'http://remote.example:9999/';
        const c = await DkgClient.connect();

        const { fn, calls } = createTrackingFetch([
          jsonRes({
            name: 'n', peerId: 'p', uptimeMs: 1,
            connectedPeers: 0, relayConnected: false, multiaddrs: [],
          }),
        ]);
        globalThis.fetch = fn;
        await c.status();
        expect(calls[0].url).toBe('http://remote.example:9999/api/status');
      });
    });
  });

  describe('normalizeBaseUrl (bot review r10-2)', () => {
    it('preserves scheme + host + port + base path', () => {
      expect(normalizeBaseUrl('https://remote.example:8443/api')).toBe(
        'https://remote.example:8443/api',
      );
      expect(normalizeBaseUrl('http://10.0.0.1:7777')).toBe(
        'http://10.0.0.1:7777',
      );
    });

    it('strips trailing slashes from the base path', () => {
      expect(normalizeBaseUrl('http://node.example:80/api/')).toBe(
        'http://node.example:80/api',
      );
      expect(normalizeBaseUrl('http://node.example:80//api//')).toBe(
        'http://node.example:80//api',
      );
    });

    it('fills in the default port for http/https when absent', () => {
      expect(normalizeBaseUrl('http://node.example')).toBe(
        'http://node.example:80',
      );
      expect(normalizeBaseUrl('https://node.example')).toBe(
        'https://node.example:443',
      );
    });

    it('returns undefined for empty, malformed, or non-http URLs', () => {
      expect(normalizeBaseUrl('')).toBeUndefined();
      expect(normalizeBaseUrl('not-a-url')).toBeUndefined();
      expect(normalizeBaseUrl('file:///etc/passwd')).toBeUndefined();
      expect(normalizeBaseUrl('ftp://node.example:21')).toBeUndefined();
    });
  });

  // PR #229 bot review round 10 (mcp-server/index.ts:449). `mcp_auth
  // status/whoami` diverged from `DkgClient.connect()` on discovery —
  // this helper centralizes the logic so both surfaces agree.
  describe('resolveDaemonEndpoint (bot review r10-3)', () => {
    it('resolves from DKG_NODE_URL + DKG_NODE_TOKEN when set', async () => {
      process.env.DKG_NODE_URL = 'https://remote.example:8443/api';
      process.env.DKG_NODE_TOKEN = 'env-tok';
      const r = await resolveDaemonEndpoint({ requireReachable: true });
      expect(r.baseOrPort).toBe('https://remote.example:8443/api');
      expect(r.displayUrl).toBe('https://remote.example:8443/api');
      expect(r.token).toBe('env-tok');
      expect(r.tokenSource).toBe('env');
      expect(r.urlSource).toBe('env');
    });

    it('falls back to the file-derived port + token on a normal install', async () => {
      process.env.DKG_API_PORT = '9201';
      await writeFile(join(tempDir, 'auth.token'), 'file-tok\n');

      const r = await resolveDaemonEndpoint({ requireReachable: true });
      expect(r.baseOrPort).toBe(9201);
      expect(r.displayUrl).toBe('http://127.0.0.1:9201');
      expect(r.token).toBe('file-tok');
      expect(r.tokenSource).toBe('file');
      expect(r.urlSource).toBe('file');
    });

    it('reports tokenSource="none" when no credential is configured anywhere', async () => {
      process.env.DKG_API_PORT = '9201';
      const r = await resolveDaemonEndpoint({ requireReachable: true });
      expect(r.token).toBe('');
      expect(r.tokenSource).toBe('none');
    });

    it('requireReachable=false returns a placeholder instead of throwing when daemon is down', async () => {
      // No DKG_API_PORT set, no env URL, no daemon.port file — the
      // reachable path would throw; the non-strict path must not.
      const r = await resolveDaemonEndpoint({ requireReachable: false });
      expect(typeof r.baseOrPort === 'number').toBe(true);
      expect(r.displayUrl).toContain('daemon not running');
    });
  });

  describe('extractPortFromUrl (bot review r9-2)', () => {
    it('extracts explicit port', () => {
      expect(extractPortFromUrl('http://127.0.0.1:9999')).toBe(9999);
      expect(extractPortFromUrl('https://node.example.com:8443')).toBe(8443);
    });

    it('defaults to 80/443 when port is absent', () => {
      expect(extractPortFromUrl('http://example.com')).toBe(80);
      expect(extractPortFromUrl('https://example.com')).toBe(443);
    });

    it('returns undefined for empty, malformed, or non-http URLs', () => {
      expect(extractPortFromUrl('')).toBeUndefined();
      expect(extractPortFromUrl('not-a-url')).toBeUndefined();
      expect(extractPortFromUrl('file:///etc/passwd')).toBeUndefined();
      expect(extractPortFromUrl('ftp://example.com:21')).toBeUndefined();
    });
  });

  describe('HTTP helpers', () => {
    it('status sends bearer token when set', async () => {
      const { fn, calls } = createTrackingFetch([
        jsonRes({
          name: 'n',
          peerId: 'p',
          uptimeMs: 1,
          connectedPeers: 0,
          relayConnected: false,
          multiaddrs: [],
        }),
      ]);
      globalThis.fetch = fn;
      const c = new DkgClient(9200, 'secret');
      await c.status();
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://127.0.0.1:9200/api/status');
      expect((calls[0].init?.headers as Record<string, string>)?.Authorization).toBe('Bearer secret');
    });

    it('get surfaces non-JSON error body', async () => {
      const { fn } = createTrackingFetch([
        {
          ok: false,
          status: 500,
          statusText: 'Err',
          json: async () => { throw new Error('not json'); },
        } as Response,
      ]);
      globalThis.fetch = fn;
      const c = new DkgClient(9200);
      await expect(c.status()).rejects.toThrow(/Err/);
    });

    it('post sends JSON body', async () => {
      const { fn, calls } = createTrackingFetch([
        jsonRes({ result: { bindings: [] } }),
      ]);
      globalThis.fetch = fn;
      const c = new DkgClient(9200);
      await c.query('SELECT * WHERE { ?s ?p ?o }');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://127.0.0.1:9200/api/query');
      expect(calls[0].init?.method).toBe('POST');
      expect(calls[0].init?.body).toBe(
        JSON.stringify({ sparql: 'SELECT * WHERE { ?s ?p ?o }', contextGraphId: undefined }),
      );
    });

    it('post propagates API error string', async () => {
      const { fn } = createTrackingFetch([
        jsonRes({ error: 'bad query' }, false),
      ]);
      globalThis.fetch = fn;
      const c = new DkgClient(9200);
      await expect(c.query('x')).rejects.toThrow('bad query');
    });

    it('covers publish, listContextGraphs, createContextGraph, agents, subscribe', async () => {
      const { fn, calls } = createTrackingFetch([
        jsonRes({}),
        jsonRes({ kcId: '1', status: 'ok', kas: [] }),
        jsonRes({ contextGraphs: [] }),
        jsonRes({ created: '1', uri: 'u' }),
        jsonRes({ agents: [] }),
        jsonRes({ subscribed: 'cg' }),
      ]);
      globalThis.fetch = fn;
      const c = new DkgClient(9200);
      await c.publish('cg', []);
      await c.listContextGraphs();
      await c.createContextGraph('id', 'name', 'desc');
      await c.agents();
      await c.subscribe('cg');
      expect(calls.length).toBeGreaterThan(0);
    });
  });
});
