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

    // `mcp_auth
    // set` mutates `process.env.DKG_NODE_TOKEN`, but the tool-call path
    // used to read ONLY from the on-disk auth.token file via
    // `loadAuthToken()`, so the rotation was invisible to real traffic.
    // `connect()` now prefers `DKG_NODE_TOKEN` when set.
    describe('mcp_auth override plumbing', () => {
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

      it('connect rejects a malformed DKG_NODE_URL instead of silently falling back to the local daemon', async () => {
        // an unusable
        // `DKG_NODE_URL` (malformed, wrong scheme, reverse-proxy
        // path prefix) silently fell through to the local
        // `daemon.port` file — so a misconfigured operator ended up
        // talking to 127.0.0.1 while the logs claimed the override
        // was honoured. Now we fail fast with a diagnostic URL.
        process.env.DKG_NODE_URL = 'not-a-url';
        process.env.DKG_API_PORT = '9201';
        await writeFile(join(tempDir, 'auth.token'), 'tok\n');
        await expect(DkgClient.connect()).rejects.toThrow(/DKG_NODE_URL.*"not-a-url".*cannot be used/i);
      });
    });

    // Until r10 the
    // env overrides collapsed `DKG_NODE_URL` to a port number and
    // hard-coded `http://127.0.0.1`, silently dropping remote hosts,
    // HTTPS, and base paths. These tests pin the fix: the full base
    // URL now routes through to the `fetch()` call site.
    describe('DKG_NODE_URL full base URL routing', () => {
      it('routes to a remote HTTPS host with an explicit port (origin-only)', async () => {
        // the base URL MUST be origin-only. Callers that
        // previously set `DKG_NODE_URL=https://host:8443/api` now
        // fail-fast at `normalizeBaseUrl`; they should drop the
        // trailing `/api` (DkgClient already hard-codes that prefix).
        process.env.DKG_NODE_URL = 'https://remote.example:8443';
        const c = await DkgClient.connect();

        const { fn, calls } = createTrackingFetch([
          jsonRes({
            name: 'n', peerId: 'p', uptimeMs: 1,
            connectedPeers: 0, relayConnected: false, multiaddrs: [],
          }),
        ]);
        globalThis.fetch = fn;
        await c.status();
        expect(calls[0].url).toBe('https://remote.example:8443/api/status');
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

      it('tolerates a single trailing slash on the env URL (pathname=`/` is still origin-only)', async () => {
        // a single trailing slash resolves to `u.pathname === '/'`
        // which the guard treats as the origin case (not rejected).
        // Anything deeper (`/api`, `/api/`) is rejected — pinned in
        // the dedicated `normalizeBaseUrl` test block above.
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

  describe('normalizeBaseUrl', () => {
    it('returns origin-only (scheme + host + port) for root-path URLs', () => {
      expect(normalizeBaseUrl('http://10.0.0.1:7777')).toBe(
        'http://10.0.0.1:7777',
      );
      expect(normalizeBaseUrl('http://10.0.0.1:7777/')).toBe(
        'http://10.0.0.1:7777',
      );
      expect(normalizeBaseUrl('https://node.example:443')).toBe(
        'https://node.example:443',
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

    it('rejects URLs with a non-root pathname instead of silently stripping it', () => {
      // these all reduced to `https://host:port` — which
      // silently bypassed any reverse-proxy prefix. Now they return
      // `undefined` so DkgClient.connect surfaces the misconfig.
      expect(normalizeBaseUrl('https://remote.example:8443/api')).toBeUndefined();
      expect(normalizeBaseUrl('http://node.example:80/some/nested/path')).toBeUndefined();
      expect(normalizeBaseUrl('http://node.example:80/api/')).toBeUndefined();
      expect(normalizeBaseUrl('http://node.example:80//api//')).toBeUndefined();
      expect(normalizeBaseUrl('https://host/dkg')).toBeUndefined();
      expect(normalizeBaseUrl('https://host/dkg/api')).toBeUndefined();
    });

    it('returns undefined for empty, malformed, or non-http URLs', () => {
      expect(normalizeBaseUrl('')).toBeUndefined();
      expect(normalizeBaseUrl('not-a-url')).toBeUndefined();
      expect(normalizeBaseUrl('file:///etc/passwd')).toBeUndefined();
      expect(normalizeBaseUrl('ftp://node.example:21')).toBeUndefined();
    });

    // The
    // code composed `${u.hostname}:${u.port}`, which strips
    // the square brackets IPv6 literals require in a URL. The result
    // was `http://::1:9200` — malformed and rejected by `fetch`. Pin
    // that brackets round-trip through normalization for both the
    // explicit-port and implicit-port paths.
    it('preserves IPv6 literal brackets (explicit port)', () => {
      expect(normalizeBaseUrl('http://[::1]:9200')).toBe('http://[::1]:9200');
      expect(normalizeBaseUrl('https://[2001:db8::1]:8443')).toBe(
        'https://[2001:db8::1]:8443',
      );
    });

    it('synthesises the default port for IPv6 while preserving brackets', () => {
      // `http://[::1]` with no port must normalize to `http://[::1]:80`
      // (not `http://::1:80`, which `fetch` cannot parse).
      expect(normalizeBaseUrl('http://[::1]')).toBe('http://[::1]:80');
      expect(normalizeBaseUrl('https://[::1]')).toBe('https://[::1]:443');
    });
  });

  // `mcp_auth
  // status/whoami` diverged from `DkgClient.connect()` on discovery —
  // this helper centralizes the logic so both surfaces agree.
  describe('resolveDaemonEndpoint', () => {
    it('resolves from DKG_NODE_URL + DKG_NODE_TOKEN when set (origin-only)', async () => {
      // the URL MUST be origin-only (no path); supplying a
      // pathname like `/api` now fails-fast in `normalizeBaseUrl`.
      process.env.DKG_NODE_URL = 'https://remote.example:8443';
      process.env.DKG_NODE_TOKEN = 'env-tok';
      const r = await resolveDaemonEndpoint({ requireReachable: true });
      expect(r.baseOrPort).toBe('https://remote.example:8443');
      expect(r.displayUrl).toBe('https://remote.example:8443');
      expect(r.token).toBe('env-tok');
      expect(r.tokenSource).toBe('env');
      expect(r.urlSource).toBe('env');
    });

    it('DKG_NODE_URL with a non-root pathname throws instead of silently falling back to the local daemon', async () => {
      // this fell through to the file-port path and the
      // operator's reverse-proxy URL was silently ignored — a
      // classic configuration footgun. Now the resolver throws a
      // diagnostic error naming the offending URL and the expected
      // shape, so the misconfiguration surfaces in `dkg mcp_auth
      // status` and in every MCP tool invocation.
      process.env.DKG_NODE_URL = 'https://remote.example:8443/dkg';
      process.env.DKG_NODE_TOKEN = 'env-tok';
      process.env.DKG_API_PORT = '9201';
      await writeFile(join(tempDir, 'auth.token'), 'file-tok\n');
      await expect(
        resolveDaemonEndpoint({ requireReachable: true }),
      ).rejects.toThrow(/DKG_NODE_URL.*"https:\/\/remote\.example:8443\/dkg".*cannot be used/i);
    });

    it('DKG_NODE_URL rejection also surfaces in requireReachable=false so the display UI cannot lie', async () => {
      // Even the lenient "just render a status line" path must NOT
      // silently claim the local daemon when the operator asked for
      // a remote one. Surfacing the error in the tool UI is strictly
      // better than showing "http://127.0.0.1:..." under a caller
      // who set `DKG_NODE_URL=https://proxy/dkg`.
      process.env.DKG_NODE_URL = 'ftp://remote.example:21';
      await expect(
        resolveDaemonEndpoint({ requireReachable: false }),
      ).rejects.toThrow(/DKG_NODE_URL.*"ftp:\/\/remote\.example:21".*cannot be used/i);
    });

    it('empty DKG_NODE_URL (the default) still falls back to the local file-port path', async () => {
      // Guard against over-reach: the r18-1 fail-fast only applies
      // to non-empty-but-unparseable inputs. Unset / empty should
      // still work as before and route to the local daemon.
      delete process.env.DKG_NODE_URL;
      process.env.DKG_API_PORT = '9201';
      await writeFile(join(tempDir, 'auth.token'), 'file-tok\n');
      const r = await resolveDaemonEndpoint({ requireReachable: true });
      expect(r.baseOrPort).toBe(9201);
      expect(r.urlSource).toBe('file');
      expect(r.tokenSource).toBe('file');
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

    // The synthetic 127.0.0.1:7777 placeholder returned when the
    // daemon is down could be probed by `mcp_auth status`, and if
    // any unrelated service happened to listen on 7777 the tool
    // reported "OK" even with no DKG daemon running. Flag the
    // placeholder with `daemonDown: true` so callers can skip the
    // probe and report the real state.
    it('non-reachable branch sets daemonDown=true so callers can skip probing the synthetic endpoint', async () => {
      delete process.env.DKG_NODE_URL;
      delete process.env.DKG_API_PORT;
      const r = await resolveDaemonEndpoint({ requireReachable: false });
      expect(r.daemonDown).toBe(true);
      // Display string still names the synthetic endpoint for
      // visibility, but the explicit flag is what callers MUST
      // check before probing — a string-contains check is brittle
      // and has already been a footgun (see the probeUrl comment
      // at mcp-server/index.ts:497).
      expect(r.baseOrPort).toBe(7777);
    });

    it('a live daemon (DKG_API_PORT set + port file present) does NOT set daemonDown', async () => {
      process.env.DKG_API_PORT = '9201';
      await writeFile(join(tempDir, 'auth.token'), 'file-tok\n');
      const r = await resolveDaemonEndpoint({ requireReachable: false });
      expect(r.daemonDown).toBeUndefined();
      expect(r.baseOrPort).toBe(9201);
    });

    // -----------------------------------------------------------------
    //
    // When `DKG_NODE_URL` is set (so `urlSource === 'env'`) and
    // `DKG_NODE_TOKEN` is unset, the code fell back to
    // `loadAuthToken()` — the LOCAL daemon's admin credential. An
    // operator pointing their MCP at `https://some.remote.node`
    // would therefore send the local admin bearer to that remote,
    // which is a textbook confused-deputy credential exfiltration.
    //
    // the local-token fallback is scoped to endpoints
    // that demonstrably point AT the local machine (either
    // `urlSource === 'file'` or a loopback host in `DKG_NODE_URL`).
    // Remote targets with no explicit `DKG_NODE_TOKEN` must get an
    // empty bearer — the operator can set `DKG_NODE_TOKEN` to the
    // remote's credential if they need authenticated access.
    // -----------------------------------------------------------------
    it('remote DKG_NODE_URL + unset DKG_NODE_TOKEN MUST NOT forward the local auth.token', async () => {
      process.env.DKG_NODE_URL = 'https://remote.example:8443';
      delete process.env.DKG_NODE_TOKEN;
      // Plant a LOCAL auth token. The code would have
      // read this file and returned it as the remote's credential.
      await writeFile(join(tempDir, 'auth.token'), 'local-admin-token\n');

      const r = await resolveDaemonEndpoint({ requireReachable: true });
      expect(r.baseOrPort).toBe('https://remote.example:8443');
      expect(r.urlSource).toBe('env');
      expect(r.token).toBe('');
      expect(r.tokenSource).toBe('none');
    });

    it('remote DKG_NODE_URL + explicit DKG_NODE_TOKEN passes the ENV token (not the local file)', async () => {
      process.env.DKG_NODE_URL = 'https://remote.example:8443';
      process.env.DKG_NODE_TOKEN = 'remote-specific-token';
      await writeFile(join(tempDir, 'auth.token'), 'local-admin-token\n');

      const r = await resolveDaemonEndpoint({ requireReachable: true });
      expect(r.token).toBe('remote-specific-token');
      expect(r.tokenSource).toBe('env');
    });

    it('loopback DKG_NODE_URL (127.0.0.1) WITH unset DKG_NODE_TOKEN still uses the local auth.token', async () => {
      // Loopback overrides are equivalent to the implicit local
      // daemon path — forwarding `auth.token` to `127.0.0.1` is
      // safe because it IS the local daemon. We MUST NOT regress
      // that ergonomics.
      process.env.DKG_NODE_URL = 'http://127.0.0.1:9201';
      delete process.env.DKG_NODE_TOKEN;
      await writeFile(join(tempDir, 'auth.token'), 'loopback-ok-tok\n');

      const r = await resolveDaemonEndpoint({ requireReachable: true });
      expect(r.token).toBe('loopback-ok-tok');
      expect(r.tokenSource).toBe('file');
    });

    it('localhost DKG_NODE_URL is also treated as local for the token fallback', async () => {
      process.env.DKG_NODE_URL = 'http://localhost:9201';
      delete process.env.DKG_NODE_TOKEN;
      await writeFile(join(tempDir, 'auth.token'), 'localhost-ok-tok\n');

      const r = await resolveDaemonEndpoint({ requireReachable: true });
      expect(r.token).toBe('localhost-ok-tok');
      expect(r.tokenSource).toBe('file');
    });

    it('IPv6 loopback [::1] is treated as local for the token fallback', async () => {
      process.env.DKG_NODE_URL = 'http://[::1]:9201';
      delete process.env.DKG_NODE_TOKEN;
      await writeFile(join(tempDir, 'auth.token'), 'ipv6-ok-tok\n');

      const r = await resolveDaemonEndpoint({ requireReachable: true });
      expect(r.token).toBe('ipv6-ok-tok');
      expect(r.tokenSource).toBe('file');
    });

    it('public IP like 8.8.8.8 is NOT misclassified as local even if the first octet is not 127', async () => {
      process.env.DKG_NODE_URL = 'http://8.8.8.8:443';
      delete process.env.DKG_NODE_TOKEN;
      await writeFile(join(tempDir, 'auth.token'), 'should-not-leak\n');

      const r = await resolveDaemonEndpoint({ requireReachable: true });
      expect(r.token).toBe('');
      expect(r.tokenSource).toBe('none');
    });

    it('a 127.0.0.2 address (valid /8 loopback) is treated as local', async () => {
      // Defensive: `127.0.0.0/8` is the RFC-1122 loopback block,
      // not just `127.0.0.1`. We honour the full block so operators
      // binding an alias on `127.0.0.2` get the same ergonomics.
      process.env.DKG_NODE_URL = 'http://127.0.0.2:9201';
      delete process.env.DKG_NODE_TOKEN;
      await writeFile(join(tempDir, 'auth.token'), 'loopback-8-tok\n');

      const r = await resolveDaemonEndpoint({ requireReachable: true });
      expect(r.token).toBe('loopback-8-tok');
      expect(r.tokenSource).toBe('file');
    });
  });

  describe('extractPortFromUrl', () => {
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

    // -----------------------------------------------------------------
    //
    // the string-form constructor kept an arbitrary pathname
    // verbatim, so `new DkgClient('https://host/dkg')` produced
    // `https://host/dkg/api/status` and `new DkgClient('https://host/api')`
    // produced the double-prefixed `https://host/api/api/status`.
    // Every per-request helper hard-codes `/api/...` (status / query /
    // publish / agents / …) — the base must be origin-only.
    // -----------------------------------------------------------------
    it('normalises an origin-only string base URL (no path segment, no double /api)', async () => {
      const { fn, calls } = createTrackingFetch([
        jsonRes({
          name: 'n', peerId: 'p', uptimeMs: 1,
          connectedPeers: 0, relayConnected: false, multiaddrs: [],
        }),
      ]);
      globalThis.fetch = fn;
      const c = new DkgClient('https://host.example:9443', 'tk');
      await c.status();
      expect(calls[0].url).toBe('https://host.example:9443/api/status');
    });

    it('rejects a base URL with a non-root path segment instead of double-appending /api', () => {
      expect(() => new DkgClient('https://host.example/dkg')).toThrow(
        /invalid or unsupported base URL.*\/dkg/i,
      );
      expect(() => new DkgClient('https://host.example/api')).toThrow(
        /invalid or unsupported base URL.*\/api/i,
      );
      expect(() => new DkgClient('https://host.example/dkg/api')).toThrow(
        /invalid or unsupported base URL/i,
      );
    });

    it('rejects empty / non-http(s) base URLs with a diagnostic error', () => {
      expect(() => new DkgClient('')).toThrow(/invalid or unsupported/i);
      expect(() => new DkgClient('not-a-url')).toThrow(/invalid or unsupported/i);
      expect(() => new DkgClient('ftp://host.example:21')).toThrow(/invalid or unsupported/i);
    });

    it('tolerates a single trailing slash (pathname=`/` is origin-only)', async () => {
      const { fn, calls } = createTrackingFetch([
        jsonRes({
          name: 'n', peerId: 'p', uptimeMs: 1,
          connectedPeers: 0, relayConnected: false, multiaddrs: [],
        }),
      ]);
      globalThis.fetch = fn;
      const c = new DkgClient('http://host.example:9999/');
      await c.status();
      expect(calls[0].url).toBe('http://host.example:9999/api/status');
    });

    it('the numeric-port form still works (backwards compatible local-daemon path)', async () => {
      const { fn, calls } = createTrackingFetch([
        jsonRes({
          name: 'n', peerId: 'p', uptimeMs: 1,
          connectedPeers: 0, relayConnected: false, multiaddrs: [],
        }),
      ]);
      globalThis.fetch = fn;
      const c = new DkgClient(9201);
      await c.status();
      expect(calls[0].url).toBe('http://127.0.0.1:9201/api/status');
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
