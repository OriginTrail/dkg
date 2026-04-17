import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DkgClient } from '../src/connection.js';

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
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dkg-conn-test-'));
    process.env.DKG_HOME = tempDir;
    delete process.env.DKG_API_PORT;
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
